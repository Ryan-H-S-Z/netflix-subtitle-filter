"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const latest = require("../src/latest-catalog.js");

function atom(value) {
  return { $type: "atom", value };
}

function fieldRef(id, field) {
  return { $type: "ref", value: ["videos", id, field] };
}

function listSlot(id) {
  return Object.fromEntries(latest.LIST_FIELDS.map((field) => [
    field,
    field === "itemSummary"
      ? atom({ title: `Title ${id}` })
      : fieldRef(id, field)
  ]));
}

function fakeDocument({
  listId = "latest-list-1",
  length = 2,
  tracking = encodeURIComponent(JSON.stringify({ list_id: listId })),
  cacheContext = latest.LATEST_CONTEXT,
  extraCaches = [],
  selfTracking = false,
  includeLatestCache = true,
  memberScript = "",
  lang = "en-US"
} = {}) {
  const trackingElement = {
    getAttribute(name) {
      return name === "data-ui-tracking-context" ? tracking : null;
    }
  };
  const row = {
    getAttribute(name) {
      return selfTracking && name === "data-ui-tracking-context" ? tracking : null;
    },
    querySelector(selector) {
      assert.equal(selector, "[data-ui-tracking-context]");
      return trackingElement;
    }
  };
  const cache = {
    lists: {
      [listId]: {
        componentSummary: atom({ context: cacheContext, length })
      }
    }
  };
  const scripts = [
    { src: "https://example.test/external.js", textContent: "window.netflix.falcorCache={};" },
    {
      src: "",
      textContent: includeLatestCache
        ? `${memberScript}\nwindow.netflix.falcorCache=${JSON.stringify(cache)};`
        : memberScript
    },
    ...extraCaches.map((item) => ({
      src: "",
      textContent: `netflix.falcorCache=${JSON.stringify(item)};`
    }))
  ];
  return {
    scripts,
    documentElement: { lang },
    location: { origin: "https://www.netflix.com" },
    querySelector(selector) {
      assert.equal(selector, '[data-list-context="windowedNewReleases"]');
      return row;
    }
  };
}

function payloadFor(listId, ids) {
  return {
    paths: [["lists", listId]],
    jsonGraph: {
      lists: {
        [listId]: Object.fromEntries(ids.map((id, index) => [index, listSlot(id)]))
      }
    }
  };
}

function componentSummaryPayload(listId, length, context = latest.LATEST_CONTEXT) {
  return {
    paths: [["lists", listId, "componentSummary"]],
    jsonGraph: {
      lists: {
        [listId]: {
          componentSummary: atom({ context, length })
        }
      }
    }
  };
}

test("discovers and verifies the latest row from its first tracking context and inline Falcor cache", () => {
  const descriptor = latest.discoverLatestList(fakeDocument({
    listId: "abc-list",
    length: 37
  }));
  assert.deepEqual(descriptor, { listId: "abc-list", length: 37 });
  assert.equal(Object.isFrozen(descriptor), true);

  assert.deepEqual(
    latest.discoverLatestList(fakeDocument({
      selfTracking: true,
      tracking: JSON.stringify({ list_id: "latest-list-1" })
    })),
    { listId: "latest-list-1", length: 2 }
  );
});

test("accepts a jsonGraph-wrapped inline Falcor cache", () => {
  const listId = "wrapped-list";
  const documentObject = fakeDocument({
    listId,
    length: 4,
    cacheContext: "not-the-latest",
    extraCaches: [{
      jsonGraph: {
        lists: {
          [listId]: {
            componentSummary: atom({ context: latest.LATEST_CONTEXT, length: 4 })
          }
        }
      }
    }]
  });
  assert.deepEqual(latest.discoverLatestList(documentObject), { listId, length: 4 });
});

test("latest-row discovery fails closed for missing, malformed, unsafe, or conflicting evidence", () => {
  const noRow = fakeDocument();
  noRow.querySelector = () => null;
  assert.throws(() => latest.discoverLatestList(noRow), (error) => {
    assert.match(error.message, /was not found/);
    assert.equal(latest.isPageNotReadyError(error), true);
    return true;
  });

  assert.throws(
    () => latest.discoverLatestList(fakeDocument({ tracking: "not-json" })),
    /invalid tracking context/
  );
  assert.throws(
    () => latest.discoverLatestList(fakeDocument({ tracking: JSON.stringify({ list_id: "__proto__" }) })),
    /valid list_id/
  );
  assert.throws(
    () => latest.discoverLatestList(fakeDocument({ cacheContext: "other" })),
    /could not be verified/
  );
  assert.throws(
    () => latest.discoverLatestList(fakeDocument({ length: 0 })),
    /unsafe length/
  );
  assert.throws(
    () => latest.discoverLatestList(fakeDocument({ length: 201 })),
    /unsafe length/
  );

  const listId = "conflicting-list";
  const conflicting = fakeDocument({
    listId,
    length: 2,
    extraCaches: [{
      lists: {
        [listId]: {
          componentSummary: atom({ context: latest.LATEST_CONTEXT, length: 3 })
        }
      }
    }]
  });
  assert.throws(() => latest.discoverLatestList(conflicting), /inconsistent/);
});

test("builds the bounded latest-list Falcor path with the exact field set", () => {
  assert.deepEqual(latest.buildListPath("new-items", 3), [
    "lists",
    "new-items",
    { from: 0, to: 2 },
    [
      "availability",
      "episodeCount",
      "inRemindMeList",
      "itemSummary",
      "queue",
      "summary"
    ]
  ]);
  assert.throws(() => latest.buildListPath("new-items", 0), /invalid/);
  assert.throws(() => latest.buildListPath("new-items", 201), /invalid/);
  assert.throws(() => latest.buildListPath("__proto__", 1), /invalid/);
});

test("builds and strictly parses a latest component-summary request", () => {
  assert.deepEqual(latest.buildComponentSummaryPath("new-items"), [
    "lists",
    "new-items",
    "componentSummary"
  ]);
  assert.deepEqual(
    latest.parseComponentSummaryPayload(componentSummaryPayload("new-items", 40), "new-items"),
    { listId: "new-items", length: 40 }
  );
  assert.throws(() => latest.buildComponentSummaryPath("__proto__"), /invalid/);

  const wrongContext = componentSummaryPayload("new-items", 40, "other");
  assert.throws(
    () => latest.parseComponentSummaryPayload(wrongContext, "new-items"),
    /invalid/
  );
  const wrongList = componentSummaryPayload("other-items", 40);
  assert.throws(
    () => latest.parseComponentSummaryPayload(wrongList, "new-items"),
    /unrecognized/
  );
  const wrongPath = componentSummaryPayload("new-items", 40);
  wrongPath.paths = [["lists", "different", "componentSummary"]];
  assert.throws(
    () => latest.parseComponentSummaryPayload(wrongPath, "new-items"),
    /unrecognized/
  );
  const responseError = componentSummaryPayload("new-items", 40);
  responseError.errors = [{ message: "partial" }];
  assert.throws(
    () => latest.parseComponentSummaryPayload(responseError, "new-items"),
    /unrecognized/
  );
  assert.throws(
    () => latest.parseComponentSummaryPayload(componentSummaryPayload("new-items", 201), "new-items"),
    /invalid/
  );
});

test("parses exact contiguous list slots into unique video IDs", () => {
  const payload = payloadFor("new-items", ["80000001", "70000002", "90000003"]);
  assert.deepEqual(
    latest.parseListPayload(payload, "new-items", 3),
    ["80000001", "70000002", "90000003"]
  );
});

test("rejects partial, error-bearing, non-video, malformed, and duplicate list responses", () => {
  assert.throws(
    () => latest.parseListPayload({ paths: [], jsonGraph: {} }, "new-items", 1),
    /unrecognized/
  );

  const responseError = payloadFor("new-items", ["80000001"]);
  responseError.errors = [{ message: "partial" }];
  assert.throws(() => latest.parseListPayload(responseError, "new-items", 1), /unrecognized/);

  const gap = payloadFor("new-items", ["80000001", "80000002"]);
  gap.jsonGraph.lists["new-items"][2] = gap.jsonGraph.lists["new-items"][1];
  delete gap.jsonGraph.lists["new-items"][1];
  assert.throws(() => latest.parseListPayload(gap, "new-items", 2), /incomplete/);

  const extra = payloadFor("new-items", ["80000001"]);
  extra.jsonGraph.lists["new-items"][1] = listSlot("80000002");
  assert.throws(() => latest.parseListPayload(extra, "new-items", 1), /incomplete/);

  const nonVideo = payloadFor("new-items", ["80000001"]);
  nonVideo.jsonGraph.lists["new-items"][0].summary = {
    $type: "ref",
    value: ["people", "80000001", "summary"]
  };
  assert.throws(() => latest.parseListPayload(nonVideo, "new-items", 1), /invalid or inconsistent/);

  const malformed = payloadFor("new-items", ["80000001"]);
  malformed.jsonGraph.lists["new-items"][0].summary = fieldRef("bad", "summary");
  assert.throws(() => latest.parseListPayload(malformed, "new-items", 1), /invalid or inconsistent/);

  const inconsistent = payloadFor("new-items", ["80000001"]);
  inconsistent.jsonGraph.lists["new-items"][0].summary = fieldRef("80000002", "summary");
  assert.throws(() => latest.parseListPayload(inconsistent, "new-items", 1), /invalid or inconsistent/);

  const missingField = payloadFor("new-items", ["80000001"]);
  delete missingField.jsonGraph.lists["new-items"][0].queue;
  assert.throws(() => latest.parseListPayload(missingField, "new-items", 1), /incomplete/);

  const duplicate = payloadFor("new-items", ["80000001", "80000001"]);
  assert.throws(() => latest.parseListPayload(duplicate, "new-items", 2), /invalid or duplicate/);
});

test("semantic hashes are FNV-style, valid, and independent of item order", () => {
  const forward = latest.semanticHash(["80000001", "70000002"]);
  const reverse = latest.semanticHash(["70000002", "80000001"]);
  assert.equal(forward, reverse);
  assert.equal(latest.validHash(forward), true);
  assert.equal(latest.validHash(forward.toUpperCase()), false);
  assert.equal(latest.validHash("abc"), false);
  assert.notEqual(forward, latest.semanticHash(["80000001", "70000003"]));

  const collisionA = latest.createSnapshot(["10462789"], {
    scope: "TH-profile-locale",
    listId: "latest-collision",
    generation: 0,
    capturedAt: 1_800_000_000_000
  });
  const collisionB = latest.createSnapshot(["10679192"], {
    scope: collisionA.scope,
    listId: collisionA.listId,
    generation: collisionA.generation,
    capturedAt: collisionA.capturedAt + 1
  });
  assert.equal(collisionA.hash, collisionB.hash, "fixture must exercise a real FNV collision");
  assert.equal(latest.sameSnapshotSet(collisionA, collisionB), false);
  assert.equal(latest.diffSnapshots(collisionA, collisionB).changed, true);
  const collisionTarget = latest.createSnapshot(["90000003"], {
    scope: collisionA.scope,
    listId: collisionA.listId,
    generation: collisionA.generation,
    capturedAt: collisionA.capturedAt + 2
  });
  assert.notEqual(
    latest.transitionEvidence(collisionA, collisionTarget),
    latest.transitionEvidence(collisionB, collisionTarget),
    "transition evidence must carry the exact previous set, not only its hash"
  );
});

test("creates sorted, scoped, generation-bound snapshots and validates their semantic hash", () => {
  const snapshot = latest.createSnapshot(["90000003", "70000001", "80000002"], {
    scope: "TH-profile-locale",
    listId: "latest-a",
    generation: 6,
    capturedAt: 1_800_000_000_000,
    verifiedLanguages: ["en", "zh-Hant"]
  });
  assert.deepEqual(snapshot.ids, ["70000001", "80000002", "90000003"]);
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.verifiedLanguages, ["en", "zh-Hant"]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.ids), true);
  assert.equal(latest.validSnapshot(snapshot, "TH-profile-locale", 6), true);
  assert.equal(latest.validSnapshot(snapshot, "US-profile-locale", 6), false);
  assert.equal(latest.validSnapshot(snapshot, "TH-profile-locale", 7), false);

  assert.equal(latest.validSnapshot({ ...snapshot, hash: "00000000" }, snapshot.scope, 6), false);
  assert.equal(latest.validSnapshot({ ...snapshot, ids: snapshot.ids.slice().reverse() }, snapshot.scope, 6), false);
  assert.equal(latest.validSnapshot({ ...snapshot, complete: false }, snapshot.scope, 6), false);
  assert.equal(latest.validSnapshot({
    ...snapshot,
    verifiedLanguages: ["zh-Hant", "en"]
  }, snapshot.scope, 6), false);
  assert.throws(
    () => latest.createSnapshot(["80000001", "80000001"], {
      scope: snapshot.scope,
      listId: snapshot.listId,
      generation: 6
    }),
    /invalid/
  );
  assert.throws(
    () => latest.createSnapshot(["80000001"], {
      scope: snapshot.scope,
      listId: snapshot.listId,
      generation: 6,
      verifiedLanguages: ["en", "en"]
    }),
    /verified languages/
  );
});

test("diffs snapshots as B minus A without depending on display order", () => {
  const options = {
    scope: "TH-profile-locale",
    listId: "latest-list",
    generation: 2,
    capturedAt: 1_800_000_000_000
  };
  const before = latest.createSnapshot(["70000001", "80000002"], options);
  const after = latest.createSnapshot(["90000003", "80000002"], {
    ...options,
    listId: "latest-list-b",
    capturedAt: options.capturedAt + 1
  });
  assert.deepEqual(latest.diffSnapshots(before, after), {
    added: ["90000003"],
    removed: ["70000001"],
    unchanged: ["80000002"],
    changed: true,
    previousHash: before.hash,
    nextHash: after.hash
  });
  assert.deepEqual(latest.diffSnapshots(null, after), {
    added: ["80000002", "90000003"],
    removed: [],
    unchanged: [],
    changed: true,
    previousHash: null,
    nextHash: after.hash
  });

  const otherGeneration = latest.createSnapshot(after.ids, {
    ...options,
    generation: 3,
    capturedAt: options.capturedAt + 2
  });
  assert.throws(() => latest.diffSnapshots(before, otherGeneration), /different cache scopes/);
});

test("binds catalog evidence to the complete latest transition epoch", () => {
  const base = {
    scope: "TH-profile-en-US",
    listId: "latest-list",
    generation: 2
  };
  const a1 = latest.createSnapshot(["1000", "2000"], {
    ...base,
    capturedAt: 1_800_000_000_000
  });
  const a2 = latest.createSnapshot(["1000", "2000"], {
    ...base,
    capturedAt: 1_800_000_000_100
  });
  const b = latest.createSnapshot(["1000", "2000", "3000"], {
    ...base,
    capturedAt: 1_800_000_000_200
  });

  assert.equal(
    latest.transitionEvidence(null, a1),
    `none:0:>${a1.hash}:${a1.ids.join(",")}`
  );
  assert.equal(
    latest.transitionEvidence(a1, b),
    `${a1.hash}:${a1.capturedAt}:${a1.ids.join(",")}>${b.hash}:${b.ids.join(",")}`
  );
  assert.equal(latest.validTransitionEvidence(latest.transitionEvidence(a1, b), b), true);
  assert.equal(latest.validTransitionEvidence(latest.transitionEvidence(a1, b), a1), false);
  assert.notEqual(
    latest.transitionEvidence(a1, b),
    latest.transitionEvidence(a2, b),
    "the same target set must not reuse evidence from an older A epoch"
  );
});

test("fetchSnapshot posts the verified list path and authURL through the member endpoint", async () => {
  const listId = "latest-fetch-list";
  const memberScript = String.raw`const boot={"authURL":"auth-token","currentCountry":"TH","user":"user:\x20profile-7"};`;
  const documentObject = fakeDocument({ listId, length: 2, memberScript, lang: "en-US" });
  const controller = new AbortController();
  let request;
  const snapshot = await latest.fetchSnapshot(documentObject, {
    generation: 9,
    capturedAt: 1_900_000_000_000,
    signal: controller.signal,
    async fetch(url, init) {
      request = { url, init };
      return {
        ok: true,
        status: 200,
        async json() {
          return payloadFor(listId, ["90000003", "70000001"]);
        }
      };
    }
  });

  assert.match(request.url, /^https:\/\/www\.netflix\.com\/nq\/website\/memberapi\/release\/pathEvaluator\?/);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.credentials, "include");
  assert.equal(request.init.signal, controller.signal);
  assert.equal(request.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(request.init.body.get("authURL"), "auth-token");
  assert.deepEqual(JSON.parse(request.init.body.get("path")), latest.buildListPath(listId, 2));
  assert.deepEqual(snapshot.ids, ["70000001", "90000003"]);
  assert.equal(snapshot.generation, 9);
  assert.equal(snapshot.listId, listId);
  assert.equal(snapshot.capturedAt, 1_900_000_000_000);
  assert.equal(latest.validSnapshot(snapshot, snapshot.scope, 9), true);
});

test("fetchSnapshot verifies componentSummary before the list after an SPA route change", async () => {
  const listId = "latest-spa-list";
  const memberScript = String.raw`const boot={"authURL":"spa-token","currentCountry":"TH","user":"user:\x20profile-spa"};`;
  const documentObject = fakeDocument({
    listId,
    length: 2,
    memberScript,
    includeLatestCache: false
  });
  const requests = [];
  const snapshot = await latest.fetchSnapshot(documentObject, {
    generation: 4,
    capturedAt: 1_900_000_000_001,
    async fetch(url, init) {
      const path = JSON.parse(init.body.get("path"));
      requests.push({ url, init, path });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => componentSummaryPayload(listId, 2)
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => payloadFor(listId, ["80000002", "70000001"])
      };
    }
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].path, latest.buildComponentSummaryPath(listId));
  assert.deepEqual(requests[1].path, latest.buildListPath(listId, 2));
  assert.equal(requests[0].init.body.get("authURL"), "spa-token");
  assert.equal(requests[1].init.body.get("authURL"), "spa-token");
  assert.equal(requests[0].url, requests[1].url);
  assert.deepEqual(snapshot.ids, ["70000001", "80000002"]);
  assert.equal(latest.validSnapshot(snapshot, snapshot.scope, 4), true);
});

test("fetchSnapshot can require the current summary instead of a stale inline length", async () => {
  const listId = "latest-revisit-list";
  const memberScript = String.raw`const boot={"authURL":"revisit-token","currentCountry":"TH","user":"user:\x20profile-revisit"};`;
  const documentObject = fakeDocument({
    listId,
    length: 1,
    memberScript
  });
  const paths = [];
  const snapshot = await latest.fetchSnapshot(documentObject, {
    generation: 5,
    capturedAt: 1_900_000_000_002,
    requireFreshSummary: true,
    async fetch(_url, init) {
      const path = JSON.parse(init.body.get("path"));
      paths.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => paths.length === 1
          ? componentSummaryPayload(listId, 2)
          : payloadFor(listId, ["80000002", "70000001"])
      };
    }
  });

  assert.deepEqual(paths, [
    latest.buildComponentSummaryPath(listId),
    latest.buildListPath(listId, 2)
  ]);
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot.ids, ["70000001", "80000002"]);
});

test("fetchSnapshot rejects an unsuccessful member API response", async () => {
  const documentObject = fakeDocument({
    length: 1,
    memberScript: String.raw`const boot={"authURL":"auth-token","currentCountry":"TH","user":"user:\x20profile-7"};`
  });
  await assert.rejects(
    latest.fetchSnapshot(documentObject, {
      fetch: async () => ({ ok: false, status: 503 })
    }),
    /503/
  );
});
