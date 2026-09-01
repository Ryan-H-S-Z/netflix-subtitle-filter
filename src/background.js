"use strict";

importScripts("config.js", "netflix-catalog.js", "latest-catalog.js");

const config = globalThis.NetflixSubtitleConfig;
const catalog = globalThis.NetflixSubtitleCatalog;
const latestCatalog = globalThis.NetflixSubtitleLatestCatalog;
const CATALOG_FETCH_LEASES_KEY = `${config.CATALOG_CACHE_KEY}:fetch-leases`;
const CATALOG_FETCH_LEASE_MS = 10 * 60 * 1000;
const MAX_LATEST_SCOPES = 4;
const LEGACY_WEEKLY_SYNC_KEYS = ["weeklyCacheRefresh"];
const LEGACY_WEEKLY_LOCAL_KEYS = [
  "nchCatalogLastAutoRefreshAt",
  "nchCatalogAutoRefreshTick"
];
let taskQueue = Promise.resolve();

function enqueue(task) {
  const result = taskQueue.then(task, task);
  taskQueue = result.catch(() => undefined);
  return result;
}

function ignoreTaskFailure(promise) {
  promise.catch(() => undefined);
}

function recordIsOlderThan(record, generation) {
  return !Number.isInteger(record?.generation) || record.generation < generation;
}

function recordIsNotNewerThan(record, generation) {
  return !Number.isInteger(record?.generation) || record.generation <= generation;
}

async function readCatalogMeta() {
  const stored = await chrome.storage.local.get(config.CATALOG_CACHE_KEY);
  const value = stored[config.CATALOG_CACHE_KEY];
  if (
    value?.version === 2
    && Number.isInteger(value.generation)
    && value.generation >= 0
  ) {
    return value;
  }
  const fresh = { version: 2, generation: 0 };
  const allStored = await chrome.storage.local.get(null);
  const invalidRecordKeys = Object.keys(allStored).filter((key) => (
    key.startsWith(catalog.CACHE_RECORD_PREFIX)
  ));
  if (invalidRecordKeys.length) {
    await chrome.storage.local.remove(invalidRecordKeys);
  }
  await chrome.storage.local.remove(CATALOG_FETCH_LEASES_KEY);
  await chrome.storage.local.set({ [config.CATALOG_CACHE_KEY]: fresh });
  return fresh;
}

async function ownsCatalogFetchLease(storageKey, token) {
  if (typeof token !== "string" || token.length < 16 || token.length > 80) {
    return false;
  }
  const leases = await readFetchLeases();
  return leases[storageKey]?.token === token;
}

async function writeCatalogCacheRecord(storageKey, record, generation, leaseToken) {
  const expectedKey = catalog.cacheRecordStorageKey(record?.scope, record?.code, generation);
  if (
    typeof storageKey !== "string"
    || storageKey !== expectedKey
    || !catalog.validCacheRecord(record, record?.code, record?.scope, Date.now(), generation)
  ) {
    throw new Error("Invalid catalog cache record");
  }

  const meta = await readCatalogMeta();
  if (meta.generation !== generation) {
    return { ok: false };
  }
  if (!await ownsCatalogFetchLease(storageKey, leaseToken)) {
    return { ok: false, leaseLost: true };
  }

  const stored = await chrome.storage.local.get(null);
  const existingCandidate = stored[storageKey];
  const existing = catalog.validCacheRecord(
    existingCandidate,
    record.code,
    record.scope,
    Date.now(),
    generation
  ) ? existingCandidate : null;
  let recordToStore = record;
  if (existing) {
    const sameIds = Array.isArray(existing.ids)
      && existing.ids.length === record.ids.length
      && existing.ids.every((id, index) => id === record.ids[index]);
    if (sameIds) {
      if (
        existing.titlesComplete === true
        && record.titlesComplete !== true
        && Number(existing.builtAt) >= Number(record.builtAt)
      ) {
        return { ok: true, written: false, record: existing };
      }
      if (existing.titlesComplete !== true && record.titlesComplete === true) {
        recordToStore = {
          ...record,
          builtAt: Math.max(Number(existing.builtAt), Number(record.builtAt))
        };
      } else if (Number(existing.builtAt) > Number(record.builtAt)) {
        return { ok: true, written: false, record: existing };
      }
    } else if (
      Number(existing.builtAt) > Number(record.builtAt)
      || (
        Number(existing.builtAt) === Number(record.builtAt)
        && existing.titlesComplete === true
        && record.titlesComplete !== true
      )
    ) {
      return { ok: true, written: false, record: existing };
    }
  }

  const removable = Object.entries(stored)
    .filter(([key, cached]) => (
      key.startsWith(catalog.CACHE_RECORD_PREFIX)
      && key !== storageKey
      && recordIsNotNewerThan(cached, generation)
    ))
    .sort(([, a], [, b]) => Number(a?.builtAt) - Number(b?.builtAt));
  const staleKeys = removable
    .filter(([, cached]) => recordIsOlderThan(cached, generation))
    .map(([key]) => key);
  const current = removable.filter(([, cached]) => cached?.generation === generation);
  const reserveKeys = current.length >= catalog.MAX_CACHE_RECORDS
    ? current.slice(0, current.length - catalog.MAX_CACHE_RECORDS + 1).map(([key]) => key)
    : [];
  const prewriteRemovals = Array.from(new Set([...staleKeys, ...reserveKeys]));
  if (prewriteRemovals.length) {
    if ((await readCatalogMeta()).generation !== generation) {
      return { ok: false };
    }
    if (!await ownsCatalogFetchLease(storageKey, leaseToken)) {
      return { ok: false, leaseLost: true };
    }
    await chrome.storage.local.remove(prewriteRemovals);
  }

  const estimatedRecordBytes = new TextEncoder().encode(
    JSON.stringify({ [storageKey]: recordToStore })
  ).byteLength;
  if (estimatedRecordBytes > catalog.MAX_CACHE_BYTES) {
    return { ok: false };
  }

  if (typeof chrome.storage.local.getBytesInUse === "function") {
    let usedBytes = await chrome.storage.local.getBytesInUse(null);
    const replacedBytes = await chrome.storage.local.getBytesInUse(storageKey);
    const byteCandidates = Object.entries(await chrome.storage.local.get(null))
      .filter(([key, cached]) => (
        key.startsWith(catalog.CACHE_RECORD_PREFIX)
        && key !== storageKey
        && recordIsNotNewerThan(cached, generation)
      ))
      .sort(([, a], [, b]) => Number(a?.builtAt) - Number(b?.builtAt));
    while (
      usedBytes - replacedBytes + estimatedRecordBytes > catalog.MAX_CACHE_BYTES
      && byteCandidates.length
    ) {
      if ((await readCatalogMeta()).generation !== generation) {
        return { ok: false };
      }
      if (!await ownsCatalogFetchLease(storageKey, leaseToken)) {
        return { ok: false, leaseLost: true };
      }
      const [key] = byteCandidates.shift();
      const bytes = await chrome.storage.local.getBytesInUse(key);
      await chrome.storage.local.remove(key);
      usedBytes = Math.max(0, usedBytes - bytes);
    }
    if (usedBytes - replacedBytes + estimatedRecordBytes > catalog.MAX_CACHE_BYTES) {
      return { ok: false };
    }
  }

  for (;;) {
    if ((await readCatalogMeta()).generation !== generation) {
      return { ok: false };
    }
    if (!await ownsCatalogFetchLease(storageKey, leaseToken)) {
      return { ok: false, leaseLost: true };
    }
    try {
      await chrome.storage.local.set({ [storageKey]: recordToStore });
      return { ok: true, written: true, record: recordToStore };
    } catch (error) {
      const candidates = Object.entries(await chrome.storage.local.get(null))
        .filter(([key, cached]) => (
          key.startsWith(catalog.CACHE_RECORD_PREFIX)
          && key !== storageKey
          && recordIsNotNewerThan(cached, generation)
        ))
        .sort(([, a], [, b]) => Number(a?.builtAt) - Number(b?.builtAt));
      if (!candidates.length) {
        throw error;
      }
      await chrome.storage.local.remove(candidates[0][0]);
    }
  }
}

async function clearCatalogCache() {
  const meta = await readCatalogMeta();
  const nextMeta = { version: 2, generation: meta.generation + 1 };
  const stored = await chrome.storage.local.get(null);
  const recordKeys = Object.keys(stored)
    .filter((key) => key.startsWith(catalog.CACHE_RECORD_PREFIX));
  if (recordKeys.length) {
    await chrome.storage.local.remove(recordKeys);
  }
  await chrome.storage.local.remove(CATALOG_FETCH_LEASES_KEY);
  await chrome.storage.local.remove(config.LATEST_SNAPSHOTS_KEY);
  await chrome.storage.local.set({ [config.CATALOG_CACHE_KEY]: nextMeta });
  return nextMeta.generation;
}

function validLeaseRequest(message) {
  const generation = Number(message?.generation);
  const code = String(message?.code || "");
  const scope = String(message?.scope || "");
  return Boolean(
    Number.isInteger(generation)
    && generation >= 0
    && config.LANGUAGES[code]?.genreId
    && scope.length > 0
    && scope.length <= 160
    && message.storageKey === catalog.cacheRecordStorageKey(scope, code, generation)
  );
}

function newLeaseToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint32Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("");
}

async function readFetchLeases(now = Date.now()) {
  const stored = await chrome.storage.local.get(CATALOG_FETCH_LEASES_KEY);
  const raw = stored[CATALOG_FETCH_LEASES_KEY];
  const leases = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return leases;
  }
  for (const [key, lease] of Object.entries(raw)) {
    if (
      typeof key === "string"
      && typeof lease?.token === "string"
      && lease.token.length >= 16
      && lease.token.length <= 80
      && Number.isFinite(Number(lease.expiresAt))
      && Number(lease.expiresAt) > now
    ) {
      leases[key] = {
        token: lease.token,
        expiresAt: Number(lease.expiresAt)
      };
    }
  }
  return leases;
}

async function acquireCatalogFetchLease(message, now = Date.now()) {
  if (!validLeaseRequest(message)) {
    throw new Error("Invalid catalog fetch lease request");
  }
  const meta = await readCatalogMeta();
  if (meta.generation !== message.generation) {
    return { ok: false, generation: meta.generation };
  }
  const leases = await readFetchLeases(now);
  const current = leases[message.storageKey];
  if (current) {
    return {
      ok: true,
      acquired: false,
      expiresAt: current.expiresAt
    };
  }
  const token = newLeaseToken();
  const expiresAt = now + CATALOG_FETCH_LEASE_MS;
  leases[message.storageKey] = { token, expiresAt };
  await chrome.storage.local.set({ [CATALOG_FETCH_LEASES_KEY]: leases });
  return { ok: true, acquired: true, token, expiresAt };
}

async function renewCatalogFetchLease(message, now = Date.now()) {
  if (
    !validLeaseRequest(message)
    || typeof message.token !== "string"
    || message.token.length < 16
    || message.token.length > 80
  ) {
    throw new Error("Invalid catalog fetch lease renewal");
  }
  const leases = await readFetchLeases(now);
  const current = leases[message.storageKey];
  if (!current || current.token !== message.token) {
    return { ok: true, renewed: false };
  }
  current.expiresAt = now + CATALOG_FETCH_LEASE_MS;
  await chrome.storage.local.set({ [CATALOG_FETCH_LEASES_KEY]: leases });
  return { ok: true, renewed: true, expiresAt: current.expiresAt };
}

async function releaseCatalogFetchLease(message) {
  if (
    !validLeaseRequest(message)
    || typeof message.token !== "string"
    || message.token.length < 16
    || message.token.length > 80
  ) {
    throw new Error("Invalid catalog fetch lease release");
  }
  const leases = await readFetchLeases();
  const current = leases[message.storageKey];
  if (!current || current.token !== message.token) {
    return { ok: true, released: false };
  }
  delete leases[message.storageKey];
  if (Object.keys(leases).length) {
    await chrome.storage.local.set({ [CATALOG_FETCH_LEASES_KEY]: leases });
  } else {
    await chrome.storage.local.remove(CATALOG_FETCH_LEASES_KEY);
  }
  return { ok: true, released: true };
}

function validLatestScope(scope) {
  return typeof scope === "string" && scope.length > 0 && scope.length <= 160;
}

async function readLatestStore() {
  const stored = await chrome.storage.local.get(config.LATEST_SNAPSHOTS_KEY);
  const value = stored[config.LATEST_SNAPSHOTS_KEY];
  if (value?.version === 1 && value.entries && typeof value.entries === "object") {
    return { version: 1, entries: { ...value.entries } };
  }
  return { version: 1, entries: {} };
}

function validStoredLatestSnapshot(snapshot, scope, generation) {
  return latestCatalog.validSnapshot(snapshot, scope, generation)
    && latestCatalog.validTransitionEvidence(snapshot.epochEvidence, snapshot);
}

async function getLatestSnapshot(scope) {
  if (!validLatestScope(scope)) {
    throw new Error("Invalid latest snapshot scope");
  }
  const meta = await readCatalogMeta();
  const store = await readLatestStore();
  const candidate = store.entries[scope];
  const snapshot = validStoredLatestSnapshot(candidate, scope, meta.generation)
    ? candidate
    : null;
  return { ok: true, generation: meta.generation, snapshot };
}

function sameLatestSnapshotEpoch(left, right) {
  return Boolean(
    latestCatalog.sameSnapshotSet(left, right)
    && left.capturedAt === right.capturedAt
    && left.listId === right.listId
    && left.epochEvidence === right.epochEvidence
  );
}

async function latestCatalogEvidenceIsPersisted(
  codes,
  scope,
  generation,
  evidence,
  minimumBuiltAt
) {
  if (!codes.length) {
    return true;
  }
  if (
    catalog.requestedLatestEvidence(evidence) !== evidence
    || codes.some((code) => !config.LANGUAGES[code]?.genreId)
  ) {
    return false;
  }
  const storageKeys = Object.fromEntries(codes.map((code) => [
    code,
    catalog.cacheRecordStorageKey(scope, code, generation)
  ]));
  const stored = await chrome.storage.local.get(Object.values(storageKeys));
  return codes.every((code) => {
    const record = stored[storageKeys[code]];
    return catalog.validCacheRecord(record, code, scope, Date.now(), generation)
      && catalog.recordMeetsLatestEvidence(record, minimumBuiltAt, evidence);
  });
}

async function commitLatestSnapshot(message) {
  const scope = String(message?.scope || "");
  const generation = Number(message?.generation);
  const expectedSnapshot = message?.expectedSnapshot ?? null;
  const snapshot = message?.snapshot;
  if (
    !validLatestScope(scope)
    || !Number.isInteger(generation)
    || generation < 0
    || !latestCatalog.validSnapshot(snapshot, scope, generation)
    || !latestCatalog.validTransitionEvidence(snapshot?.epochEvidence, snapshot)
    || (
      expectedSnapshot !== null
      && !latestCatalog.validSnapshot(expectedSnapshot, scope, generation)
    )
  ) {
    throw new Error("Invalid latest snapshot commit");
  }

  const meta = await readCatalogMeta();
  if (meta.generation !== generation) {
    return { ok: false, conflict: true, generation: meta.generation };
  }
  const store = await readLatestStore();
  const currentCandidate = store.entries[scope];
  const current = validStoredLatestSnapshot(currentCandidate, scope, generation)
    ? currentCandidate
    : null;
  const currentMatchesExpected = expectedSnapshot === null
    ? current === null
    : sameLatestSnapshotEpoch(current, expectedSnapshot);
  const currentIsSameSet = latestCatalog.sameSnapshotSet(current, snapshot);
  const expectedEvidence = currentIsSameSet && current?.epochEvidence
    ? current.epochEvidence
    : latestCatalog.transitionEvidence(expectedSnapshot, snapshot);
  const sameTransitionWinner = currentIsSameSet
    && current?.epochEvidence === snapshot.epochEvidence;
  if (
    snapshot.epochEvidence !== expectedEvidence
    || (!currentMatchesExpected && !sameTransitionWinner)
  ) {
    return {
      ok: false,
      conflict: true,
      generation,
      snapshot: current
    };
  }
  const currentLanguages = Array.isArray(current?.verifiedLanguages)
    ? current.verifiedLanguages
    : [];
  const nextLanguages = Array.isArray(snapshot.verifiedLanguages)
    ? snapshot.verifiedLanguages
    : [];
  if (nextLanguages.some((code) => !config.LANGUAGES[code]?.genreId)) {
    throw new Error("Invalid latest snapshot languages");
  }
  const difference = current
    ? latestCatalog.diffSnapshots(current, snapshot)
    : { added: snapshot.ids.slice() };
  const requiredPersistedLanguages = !current || difference.added.length > 0
    ? nextLanguages
    : nextLanguages.filter((code) => !currentLanguages.includes(code));
  if (!await latestCatalogEvidenceIsPersisted(
    requiredPersistedLanguages,
    scope,
    generation,
    message?.catalogEvidence,
    snapshot.capturedAt
  )) {
    return {
      ok: false,
      persistenceConflict: true,
      generation,
      snapshot: current
    };
  }
  const mergedLanguages = currentIsSameSet
    ? Array.from(new Set([...currentLanguages, ...nextLanguages])).sort()
    : nextLanguages;
  const sameSetBase = currentIsSameSet
    && Number(current.capturedAt) > Number(snapshot.capturedAt)
    ? current
    : snapshot;
  const snapshotToStore = currentIsSameSet
    ? {
      ...sameSetBase,
      epochEvidence: snapshot.epochEvidence,
      verifiedLanguages: mergedLanguages
    }
    : snapshot;
  if (
    currentIsSameSet
    && currentLanguages.length === mergedLanguages.length
    && currentLanguages.every((code, index) => code === mergedLanguages[index])
    && Number(current.capturedAt) >= Number(snapshot.capturedAt)
    && current.listId === sameSetBase.listId
  ) {
    return { ok: true, written: false, generation, snapshot: current };
  }

  const entries = { ...store.entries, [scope]: snapshotToStore };
  const ordered = Object.entries(entries)
    .filter(([, candidate]) => validStoredLatestSnapshot(
      candidate,
      candidate?.scope,
      generation
    ))
    .sort(([, left], [, right]) => Number(right.capturedAt) - Number(left.capturedAt));
  const prunedEntries = Object.fromEntries(ordered.slice(0, MAX_LATEST_SCOPES));
  await chrome.storage.local.set({
    [config.LATEST_SNAPSHOTS_KEY]: { version: 1, entries: prunedEntries }
  });
  return { ok: true, written: true, generation, snapshot: snapshotToStore };
}

async function cleanupLegacyWeeklySettings() {
  await Promise.all([
    chrome.storage.sync.remove(LEGACY_WEEKLY_SYNC_KEYS),
    chrome.storage.local.remove(LEGACY_WEEKLY_LOCAL_KEYS)
  ]);
}

chrome.runtime.onInstalled.addListener(() => {
  ignoreTaskFailure(enqueue(cleanupLegacyWeeklySettings));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let task;
  if (message?.type === "NCH_WRITE_CATALOG_CACHE_RECORD") {
    task = () => writeCatalogCacheRecord(
      message.storageKey,
      message.record,
      message.generation,
      message.leaseToken
    );
  } else if (message?.type === "NCH_CLEAR_CATALOG_CACHE") {
    task = async () => ({
      ok: true,
      generation: await clearCatalogCache()
    });
  } else if (message?.type === "NCH_GET_CATALOG_CACHE_META") {
    task = async () => ({
      ok: true,
      meta: await readCatalogMeta()
    });
  } else if (message?.type === "NCH_ACQUIRE_CATALOG_FETCH_LEASE") {
    task = () => acquireCatalogFetchLease(message);
  } else if (message?.type === "NCH_RENEW_CATALOG_FETCH_LEASE") {
    task = () => renewCatalogFetchLease(message);
  } else if (message?.type === "NCH_RELEASE_CATALOG_FETCH_LEASE") {
    task = () => releaseCatalogFetchLease(message);
  } else if (message?.type === "NCH_GET_LATEST_SNAPSHOT") {
    task = () => getLatestSnapshot(message.scope);
  } else if (message?.type === "NCH_COMMIT_LATEST_SNAPSHOT") {
    task = () => commitLatestSnapshot(message);
  } else {
    return undefined;
  }

  enqueue(task).then(
    (response) => sendResponse(response),
    () => sendResponse({ ok: false })
  );
  return true;
});
