(function startNetflixMetadataChannel() {
  "use strict";

  const identity = globalThis.NetflixSubtitleVideoIdentity;
  if (!identity || globalThis.NetflixSubtitleMetadataChannel) {
    return;
  }

  const MESSAGE_SOURCE = "nch-netflix-metadata-bridge";
  const REQUEST_SOURCE = "nch-netflix-card-filter";
  const MAX_CAPTURED_SCRIPTS = 16;
  const MAX_SEED_PAIRS = 2_048;
  const RETRY_DELAYS = [250, 750, 1_500, 3_000];
  const subscribers = new Set();
  const currentMap = new Map();
  const ambiguous = new Set();
  const seedMap = new Map();
  const seedAmbiguous = new Set();
  const observedScriptLengths = new WeakMap();
  let capturedScriptCount = 0;
  let activeIds = new Set();
  let activeEpoch = 0;
  let lastRequestedIds = new Set();
  let pendingRequestIds = [];
  let pendingRequestEpoch = 0;
  let lastPostedEpoch = null;
  let acknowledgedEpoch = null;
  let requestTimer = null;
  let retryTimer = null;
  let retryAttempt = 0;

  function notify() {
    const snapshot = new Map(currentMap);
    subscribers.forEach((subscriber) => {
      try {
        subscriber(new Map(snapshot));
      } catch (_error) {
        // One local consumer must not prevent another consumer from updating.
      }
    });
  }

  function sameIds(left, right) {
    return left.size === right.size && Array.from(left).every((id) => right.has(id));
  }

  function setActiveIds(ids) {
    const next = new Set(Array.from(ids || [])
      .filter((id) => typeof id === "string" && identity.isValidId(id))
      .slice(0, identity.MAX_PAIRS));
    const changed = !sameIds(activeIds, next);
    activeIds = next;

    let mapChanged = false;
    for (const id of currentMap.keys()) {
      if (!activeIds.has(id)) {
        currentMap.delete(id);
        mapChanged = true;
      }
    }
    for (const id of Array.from(ambiguous)) {
      if (!activeIds.has(id)) {
        ambiguous.delete(id);
      }
    }
    return { changed, mapChanged };
  }

  function mergeSeedForActiveIds() {
    let changed = false;
    for (const structuralId of activeIds) {
      if (seedAmbiguous.has(structuralId)) {
        const removed = currentMap.delete(structuralId);
        const newlyAmbiguous = !ambiguous.has(structuralId);
        ambiguous.add(structuralId);
        changed = removed || newlyAmbiguous || changed;
        continue;
      }

      const canonicalId = seedMap.get(structuralId);
      if (!canonicalId || ambiguous.has(structuralId)) {
        continue;
      }
      const existing = currentMap.get(structuralId);
      if (existing && existing !== canonicalId) {
        currentMap.delete(structuralId);
        ambiguous.add(structuralId);
        changed = true;
      } else if (!existing) {
        currentMap.set(structuralId, canonicalId);
        changed = true;
      }
    }
    return changed;
  }

  function addSeedAnalysis(analysis) {
    let seedChanged = false;
    for (const structuralId of analysis.ambiguousIds || []) {
      if (typeof structuralId !== "string" || !identity.isValidId(structuralId)) {
        continue;
      }
      const removed = seedMap.delete(structuralId);
      const newlyAmbiguous = !seedAmbiguous.has(structuralId);
      if (removed || !newlyAmbiguous || seedMap.size + seedAmbiguous.size < MAX_SEED_PAIRS) {
        seedAmbiguous.add(structuralId);
        seedChanged = removed || newlyAmbiguous || seedChanged;
      }
    }
    for (const pair of Array.isArray(analysis.pairs) ? analysis.pairs : []) {
      if (
        !Array.isArray(pair)
        || pair.length !== 2
        || typeof pair[0] !== "string"
        || typeof pair[1] !== "string"
        || !identity.isValidId(pair[0])
        || !identity.isValidId(pair[1])
      ) {
        continue;
      }
      const [structuralId, canonicalId] = pair;
      if (seedAmbiguous.has(structuralId)) {
        continue;
      }
      const existing = seedMap.get(structuralId);
      if (existing && existing !== canonicalId) {
        seedMap.delete(structuralId);
        seedAmbiguous.add(structuralId);
        seedChanged = true;
      } else if (!existing && seedMap.size + seedAmbiguous.size < MAX_SEED_PAIRS) {
        seedMap.set(structuralId, canonicalId);
        seedChanged = true;
      }
    }

    if (seedChanged && mergeSeedForActiveIds()) {
      notify();
    }
  }

  function captureInlineFalcorCache(text) {
    if (
      typeof text !== "string"
      || !text.includes("netflix.falcorCache")
      || capturedScriptCount >= MAX_CAPTURED_SCRIPTS
      || typeof identity.parseInlineFalcorCaches !== "function"
      || typeof identity.analyzeVideoNodes !== "function"
    ) {
      return false;
    }

    for (const payload of identity.parseInlineFalcorCaches(text)) {
      const videos = payload?.videos;
      if (!videos || typeof videos !== "object" || Array.isArray(videos)) {
        continue;
      }

      let analysis;
      try {
        analysis = identity.analyzeVideoNodes(videos, null);
      } catch (_error) {
        continue;
      }
      if (!analysis.complete) {
        continue;
      }
      capturedScriptCount += 1;
      addSeedAnalysis(analysis);
      return true;
    }
    return false;
  }

  function inspectScript(script) {
    if (!script || String(script.tagName || "").toUpperCase() !== "SCRIPT") {
      return;
    }
    const source = typeof script.getAttribute === "function"
      ? script.getAttribute("src")
      : script.src;
    if (source) {
      return;
    }

    const text = String(script.textContent || "");
    if (observedScriptLengths.get(script) === text.length) {
      return;
    }
    observedScriptLengths.set(script, text.length);
    captureInlineFalcorCache(text);
  }

  function inspectNode(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    inspectScript(node);
    if (typeof node.querySelectorAll === "function") {
      for (const script of node.querySelectorAll("script:not([src])")) {
        inspectScript(script);
      }
    }
    const parent = node.parentElement;
    if (parent && String(parent.tagName || "").toUpperCase() === "SCRIPT") {
      inspectScript(parent);
    }
  }

  function installInlineCapture() {
    const documentObject = globalThis.document;
    if (!documentObject) {
      return;
    }

    for (const script of Array.from(documentObject.scripts || [])) {
      inspectScript(script);
    }

    if (typeof globalThis.MutationObserver === "function") {
      const observer = new globalThis.MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes || [])) {
            inspectNode(node);
          }
        }
      });
      observer.observe(documentObject, { childList: true, subtree: true });
    }

    documentObject.addEventListener?.("DOMContentLoaded", () => {
      for (const script of Array.from(documentObject.scripts || [])) {
        inspectScript(script);
      }
    }, { once: true });
  }

  function clearRetryTimer() {
    if (retryTimer) {
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function postRequest(epoch) {
    if (epoch !== activeEpoch || epoch !== pendingRequestEpoch) {
      return;
    }
    lastPostedEpoch = epoch;
    globalThis.postMessage({
      source: REQUEST_SOURCE,
      type: "NCH_REQUEST_VIDEO_ID_MAP",
      version: 1,
      epoch,
      ids: pendingRequestIds
    }, location.origin);
  }

  function scheduleRetry(epoch) {
    if (
      acknowledgedEpoch === epoch
      || epoch !== activeEpoch
      || epoch !== pendingRequestEpoch
      || retryTimer
      || retryAttempt >= RETRY_DELAYS.length
    ) {
      return;
    }
    const delay = RETRY_DELAYS[retryAttempt];
    retryAttempt += 1;
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = null;
      if (acknowledgedEpoch === epoch || epoch !== activeEpoch || epoch !== pendingRequestEpoch) {
        return;
      }
      postRequest(epoch);
      scheduleRetry(epoch);
    }, delay);
  }

  function postPendingRequest() {
    requestTimer = null;
    const epoch = pendingRequestEpoch;
    postRequest(epoch);
    scheduleRetry(epoch);
  }

  function request(ids) {
    const activeResult = setActiveIds(ids);
    const seedChanged = mergeSeedForActiveIds();
    if (activeResult.mapChanged || seedChanged) {
      notify();
    }
    if (!activeResult.changed && sameIds(activeIds, lastRequestedIds)) {
      return;
    }

    activeEpoch += 1;
    pendingRequestIds = Array.from(activeIds);
    pendingRequestEpoch = activeEpoch;
    lastRequestedIds = new Set(activeIds);
    lastPostedEpoch = null;
    acknowledgedEpoch = null;
    retryAttempt = 0;
    clearRetryTimer();
    if (!requestTimer) {
      requestTimer = globalThis.setTimeout(postPendingRequest, 80);
    }
  }

  globalThis.addEventListener("message", (event) => {
    if (
      event.source !== globalThis
      || event.origin !== location.origin
      || !event.data
      || typeof event.data !== "object"
      || event.data.source !== MESSAGE_SOURCE
      || event.data.type !== "NCH_VIDEO_ID_MAP"
      || event.data.version !== 1
      || event.data.ack !== true
      || !Number.isSafeInteger(event.data.epoch)
      || event.data.epoch !== activeEpoch
      || event.data.epoch !== pendingRequestEpoch
      || event.data.epoch !== lastPostedEpoch
      || !Array.isArray(event.data.pairs)
      || event.data.pairs.length > identity.MAX_PAIRS
      || !Array.isArray(event.data.ambiguousIds)
      || event.data.ambiguousIds.length > identity.MAX_PAIRS
      || event.data.ambiguousIds.some((id) => typeof id !== "string" || !identity.isValidId(id))
    ) {
      return;
    }

    acknowledgedEpoch = event.data.epoch;
    clearRetryTimer();

    let changed = false;
    const batch = identity.analyzePairs(event.data.pairs);
    const reportedAmbiguous = new Set([...batch.ambiguousIds, ...event.data.ambiguousIds]);
    for (const structuralId of reportedAmbiguous) {
      if (!activeIds.has(structuralId)) {
        continue;
      }
      const removed = currentMap.delete(structuralId);
      const newlyAmbiguous = !ambiguous.has(structuralId);
      ambiguous.add(structuralId);
      changed = removed || newlyAmbiguous || changed;
    }
    for (const [structuralId, canonicalId] of batch.pairs) {
      if (!activeIds.has(structuralId) || ambiguous.has(structuralId)) {
        continue;
      }
      const existing = currentMap.get(structuralId);
      if (existing && existing !== canonicalId) {
        currentMap.delete(structuralId);
        ambiguous.add(structuralId);
        changed = true;
      } else if (!existing) {
        currentMap.set(structuralId, canonicalId);
        changed = true;
      }
    }
    if (changed) {
      notify();
    }
  });

  installInlineCapture();
  globalThis.NetflixSubtitleMetadataChannel = Object.freeze({
    getMap() {
      return new Map(currentMap);
    },
    subscribe(subscriber) {
      if (typeof subscriber !== "function") {
        return () => {};
      }
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    request
  });
})();
