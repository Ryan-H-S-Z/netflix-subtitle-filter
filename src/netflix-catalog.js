(function exposeNetflixCatalog(root, factory) {
  const config = typeof module === "object" && module.exports
    ? require("./config.js")
    : root.NetflixSubtitleConfig;
  const api = factory(config);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNetflixCatalog(config) {
  "use strict";

  const ENDPOINT_PATH = "/nq/website/memberapi/release/pathEvaluator";
  const CHUNK_SIZE = 200;
  const TITLE_BATCH_SIZE = 200;
  const MAX_CATALOG_ITEMS = 20_000;
  const MAX_CACHE_RECORDS = 8;
  const MAX_CACHE_BYTES = 8 * 1024 * 1024;
  const LANGUAGE_LOAD_TIMEOUT_MS = 12 * 60 * 1000;
  const LEASE_WINNER_WAIT_MS = 60 * 1000;
  const CACHE_RECORD_PREFIX = `${config.CATALOG_CACHE_KEY}:record:`;

  function decodeEmbeddedString(value) {
    return String(value || "")
      .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\([\\/"'])/g, "$1");
  }

  function hashScope(value) {
    let hash = 2166136261;
    for (const character of String(value || "")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function extractMemberContext(documentObject = document) {
    for (const script of Array.from(documentObject.scripts || [])) {
      if (script.src || !script.textContent?.includes('"authURL"')) {
        continue;
      }

      const text = script.textContent;
      const authMatch = text.match(/"authURL":"((?:\\.|[^"\\])*)"/);
      if (!authMatch) {
        continue;
      }

      const countryMatch = text.match(/"currentCountry":"([A-Z]{2})"/);
      const userMatch = text.match(/"user":"user:(?:\\x20|\s)*((?:\\.|[^"\\])+)"/);
      if (!countryMatch || !userMatch) {
        throw new Error("无法确认 Netflix 当前地区或资料，已暂停字幕筛选");
      }

      const country = countryMatch[1];
      const userKey = decodeEmbeddedString(userMatch[1]);
      if (!userKey) {
        throw new Error("无法确认 Netflix 当前资料，已暂停字幕筛选");
      }
      const locale = String(documentObject.documentElement?.lang || "").trim().toLowerCase();
      if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale)) {
        throw new Error("无法确认 Netflix 当前界面语言，已暂停字幕筛选");
      }

      return {
        authUrl: decodeEmbeddedString(authMatch[1]),
        country,
        locale,
        scope: `${country}-${hashScope(userKey)}-${hashScope(locale)}`
      };
    }

    throw new Error("无法读取 Netflix 当前资料信息，请刷新 Netflix 页面后再试");
  }

  function buildEndpoint(origin = location.origin) {
    const url = new URL(ENDPOINT_PATH, origin);
    url.search = new URLSearchParams({
      webp: "true",
      drmSystem: "widevine",
      isVolatileBillboardsEnabled: "true",
      isTop10Supported: "true",
      hasVideoMerchInBob: "false",
      hasVideoMerchInJaw: "true",
      falcor_server: "0.1.0",
      withSize: "true",
      materialize: "true",
      original_path: "/shakti/mre/pathEvaluator"
    }).toString();
    return url.href;
  }

  function buildCatalogPath(genreId, from, to) {
    return [
      "genres",
      Number(genreId),
      "su",
      { from, to },
      "reference"
    ];
  }

  function buildTitlePath(ids) {
    const numericIds = Array.from(new Set(ids || []))
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id) && id >= 1000);
    if (!numericIds.length || numericIds.length > TITLE_BATCH_SIZE) {
      throw new Error("影片名称请求包含无效编号");
    }
    return ["videos", numericIds, "title"];
  }

  function extractVideoIds(payload, genreId) {
    const su = payload?.jsonGraph?.genres?.[String(genreId)]?.su || {};
    const ids = [];
    let referenceCount = 0;
    let slotCount = 0;
    let hasError = false;
    let terminalStarted = false;

    for (const key of Object.keys(su).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b))) {
      const node = su[key];
      slotCount += 1;
      if (node?.$type === "error" || node?.reference?.$type === "error") {
        hasError = true;
        continue;
      }

      const referenceNode = node?.reference && typeof node.reference === "object"
        ? node.reference
        : (node?.$type === "ref" ? node : null);

      if (referenceNode?.$type === "atom") {
        const isMaterializedTerminal = node?.reference === referenceNode
          && Object.keys(referenceNode).length === 1
          && !Object.prototype.hasOwnProperty.call(referenceNode, "value");
        if (!isMaterializedTerminal) {
          hasError = true;
        }
        terminalStarted = true;
        continue;
      }

      if (referenceNode?.$type !== "ref" || terminalStarted) {
        hasError = true;
        continue;
      }

      const reference = referenceNode.value;
      if (!Array.isArray(reference) || reference.length !== 2 || reference[0] !== "videos") {
        hasError = true;
        continue;
      }
      referenceCount += 1;
      const id = String(reference[1] || "");
      if (/^\d{4,20}$/.test(id)) {
        ids.push(id);
      } else {
        hasError = true;
      }
    }

    return { ids, referenceCount, slotCount, hasError };
  }

  function parseCatalogRange(payload, genreId, from, to) {
    const genreNode = payload?.jsonGraph?.genres?.[String(genreId)];
    const responseErrors = payload?.errors;
    const hasResponseErrors = responseErrors != null
      && (!Array.isArray(responseErrors) || responseErrors.length > 0);
    if (
      !Array.isArray(payload?.paths)
      || payload.paths.length === 0
      || hasResponseErrors
      || !genreNode
      || genreNode.$type === "error"
      || !genreNode.su
      || typeof genreNode.su !== "object"
    ) {
      throw new Error("Netflix 字幕目录返回了无法识别的数据");
    }

    const result = extractVideoIds(payload, genreId);
    const expectedSlots = to - from + 1;
    const numericKeys = Object.keys(genreNode.su)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((a, b) => a - b);
    const hasExactRange = numericKeys.length === expectedSlots
      && numericKeys.every((key, index) => key === from + index);
    if (result.hasError || result.slotCount !== expectedSlots || !hasExactRange) {
      throw new Error("Netflix 字幕目录数据不完整");
    }
    if (from === 0 && result.referenceCount === 0) {
      throw new Error("Netflix 字幕目录返回空结果，已保留所有影片");
    }
    return result;
  }

  function parseTitleBatch(payload, requestedIds) {
    const responseErrors = payload?.errors;
    const hasResponseErrors = responseErrors != null
      && (!Array.isArray(responseErrors) || responseErrors.length > 0);
    const videoNodes = payload?.jsonGraph?.videos;
    if (
      !Array.isArray(payload?.paths)
      || payload.paths.length === 0
      || hasResponseErrors
      || !videoNodes
      || typeof videoNodes !== "object"
    ) {
      throw new Error("Netflix 影片名称目录返回了无法识别的数据");
    }

    const titles = [];
    for (const rawId of requestedIds) {
      const id = String(rawId || "");
      const titleNode = videoNodes[id]?.title;
      const title = titleNode?.$type === "atom" && typeof titleNode.value === "string"
        ? config.normalizeTitle(titleNode.value)
        : "";
      if (!title) {
        throw new Error("Netflix 影片名称目录数据不完整");
      }
      titles.push(title);
    }

    return titles;
  }

  async function fetchCatalogRange(context, language, from, to, signal) {
    const body = new URLSearchParams({
      path: JSON.stringify(buildCatalogPath(language.genreId, from, to)),
      authURL: context.authUrl
    });
    const response = await fetch(buildEndpoint(), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body,
      signal
    });

    if (!response.ok) {
      throw new Error(`Netflix 字幕目录请求失败（${response.status}）`);
    }

    const payload = await response.json();
    return parseCatalogRange(payload, language.genreId, from, to);
  }

  async function fetchTitleBatch(context, ids, signal) {
    const requestedIds = Array.from(new Set(ids || [])).map(String);
    const body = new URLSearchParams({
      path: JSON.stringify(buildTitlePath(requestedIds)),
      authURL: context.authUrl
    });
    const response = await fetch(buildEndpoint(), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body,
      signal
    });

    if (!response.ok) {
      throw new Error(`Netflix 影片名称目录请求失败（${response.status}）`);
    }

    return parseTitleBatch(await response.json(), requestedIds);
  }

  async function fetchTitleIndex(ids, context, options = {}) {
    const allIds = Array.from(ids || []);
    const titles = new Set();
    for (let from = 0; from < allIds.length; from += TITLE_BATCH_SIZE) {
      const batch = allIds.slice(from, from + TITLE_BATCH_SIZE);
      const batchTitles = await fetchTitleBatch(context, batch, options.signal);
      batchTitles.forEach((title) => titles.add(title));
      await new Promise((resolve) => window.setTimeout(resolve, 15));
    }
    return { titles, sourceCount: allIds.length };
  }

  async function fetchLanguageIndex(code, context, options = {}) {
    const language = config.LANGUAGES[code];
    if (!language?.genreId) {
      throw new Error(`不支持的字幕语言：${code}`);
    }

    const ids = new Set();
    let complete = false;

    for (let from = 0; from < MAX_CATALOG_ITEMS; from += CHUNK_SIZE) {
      const to = Math.min(MAX_CATALOG_ITEMS - 1, from + CHUNK_SIZE - 1);
      const result = await fetchCatalogRange(context, language, from, to, options.signal);
      result.ids.forEach((id) => ids.add(id));
      options.onProgress?.({ code, loaded: ids.size, from, to });

      if (result.referenceCount < to - from + 1) {
        complete = true;
        break;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 15));
    }

    let titles = new Set();
    let titlesComplete = false;
    let titleSourceCount = 0;
    if (complete && ids.size) {
      for (let attempt = 0; attempt < 2 && !titlesComplete; attempt += 1) {
        try {
          const titleIndex = await fetchTitleIndex(ids, context, options);
          titles = titleIndex.titles;
          titleSourceCount = titleIndex.sourceCount;
          titlesComplete = true;
        } catch (error) {
          if (options.signal?.aborted || error?.name === "AbortError") {
            throw error;
          }
          if (attempt === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          // Numeric IDs remain authoritative. Name matching fails open after
          // two bounded attempts and can be retried with the manual refresh.
        }
      }
    }

    return { code, ids, complete, titles, titlesComplete, titleSourceCount };
  }

  function validCacheRecord(
    record,
    code,
    scope,
    now = Date.now(),
    generation = record?.generation
  ) {
    const builtAt = Number(record?.builtAt);
    return Boolean(
      record
      && record.version === 4
      && record.generation === generation
      && record.code === code
      && record.scope === scope
      && record.genreId === config.LANGUAGES[code]?.genreId
      && record.complete === true
      && Array.isArray(record.ids)
      && record.ids.length <= MAX_CATALOG_ITEMS
      && record.ids.every((id) => typeof id === "string" && /^\d{4,20}$/.test(id))
      && new Set(record.ids).size === record.ids.length
      && typeof record.titlesComplete === "boolean"
      && Number.isInteger(record.titleSourceCount)
      && record.titleSourceCount >= 0
      && Array.isArray(record.titles)
      && record.titles.length <= MAX_CATALOG_ITEMS
      && (record.titlesComplete !== true || record.titles.length > 0)
      && (
        record.titlesComplete !== true
        || record.titleSourceCount === record.ids.length
      )
      && record.titles.every((title) => (
        typeof title === "string"
        && title === config.normalizeTitle(title)
        && Boolean(title)
      ))
      && new Set(record.titles).size === record.titles.length
      && Number.isFinite(builtAt)
      && builtAt <= now + 5 * 60 * 1000
    );
  }

  function pruneCache(records) {
    return Object.fromEntries(
      Object.entries(records || {})
        .filter(([, record]) => record && Array.isArray(record.ids))
        .sort(([, a], [, b]) => Number(b.builtAt) - Number(a.builtAt))
        .slice(0, MAX_CACHE_RECORDS)
    );
  }

  function cacheRecordStorageKey(scope, code, generation = 0) {
    return `${CACHE_RECORD_PREFIX}g${generation}:${scope}:${code}`;
  }

  function cacheNeedsAutoRefresh(record, autoRefreshAt) {
    const refreshAt = Number(autoRefreshAt);
    const builtAt = Number(record?.builtAt);
    return Number.isFinite(refreshAt)
      && refreshAt > 0
      && Number.isFinite(builtAt)
      && builtAt < refreshAt;
  }

  function preserveStalePositiveTitles(result, staleRecord) {
    if (
      !result?.complete
      || result.titlesComplete === true
      || staleRecord?.titlesComplete !== true
      || !Array.isArray(staleRecord.titles)
      || staleRecord.titles.length === 0
    ) {
      return result;
    }

    return {
      ...result,
      titles: new Set(staleRecord.titles),
      titlesComplete: false,
      titleSourceCount: Number(staleRecord.titleSourceCount || 0),
      staleTitles: true
    };
  }

  function cacheRecordToIndex(record, cached = true) {
    return {
      ids: new Set(record.ids),
      titles: new Set(record.titles),
      complete: true,
      titlesComplete: record.titlesComplete,
      titleSourceCount: record.titleSourceCount,
      builtAt: record.builtAt,
      cached
    };
  }

  async function readCacheMeta() {
    const response = await chrome.runtime.sendMessage({
      type: "NCH_GET_CATALOG_CACHE_META"
    });
    const value = response?.meta;
    if (
      !response?.ok
      || value?.version !== 2
      || !Number.isInteger(value.generation)
      || value.generation < 0
    ) {
      throw new Error("无法读取字幕目录缓存状态");
    }
    return value;
  }

  async function writeCacheRecord(storageKey, record, generation, leaseToken, signal) {
    if (signal?.aborted) {
      return { ok: false };
    }
    const response = await chrome.runtime.sendMessage({
      type: "NCH_WRITE_CATALOG_CACHE_RECORD",
      storageKey,
      record,
      generation,
      leaseToken
    });
    return response || { ok: false };
  }

  function abortError() {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }

  function abortableDelay(milliseconds, signal) {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function leaseMessage(type, item, generation, token) {
    return {
      type,
      storageKey: item.storageKey,
      scope: item.scope,
      code: item.code,
      generation,
      ...(token ? { token } : {})
    };
  }

  async function releaseFetchLease(item, generation, token) {
    if (!token) {
      return;
    }
    try {
      await chrome.runtime.sendMessage(leaseMessage(
        "NCH_RELEASE_CATALOG_FETCH_LEASE",
        item,
        generation,
        token
      ));
    } catch (_error) {
      // The lease expires automatically if the owning tab disappears.
    }
  }

  function startLeaseHeartbeat(item, generation, token) {
    let lost = false;
    let renewalInFlight = false;
    const timer = globalThis.setInterval(async () => {
      if (renewalInFlight || lost) {
        return;
      }
      renewalInFlight = true;
      try {
        const response = await chrome.runtime.sendMessage(leaseMessage(
          "NCH_RENEW_CATALOG_FETCH_LEASE",
          item,
          generation,
          token
        ));
        if (response?.ok && response.renewed !== true) {
          lost = true;
        }
      } catch (_error) {
        // A transient worker wake-up failure does not itself prove lease loss;
        // the token is validated again atomically when the record is written.
      } finally {
        renewalInFlight = false;
      }
    }, 60 * 1000);
    return {
      hasLost: () => lost,
      stop: () => globalThis.clearInterval(timer)
    };
  }

  function createBoundedSignal(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort();
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    }
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      cleanup: () => {
        globalThis.clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    };
  }

  async function waitForFreshRecord(item, generation, refreshAt, signal, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (!signal?.aborted && Date.now() < deadline) {
      const record = await readFreshRecord(item, generation, refreshAt);
      if (record) {
        return record;
      }
      await abortableDelay(Math.min(1000, Math.max(100, deadline - Date.now())), signal);
    }
    return null;
  }

  function positiveOnlyIndex(result, message) {
    return {
      ...result,
      complete: false,
      titlesComplete: false,
      cached: false,
      stale: true,
      error: message
    };
  }

  async function readFreshRecord(item, generation, refreshAt) {
    const stored = await chrome.storage.local.get(item.storageKey);
    const record = stored[item.storageKey];
    if (
      validCacheRecord(record, item.code, item.scope, Date.now(), generation)
      && !cacheNeedsAutoRefresh(record, refreshAt)
    ) {
      return record;
    }
    return null;
  }

  async function acquireFetchLeaseOrRecord(item, generation, refreshAt, signal) {
    for (;;) {
      if (signal?.aborted) {
        throw abortError();
      }
      const response = await chrome.runtime.sendMessage(leaseMessage(
        "NCH_ACQUIRE_CATALOG_FETCH_LEASE",
        item,
        generation
      ));
      if (!response?.ok) {
        throw new Error("字幕目录缓存正在刷新，已暂时保留所有影片");
      }

      if (response.acquired === true && typeof response.token === "string") {
        // A previous owner may have committed and released between our last
        // storage read and this acquire. Re-check before doing duplicate work.
        const record = await readFreshRecord(item, generation, refreshAt);
        if (record) {
          await releaseFetchLease(item, generation, response.token);
          return { record };
        }
        return { token: response.token };
      }

      const record = await readFreshRecord(item, generation, refreshAt);
      if (record) {
        return { record };
      }

      const expiresAt = Number(response.expiresAt);
      const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 1000;
      await abortableDelay(Math.max(150, Math.min(1000, remaining + 25)), signal);
    }
  }

  async function loadIndexes(codes, options = {}) {
    const cacheRetryCount = Number(options.cacheRetryCount || 0);
    const selectedCodes = Array.from(new Set(codes))
      .filter((code) => config.LANGUAGES[code]?.genreId);
    const context = extractMemberContext(options.documentObject || document);
    const cacheMeta = await readCacheMeta();
    const generation = cacheMeta.generation;
    const [refreshState, scheduleState] = await Promise.all([
      chrome.storage.local.get(config.CATALOG_AUTO_REFRESH_TICK_KEY),
      chrome.storage.sync.get({
        [config.WEEKLY_CACHE_REFRESH_KEY]: config.DEFAULT_WEEKLY_CACHE_REFRESH
      })
    ]);
    const autoRefreshAt = Number(refreshState[config.CATALOG_AUTO_REFRESH_TICK_KEY]);
    const validAutoRefreshAt = scheduleState[config.WEEKLY_CACHE_REFRESH_KEY] === true
      && Number.isFinite(autoRefreshAt)
      && autoRefreshAt > 0
      ? autoRefreshAt
      : 0;
    const storageKeys = Object.fromEntries(selectedCodes.map((code) => [
      code,
      cacheRecordStorageKey(context.scope, code, generation)
    ]));
    const storedRecords = await chrome.storage.local.get(Object.values(storageKeys));
    const confirmedMeta = await readCacheMeta();
    if (confirmedMeta.generation !== generation) {
      if (options.signal?.aborted) {
        return {};
      }
      if (cacheRetryCount >= 2) {
        throw new Error("字幕目录缓存正在刷新，已暂时保留所有影片");
      }
      return loadIndexes(codes, { ...options, cacheRetryCount: cacheRetryCount + 1 });
    }
    const indexes = {};
    const pending = [];

    for (const code of selectedCodes) {
      const storageKey = storageKeys[code];
      const record = storedRecords[storageKey];
      const recordIsValid = validCacheRecord(
        record,
        code,
        context.scope,
        Date.now(),
        generation
      );
      const refreshDue = recordIsValid
        && cacheNeedsAutoRefresh(record, validAutoRefreshAt);
      if (!options.force && recordIsValid && !refreshDue) {
        indexes[code] = cacheRecordToIndex(record, true);
        options.onLanguageReady?.({ code, cached: true, count: record.ids.length });
      } else {
        pending.push({
          code,
          storageKey,
          scope: context.scope,
          staleRecord: recordIsValid ? record : null
        });
      }
    }

    let queueIndex = 0;
    const worker = async () => {
      while (queueIndex < pending.length) {
        const item = pending[queueIndex];
        queueIndex += 1;
        let leaseToken = "";
        let leaseHeartbeat = {
          hasLost: () => false,
          stop: () => undefined
        };
        const bounded = createBoundedSignal(options.signal, LANGUAGE_LOAD_TIMEOUT_MS);

        try {
          const coordination = await acquireFetchLeaseOrRecord(
            item,
            generation,
            validAutoRefreshAt,
            bounded.signal
          );
          if (coordination.record) {
            const cachedIndex = cacheRecordToIndex(coordination.record, true);
            indexes[item.code] = cachedIndex;
            options.onLanguageReady?.({
              code: item.code,
              cached: true,
              count: cachedIndex.ids.size,
              complete: true
            });
            continue;
          }

          leaseToken = coordination.token;
          leaseHeartbeat = startLeaseHeartbeat(item, generation, leaseToken);
          const refreshStartedAt = Date.now();
          const fetchedResult = await fetchLanguageIndex(item.code, context, {
            ...options,
            signal: bounded.signal
          });
          if (options.signal?.aborted) {
            return;
          }
          if (bounded.signal.aborted) {
            throw abortError();
          }
          const result = preserveStalePositiveTitles(fetchedResult, item.staleRecord);
          let effectiveIndex = result;
          if (result.complete) {
            const ids = Array.from(result.ids);
            const titles = Array.from(result.titles || []);
            const record = {
              version: 4,
              generation,
              code: item.code,
              scope: context.scope,
              genreId: config.LANGUAGES[item.code].genreId,
              ids,
              titles,
              complete: true,
              titlesComplete: result.titlesComplete === true,
              titleSourceCount: Number(result.titleSourceCount || 0),
              builtAt: refreshStartedAt
            };
            try {
              const writeResult = await writeCacheRecord(
                item.storageKey,
                record,
                generation,
                leaseToken,
                bounded.signal
              );
              if (bounded.signal.aborted) {
                throw abortError();
              }
              if (writeResult?.leaseLost || leaseHeartbeat.hasLost()) {
                const winner = await waitForFreshRecord(
                  item,
                  generation,
                  validAutoRefreshAt,
                  bounded.signal,
                  LEASE_WINNER_WAIT_MS
                );
                effectiveIndex = winner
                  ? cacheRecordToIndex(winner, true)
                  : positiveOnlyIndex(result, "字幕目录由另一个页面更新，等待下次同步");
              } else if (!writeResult?.ok) {
                effectiveIndex = positiveOnlyIndex(
                  result,
                  "字幕目录缓存状态已变化，已仅保留确认匹配的影片"
                );
              } else if (
                writeResult?.record
                && validCacheRecord(
                  writeResult.record,
                  item.code,
                  context.scope,
                  Date.now(),
                  generation
                )
              ) {
                effectiveIndex = cacheRecordToIndex(
                  writeResult.record,
                  writeResult.written !== true
                );
              }
            } catch (_error) {
              effectiveIndex = positiveOnlyIndex(
                result,
                "字幕目录缓存提交失败，已仅保留确认匹配的影片"
              );
            }
          }
          indexes[item.code] = effectiveIndex;
          options.onLanguageReady?.({
            code: item.code,
            cached: effectiveIndex.cached === true,
            count: effectiveIndex.ids.size,
            complete: effectiveIndex.complete
          });
        } catch (error) {
          if (
            options.signal?.aborted
            || (error?.name === "AbortError" && !bounded.timedOut())
          ) {
            return;
          }
          if (item.staleRecord) {
            indexes[item.code] = {
              ids: new Set(item.staleRecord.ids),
              titles: new Set(item.staleRecord.titles),
              complete: false,
              titlesComplete: false,
              builtAt: item.staleRecord.builtAt,
              cached: true,
              stale: true,
              error: error?.message || "字幕目录读取失败"
            };
          } else {
            indexes[item.code] = {
              ids: new Set(),
              titles: new Set(),
              complete: false,
              titlesComplete: false,
              error: error?.message || "字幕目录读取失败"
            };
          }
          options.onLanguageError?.({ code: item.code, error });
        } finally {
          leaseHeartbeat.stop();
          bounded.cleanup();
          await releaseFetchLease(item, generation, leaseToken);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
    const finalMeta = await readCacheMeta();
    if (finalMeta.generation !== generation) {
      if (options.signal?.aborted) {
        return {};
      }
      if (cacheRetryCount >= 2) {
        throw new Error("字幕目录缓存正在刷新，已暂时保留所有影片");
      }
      return loadIndexes(codes, { ...options, cacheRetryCount: cacheRetryCount + 1 });
    }
    return indexes;
  }

  async function clearCache() {
    const response = await chrome.runtime.sendMessage({
      type: "NCH_CLEAR_CATALOG_CACHE"
    });
    if (!response?.ok || !Number.isInteger(response.generation)) {
      throw new Error("无法清除字幕目录缓存");
    }
    return response.generation;
  }

  return Object.freeze({
    ENDPOINT_PATH,
    CHUNK_SIZE,
    TITLE_BATCH_SIZE,
    MAX_CATALOG_ITEMS,
    MAX_CACHE_RECORDS,
    MAX_CACHE_BYTES,
    CACHE_RECORD_PREFIX,
    decodeEmbeddedString,
    hashScope,
    extractMemberContext,
    buildEndpoint,
    buildCatalogPath,
    buildTitlePath,
    extractVideoIds,
    parseCatalogRange,
    parseTitleBatch,
    validCacheRecord,
    pruneCache,
    cacheRecordStorageKey,
    cacheNeedsAutoRefresh,
    preserveStalePositiveTitles,
    cacheRecordToIndex,
    fetchLanguageIndex,
    loadIndexes,
    clearCache
  });
});
