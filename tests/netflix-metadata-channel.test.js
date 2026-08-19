"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const identity = require("../src/video-identity.js");

const channelSource = fs.readFileSync(
  path.join(__dirname, "../src/netflix-metadata-channel.js"),
  "utf8"
);

function createHarness({ scripts = [], observeMutations = false } = {}) {
  const listeners = new Map();
  const tasks = [];
  const messages = [];
  let nextTimerId = 1;
  let mutationCallback = null;

  class FakeMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }

    observe() {}
  }

  const context = vm.createContext({
    NetflixSubtitleVideoIdentity: identity,
    location: { origin: "https://www.netflix.com" },
    document: {
      scripts,
      addEventListener() {}
    },
    MutationObserver: observeMutations ? FakeMutationObserver : undefined,
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setTimeout(callback) {
      const task = { id: nextTimerId, callback, cancelled: false };
      nextTimerId += 1;
      tasks.push(task);
      return task.id;
    },
    clearTimeout(timerId) {
      const task = tasks.find((candidate) => candidate.id === timerId);
      if (task) {
        task.cancelled = true;
      }
    }
  });
  vm.runInContext(channelSource, context);
  const contextGlobal = vm.runInContext("globalThis", context);

  function runNextTimer() {
    while (tasks.length) {
      const task = tasks.shift();
      if (!task.cancelled) {
        task.callback();
        return true;
      }
    }
    return false;
  }

  function runUntil(predicate, limit = 50) {
    let runs = 0;
    while (!predicate()) {
      assert.equal(runNextTimer(), true, "expected another scheduled task");
      runs += 1;
      assert.ok(runs <= limit, "channel timers should remain bounded");
    }
  }

  function drainTimers(limit = 50) {
    let runs = 0;
    while (runNextTimer()) {
      runs += 1;
      assert.ok(runs <= limit, "channel timers should settle");
    }
  }

  function dispatchBridge({ epoch, pairs = [], ambiguousIds = [], ack = true }) {
    listeners.get("message")({
      source: contextGlobal,
      origin: context.location.origin,
      data: {
        source: "nch-netflix-metadata-bridge",
        type: "NCH_VIDEO_ID_MAP",
        version: 1,
        epoch,
        ack,
        pairs,
        ambiguousIds
      }
    });
  }

  return {
    channel: context.NetflixSubtitleMetadataChannel,
    context,
    messages,
    dispatchBridge,
    drainTimers,
    runUntil,
    emitMutations(records) {
      mutationCallback?.(records);
    }
  };
}

test("coalesced A to B to A changes retain the newest acknowledged generation", () => {
  const harness = createHarness();

  harness.channel.request(new Set(["1000"]));
  harness.runUntil(() => harness.messages.length === 1);
  const firstEpoch = harness.messages[0].epoch;
  harness.dispatchBridge({ epoch: firstEpoch });
  harness.drainTimers();

  harness.channel.request(new Set(["2000"]));
  harness.channel.request(new Set(["1000"]));
  harness.runUntil(() => harness.messages.length === 2);
  const newest = harness.messages.at(-1);

  assert.deepEqual([...newest.ids], ["1000"]);
  assert.ok(newest.epoch > firstEpoch);
  harness.dispatchBridge({ epoch: newest.epoch });
  harness.drainTimers();
  assert.equal(harness.messages.length, 2, "an ACK should stop all bounded retries");
});

test("retries a lost request, stops after ACK, and rejects stale epoch data", () => {
  const harness = createHarness();

  harness.channel.request(["1000"]);
  harness.runUntil(() => harness.messages.length === 2);
  const firstEpoch = harness.messages[0].epoch;
  assert.equal(harness.messages[1].epoch, firstEpoch);
  harness.dispatchBridge({ epoch: firstEpoch });
  harness.drainTimers();
  assert.equal(harness.messages.length, 2);

  harness.channel.request(["2000"]);
  harness.runUntil(() => harness.messages.length === 3);
  const currentEpoch = harness.messages.at(-1).epoch;
  harness.dispatchBridge({
    epoch: firstEpoch,
    pairs: [["2000", "3000"]]
  });
  assert.deepEqual(Object.fromEntries(harness.channel.getMap()), {});

  harness.dispatchBridge({
    epoch: currentEpoch,
    pairs: [["2000", "3000"]]
  });
  harness.drainTimers();
  assert.deepEqual(Object.fromEntries(harness.channel.getMap()), { "2000": "3000" });
});

test("captures a removed inline bootstrap script and exposes only its verified active mapping", () => {
  const harness = createHarness({ observeMutations: true });
  const script = {
    tagName: "SCRIPT",
    parentElement: null,
    getAttribute() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    textContent: String.raw`
      window.netflix.falcorCache = {
        "label":"brace { text } and \x41",
        "videos":{
          "1000":{
            "summary":{"$type":"atom","value":{"type":"show","id":1000}},
            "current":{"$type":"ref","value":["videos","2000"]}
          },
          "2000":{"summary":{"$type":"atom","value":{"type":"episode","id":2000}}}
        }
      };
      globalThis.__nchShouldNeverRun = true;
    `
  };

  harness.emitMutations([{ addedNodes: [script] }]);
  harness.channel.request(["2000"]);

  assert.deepEqual(Object.fromEntries(harness.channel.getMap()), { "2000": "1000" });
  assert.equal(harness.context.__nchShouldNeverRun, undefined);
});
