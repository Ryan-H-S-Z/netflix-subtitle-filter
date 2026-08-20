"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../src/video-identity.js");

function atom(value) {
  return { $type: "atom", value };
}

test("maps verified movie IDs and current episode IDs to catalog title IDs", () => {
  const videos = {
    "80000001": {
      summary: atom({ type: "movie", id: 80000001 })
    },
    "80000002": {
      summary: atom({ type: "show", id: 80000002 }),
      current: { $type: "ref", value: ["videos", "80000003"] }
    },
    "80000003": {
      summary: atom({ type: "episode", id: 80000003 })
    }
  };

  assert.deepEqual(identity.pairsFromVideoNodes(videos), [
    ["80000001", "80000001"],
    ["80000002", "80000002"],
    ["80000003", "80000002"]
  ]);
  assert.deepEqual(
    identity.pairsFromPayload({ jsonGraph: { videos } }, new Set(["80000003"])),
    [["80000003", "80000002"]]
  );
});

test("rejects incomplete, ambiguous, and guessed episode relationships", () => {
  const missingEpisodeTarget = {
    "80000002": {
      summary: atom({ type: "show" }),
      current: { $type: "ref", value: ["videos", "80000003"] }
    }
  };
  assert.deepEqual(identity.pairsFromVideoNodes(missingEpisodeTarget, ["80000003"]), []);

  const wrongReferenceType = {
    ...missingEpisodeTarget,
    "80000002": {
      summary: atom({ type: "show" }),
      current: { $type: "atom", value: ["videos", "80000003"] }
    },
    "80000003": { summary: atom({ type: "episode" }) }
  };
  assert.deepEqual(identity.pairsFromVideoNodes(wrongReferenceType, ["80000003"]), []);

  const conflict = identity.analyzePairs([
    ["80000003", "80000002"],
    ["80000003", "80000004"],
    [80000005, "80000005"],
    ["bad", "80000006"]
  ]);
  assert.deepEqual(conflict.pairs, []);
  assert.deepEqual(conflict.ambiguousIds, ["80000003"]);
  assert.deepEqual(identity.normalizePairs([
    ["80000003", "80000002"],
    ["80000003", "80000004"]
  ]), []);
});

test("extracts only same-origin explicit and watch IDs from strict Netflix links", () => {
  const base = "https://www.netflix.com/browse/genre/83";
  assert.deepEqual(identity.idsFromHref("/browse?jbv=80000001", base), {
    explicitIds: ["80000001"],
    watchId: null
  });
  assert.deepEqual(identity.idsFromHref("/title/80000002", base), {
    explicitIds: ["80000002"],
    watchId: null
  });
  assert.deepEqual(identity.idsFromHref("/watch/80000003?tctx=opaque", base), {
    explicitIds: [],
    watchId: "80000003"
  });
  assert.deepEqual(identity.idsFromHref("/watch/80000003?jbv=80000001", base), {
    explicitIds: ["80000001"],
    watchId: null
  });
  assert.deepEqual(identity.idsFromHref("https://example.com/watch/80000003", base), {
    explicitIds: [],
    watchId: null
  });
  assert.deepEqual(identity.idsFromHref("/watch/80000003/extra", base), {
    explicitIds: [],
    watchId: null
  });
});

test("keeps mixed card identities ambiguous until every watch ID maps to one title", () => {
  const explicit = new Set(["80000001"]);
  const watch = new Set(["80000002", "80000003"]);

  assert.deepEqual(
    [...identity.resolveStructuralIds(explicit, watch, new Map())],
    ["80000001", "80000002", "80000003"]
  );
  assert.deepEqual(
    [...identity.resolveStructuralIds(explicit, watch, new Map([
      ["80000002", "80000001"],
      ["80000003", "80000001"]
    ]))],
    ["80000001"]
  );
});

test("canonicalizes an explicit homepage ID when verified metadata maps it to a show", () => {
  assert.deepEqual(
    [...identity.resolveStructuralIds(
      new Set(["80000003"]),
      new Set(),
      new Map([["80000003", "80000001"]])
    )],
    ["80000001"]
  );
});

test("reports conflicting cache relationships so an old mapping can be quarantined", () => {
  const videos = {
    "80000001": {
      summary: atom({ type: "show", id: 80000001 }),
      current: { $type: "ref", value: ["videos", "80000003"] }
    },
    "80000002": {
      summary: atom({ type: "show", id: 80000002 }),
      current: { $type: "ref", value: ["videos", "80000003"] }
    },
    "80000003": {
      summary: atom({ type: "episode", id: 80000003 })
    }
  };

  assert.deepEqual(identity.analyzePayload({ videos }, ["80000003"]), {
    pairs: [],
    ambiguousIds: ["80000003"],
    complete: true
  });
});

test("quarantines derived episode mappings when the video graph is truncated", () => {
  const videos = {
    "1000": {
      summary: atom({ type: "show", id: 1000 }),
      current: { $type: "ref", value: ["videos", "2000"] }
    },
    "2000": {
      summary: atom({ type: "episode", id: 2000 })
    }
  };
  for (let id = 3000; id <= 23000; id += 1) {
    videos[String(id)] = {};
  }

  assert.deepEqual(identity.analyzeVideoNodes(videos, ["2000"]), {
    pairs: [],
    ambiguousIds: ["2000"],
    complete: false
  });
});

test("an incomplete payload keeps verified self IDs but quarantines derived IDs", () => {
  const videos = {
    "1000": {
      summary: atom({ type: "movie", id: 1000 })
    }
  };
  for (let id = 3000; id <= 23000; id += 1) {
    videos[String(id)] = {};
  }

  assert.deepEqual(identity.analyzePayload({ videos }, ["1000"]), {
    pairs: [["1000", "1000"]],
    ambiguousIds: [],
    complete: false
  });
});

test("marks payload arrays over the traversal cap as incomplete", () => {
  const payload = Array.from({ length: 101 }, () => ({}));
  payload[0] = {
    videos: {
      "1000": {
        summary: atom({ type: "show", id: 1000 }),
        current: { $type: "ref", value: ["videos", "2000"] }
      },
      "2000": {
        summary: atom({ type: "episode", id: 2000 })
      }
    }
  };

  assert.deepEqual(identity.analyzePayload(payload, ["2000"]), {
    pairs: [],
    ambiguousIds: ["2000"],
    complete: false
  });
});

test("does not preserve a self ID when payload traversal hides a later conflict", () => {
  const payload = Array.from({ length: 101 }, () => ({}));
  payload[0] = {
    videos: {
      "1000": {
        summary: atom({ type: "movie", id: 1000 })
      }
    }
  };
  payload[100] = {
    videos: {
      "1000": {
        summary: atom({ type: "episode", id: 1000 })
      },
      "2000": {
        summary: atom({ type: "show", id: 2000 }),
        current: { $type: "ref", value: ["videos", "1000"] }
      }
    }
  };

  assert.deepEqual(identity.analyzePayload(payload, ["1000"]), {
    pairs: [],
    ambiguousIds: ["1000"],
    complete: false
  });
});

test("safely parses JSON-compatible inline Falcor caches without executing suffix code", () => {
  globalThis.__nchInlineParserExecuted = false;
  const script = String.raw`
    before();
    window.netflix.falcorCache = {
      "label": "a { brace } and a \x20 space",
      "videos": {
        "1000": {
          "summary": {"$type":"atom","value":{"type":"show","id":1000}},
          "current": {"$type":"ref","value":["videos","2000"]}
        },
        "2000": {
          "summary": {"$type":"atom","value":{"type":"episode","id":2000}}
        }
      }
    };
    globalThis.__nchInlineParserExecuted = true;
  `;

  const caches = identity.parseInlineFalcorCaches(script);
  assert.equal(caches.length, 1);
  assert.equal(caches[0].label, "a { brace } and a   space");
  assert.equal(globalThis.__nchInlineParserExecuted, false);
  delete globalThis.__nchInlineParserExecuted;
});

test("accepts assignments only from executable code, not comments or literals", () => {
  const script = [
    "// window.netflix.falcorCache = {};",
    "/* window.netflix.falcorCache = {}; */",
    "const single = 'window.netflix.falcorCache = {};'",
    "const double = \"window.netflix.falcorCache = {};\"",
    "const template = `window.netflix.falcorCache = {};`",
    "const pattern = /window.netflix.falcorCache = {}/;",
    "window.netflix.falcorCache = {\"kind\":\"real\",\"videos\":{}};"
  ].join("\n");

  assert.deepEqual(identity.parseInlineFalcorCaches(script), [{ kind: "real", videos: {} }]);
});

test("normalizes adjacent lowercase JavaScript hex escapes without changing literal slashes or uppercase X", () => {
  const adjacent = identity.parseInlineFalcorCaches(
    String.raw`window.netflix.falcorCache={"kind":"\x41\x42","videos":{}};`
  );
  assert.equal(adjacent[0].kind, "AB");

  const literalSlash = identity.parseInlineFalcorCaches(
    String.raw`window.netflix.falcorCache={"kind":"\\x41","videos":{}};`
  );
  assert.equal(literalSlash[0].kind, String.raw`\x41`);

  assert.deepEqual(identity.parseInlineFalcorCaches(
    String.raw`window.netflix.falcorCache={"kind":"\X41","videos":{}};`
  ), []);
});

test("an unterminated assignment is scanned once and fails closed", () => {
  const script = `${"window.netflix.falcorCache = { ".repeat(2_000)} end`;
  assert.deepEqual(identity.parseInlineFalcorCaches(script), []);
});

test("extracts bounded type and show-reference facts that can be joined across responses", () => {
  const showFacts = identity.factsFromPayload({
    jsonGraph: {
      videos: {
        "1000": {
          summary: atom({ type: "show", id: 1000 }),
          current: { $type: "ref", value: ["videos", "2000"] }
        }
      }
    }
  });
  const episodeFacts = identity.factsFromPayload({
    value: {
      videos: {
        "2000": {
          summary: atom({ type: "episode", id: 2000 })
        }
      }
    }
  });

  assert.deepEqual(showFacts, {
    types: [["1000", "show"]],
    showRefs: [["2000", "1000"]],
    ambiguousIds: [],
    complete: true
  });
  assert.deepEqual(episodeFacts, {
    types: [["2000", "episode"]],
    showRefs: [],
    ambiguousIds: [],
    complete: true
  });
});

test("rejects incomplete or error-bearing evidence payloads", () => {
  const validVideos = {
    "1000": { summary: atom({ type: "movie", id: 1000 }) }
  };
  assert.equal(identity.factsFromPayload({ errors: [{ message: "partial" }], videos: validVideos }).complete, false);
  assert.equal(identity.factsFromPayload({ errors: { message: "partial" }, videos: validVideos }).complete, false);
  assert.equal(identity.factsFromPayload({ videos: validVideos }, 1).complete, true);

  const tooManyFacts = {
    videos: {
      "1000": { summary: atom({ type: "movie", id: 1000 }) },
      "2000": { summary: atom({ type: "movie", id: 2000 }) }
    }
  };
  assert.deepEqual(identity.factsFromPayload(tooManyFacts, 1), {
    types: [],
    showRefs: [],
    ambiguousIds: [],
    complete: false
  });
});

test("extracts requested homepage facts without spending the fact budget on unrelated cache nodes", () => {
  const videos = {};
  for (let index = 0; index < 3_000; index += 1) {
    const id = String(100_000 + index);
    videos[id] = { summary: atom({ type: "movie", id: Number(id) }) };
  }
  videos["9000"] = {
    summary: atom({ type: "show", id: 9000 }),
    current: { $type: "ref", value: ["videos", "9001"] }
  };
  videos["9001"] = { summary: atom({ type: "episode", id: 9001 }) };

  assert.deepEqual(
    identity.factsFromPayload({ videos }, 6, new Set(["9001"])),
    {
      types: [["9000", "show"], ["9001", "episode"]],
      showRefs: [["9001", "9000"]],
      ambiguousIds: [],
      complete: true
    }
  );
});
