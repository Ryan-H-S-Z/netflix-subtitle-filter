"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const projectRoot = path.resolve(__dirname, "..");
const config = require("../src/config.js");
const catalog = require("../src/netflix-catalog.js");
const latestCatalog = require("../src/latest-catalog.js");

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
    version: 5,
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

function latestSnapshot(overrides = {}) {
  const {
    ids = ["81414001", "81739044"],
    ...options
  } = overrides;
  return latestCatalog.createSnapshot(ids, {
    scope: "TH-profile-locale",
    generation: 0,
    listId: "latest-list",
    capturedAt: 1_800_000_000_000,
    ...options
  });
}

function checkpointSnapshot(previous, snapshot) {
  const epochEvidence = latestCatalog.sameSnapshotSet(previous, snapshot)
    && latestCatalog.validTransitionEvidence(previous?.epochEvidence, snapshot)
    ? previous.epochEvidence
    : latestCatalog.transitionEvidence(previous, snapshot);
  return { ...snapshot, epochEvidence };
}

function persistLatestLanguages(harness, snapshot) {
  if (!Object.hasOwn(harness.local, config.CATALOG_CACHE_KEY)) {
    harness.local[config.CATALOG_CACHE_KEY] = {
      version: 2,
      generation: snapshot.generation
    };
  }
  for (const code of snapshot.verifiedLanguages || []) {
    const storageKey = catalog.cacheRecordStorageKey(
      snapshot.scope,
      code,
      snapshot.generation
    );
    harness.local[storageKey] = validCacheRecord({
      generation: snapshot.generation,
      code,
      scope: snapshot.scope,
      genreId: config.LANGUAGES[code].genreId,
      latestEvidence: snapshot.epochEvidence,
      builtAt: Date.now()
    });
  }
}

function latestCommitMessage(previous, snapshot) {
  return {
    type: "NCH_COMMIT_LATEST_SNAPSHOT",
    scope: snapshot.scope,
    generation: snapshot.generation,
    expectedSnapshot: previous,
    catalogEvidence: snapshot.verifiedLanguages?.length
      ? snapshot.epochEvidence
      : undefined,
    snapshot
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
      [config.LATEST_SNAPSHOTS_KEY]: {
        version: 1,
        entries: {
          [scope]: latestSnapshot({ scope, generation: 2 })
        }
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
  assert.equal(Object.hasOwn(harness.local, config.LATEST_SNAPSHOTS_KEY), false);
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

test("latest snapshot protocol reads an empty checkpoint and commits the first snapshot", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const snapshot = checkpointSnapshot(null, latestSnapshot({
    scope,
    verifiedLanguages: ["zh-hans"]
  }));
  persistLatestLanguages(harness, snapshot);

  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_LATEST_SNAPSHOT", scope }),
    { ok: true, generation: 0, snapshot: null }
  );
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(null, snapshot)),
    { ok: true, written: true, generation: 0, snapshot }
  );
  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_LATEST_SNAPSHOT", scope }),
    { ok: true, generation: 0, snapshot }
  );
  assert.deepEqual(harness.local[config.LATEST_SNAPSHOTS_KEY], {
    version: 1,
    entries: { [scope]: snapshot }
  });
});

test("latest snapshot protocol checkpoints verified languages even when the IDs are unchanged", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const initial = checkpointSnapshot(null, latestSnapshot({
    scope,
    capturedAt: 1_800_000_000_000,
    verifiedLanguages: ["en"]
  }));
  const checkpoint = checkpointSnapshot(initial, latestSnapshot({
    scope,
    capturedAt: 1_800_000_000_100,
    verifiedLanguages: ["zh-hans", "en"]
  }));
  assert.equal(checkpoint.hash, initial.hash);

  persistLatestLanguages(harness, initial);
  await harness.sendMessage(latestCommitMessage(null, initial));
  persistLatestLanguages(harness, checkpoint);
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(initial, checkpoint)),
    { ok: true, written: true, generation: 0, snapshot: checkpoint }
  );
  assert.deepEqual(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[scope].verifiedLanguages,
    ["en", "zh-hans"]
  );

  const staleParallelCheckpoint = checkpointSnapshot(initial, latestSnapshot({
    scope,
    capturedAt: 1_800_000_000_200,
    verifiedLanguages: ["th"]
  }));
  persistLatestLanguages(harness, staleParallelCheckpoint);
  const merged = await harness.sendMessage(
    latestCommitMessage(initial, staleParallelCheckpoint)
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.snapshot.verifiedLanguages, ["en", "th", "zh-hans"]);
  assert.deepEqual(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[scope].verifiedLanguages,
    ["en", "th", "zh-hans"],
    "same-hash commits must not erase languages verified by another tab"
  );
});

test("latest snapshot commit uses the complete expected epoch as a compare-and-swap guard", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const current = checkpointSnapshot(null, latestSnapshot({ scope }));
  const replacement = checkpointSnapshot(current, latestSnapshot({
    scope,
    ids: ["81414001", "81818181"],
    capturedAt: current.capturedAt + 1
  }));
  const staleExpected = {
    ...current,
    capturedAt: current.capturedAt + 50
  };

  await harness.sendMessage(latestCommitMessage(null, current));
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(staleExpected, replacement)),
    { ok: false, conflict: true, generation: 0, snapshot: current }
  );
  assert.deepEqual(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[scope],
    current
  );
});

test("parallel A-to-B commits merge verified languages for the same exact B set", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const snapshotA = checkpointSnapshot(null, latestSnapshot({ scope }));
  const snapshotBEnglish = checkpointSnapshot(snapshotA, latestSnapshot({
    scope,
    ids: ["81414001", "81818181"],
    capturedAt: snapshotA.capturedAt + 1,
    verifiedLanguages: ["en"]
  }));
  const snapshotBThai = checkpointSnapshot(snapshotA, latestSnapshot({
    scope,
    ids: snapshotBEnglish.ids,
    capturedAt: snapshotA.capturedAt + 2,
    verifiedLanguages: ["th"]
  }));

  await harness.sendMessage(latestCommitMessage(null, snapshotA));
  persistLatestLanguages(harness, snapshotBEnglish);
  await harness.sendMessage(latestCommitMessage(snapshotA, snapshotBEnglish));
  persistLatestLanguages(harness, snapshotBThai);
  const merged = await harness.sendMessage(latestCommitMessage(snapshotA, snapshotBThai));

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.snapshot.verifiedLanguages, ["en", "th"]);
  assert.deepEqual(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[scope].verifiedLanguages,
    ["en", "th"]
  );
});

test("a later same-set commit cannot move the snapshot capture time backwards", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const newer = checkpointSnapshot(null, latestSnapshot({
    scope,
    capturedAt: 1_800_000_000_200,
    verifiedLanguages: ["en"]
  }));
  const olderFinishingLater = checkpointSnapshot(null, latestSnapshot({
    scope,
    ids: newer.ids,
    capturedAt: 1_800_000_000_100,
    verifiedLanguages: ["th"]
  }));

  persistLatestLanguages(harness, newer);
  await harness.sendMessage(latestCommitMessage(null, newer));
  persistLatestLanguages(harness, olderFinishingLater);
  const merged = await harness.sendMessage(
    latestCommitMessage(null, olderFinishingLater)
  );

  assert.equal(merged.snapshot.capturedAt, newer.capturedAt);
  assert.deepEqual(merged.snapshot.verifiedLanguages, ["en", "th"]);
  assert.equal(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[scope].capturedAt,
    newer.capturedAt
  );
});

test("a newer same-set checkpoint updates capture metadata even without new languages", async () => {
  const harness = createBackgroundHarness();
  const scope = "TH-profile-locale";
  const earlier = checkpointSnapshot(null, latestSnapshot({
    scope,
    capturedAt: 1_800_000_000_100,
    verifiedLanguages: ["en"]
  }));
  const newer = checkpointSnapshot(earlier, latestSnapshot({
    scope,
    ids: earlier.ids,
    listId: "latest-list-new",
    capturedAt: 1_800_000_000_200,
    verifiedLanguages: ["en"]
  }));

  persistLatestLanguages(harness, earlier);
  await harness.sendMessage(latestCommitMessage(null, earlier));
  const committed = await harness.sendMessage(latestCommitMessage(earlier, newer));

  assert.equal(committed.written, true);
  assert.equal(committed.snapshot.capturedAt, newer.capturedAt);
  assert.equal(committed.snapshot.listId, newer.listId);
});

test("latest snapshots are isolated by member scope and cache generation", async () => {
  const scope = "TH-profile-locale";
  const otherScope = "TH-other-profile-locale";
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 2, generation: 2 }
    }
  });
  const current = checkpointSnapshot(null, latestSnapshot({ scope, generation: 2 }));

  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(null, current)),
    { ok: true, written: true, generation: 2, snapshot: current }
  );
  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_LATEST_SNAPSHOT", scope: otherScope }),
    { ok: true, generation: 2, snapshot: null }
  );

  const stale = checkpointSnapshot(null, latestSnapshot({
    scope,
    generation: 1,
    capturedAt: current.capturedAt + 1
  }));
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(null, stale)),
    { ok: false, conflict: true, generation: 2 }
  );
  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_LATEST_SNAPSHOT", scope }),
    { ok: true, generation: 2, snapshot: current }
  );
});

test("a pre-epoch latest snapshot is ignored instead of bypassing verification", async () => {
  const scope = "TH-profile-locale";
  const legacySnapshot = latestSnapshot({ scope });
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 2, generation: 0 },
      [config.LATEST_SNAPSHOTS_KEY]: {
        version: 1,
        entries: { [scope]: legacySnapshot }
      }
    }
  });

  assert.deepEqual(
    await harness.sendMessage({ type: "NCH_GET_LATEST_SNAPSHOT", scope }),
    { ok: true, generation: 0, snapshot: null }
  );
});

test("latest snapshot refuses to checkpoint a language whose catalog was evicted", async () => {
  const harness = createBackgroundHarness();
  const snapshot = checkpointSnapshot(null, latestSnapshot({ verifiedLanguages: ["en"] }));

  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(null, snapshot)),
    {
      ok: false,
      persistenceConflict: true,
      generation: 0,
      snapshot: null
    }
  );
  assert.equal(Object.hasOwn(harness.local, config.LATEST_SNAPSHOTS_KEY), false);
});

test("latest snapshot accepts a complete catalog built after B without transition metadata", async () => {
  const now = Date.now();
  const harness = createBackgroundHarness({
    local: {
      [config.CATALOG_CACHE_KEY]: { version: 2, generation: 0 }
    }
  });
  const snapshot = checkpointSnapshot(null, latestSnapshot({
    capturedAt: now - 1_000,
    verifiedLanguages: ["en"]
  }));
  const storageKey = catalog.cacheRecordStorageKey(snapshot.scope, "en", 0);
  harness.local[storageKey] = validCacheRecord({
    code: "en",
    scope: snapshot.scope,
    genreId: config.LANGUAGES.en.genreId,
    builtAt: now
  });

  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(null, snapshot)),
    { ok: true, written: true, generation: 0, snapshot }
  );
});

test("latest snapshot CAS rejects A-to-B work after an A-to-C-to-A epoch change", async () => {
  const harness = createBackgroundHarness();
  const snapshotA1 = checkpointSnapshot(null, latestSnapshot({
    capturedAt: 1_800_000_000_000
  }));
  const staleB = checkpointSnapshot(snapshotA1, latestSnapshot({
    ids: ["81414001", "81818181"],
    capturedAt: 1_800_000_000_010
  }));
  const snapshotC = checkpointSnapshot(snapshotA1, latestSnapshot({
    ids: ["81414001", "81999999"],
    capturedAt: 1_800_000_000_020
  }));
  const snapshotA2 = checkpointSnapshot(snapshotC, latestSnapshot({
    ids: snapshotA1.ids,
    capturedAt: 1_800_000_000_030
  }));

  await harness.sendMessage(latestCommitMessage(null, snapshotA1));
  await harness.sendMessage(latestCommitMessage(snapshotA1, snapshotC));
  await harness.sendMessage(latestCommitMessage(snapshotC, snapshotA2));
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(snapshotA1, staleB)),
    { ok: false, conflict: true, generation: 0, snapshot: snapshotA2 }
  );
});

test("same target IDs do not merge verified languages from an older transition epoch", async () => {
  const harness = createBackgroundHarness();
  const snapshotA = checkpointSnapshot(null, latestSnapshot({
    capturedAt: 1_800_000_000_000
  }));
  const snapshotC = checkpointSnapshot(snapshotA, latestSnapshot({
    ids: ["81414001", "81999999"],
    capturedAt: 1_800_000_000_010
  }));
  const currentB = checkpointSnapshot(snapshotC, latestSnapshot({
    ids: ["81414001", "81818181"],
    capturedAt: 1_800_000_000_020,
    verifiedLanguages: ["th"]
  }));
  const staleB = checkpointSnapshot(snapshotA, latestSnapshot({
    ids: currentB.ids,
    capturedAt: 1_800_000_000_030,
    verifiedLanguages: ["en"]
  }));

  await harness.sendMessage(latestCommitMessage(null, snapshotA));
  await harness.sendMessage(latestCommitMessage(snapshotA, snapshotC));
  persistLatestLanguages(harness, currentB);
  await harness.sendMessage(latestCommitMessage(snapshotC, currentB));
  persistLatestLanguages(harness, staleB);
  assert.deepEqual(
    await harness.sendMessage(latestCommitMessage(snapshotA, staleB)),
    { ok: false, conflict: true, generation: 0, snapshot: currentB }
  );
  assert.deepEqual(
    harness.local[config.LATEST_SNAPSHOTS_KEY].entries[snapshotA.scope].verifiedLanguages,
    ["th"]
  );
});

test("extension update removes legacy weekly-refresh settings", async () => {
  const harness = createBackgroundHarness({
    local: {
      nchCatalogLastAutoRefreshAt: 1_700_000_000_000,
      nchCatalogAutoRefreshTick: 1_700_000_000_100,
      unrelatedLocal: "keep"
    },
    sync: {
      weeklyCacheRefresh: true,
      unrelatedSync: "keep"
    }
  });

  harness.chrome.runtime.onInstalled.dispatch({ reason: "update" });
  await harness.sendMessage({ type: "NCH_GET_CATALOG_CACHE_META" });

  assert.equal(Object.hasOwn(harness.sync, "weeklyCacheRefresh"), false);
  assert.equal(Object.hasOwn(harness.local, "nchCatalogLastAutoRefreshAt"), false);
  assert.equal(Object.hasOwn(harness.local, "nchCatalogAutoRefreshTick"), false);
  assert.equal(harness.sync.unrelatedSync, "keep");
  assert.equal(harness.local.unrelatedLocal, "keep");
});
