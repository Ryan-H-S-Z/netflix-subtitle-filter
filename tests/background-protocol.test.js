"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const projectRoot = path.resolve(__dirname, "..");
const schedule = require("../src/cache-schedule.js");
const config = require("../src/config.js");
const catalog = require("../src/netflix-catalog.js");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    dispatch(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    },
    listeners
  };
}

function createStorageArea(initial, failures, areaName) {
  const data = clone(initial || {});

  function takeFailure(operation) {
    const key = `storage.${areaName}.${operation}`;
    const plan = failures.get(key);
    if (Array.isArray(plan)) {
      const mode = plan.shift();
      if (!plan.length) {
        failures.delete(key);
      }
      return mode || null;
    }
    if (plan) {
      failures.set(key, plan - 1);
      return "before";
    }
    return null;
  }

  function failBefore(operation, mode) {
    if (mode === "before") {
      throw new Error(`Injected storage.${areaName}.${operation} failure`);
    }
  }

  function failAfter(operation, mode) {
    if (mode === "after") {
      throw new Error(`Injected storage.${areaName}.${operation} post-commit failure`);
    }
  }

  return {
    data,
    async get(keys) {
      const failure = takeFailure("get");
      failBefore("get", failure);
      let result;
      if (keys === null || keys === undefined) {
        result = clone(data);
      } else if (typeof keys === "string") {
        result = Object.hasOwn(data, keys) ? { [keys]: clone(data[keys]) } : {};
      } else if (Array.isArray(keys)) {
        result = Object.fromEntries(keys
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, clone(data[key])]));
      } else {
        result = clone(keys);
        for (const key of Object.keys(keys)) {
          if (Object.hasOwn(data, key)) {
            result[key] = clone(data[key]);
          }
        }
      }
      failAfter("get", failure);
      return result;
    },
    async set(items) {
      const failure = takeFailure("set");
      failBefore("set", failure);
      Object.assign(data, clone(items));
      failAfter("set", failure);
    },
    async remove(keys) {
      const failure = takeFailure("remove");
      failBefore("remove", failure);
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
      failAfter("remove", failure);
    },
    async getBytesInUse(keys) {
      const subset = await this.get(keys);
      return Buffer.byteLength(JSON.stringify(subset));
    }
  };
}

function createBackgroundHarness({ local = {}, sync = {}, alarm = null } = {}) {
  const failures = new Map();
  const runtimeOnMessage = createEvent();
  const localArea = createStorageArea(local, failures, "local");
  const syncArea = createStorageArea(sync, failures, "sync");
  const alarms = new Map(alarm ? [[alarm.name, clone(alarm)]] : []);

  function takeAlarmFailure(operation) {
    const key = `alarms.${operation}`;
    const plan = failures.get(key);
    if (Array.isArray(plan)) {
      const mode = plan.shift();
      if (!plan.length) {
        failures.delete(key);
      }
      return mode || null;
    }
    if (plan) {
      failures.set(key, plan - 1);
      return "before";
    }
    return null;
  }

  const chrome = {
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: runtimeOnMessage
    },
    storage: {
      local: localArea,
      sync: syncArea,
      onChanged: createEvent()
    },
    alarms: {
      onAlarm: createEvent(),
      async create(name, options) {
        const failure = takeAlarmFailure("create");
        if (failure === "before") {
          throw new Error("Injected alarms.create failure");
        }
        alarms.set(name, { name, scheduledTime: options.when, ...clone(options) });
        if (failure === "after") {
          throw new Error("Injected alarms.create post-commit failure");
        }
      },
      async clear(name) {
        const failure = takeAlarmFailure("clear");
        if (failure === "before") {
          throw new Error("Injected alarms.clear failure");
        }
        const removed = alarms.delete(name);
        if (failure === "after") {
          throw new Error("Injected alarms.clear post-commit failure");
        }
        return removed;
      },
      async get(name) {
        return clone(alarms.get(name));
      }
    }
  };

  const context = vm.createContext({
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID: nodeCrypto.randomUUID },
    structuredClone,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("Unexpected fetch in background protocol test");
    },
    chrome,
    console
  });

  context.importScripts = (...scripts) => {
    for (const script of scripts) {
      const filename = path.join(projectRoot, "src", script);
      vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    }
  };
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, "src/background.js"), "utf8"),
    context,
    { filename: path.join(projectRoot, "src/background.js") }
  );

  async function sendMessage(message) {
    const listener = runtimeOnMessage.listeners[0];
    assert.equal(typeof listener, "function", "background must register onMessage");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 1000);
      const keepChannelOpen = listener(message, {}, (response) => {
        clearTimeout(timeout);
        resolve(clone(response));
      });
      assert.equal(keepChannelOpen, true, `unsupported background message: ${message.type}`);
    });
  }

  return {
    chrome,
    local: localArea.data,
    sync: syncArea.data,
    alarms,
    failNext(operation, count = 1) {
      failures.set(operation, count);
    },
    failSequence(operation, modes) {
      failures.set(operation, [...modes]);
    },
    sendMessage
  };
}

function leaseMessage(type) {
  const scope = "TH-profile-locale";
  const code = "zh-hans";
  const generation = 0;
  return {
    type,
    storageKey: catalog.cacheRecordStorageKey(scope, code, generation),
    scope,
    code,
    generation
  };
}

function validCacheRecord(overrides = {}) {
  const request = leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE");
  return {
    version: 4,
    generation: request.generation,
    code: request.code,
    scope: request.scope,
    genreId: config.LANGUAGES[request.code].genreId,
    complete: true,
    ids: ["81414001"],
    titlesComplete: true,
    titleSourceCount: 1,
    titles: ["测试影片"],
    builtAt: Date.now(),
    ...overrides
  };
}

function writeMessage(record, leaseToken) {
  const request = leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE");
  return {
    type: "NCH_WRITE_CATALOG_CACHE_RECORD",
    storageKey: request.storageKey,
    generation: request.generation,
    record,
    ...(leaseToken ? { leaseToken } : {})
  };
}

test("catalog fetch lease grants only one concurrent owner and requires its token", async () => {
  const harness = createBackgroundHarness();
  // Queue behind the background's startup reconciliation so the test observes
  // the same serialized protocol used by real tabs.
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });

  const request = leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE");
  const [first, second] = await Promise.all([
    harness.sendMessage(request),
    harness.sendMessage(request)
  ]);

  const winner = first.acquired ? first : second;
  const loser = first.acquired ? second : first;
  assert.equal(winner.ok, true);
  assert.equal(winner.acquired, true);
  assert.equal(typeof winner.token, "string");
  assert.ok(winner.token.length >= 8);
  assert.equal(loser.ok, true);
  assert.equal(loser.acquired, false);
  assert.equal(loser.expiresAt, winner.expiresAt);

  const wrongRelease = await harness.sendMessage({
    ...leaseMessage("NCH_RELEASE_CATALOG_FETCH_LEASE"),
    token: "00000000-not-the-owner"
  });
  assert.equal(wrongRelease.ok, true);
  assert.equal(wrongRelease.released, false);
  assert.equal(
    (await harness.sendMessage(request)).acquired,
    false,
    "a non-owner must not unlock another tab's fetch"
  );

  const release = await harness.sendMessage({
    ...leaseMessage("NCH_RELEASE_CATALOG_FETCH_LEASE"),
    token: winner.token
  });
  assert.equal(release.ok, true);
  assert.equal(release.released, true);
  const next = await harness.sendMessage(request);
  assert.equal(next.acquired, true);
  assert.notEqual(next.token, winner.token);
});

test("catalog fetch lease can be taken over after its persisted expiry", async () => {
  const harness = createBackgroundHarness();
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  const request = leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE");
  const first = await harness.sendMessage(request);
  assert.equal(first.acquired, true);

  const leaseEntry = Object.values(harness.local)
    .flatMap((value) => value && typeof value === "object" ? Object.values(value) : [])
    .find((value) => value && typeof value === "object" && value.token === first.token);
  assert.ok(leaseEntry, "the lease must be persisted across service-worker suspension");
  leaseEntry.expiresAt = Date.now() - 1;

  const replacement = await harness.sendMessage(request);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.acquired, true);
  assert.notEqual(replacement.token, first.token);
});

test("only the lease owner can renew it and a cache generation bump invalidates it", async () => {
  const harness = createBackgroundHarness();
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  const acquired = await harness.sendMessage(
    leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE")
  );
  assert.equal(acquired.acquired, true);

  const foreignRenewal = await harness.sendMessage({
    ...leaseMessage("NCH_RENEW_CATALOG_FETCH_LEASE"),
    token: "00000000-not-the-owner"
  });
  assert.deepEqual(foreignRenewal, { ok: true, renewed: false });
  const ownerRenewal = await harness.sendMessage({
    ...leaseMessage("NCH_RENEW_CATALOG_FETCH_LEASE"),
    token: acquired.token
  });
  assert.equal(ownerRenewal.ok, true);
  assert.equal(ownerRenewal.renewed, true);
  assert.ok(ownerRenewal.expiresAt >= acquired.expiresAt);

  const cleared = await harness.sendMessage({ type: "NCH_CLEAR_CATALOG_CACHE" });
  assert.deepEqual(cleared, { ok: true, generation: 1 });
  assert.equal(
    Object.values(harness.local).some((value) => (
      value && typeof value === "object" && JSON.stringify(value).includes(acquired.token)
    )),
    false,
    "generation changes must discard outstanding fetch work"
  );
  assert.deepEqual(
    await harness.sendMessage(leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE")),
    { ok: false, generation: 1 }
  );
});

test("catalog writes require the current unexpired lease token", async () => {
  const harness = createBackgroundHarness();
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  const request = leaseMessage("NCH_ACQUIRE_CATALOG_FETCH_LEASE");
  const storageKey = request.storageKey;
  const record = validCacheRecord();
  const first = await harness.sendMessage(request);
  assert.equal(first.acquired, true);

  assert.deepEqual(
    await harness.sendMessage(writeMessage(record)),
    { ok: false, leaseLost: true },
    "a tab cannot commit without proving lease ownership"
  );
  assert.equal(Object.hasOwn(harness.local, storageKey), false);

  const leaseMap = Object.values(harness.local).find((value) => (
    value && typeof value === "object" && value[storageKey]?.token === first.token
  ));
  assert.ok(leaseMap);
  leaseMap[storageKey].expiresAt = Date.now() - 1;
  assert.deepEqual(
    await harness.sendMessage(writeMessage(record, first.token)),
    { ok: false, leaseLost: true },
    "an expired owner cannot publish its completed fetch"
  );
  assert.equal(Object.hasOwn(harness.local, storageKey), false);

  const replacement = await harness.sendMessage(request);
  assert.equal(replacement.acquired, true);
  assert.notEqual(replacement.token, first.token);
  assert.deepEqual(
    await harness.sendMessage(writeMessage(record, first.token)),
    { ok: false, leaseLost: true },
    "a replaced token cannot overwrite the current owner's result"
  );
  assert.equal(Object.hasOwn(harness.local, storageKey), false);

  const committed = await harness.sendMessage(writeMessage(record, replacement.token));
  assert.equal(committed.ok, true);
  assert.equal(committed.written, true);
  assert.deepEqual(harness.local[storageKey], record);
});

test("clearing the catalog removes every record generation and all leases", async () => {
  const scope = "TH-profile-locale";
  const recordKeys = [
    catalog.cacheRecordStorageKey(scope, "zh-hans", 1),
    catalog.cacheRecordStorageKey(scope, "th", 2),
    catalog.cacheRecordStorageKey(scope, "en", 99)
  ];
  const leaseKey = `${config.CATALOG_CACHE_KEY}:fetch-leases`;
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 2, generation: 2 },
      [recordKeys[0]]: { generation: 1 },
      [recordKeys[1]]: { generation: 2 },
      [recordKeys[2]]: { generation: 99 },
      [leaseKey]: {
        [recordKeys[1]]: { token: "00000000-current-owner", expiresAt: Date.now() + 60_000 }
      },
      unrelatedSetting: "keep"
    }
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });

  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_CLEAR_CATALOG_CACHE" }),
    { ok: true, generation: 3 }
  );
  for (const key of recordKeys) {
    assert.equal(Object.hasOwn(harness.local, key), false, `must remove ${key}`);
  }
  assert.equal(Object.hasOwn(harness.local, leaseKey), false);
  assert.equal(harness.local.unrelatedSetting, "keep");
  assert.deepEqual(harness.local[config.CATALOG_CACHE_KEY], { version: 2, generation: 3 });
});

test("a failed catalog purge never publishes the next generation", async () => {
  const scope = "TH-profile-locale";
  const recordKey = catalog.cacheRecordStorageKey(scope, "zh-hans", 2);
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 2, generation: 2 },
      [recordKey]: { generation: 2 }
    }
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  harness.failNext("storage.local.remove");

  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_CLEAR_CATALOG_CACHE" }),
    { ok: false }
  );
  assert.deepEqual(
    harness.local[config.CATALOG_CACHE_KEY],
    { version: 2, generation: 2 },
    "the next generation must be committed only after every old record is gone"
  );
  assert.equal(Object.hasOwn(harness.local, recordKey), true);
});

test("initializing missing or invalid catalog meta purges orphaned records and leases", async () => {
  const scope = "TH-profile-locale";
  const recordKey = catalog.cacheRecordStorageKey(scope, "zh-hans", 77);
  const leaseKey = `${config.CATALOG_CACHE_KEY}:fetch-leases`;
  for (const [label, meta] of [
    ["missing", undefined],
    ["invalid", { version: 1, generation: 77 }]
  ]) {
    const local = {
      [recordKey]: { generation: 77 },
      [leaseKey]: {
        [recordKey]: { token: "00000000-orphan-owner", expiresAt: Date.now() + 60_000 }
      },
      unrelatedSetting: label
    };
    if (meta !== undefined) {
      local[config.CATALOG_CACHE_KEY] = meta;
    }
    const harness = createBackgroundHarness({ local });

    assert.deepEqual(
      await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" }),
      { ok: true, meta: { version: 2, generation: 0 } },
      label
    );
    assert.equal(Object.hasOwn(harness.local, recordKey), false, label);
    assert.equal(Object.hasOwn(harness.local, leaseKey), false, label);
    assert.equal(harness.local.unrelatedSetting, label);
  }
});

test("failed invalid-meta cleanup does not activate generation zero", async () => {
  const recordKey = catalog.cacheRecordStorageKey("TH-profile-locale", "zh-hans", 0);
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 1, generation: 0 },
      [recordKey]: { generation: 0 }
    }
  });
  await harness.sendMessage({ type: "NCH_RESET_WEEKLY_REFRESH_SCHEDULE" });
  harness.failNext("storage.local.remove");

  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" }),
    { ok: false }
  );
  assert.deepEqual(
    harness.local[config.CATALOG_CACHE_KEY],
    { version: 1, generation: 0 }
  );
  assert.equal(Object.hasOwn(harness.local, recordKey), true);
});

test("weekly refresh toggle commits settings, timestamp, tick and alarm together", async () => {
  const harness = createBackgroundHarness({
    local: {
      [schedule.LAST_REFRESH_KEY]: 1000,
      [schedule.REFRESH_TICK_KEY]: 900
    },
    sync: { [schedule.AUTO_REFRESH_KEY]: false }
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });

  const beforeEnable = Date.now();
  const enabled = await harness.sendMessage({
    type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
    enabled: true
  });
  assert.deepEqual(enabled, { ok: true, enabled: true });
  assert.equal(harness.sync[schedule.AUTO_REFRESH_KEY], true);
  assert.ok(harness.local[schedule.LAST_REFRESH_KEY] >= beforeEnable);
  assert.equal(Object.hasOwn(harness.local, schedule.REFRESH_TICK_KEY), false);
  const activeAlarm = harness.alarms.get(schedule.ALARM_NAME);
  assert.equal(activeAlarm.periodInMinutes, schedule.WEEK_MINUTES);
  assert.ok(activeAlarm.scheduledTime >= harness.local[schedule.LAST_REFRESH_KEY] + schedule.WEEK_MS);

  const disabled = await harness.sendMessage({
    type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
    enabled: false
  });
  assert.deepEqual(disabled, { ok: true, enabled: false });
  assert.equal(harness.sync[schedule.AUTO_REFRESH_KEY], false);
  assert.equal(harness.alarms.has(schedule.ALARM_NAME), false);
  assert.equal(Object.hasOwn(harness.local, schedule.REFRESH_TICK_KEY), false);
});

test("weekly refresh toggle restores the prior disabled state after a partial failure", async () => {
  const oldAlarm = {
    name: schedule.ALARM_NAME,
    scheduledTime: 2_500_000_000_000,
    when: 2_500_000_000_000,
    periodInMinutes: schedule.WEEK_MINUTES
  };
  const harness = createBackgroundHarness({
    sync: { [schedule.AUTO_REFRESH_KEY]: false },
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  // The service worker's initial reconciliation runs before messages and
  // legitimately removes a disabled schedule. Install the transaction's
  // pre-state only after that startup work has drained.
  harness.local[schedule.LAST_REFRESH_KEY] = 123456;
  harness.local[schedule.REFRESH_TICK_KEY] = 123000;
  harness.alarms.set(schedule.ALARM_NAME, clone(oldAlarm));
  harness.failNext("alarms.create");

  const response = await harness.sendMessage({
    type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
    enabled: true
  });
  assert.equal(response.ok, false);
  assert.equal(harness.sync[schedule.AUTO_REFRESH_KEY], false);
  assert.equal(harness.local[schedule.LAST_REFRESH_KEY], 123456);
  assert.equal(Object.hasOwn(harness.local, schedule.REFRESH_TICK_KEY), false);
  assert.equal(harness.alarms.has(schedule.ALARM_NAME), false);
});

test("rollback continues after a second failure and reconciles from the actual sync value", async () => {
  const harness = createBackgroundHarness({
    sync: { [schedule.AUTO_REFRESH_KEY]: false }
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  const lastRefreshAt = Date.now();
  const refreshTick = lastRefreshAt - 1;
  const scheduledTime = lastRefreshAt + schedule.WEEK_MS;
  harness.local[schedule.LAST_REFRESH_KEY] = lastRefreshAt;
  harness.local[schedule.REFRESH_TICK_KEY] = refreshTick;
  harness.alarms.set(schedule.ALARM_NAME, {
    name: schedule.ALARM_NAME,
    scheduledTime,
    when: scheduledTime,
    periodInMinutes: schedule.WEEK_MINUTES
  });

  // The requested sync write reaches storage and then reports failure. Its
  // rollback also fails, before writing the prior value. The worker must still
  // restore local state/alarm and reconcile against the actual `true` value.
  harness.failSequence("storage.sync.set", ["after", "before"]);
  const response = await harness.sendMessage({
    type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
    enabled: true
  });

  assert.deepEqual(response, { ok: false, enabled: true });
  assert.equal(harness.sync[schedule.AUTO_REFRESH_KEY], true);
  assert.equal(harness.local[schedule.LAST_REFRESH_KEY], lastRefreshAt);
  assert.equal(harness.local[schedule.REFRESH_TICK_KEY], refreshTick);
  const reconciledAlarm = harness.alarms.get(schedule.ALARM_NAME);
  assert.equal(reconciledAlarm.periodInMinutes, schedule.WEEK_MINUTES);
  assert.equal(reconciledAlarm.scheduledTime, scheduledTime);
});

test("disabling weekly refresh also rolls back if the final setting write fails", async () => {
  const harness = createBackgroundHarness({
    sync: { [schedule.AUTO_REFRESH_KEY]: true }
  });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });
  const lastRefreshAt = Date.now();
  const oldAlarm = {
    name: schedule.ALARM_NAME,
    scheduledTime: lastRefreshAt + schedule.WEEK_MS,
    when: lastRefreshAt + schedule.WEEK_MS,
    periodInMinutes: schedule.WEEK_MINUTES
  };
  harness.local[schedule.LAST_REFRESH_KEY] = lastRefreshAt;
  harness.local[schedule.REFRESH_TICK_KEY] = lastRefreshAt - 1;
  harness.alarms.set(schedule.ALARM_NAME, clone(oldAlarm));
  harness.failNext("storage.sync.set");

  const response = await harness.sendMessage({
    type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
    enabled: false
  });
  assert.deepEqual(response, { ok: false, enabled: true });
  assert.equal(harness.sync[schedule.AUTO_REFRESH_KEY], true);
  assert.equal(harness.local[schedule.LAST_REFRESH_KEY], lastRefreshAt);
  assert.equal(harness.local[schedule.REFRESH_TICK_KEY], lastRefreshAt - 1);
  assert.deepEqual(harness.alarms.get(schedule.ALARM_NAME), oldAlarm);
});
