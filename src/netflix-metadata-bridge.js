(function startNetflixMetadataBridge() {
  "use strict";

  const identity = globalThis.NetflixSubtitleVideoIdentity;
  if (!identity || globalThis.__nchMetadataBridgeInstalled) {
    return;
  }
  globalThis.__nchMetadataBridgeInstalled = true;

  const MESSAGE_SOURCE = "nch-netflix-metadata-bridge";
  const REQUEST_SOURCE = "nch-netflix-card-filter";
  const ENDPOINT_PATH = "/nq/website/memberapi/release/pathEvaluator";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_CONCURRENT_RESPONSES = 2;
  const MAX_RESPONSES_PER_MINUTE = 30;
  const MAX_EVIDENCE_FACTS = 2_048;
  const MAX_REQUEST_IDS = MAX_EVIDENCE_FACTS;
  const MAX_TARGETED_FACTS = MAX_REQUEST_IDS * 3;
  const EVIDENCE_TTL_MS = 10 * 60 * 1000;
  const MAX_INLINE_SCAN_BYTES = 2 * 1024 * 1024;
  const RESPONSE_READ_TIMEOUT_MS = 8_000;
  const CACHE_SCAN_RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000, 8_000];

  const evidenceTypes = new Map();
  const evidenceShowRefs = new Map();
  const evidenceAmbiguous = new Map();
  let pendingIds = new Set();
  let lastExternalRequestIds = new Set();
  let lastExternalEpoch = null;
  let scanTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let inlineScanned = false;
  let activeResponseReads = 0;
  let responseWindowStartedAt = null;
  let responseWindowCount = 0;

  function sameIds(left, right) {
    return left.size === right.size && Array.from(left).every((id) => right.has(id));
  }

  function validEpoch(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function publish(analysis, { epoch = lastExternalEpoch } = {}) {
    if (!validEpoch(epoch)) {
      return { pairs: [], ambiguousIds: [] };
    }
    const rawPairs = Array.isArray(analysis?.pairs) ? analysis.pairs : [];
    const rawAmbiguousIds = Array.from(analysis?.ambiguousIds || [])
      .filter((id) => typeof id === "string" && identity.isValidId(id));
    const chunkCount = Math.max(
      1,
      Math.ceil(rawPairs.length / identity.MAX_PAIRS),
      Math.ceil(rawAmbiguousIds.length / identity.MAX_PAIRS)
    );
    const publishedPairs = [];
    const publishedAmbiguousIds = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const pairs = identity.normalizePairs(rawPairs.slice(
        index * identity.MAX_PAIRS,
        (index + 1) * identity.MAX_PAIRS
      ));
      const ambiguousIds = rawAmbiguousIds.slice(
        index * identity.MAX_PAIRS,
        (index + 1) * identity.MAX_PAIRS
      );
      try {
        globalThis.postMessage({
          source: MESSAGE_SOURCE,
          type: "NCH_VIDEO_ID_MAP",
          version: 1,
          epoch,
          ack: true,
          pairs,
          ambiguousIds
        }, location.origin);
        publishedPairs.push(...pairs);
        publishedAmbiguousIds.push(...ambiguousIds);
      } catch (_error) {
        // Page-owned messaging must never escape into Netflix's request callbacks.
      }
    }
    return { pairs: publishedPairs, ambiguousIds: publishedAmbiguousIds };
  }

  function publishAck(epoch) {
    publish({ pairs: [], ambiguousIds: [] }, { epoch });
  }

  function evidenceSize() {
    return evidenceTypes.size + evidenceShowRefs.size + evidenceAmbiguous.size;
  }

  function hasEvidenceRoom() {
    return evidenceSize() < MAX_EVIDENCE_FACTS;
  }

  function pruneExpiredEvidence(now = Date.now()) {
    const expiresBefore = now - EVIDENCE_TTL_MS;
    for (const [id, record] of evidenceTypes) {
      if (record.seenAt < expiresBefore) {
        evidenceTypes.delete(id);
      }
    }
    for (const [id, record] of evidenceShowRefs) {
      if (record.seenAt < expiresBefore) {
        evidenceShowRefs.delete(id);
      }
    }
    for (const [id, seenAt] of evidenceAmbiguous) {
      if (seenAt < expiresBefore) {
        evidenceAmbiguous.delete(id);
      }
    }
  }

  function markEvidenceAmbiguous(rawId, seenAt = Date.now()) {
    const id = String(rawId || "");
    if (!identity.isValidId(id)) {
      return false;
    }

    let changed = evidenceTypes.delete(id);
    changed = evidenceShowRefs.delete(id) || changed;
    const existingAmbiguous = evidenceAmbiguous.has(id);
    if (existingAmbiguous || hasEvidenceRoom() || changed) {
      evidenceAmbiguous.set(id, seenAt);
      changed = !existingAmbiguous || changed;
    }

    for (const [episodeId, record] of Array.from(evidenceShowRefs)) {
      if (record.value !== id) {
        continue;
      }
      evidenceShowRefs.delete(episodeId);
      evidenceAmbiguous.set(episodeId, seenAt);
      changed = true;
    }
    return changed;
  }

  function mergeEvidenceType(rawId, type, seenAt) {
    const id = String(rawId || "");
    if (
      !identity.isValidId(id)
      || (type !== "movie" && type !== "show" && type !== "episode")
      || evidenceAmbiguous.has(id)
    ) {
      return false;
    }
    const existing = evidenceTypes.get(id);
    if (existing && existing.value !== type) {
      return markEvidenceAmbiguous(id, seenAt);
    }
    if (type !== "episode" && evidenceShowRefs.has(id)) {
      return markEvidenceAmbiguous(id, seenAt);
    }
    if (existing) {
      existing.seenAt = seenAt;
      return false;
    }
    if (hasEvidenceRoom()) {
      evidenceTypes.set(id, { value: type, seenAt });
      return true;
    }
    return false;
  }

  function mergeEvidenceShowRef(rawEpisodeId, rawShowId, seenAt) {
    const episodeId = String(rawEpisodeId || "");
    const showId = String(rawShowId || "");
    if (
      !identity.isValidId(episodeId)
      || !identity.isValidId(showId)
      || evidenceAmbiguous.has(episodeId)
    ) {
      return false;
    }
    const existing = evidenceShowRefs.get(episodeId);
    const episodeType = evidenceTypes.get(episodeId)?.value;
    if (episodeType && episodeType !== "episode") {
      return markEvidenceAmbiguous(episodeId, seenAt);
    }
    if (existing && existing.value !== showId) {
      return markEvidenceAmbiguous(episodeId, seenAt);
    }
    if (existing) {
      existing.seenAt = seenAt;
      return false;
    }
    if (hasEvidenceRoom()) {
      evidenceShowRefs.set(episodeId, { value: showId, seenAt });
      return true;
    }
    return false;
  }

  function mergePayloadFacts(payload) {
    if (typeof identity.factsFromPayload !== "function") {
      return { complete: false, changed: false };
    }

    let facts;
    try {
      facts = identity.factsFromPayload(payload, MAX_EVIDENCE_FACTS);
    } catch (_error) {
      return { complete: false, changed: false };
    }
    if (!facts?.complete) {
      return { complete: false, changed: false };
    }

    const seenAt = Date.now();
    pruneExpiredEvidence(seenAt);
    let changed = false;
    for (const id of Array.isArray(facts.ambiguousIds) ? facts.ambiguousIds : []) {
      changed = markEvidenceAmbiguous(id, seenAt) || changed;
    }
    for (const fact of Array.isArray(facts.types) ? facts.types : []) {
      if (Array.isArray(fact) && fact.length === 2) {
        changed = mergeEvidenceType(fact[0], fact[1], seenAt) || changed;
      }
    }
    for (const fact of Array.isArray(facts.showRefs) ? facts.showRefs : []) {
      if (Array.isArray(fact) && fact.length === 2) {
        changed = mergeEvidenceShowRef(fact[0], fact[1], seenAt) || changed;
      }
    }
    return { complete: true, changed };
  }

  function evidenceAnalysis(ids = lastExternalRequestIds) {
    pruneExpiredEvidence();
    const pairs = [];
    const ambiguousIds = [];
    for (const structuralId of ids) {
      if (evidenceAmbiguous.has(structuralId)) {
        ambiguousIds.push(structuralId);
        continue;
      }

      const type = evidenceTypes.get(structuralId)?.value;
      if (type === "movie" || type === "show") {
        pairs.push([structuralId, structuralId]);
        continue;
      }
      if (type !== "episode") {
        continue;
      }

      const showId = evidenceShowRefs.get(structuralId)?.value;
      if (
        showId
        && !evidenceAmbiguous.has(showId)
        && evidenceTypes.get(showId)?.value === "show"
      ) {
        pairs.push([structuralId, showId]);
      }
    }
    return { pairs, ambiguousIds };
  }

  function analysisFromFacts(facts, ids) {
    const types = new Map();
    const showRefs = new Map();
    const ambiguous = new Set(
      Array.from(facts?.ambiguousIds || [])
        .filter((id) => typeof id === "string" && identity.isValidId(id))
    );

    for (const fact of Array.isArray(facts?.types) ? facts.types : []) {
      if (!Array.isArray(fact) || fact.length !== 2) {
        continue;
      }
      const [id, type] = fact;
      if (
        typeof id !== "string"
        || !identity.isValidId(id)
        || (type !== "movie" && type !== "show" && type !== "episode")
      ) {
        continue;
      }
      const existing = types.get(id);
      if (existing && existing !== type) {
        types.delete(id);
        ambiguous.add(id);
      } else if (!ambiguous.has(id)) {
        types.set(id, type);
      }
    }
    for (const fact of Array.isArray(facts?.showRefs) ? facts.showRefs : []) {
      if (!Array.isArray(fact) || fact.length !== 2) {
        continue;
      }
      const [episodeId, showId] = fact;
      if (
        typeof episodeId !== "string"
        || typeof showId !== "string"
        || !identity.isValidId(episodeId)
        || !identity.isValidId(showId)
      ) {
        continue;
      }
      const existing = showRefs.get(episodeId);
      if (existing && existing !== showId) {
        showRefs.delete(episodeId);
        ambiguous.add(episodeId);
      } else if (!ambiguous.has(episodeId)) {
        showRefs.set(episodeId, showId);
      }
    }
    for (const [episodeId, showId] of Array.from(showRefs)) {
      if (
        ambiguous.has(episodeId)
        || ambiguous.has(showId)
        || (types.has(episodeId) && types.get(episodeId) !== "episode")
      ) {
        showRefs.delete(episodeId);
        types.delete(episodeId);
        ambiguous.add(episodeId);
      }
    }

    const pairs = [];
    const ambiguousIds = [];
    for (const structuralId of ids || []) {
      if (ambiguous.has(structuralId)) {
        ambiguousIds.push(structuralId);
        continue;
      }
      const type = types.get(structuralId);
      if (type === "movie" || type === "show") {
        pairs.push([structuralId, structuralId]);
        continue;
      }
      if (type !== "episode") {
        continue;
      }
      const showId = showRefs.get(structuralId);
      if (showId && !ambiguous.has(showId) && types.get(showId) === "show") {
        pairs.push([structuralId, showId]);
      }
    }
    return { pairs, ambiguousIds };
  }

  function clearSettledPending(analysis) {
    for (const [structuralId] of analysis.pairs) {
      pendingIds.delete(structuralId);
    }
    for (const structuralId of analysis.ambiguousIds) {
      pendingIds.delete(structuralId);
    }
    if (!pendingIds.size && retryTimer) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function publishEvidenceForActive() {
    if (!validEpoch(lastExternalEpoch) || !lastExternalRequestIds.size) {
      return;
    }
    const analysis = evidenceAnalysis();
    if (!analysis.pairs.length && !analysis.ambiguousIds.length) {
      return;
    }
    clearSettledPending(publish(analysis));
  }

  function processObservedPayload(payload) {
    let result = { complete: false, changed: false };
    try {
      result = mergePayloadFacts(payload);
    } catch (_error) {
      // A page-owned object or getter must never affect Netflix execution.
    }
    if (result.changed) {
      publishEvidenceForActive();
    }
  }

  function isExactEndpoint(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      return url.origin === location.origin && url.pathname === ENDPOINT_PATH;
    } catch (_error) {
      return false;
    }
  }

  function responseContentLength(headers) {
    try {
      const rawLength = headers?.get?.("content-length");
      if (rawLength == null || rawLength === "") {
        return null;
      }
      const normalizedLength = String(rawLength).trim();
      if (!/^\d+$/.test(normalizedLength)) {
        return -1;
      }
      const length = Number(normalizedLength);
      return Number.isSafeInteger(length) ? length : -1;
    } catch (_error) {
      return -1;
    }
  }

  function contentLengthWithinLimit(headers) {
    const length = responseContentLength(headers);
    return length === null || (length >= 0 && length <= MAX_RESPONSE_BYTES);
  }

  function hasJsonContentType(headers) {
    try {
      const rawType = headers?.get?.("content-type");
      if (typeof rawType !== "string") {
        return false;
      }
      const mimeType = rawType.split(";", 1)[0].trim().toLowerCase();
      return mimeType === "application/json"
        || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(mimeType);
    } catch (_error) {
      return false;
    }
  }

  function utf8LengthWithinLimit(text) {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (
        code >= 0xd800
        && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
      if (bytes > MAX_RESPONSE_BYTES) {
        return false;
      }
    }
    return true;
  }

  function claimResponseRead() {
    const now = Date.now();
    if (responseWindowStartedAt === null || now - responseWindowStartedAt >= 60_000) {
      responseWindowStartedAt = now;
      responseWindowCount = 0;
    }
    if (
      responseWindowCount >= MAX_RESPONSES_PER_MINUTE
      || activeResponseReads >= MAX_CONCURRENT_RESPONSES
    ) {
      return false;
    }
    responseWindowCount += 1;
    activeResponseReads += 1;
    return true;
  }

  function releaseResponseRead() {
    activeResponseReads = Math.max(0, activeResponseReads - 1);
  }

  async function readJsonResponseBounded(response) {
    if (
      !response
      || response.status !== 200
      || !isExactEndpoint(response.url)
      || !hasJsonContentType(response.headers)
      || !contentLengthWithinLimit(response.headers)
    ) {
      return null;
    }

    let reader;
    try {
      reader = response.clone().body?.getReader?.();
    } catch (_error) {
      return null;
    }
    if (!reader || typeof TextDecoder !== "function") {
      return null;
    }

    const chunks = [];
    let total = 0;
    let timedOut = false;
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      try {
        const cancellation = reader.cancel();
        cancellation?.catch?.(() => {});
      } catch (_error) {
        // Cancellation is best-effort and never affects the original response.
      }
    }, RESPONSE_READ_TIMEOUT_MS);

    try {
      while (!timedOut) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) {
          return null;
        }
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          try {
            const cancellation = reader.cancel();
            cancellation?.catch?.(() => {});
          } catch (_error) {
            // The oversized observer branch is discarded fail-open.
          }
          return null;
        }
        chunks.push(chunk);
      }
      if (timedOut) {
        return null;
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch (_error) {
      return null;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  function observeFetchResponse(response) {
    if (!claimResponseRead()) {
      return;
    }
    Promise.resolve(readJsonResponseBounded(response))
      .then((payload) => {
        if (payload) {
          processObservedPayload(payload);
        }
      })
      .catch(() => {})
      .finally(releaseResponseRead);
  }

  function fetchRequestTargetsEndpoint(args) {
    try {
      const input = args?.[0];
      const init = args?.[1];
      const rawUrl = typeof input === "string" || input instanceof URL
        ? input
        : input?.url;
      const initMethod = init?.method;
      const method = String(
        initMethod !== undefined ? initMethod : (input?.method || "GET")
      ).toUpperCase();
      return method === "POST" && isExactEndpoint(rawUrl);
    } catch (_error) {
      return false;
    }
  }

  function installFetchObserver() {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function" || typeof Proxy !== "function") {
      return;
    }

    try {
      globalThis.fetch = new Proxy(originalFetch, {
        apply(target, thisArgument, argumentsList) {
          const result = Reflect.apply(target, thisArgument, argumentsList);
          try {
            if (fetchRequestTargetsEndpoint(argumentsList)) {
              const then = result?.then;
              if (typeof then === "function") {
                const observerPromise = Reflect.apply(then, result, [
                  (response) => {
                    try {
                      observeFetchResponse(response);
                    } catch (_error) {
                      // Observation failures are detached from Netflix's promise.
                    }
                  },
                  () => {}
                ]);
                try {
                  observerPromise?.catch?.(() => {});
                } catch (_error) {
                  // A non-standard thenable is ignored after the native call.
                }
              }
            }
          } catch (_error) {
            // Nothing in the observer path may change fetch's return or throw behavior.
          }
          return result;
        }
      });
    } catch (_error) {
      // A locked or page-replaced fetch is left untouched.
    }
  }

  function observeXhrResponse(xhr) {
    let claimed = false;
    try {
      const headers = { get: (name) => xhr.getResponseHeader(name) };
      const contentLength = responseContentLength(headers);
      if (
        xhr.status !== 200
        || !isExactEndpoint(xhr.responseURL)
        || !hasJsonContentType(headers)
        || contentLength === -1
        || (contentLength !== null && contentLength > MAX_RESPONSE_BYTES)
      ) {
        return;
      }
      if (!claimResponseRead()) {
        return;
      }
      claimed = true;

      let payload = null;
      const responseType = String(xhr.responseType || "");
      if (responseType === "" || responseType === "text") {
        const text = xhr.responseText;
        if (
          typeof text !== "string"
          || text.length > MAX_RESPONSE_BYTES
          || !utf8LengthWithinLimit(text)
        ) {
          return;
        }
        payload = JSON.parse(text);
      } else {
        // A pre-parsed JSON object has no trustworthy post-decompression byte
        // length. Text is required so the hard 2 MiB evidence limit is real.
        return;
      }
      if (payload) {
        processObservedPayload(payload);
      }
    } catch (_error) {
      // Response access, decoding and evidence parsing are all optional.
    } finally {
      if (claimed) {
        releaseResponseRead();
      }
    }
  }

  function installXhrObserver() {
    const prototype = globalThis.XMLHttpRequest?.prototype;
    const originalOpen = prototype?.open;
    const originalSend = prototype?.send;
    if (
      typeof originalOpen !== "function"
      || typeof originalSend !== "function"
      || typeof Proxy !== "function"
    ) {
      return;
    }

    const requestState = new WeakMap();
    try {
      prototype.open = new Proxy(originalOpen, {
        apply(target, xhr, argumentsList) {
          const result = Reflect.apply(target, xhr, argumentsList);
          try {
            requestState.set(xhr, {
              target: String(argumentsList?.[0] || "GET").toUpperCase() === "POST"
                && isExactEndpoint(argumentsList?.[1])
            });
          } catch (_error) {
            requestState.delete(xhr);
          }
          return result;
        }
      });

      prototype.send = new Proxy(originalSend, {
        apply(target, xhr, argumentsList) {
          const state = requestState.get(xhr);
          let listener = null;
          if (state?.target) {
            listener = () => {
              try {
                observeXhrResponse(xhr);
              } catch (_error) {
                // Event-listener failures stay detached from Netflix's XHR flow.
              }
            };
            try {
              xhr.addEventListener("loadend", listener, { once: true });
            } catch (_error) {
              listener = null;
            }
          }
          try {
            return Reflect.apply(target, xhr, argumentsList);
          } catch (error) {
            if (listener) {
              try {
                xhr.removeEventListener("loadend", listener);
              } catch (_removeError) {
                // Preserve the original send exception.
              }
            }
            throw error;
          }
        }
      });
    } catch (_error) {
      try {
        prototype.open = originalOpen;
        prototype.send = originalSend;
      } catch (_restoreError) {
        // If the prototype is locked, leave Netflix's existing methods alone.
      }
    }
  }

  function scanInlineCachesOnce() {
    if (inlineScanned) {
      return;
    }
    inlineScanned = true;
    if (typeof identity.parseInlineFalcorCaches !== "function") {
      return;
    }

    try {
      let remainingBytes = MAX_INLINE_SCAN_BYTES;
      const scripts = globalThis.document?.scripts;
      const scriptCount = Math.min(
        100,
        Math.max(0, Math.floor(Number(scripts?.length) || 0))
      );
      for (let index = 0; index < scriptCount; index += 1) {
        const script = scripts[index];
        if (script.src) {
          continue;
        }
        const text = script.textContent;
        if (
          typeof text !== "string"
          || text.length > remainingBytes
          || !text.includes("falcorCache")
        ) {
          continue;
        }
        remainingBytes -= text.length;
        for (const cache of identity.parseInlineFalcorCaches(text)) {
          mergePayloadFacts(cache);
        }
      }
    } catch (_error) {
      // Inline evidence is optional and always fail-open.
    }
  }

  function scanPendingIds() {
    scanTimer = null;
    if (!pendingIds.size) {
      return;
    }

    scanInlineCachesOnce();
    publishEvidenceForActive();
    if (!pendingIds.size) {
      return;
    }

    let factsComplete = false;
    const cache = globalThis.netflix?.falcorCache;
    if (typeof identity.factsFromPayload === "function") {
      try {
        const facts = identity.factsFromPayload(
          cache,
          MAX_TARGETED_FACTS,
          pendingIds
        );
        factsComplete = facts?.complete === true;
        if (factsComplete) {
          const analysis = analysisFromFacts(facts, pendingIds);
          if (analysis.pairs.length || analysis.ambiguousIds.length) {
            clearSettledPending(publish(analysis));
          }
        }
      } catch (_error) {
        // Netflix owns this MAIN-world object. Access failures remain unknown.
      }
    }

    if (!factsComplete && typeof identity.analyzePayload === "function") {
      const snapshot = Array.from(pendingIds);
      for (let offset = 0; offset < snapshot.length; offset += identity.MAX_PAIRS) {
        const batchIds = new Set(snapshot.slice(offset, offset + identity.MAX_PAIRS));
        let analysis = { pairs: [], ambiguousIds: [], complete: false };
        try {
          analysis = identity.analyzePayload(cache, batchIds);
        } catch (_error) {
          // Keep compatibility with a missing or temporarily inaccessible cache.
        }
        if (analysis?.complete === true) {
          if (analysis.pairs.length || analysis.ambiguousIds.length) {
            clearSettledPending(publish(analysis));
          }
        } else if (analysis?.pairs?.length) {
          // analyzePayload removes every uncertain mapping before returning.
          // Its remaining self-ID pairs are strict positive evidence even when
          // a very large cache prevented it from proving absence elsewhere.
          // Do not publish incomplete ambiguousIds: those IDs must remain
          // pending so later network evidence can still resolve them.
          const positiveEvidence = {
            pairs: analysis.pairs,
            ambiguousIds: []
          };
          clearSettledPending(publish(positiveEvidence));
        }
      }
    }

    if (pendingIds.size && retryCount < CACHE_SCAN_RETRY_DELAYS.length && !retryTimer) {
      const delay = CACHE_SCAN_RETRY_DELAYS[retryCount];
      retryCount += 1;
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        scheduleScan();
      }, delay);
    }
  }

  function scheduleScan() {
    if (!scanTimer) {
      scanTimer = globalThis.setTimeout(scanPendingIds, 100);
    }
  }

  installFetchObserver();
  installXhrObserver();

  globalThis.addEventListener("message", (event) => {
    if (
      event.source !== globalThis
      || event.origin !== location.origin
      || !event.data
      || typeof event.data !== "object"
      || event.data.source !== REQUEST_SOURCE
      || event.data.type !== "NCH_REQUEST_VIDEO_ID_MAP"
      || event.data.version !== 1
      || !validEpoch(event.data.epoch)
      || !Array.isArray(event.data.ids)
      || event.data.ids.length > MAX_REQUEST_IDS
      || event.data.ids.some((id) => typeof id !== "string" || !identity.isValidId(id))
    ) {
      return;
    }

    const nextPendingIds = new Set(event.data.ids);

    if (event.data.epoch === lastExternalEpoch) {
      if (!sameIds(lastExternalRequestIds, nextPendingIds)) {
        return;
      }
      publishAck(event.data.epoch);
      publishEvidenceForActive();
      if (
        pendingIds.size
        && !scanTimer
        && !retryTimer
        && retryCount < CACHE_SCAN_RETRY_DELAYS.length
      ) {
        scheduleScan();
      }
      return;
    }

    lastExternalEpoch = event.data.epoch;
    lastExternalRequestIds = new Set(nextPendingIds);
    pendingIds = nextPendingIds;
    retryCount = 0;
    if (retryTimer) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
    publishAck(event.data.epoch);
    publishEvidenceForActive();
    scheduleScan();
  });
})();
