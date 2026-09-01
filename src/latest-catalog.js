(function exposeNetflixLatestCatalog(root, factory) {
  const videoIdentity = typeof module === "object" && module.exports
    ? require("./video-identity.js")
    : root.NetflixSubtitleVideoIdentity;
  const catalog = typeof module === "object" && module.exports
    ? require("./netflix-catalog.js")
    : root.NetflixSubtitleCatalog;
  const api = factory(videoIdentity, catalog);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleLatestCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNetflixLatestCatalog(
  videoIdentity,
  catalog
) {
  "use strict";

  const LATEST_CONTEXT = "windowedNewReleases";
  const SNAPSHOT_VERSION = 1;
  const MAX_LATEST_ITEMS = 200;
  const LIST_FIELDS = Object.freeze([
    "availability",
    "episodeCount",
    "inRemindMeList",
    "itemSummary",
    "queue",
    "summary"
  ]);

  function own(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function validId(value) {
    return /^\d{4,20}$/.test(String(value || ""));
  }

  function validListId(value) {
    return typeof value === "string"
      && value.length > 0
      && value.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(value)
      && value !== "__proto__"
      && value !== "constructor"
      && value !== "prototype";
  }

  function validScope(value) {
    return typeof value === "string"
      && value.length > 0
      && value.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(value);
  }

  function validGeneration(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validLength(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LATEST_ITEMS;
  }

  function validHash(value) {
    return typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
  }

  function normalizedVerifiedLanguages(values) {
    if (values == null) {
      return null;
    }
    if (
      !Array.isArray(values)
      || values.length > 64
      || values.some((value) => (
        typeof value !== "string"
        || value.length === 0
        || value.length > 64
        || /[\u0000-\u001f\u007f]/.test(value)
      ))
      || new Set(values).size !== values.length
    ) {
      return false;
    }
    return Array.from(values).sort();
  }

  function trackingContextElement(row) {
    if (typeof row?.getAttribute === "function" && row.getAttribute("data-ui-tracking-context") != null) {
      return row;
    }
    return typeof row?.querySelector === "function"
      ? row.querySelector("[data-ui-tracking-context]")
      : null;
  }

  function parseTrackingListId(row) {
    const element = trackingContextElement(row);
    const raw = element?.getAttribute?.("data-ui-tracking-context");
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 16 * 1024) {
      throw new Error("Netflix latest row is missing its tracking context");
    }

    let decoded = raw;
    if (!/^\s*\{/.test(raw)) {
      try {
        decoded = decodeURIComponent(raw);
      } catch (_error) {
        throw new Error("Netflix latest row has an invalid tracking context");
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (_error) {
      throw new Error("Netflix latest row has an invalid tracking context");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !validListId(parsed.list_id)) {
      throw new Error("Netflix latest row is missing a valid list_id");
    }
    return parsed.list_id;
  }

  function graphFromCache(cache) {
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      return null;
    }
    return cache.jsonGraph && typeof cache.jsonGraph === "object" && !Array.isArray(cache.jsonGraph)
      ? cache.jsonGraph
      : cache;
  }

  function verifiedLengthFromCache(cache, listId) {
    const graph = graphFromCache(cache);
    const lists = graph?.lists;
    if (!lists || typeof lists !== "object" || Array.isArray(lists) || !own(lists, listId)) {
      return null;
    }

    const list = lists[listId];
    const componentSummary = list?.componentSummary;
    if (
      componentSummary?.$type !== "atom"
      || !componentSummary.value
      || typeof componentSummary.value !== "object"
      || componentSummary.value.context !== LATEST_CONTEXT
    ) {
      return null;
    }

    const length = componentSummary.value.length;
    if (!validLength(length)) {
      throw new Error("Netflix latest list has an invalid or unsafe length");
    }
    return length;
  }

  function discoverLatestListId(documentObject = document) {
    const row = documentObject?.querySelector?.(`[data-list-context="${LATEST_CONTEXT}"]`);
    if (!row) {
      const error = new Error("Netflix latest row was not found");
      error.code = "NCH_LATEST_ROW_NOT_READY";
      throw error;
    }
    return parseTrackingListId(row);
  }

  function isPageNotReadyError(error) {
    return error?.code === "NCH_LATEST_ROW_NOT_READY";
  }

  function discoverInlineLatestList(documentObject, listId) {
    const lengths = new Set();

    for (const script of Array.from(documentObject.scripts || [])) {
      if (script?.src || typeof script?.textContent !== "string") {
        continue;
      }
      for (const cache of videoIdentity.parseInlineFalcorCaches(script.textContent)) {
        const length = verifiedLengthFromCache(cache, listId);
        if (length != null) {
          lengths.add(length);
        }
      }
    }

    if (lengths.size !== 1) {
      if (lengths.size === 0) {
        return null;
      }
      throw new Error("Netflix latest list metadata is inconsistent");
    }
    return Object.freeze({ listId, length: Array.from(lengths)[0] });
  }

  function discoverLatestList(documentObject = document) {
    const listId = discoverLatestListId(documentObject);
    const descriptor = discoverInlineLatestList(documentObject, listId);
    if (!descriptor) {
      throw new Error("Netflix latest list could not be verified from page metadata");
    }
    return descriptor;
  }

  function buildComponentSummaryPath(listId) {
    if (!validListId(listId)) {
      throw new Error("Netflix latest component-summary request is invalid");
    }
    return ["lists", listId, "componentSummary"];
  }

  function parseComponentSummaryPayload(payload, listId) {
    if (!validListId(listId)) {
      throw new Error("Netflix latest component-summary response parameters are invalid");
    }
    const lists = payload?.jsonGraph?.lists;
    const listKeys = lists && typeof lists === "object" && !Array.isArray(lists)
      ? Object.keys(lists).filter((key) => !key.startsWith("$"))
      : [];
    const paths = payload?.paths;
    const pathIsExact = Array.isArray(paths)
      && paths.length === 1
      && Array.isArray(paths[0])
      && paths[0].length === 3
      && paths[0][0] === "lists"
      && paths[0][1] === listId
      && paths[0][2] === "componentSummary";
    if (
      !pathIsExact
      || responseHasErrors(payload)
      || listKeys.length !== 1
      || listKeys[0] !== listId
    ) {
      throw new Error("Netflix latest component summary returned unrecognized data");
    }
    const componentSummary = lists[listId]?.componentSummary;
    const value = componentSummary?.$type === "atom" ? componentSummary.value : null;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.context !== LATEST_CONTEXT
      || !validLength(value.length)
    ) {
      throw new Error("Netflix latest component summary is invalid");
    }
    return Object.freeze({ listId, length: value.length });
  }

  function buildListPath(listId, length) {
    if (!validListId(listId) || !validLength(length)) {
      throw new Error("Netflix latest list request is invalid");
    }
    return [
      "lists",
      listId,
      { from: 0, to: length - 1 },
      Array.from(LIST_FIELDS)
    ];
  }

  function responseHasErrors(payload) {
    const errors = payload?.errors;
    return errors != null && (!Array.isArray(errors) || errors.length > 0);
  }

  function parseListPayload(payload, listId, length) {
    if (!validListId(listId) || !validLength(length)) {
      throw new Error("Netflix latest list response parameters are invalid");
    }
    const list = payload?.jsonGraph?.lists?.[listId];
    if (
      !Array.isArray(payload?.paths)
      || payload.paths.length === 0
      || responseHasErrors(payload)
      || !list
      || typeof list !== "object"
      || Array.isArray(list)
    ) {
      throw new Error("Netflix latest list returned unrecognized data");
    }

    const numericKeys = Object.keys(list)
      .filter((key) => /^\d+$/.test(key))
      .map(Number)
      .sort((a, b) => a - b);
    if (
      numericKeys.length !== length
      || !numericKeys.every((key, index) => key === index)
    ) {
      throw new Error("Netflix latest list data is incomplete");
    }

    const ids = [];
    const uniqueIds = new Set();
    for (let index = 0; index < length; index += 1) {
      const slot = list[String(index)];
      if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
        throw new Error("Netflix latest list contains invalid or duplicate video references");
      }

      let id = null;
      for (const field of LIST_FIELDS) {
        if (!own(slot, field)) {
          throw new Error("Netflix latest list data is incomplete");
        }
        const reference = slot[field];
        if (field === "itemSummary" && reference?.$type === "atom") {
          continue;
        }
        const value = reference?.$type === "ref" ? reference.value : null;
        const referencedId = String(value?.[1] || "");
        if (
          !Array.isArray(value)
          || value.length !== 3
          || value[0] !== "videos"
          || value[2] !== field
          || !validId(referencedId)
          || (id !== null && id !== referencedId)
        ) {
          throw new Error("Netflix latest list contains invalid or inconsistent video references");
        }
        id = referencedId;
      }
      if (id === null || uniqueIds.has(id)) {
        throw new Error("Netflix latest list contains invalid or duplicate video references");
      }
      uniqueIds.add(id);
      ids.push(id);
    }
    return ids;
  }

  function sortedIds(values) {
    return Array.from(values || [], (value) => String(value)).sort();
  }

  function semanticHash(ids) {
    const normalized = sortedIds(new Set(Array.from(ids || [], (id) => String(id))));
    let hash = 2166136261;
    const text = `latest-v${SNAPSHOT_VERSION}\u0000${normalized.join("\u0000")}\u0000`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function sameSnapshotSet(left, right) {
    return Boolean(
      left
      && right
      && left.scope === right.scope
      && left.generation === right.generation
      && left.hash === right.hash
      && Array.isArray(left.ids)
      && Array.isArray(right.ids)
      && left.ids.length === right.ids.length
      && left.ids.every((id, index) => id === right.ids[index])
    );
  }

  function validTransitionEvidence(value, next = null) {
    if (typeof value !== "string" || value.length === 0 || value.length > 9_000) {
      return false;
    }
    const match = value.match(
      /^(none|[0-9a-f]{8}):(0|[1-9]\d{0,15}):(\d{4,20}(?:,\d{4,20}){0,199})?>([0-9a-f]{8}):(\d{4,20}(?:,\d{4,20}){0,199})$/
    );
    if (!match) {
      return false;
    }
    const previousIds = match[3] ? match[3].split(",") : [];
    const previousIsValid = match[1] === "none"
      ? match[2] === "0" && previousIds.length === 0
      : match[2] !== "0"
        && previousIds.length > 0
        && previousIds.every((id, index) => index === 0 || previousIds[index - 1] < id)
        && semanticHash(previousIds) === match[1];
    const ids = match[5].split(",");
    if (
      !previousIsValid
      || ids.some((id, index) => index > 0 && ids[index - 1] >= id)
      || semanticHash(ids) !== match[4]
    ) {
      return false;
    }
    return next == null || Boolean(
      next.hash === match[4]
      && Array.isArray(next.ids)
      && next.ids.length === ids.length
      && next.ids.every((id, index) => id === ids[index])
    );
  }

  function createSnapshot(ids, options = {}) {
    const sourceIds = Array.from(ids || [], (id) => String(id));
    if (
      !validLength(sourceIds.length)
      || sourceIds.some((id) => !validId(id))
      || new Set(sourceIds).size !== sourceIds.length
      || !validScope(options.scope)
      || !validListId(options.listId)
      || !validGeneration(options.generation ?? 0)
    ) {
      throw new Error("Cannot create an invalid Netflix latest snapshot");
    }
    const capturedAt = options.capturedAt ?? Date.now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) {
      throw new Error("Netflix latest snapshot has an invalid capture time");
    }

    const normalizedIds = sortedIds(sourceIds);
    const verifiedLanguages = normalizedVerifiedLanguages(options.verifiedLanguages);
    if (verifiedLanguages === false) {
      throw new Error("Netflix latest snapshot has invalid verified languages");
    }
    if (
      options.epochEvidence != null
      && !validTransitionEvidence(options.epochEvidence, {
        hash: semanticHash(normalizedIds),
        ids: normalizedIds
      })
    ) {
      throw new Error("Netflix latest snapshot has invalid transition evidence");
    }
    return Object.freeze({
      version: SNAPSHOT_VERSION,
      source: LATEST_CONTEXT,
      generation: options.generation ?? 0,
      scope: options.scope,
      listId: options.listId,
      length: normalizedIds.length,
      ids: Object.freeze(normalizedIds),
      hash: semanticHash(normalizedIds),
      capturedAt,
      complete: true,
      ...(verifiedLanguages == null ? {} : {
        verifiedLanguages: Object.freeze(verifiedLanguages)
      }),
      ...(options.epochEvidence == null ? {} : {
        epochEvidence: options.epochEvidence
      })
    });
  }

  function validSnapshot(snapshot, scope, generation) {
    if (
      !snapshot
      || snapshot.version !== SNAPSHOT_VERSION
      || snapshot.source !== LATEST_CONTEXT
      || snapshot.complete !== true
      || !validScope(scope)
      || snapshot.scope !== scope
      || !validGeneration(generation)
      || snapshot.generation !== generation
      || !validListId(snapshot.listId)
      || !validLength(snapshot.length)
      || !Array.isArray(snapshot.ids)
      || snapshot.ids.length !== snapshot.length
      || !Number.isSafeInteger(snapshot.capturedAt)
      || snapshot.capturedAt <= 0
      || !validHash(snapshot.hash)
    ) {
      return false;
    }

    const expected = sortedIds(snapshot.ids);
    const verifiedLanguages = normalizedVerifiedLanguages(snapshot.verifiedLanguages);
    const verifiedLanguagesValid = verifiedLanguages !== false && (
      verifiedLanguages == null
      || snapshot.verifiedLanguages.every((code, index) => code === verifiedLanguages[index])
    );
    const epochEvidenceValid = snapshot.epochEvidence == null
      || validTransitionEvidence(snapshot.epochEvidence, snapshot);
    return verifiedLanguagesValid && epochEvidenceValid && snapshot.ids.every((id, index) => (
      typeof id === "string"
      && validId(id)
      && id === expected[index]
      && (index === 0 || id !== snapshot.ids[index - 1])
    )) && semanticHash(snapshot.ids) === snapshot.hash;
  }

  function diffSnapshots(previous, next) {
    if (!validSnapshot(next, next?.scope, next?.generation)) {
      throw new Error("The new Netflix latest snapshot is invalid");
    }
    if (previous == null) {
      return Object.freeze({
        added: Array.from(next.ids),
        removed: [],
        unchanged: [],
        changed: next.ids.length > 0,
        previousHash: null,
        nextHash: next.hash
      });
    }
    if (!validSnapshot(previous, previous?.scope, previous?.generation)) {
      throw new Error("The previous Netflix latest snapshot is invalid");
    }
    if (previous.scope !== next.scope || previous.generation !== next.generation) {
      throw new Error("Netflix latest snapshots belong to different cache scopes");
    }

    const before = new Set(previous.ids);
    const after = new Set(next.ids);
    const added = next.ids.filter((id) => !before.has(id));
    const removed = previous.ids.filter((id) => !after.has(id));
    const unchanged = next.ids.filter((id) => before.has(id));
    return Object.freeze({
      added,
      removed,
      unchanged,
      changed: !sameSnapshotSet(previous, next),
      previousHash: previous.hash,
      nextHash: next.hash
    });
  }

  function transitionEvidence(previous, next) {
    if (!validSnapshot(next, next?.scope, next?.generation)) {
      throw new Error("The new Netflix latest snapshot is invalid");
    }
    if (previous == null) {
      return `none:0:>${next.hash}:${next.ids.join(",")}`;
    }
    if (!validSnapshot(previous, previous?.scope, previous?.generation)) {
      throw new Error("The previous Netflix latest snapshot is invalid");
    }
    if (previous.scope !== next.scope || previous.generation !== next.generation) {
      throw new Error("Netflix latest snapshots belong to different cache scopes");
    }
    return `${previous.hash}:${previous.capturedAt}:${previous.ids.join(",")}>${next.hash}:${next.ids.join(",")}`;
  }

  async function fetchSnapshot(documentObject = document, options = {}) {
    const generation = options.generation ?? 0;
    if (!validGeneration(generation)) {
      throw new Error("Netflix latest snapshot generation is invalid");
    }
    const listId = discoverLatestListId(documentObject);
    const context = catalog.extractMemberContext(documentObject);
    const fetchImpl = options.fetch || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("Netflix latest list cannot be requested in this environment");
    }
    const origin = options.origin || documentObject?.location?.origin;
    const endpoint = catalog.buildEndpoint(origin);
    const requestPath = async (path, label) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          path: JSON.stringify(path),
          authURL: context.authUrl
        }),
        signal: options.signal
      });
      if (!response?.ok) {
        throw new Error(`Netflix latest ${label} request failed (${response?.status || "network"})`);
      }
      return response.json();
    };

    let descriptor = options.requireFreshSummary === true
      ? null
      : discoverInlineLatestList(documentObject, listId);
    if (!descriptor) {
      const summaryPayload = await requestPath(
        buildComponentSummaryPath(listId),
        "component summary"
      );
      descriptor = parseComponentSummaryPayload(summaryPayload, listId);
    }
    const listPayload = await requestPath(
      buildListPath(descriptor.listId, descriptor.length),
      "list"
    );
    const ids = parseListPayload(listPayload, descriptor.listId, descriptor.length);
    return createSnapshot(ids, {
      generation,
      scope: context.scope,
      listId: descriptor.listId,
      capturedAt: options.capturedAt ?? Date.now(),
      verifiedLanguages: options.verifiedLanguages
    });
  }

  return Object.freeze({
    LATEST_CONTEXT,
    SNAPSHOT_VERSION,
    MAX_LATEST_ITEMS,
    LIST_FIELDS,
    validHash,
    isPageNotReadyError,
    discoverLatestListId,
    discoverLatestList,
    buildComponentSummaryPath,
    parseComponentSummaryPayload,
    buildListPath,
    parseListPayload,
    semanticHash,
    sameSnapshotSet,
    validTransitionEvidence,
    createSnapshot,
    validSnapshot,
    diffSnapshots,
    transitionEvidence,
    fetchSnapshot
  });
});
