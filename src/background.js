"use strict";

importScripts("config.js", "cache-schedule.js", "netflix-catalog.js");

const config = globalThis.NetflixSubtitleConfig;
const schedule = globalThis.NetflixSubtitleCacheSchedule;
const catalog = globalThis.NetflixSubtitleCatalog;
const CATALOG_FETCH_LEASES_KEY = `${config.CATALOG_CACHE_KEY}:fetch-leases`;
const CATALOG_FETCH_LEASE_MS = 10 * 60 * 1000;
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

async function autoRefreshEnabled() {
  const stored = await chrome.storage.sync.get({
    [schedule.AUTO_REFRESH_KEY]: false
  });
  return stored[schedule.AUTO_REFRESH_KEY] === true;
}

async function createAlarm(lastRefreshAt, now = Date.now()) {
  const when = Math.max(now + 60 * 1000, schedule.nextDueAt(lastRefreshAt, now));
  await chrome.alarms.create(schedule.ALARM_NAME, {
    when,
    periodInMinutes: schedule.WEEK_MINUTES
  });
}

async function publishRefreshTick(now = Date.now()) {
  await chrome.storage.local.set({
    [schedule.LAST_REFRESH_KEY]: now,
    [schedule.REFRESH_TICK_KEY]: now
  });
  await createAlarm(now, now);
}

async function disableWeeklySchedule() {
  await chrome.alarms.clear(schedule.ALARM_NAME);
  await chrome.storage.local.remove(schedule.REFRESH_TICK_KEY);
}

async function refreshIfDue(now = Date.now()) {
  if (!await autoRefreshEnabled()) {
    await disableWeeklySchedule();
    return false;
  }

  // Always re-read LAST inside the serialized task. A reconcile and a queued
  // alarm event can therefore observe the tick published by the earlier task
  // instead of publishing the same weekly refresh twice.
  const stored = await chrome.storage.local.get(schedule.LAST_REFRESH_KEY);
  let lastRefreshAt = schedule.validTimestamp(stored[schedule.LAST_REFRESH_KEY]);
  if (!lastRefreshAt) {
    lastRefreshAt = now;
    await chrome.storage.local.set({ [schedule.LAST_REFRESH_KEY]: lastRefreshAt });
    await chrome.storage.local.remove(schedule.REFRESH_TICK_KEY);
  }

  if (schedule.isDue(lastRefreshAt, now)) {
    await publishRefreshTick(now);
    return true;
  }

  const alarm = await chrome.alarms.get(schedule.ALARM_NAME);
  if (!schedule.alarmMatches(alarm, lastRefreshAt, now)) {
    await createAlarm(lastRefreshAt, now);
  }
  return false;
}

async function reconcileAlarm() {
  await refreshIfDue(Date.now());
}

async function resetWeeklySchedule() {
  await chrome.storage.local.remove(schedule.REFRESH_TICK_KEY);
  if (!await autoRefreshEnabled()) {
    await chrome.alarms.clear(schedule.ALARM_NAME);
    return;
  }
  const now = Date.now();
  await chrome.storage.local.set({ [schedule.LAST_REFRESH_KEY]: now });
  await createAlarm(now, now);
}

async function restoreLocalSchedule(snapshot) {
  const restore = {};
  const remove = [];
  for (const key of [schedule.LAST_REFRESH_KEY, schedule.REFRESH_TICK_KEY]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      restore[key] = snapshot[key];
    } else {
      remove.push(key);
    }
  }
  if (Object.keys(restore).length) {
    await chrome.storage.local.set(restore);
  }
  if (remove.length) {
    await chrome.storage.local.remove(remove);
  }
}

async function restoreAlarm(snapshot) {
  if (!snapshot) {
    await chrome.alarms.clear(schedule.ALARM_NAME);
    return;
  }
  const alarmInfo = {};
  if (Number.isFinite(Number(snapshot.scheduledTime))) {
    alarmInfo.when = Math.max(Date.now() + 1000, Number(snapshot.scheduledTime));
  }
  if (Number.isFinite(Number(snapshot.periodInMinutes))) {
    alarmInfo.periodInMinutes = Number(snapshot.periodInMinutes);
  }
  if (Object.keys(alarmInfo).length) {
    await chrome.alarms.create(schedule.ALARM_NAME, alarmInfo);
  }
}

async function setWeeklyRefreshEnabled(enabled) {
  const requested = enabled === true;
  const [syncSnapshot, localSnapshot, alarmSnapshot] = await Promise.all([
    chrome.storage.sync.get(schedule.AUTO_REFRESH_KEY),
    chrome.storage.local.get([
      schedule.LAST_REFRESH_KEY,
      schedule.REFRESH_TICK_KEY
    ]),
    chrome.alarms.get(schedule.ALARM_NAME)
  ]);
  const previousEnabled = syncSnapshot[schedule.AUTO_REFRESH_KEY] === true;

  try {
    if (requested) {
      const now = Date.now();
      await chrome.storage.local.set({ [schedule.LAST_REFRESH_KEY]: now });
      await chrome.storage.local.remove(schedule.REFRESH_TICK_KEY);
      await createAlarm(now, now);
      await chrome.storage.sync.set({ [schedule.AUTO_REFRESH_KEY]: true });
    } else {
      await disableWeeklySchedule();
      await chrome.storage.sync.set({ [schedule.AUTO_REFRESH_KEY]: false });
    }
    return { ok: true, enabled: requested };
  } catch (_error) {
    try {
      await chrome.storage.sync.set({ [schedule.AUTO_REFRESH_KEY]: previousEnabled });
    } catch (_rollbackError) {
      // Continue with the remaining compensation steps.
    }
    try {
      await restoreLocalSchedule(localSnapshot);
    } catch (_rollbackError) {
      // Continue so the alarm can still be restored or reconciled.
    }
    try {
      await restoreAlarm(alarmSnapshot);
    } catch (_rollbackError) {
      // Reconciliation below gets one more chance to restore consistency.
    }
    let actualEnabled = previousEnabled;
    try {
      actualEnabled = await autoRefreshEnabled();
    } catch (_readError) {
      // Keep the last known value.
    }
    try {
      await reconcileAlarm();
      actualEnabled = await autoRefreshEnabled();
    } catch (_reconcileError) {
      // The popup receives a failed result and the worker retries on next wake.
    }
    return { ok: false, enabled: actualEnabled };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ignoreTaskFailure(enqueue(async () => {
    const stored = await chrome.storage.sync.get(schedule.AUTO_REFRESH_KEY);
    if (typeof stored[schedule.AUTO_REFRESH_KEY] !== "boolean") {
      await chrome.storage.sync.set({ [schedule.AUTO_REFRESH_KEY]: false });
    }
    await reconcileAlarm();
  }));
});

chrome.runtime.onStartup.addListener(() => {
  ignoreTaskFailure(enqueue(reconcileAlarm));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes[schedule.AUTO_REFRESH_KEY]) {
    // The atomic popup command prepares LAST/alarm before changing sync.
    // For sync propagation or recovery, reconcile from the final stored value
    // instead of restarting the seven-day period for each intermediate event.
    ignoreTaskFailure(enqueue(reconcileAlarm));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === schedule.ALARM_NAME) {
    ignoreTaskFailure(enqueue(() => refreshIfDue(Date.now())));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let task;
  if (message?.type === "NCH_RESET_WEEKLY_REFRESH_SCHEDULE") {
    task = async () => {
      await resetWeeklySchedule();
      return { ok: true };
    };
  } else if (message?.type === "NCH_WRITE_CATALOG_CACHE_RECORD") {
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
  } else if (message?.type === "NCH_SET_WEEKLY_REFRESH_ENABLED") {
    task = () => setWeeklyRefreshEnabled(message.enabled);
  } else {
    return undefined;
  }

  enqueue(task).then(
    (response) => sendResponse(response),
    () => sendResponse({ ok: false })
  );
  return true;
});

ignoreTaskFailure(enqueue(reconcileAlarm));
