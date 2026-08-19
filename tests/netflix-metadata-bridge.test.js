"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const identityModule = require("../src/video-identity.js");

const bridgeSource = fs.readFileSync(
  path.join(__dirname, "../src/netflix-metadata-bridge.js"),
  "utf8"
);

test("a genuinely new active ID set receives a fresh bounded scan generation", () => {
  const listeners = new Map();
  const tasks = [];
  const scans = [];
  let nextTimerId = 1;

  const identity = {
    MAX_PAIRS: 128,
    isValidId(value) {
      return /^\d{4,20}$/.test(String(value || ""));
    },
    normalizePairs(pairs) {
      return pairs;
    },
    analyzePayload(_payload, ids) {
      const requested = [...ids];
      scans.push(requested);
      return {
        pairs: ids.has("1000") ? [["1000", "1000"]] : [],
        ambiguousIds: [],
        complete: true
      };
    }
  };

  const context = vm.createContext({
    NetflixSubtitleVideoIdentity: identity,
    netflix: { falcorCache: {} },
    location: { origin: "https://www.netflix.com" },
    postMessage() {},
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
  vm.runInContext(bridgeSource, context);
  const contextGlobal = vm.runInContext("globalThis", context);

  function dispatch(ids, epoch) {
    listeners.get("message")({
      source: contextGlobal,
      origin: context.location.origin,
      data: {
        source: "nch-netflix-card-filter",
        type: "NCH_REQUEST_VIDEO_ID_MAP",
        version: 1,
        epoch,
        ids
      }
    });
  }

  function runAllTimers(limit = 1000) {
    let runs = 0;
    while (tasks.length) {
      const task = tasks.shift();
      if (!task.cancelled) {
        task.callback();
        runs += 1;
      }
      assert.ok(runs <= limit, "bounded bridge timers should settle");
    }
  }

  dispatch(["1000", "2000"], 1);
  runAllTimers();
  assert.deepEqual(scans[0], ["1000", "2000"]);
  assert.deepEqual(scans.at(-1), ["2000"]);

  const exhaustedScanCount = scans.length;
  dispatch(["2000"], 2);
  assert.ok(tasks.length > 0, "the changed external set should start a new generation");
  runAllTimers();
  assert.ok(scans.length > exhaustedScanCount);

  const sameSetScanCount = scans.length;
  dispatch(["2000"], 3);
  assert.ok(tasks.length > 0, "a new epoch should restart even when the IDs are unchanged");
  runAllTimers();
  assert.ok(scans.length > sameSetScanCount);
});

function observedPayload() {
  return {
    jsonGraph: {
      videos: {
        "1000": {
          summary: { $type: "atom", value: { type: "show", id: 1000 } },
          current: { $type: "ref", value: ["videos", "2000"] }
        },
        "2000": {
          summary: { $type: "atom", value: { type: "episode", id: 2000 } }
        }
      }
    }
  };
}

function makeTimerQueue() {
  const tasks = [];
  let nextId = 1;
  return {
    tasks,
    setTimeout(callback) {
      const task = { id: nextId, callback, cancelled: false };
      nextId += 1;
      tasks.push(task);
      return task.id;
    },
    clearTimeout(id) {
      const task = tasks.find((candidate) => candidate.id === id);
      if (task) {
        task.cancelled = true;
      }
    }
  };
}

test("passive fetch observation returns the exact original promise and joins strict evidence", async () => {
  const endpoint = "https://www.netflix.com/nq/website/memberapi/release/pathEvaluator";
  const listeners = new Map();
  const messages = [];
  const timers = makeTimerQueue();
  const encoded = new TextEncoder().encode(JSON.stringify(observedPayload()));
  let reads = 0;
  const response = {
    status: 200,
    url: endpoint,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-length") {
          return String(encoded.byteLength);
        }
        if (String(name).toLowerCase() === "content-type") {
          return "application/json; charset=utf-8";
        }
        return null;
      }
    },
    clone() {
      return {
        body: {
          getReader() {
            return {
              read() {
                reads += 1;
                return Promise.resolve(reads === 1
                  ? { done: false, value: encoded }
                  : { done: true, value: undefined });
              },
              cancel() {
                return Promise.resolve();
              }
            };
          }
        }
      };
    }
  };
  const originalPromise = Promise.resolve(response);
  function originalFetch() {
    return originalPromise;
  }

  const context = vm.createContext({
    NetflixSubtitleVideoIdentity: identityModule,
    location: {
      origin: "https://www.netflix.com",
      href: "https://www.netflix.com/browse/genre/83"
    },
    document: { scripts: [] },
    fetch: originalFetch,
    URL,
    TextDecoder,
    Uint8Array,
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  vm.runInContext(bridgeSource, context);
  const contextGlobal = vm.runInContext("globalThis", context);

  const returnedPromise = context.fetch(endpoint, { method: "POST" });
  assert.strictEqual(returnedPromise, originalPromise);
  await new Promise((resolve) => setImmediate(resolve));

  listeners.get("message")({
    source: contextGlobal,
    origin: context.location.origin,
    data: {
      source: "nch-netflix-card-filter",
      type: "NCH_REQUEST_VIDEO_ID_MAP",
      version: 1,
      epoch: 7,
      ids: ["2000"]
    }
  });

  const mappingMessage = messages.find((message) => message.pairs?.length);
  assert.ok(mappingMessage, "evidence observed before the request should be retained in memory");
  assert.equal(mappingMessage.epoch, 7);
  assert.equal(mappingMessage.ack, true);
  assert.deepEqual(Array.from(mappingMessage.pairs, (pair) => Array.from(pair)), [["2000", "1000"]]);
});

test("passive XHR observation preserves open/send results and publishes the active mapping", () => {
  const endpoint = "https://www.netflix.com/nq/website/memberapi/release/pathEvaluator";
  const listeners = new Map();
  const messages = [];
  const timers = makeTimerQueue();
  const text = JSON.stringify(observedPayload());

  class FakeXhr {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.responseURL = endpoint;
      this.responseType = "";
      this.responseText = text;
    }

    open() {
      return "open-result";
    }

    send() {
      return "send-result";
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    getResponseHeader(name) {
      if (String(name).toLowerCase() === "content-length") {
        return String(Buffer.byteLength(text));
      }
      if (String(name).toLowerCase() === "content-type") {
        return "application/json";
      }
      return null;
    }
  }

  const context = vm.createContext({
    NetflixSubtitleVideoIdentity: identityModule,
    location: {
      origin: "https://www.netflix.com",
      href: "https://www.netflix.com/browse/genre/83"
    },
    document: { scripts: [] },
    XMLHttpRequest: FakeXhr,
    URL,
    Uint8Array,
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  vm.runInContext(bridgeSource, context);
  const contextGlobal = vm.runInContext("globalThis", context);
  listeners.get("message")({
    source: contextGlobal,
    origin: context.location.origin,
    data: {
      source: "nch-netflix-card-filter",
      type: "NCH_REQUEST_VIDEO_ID_MAP",
      version: 1,
      epoch: 9,
      ids: ["2000"]
    }
  });

  const xhr = new context.XMLHttpRequest();
  assert.equal(xhr.open("POST", endpoint), "open-result");
  assert.equal(xhr.send("opaque-body"), "send-result");
  xhr.listeners.get("loadend")();

  const mappingMessage = messages.find((message) => message.pairs?.length);
  assert.ok(mappingMessage);
  assert.equal(mappingMessage.epoch, 9);
  assert.deepEqual(Array.from(mappingMessage.pairs, (pair) => Array.from(pair)), [["2000", "1000"]]);
});
