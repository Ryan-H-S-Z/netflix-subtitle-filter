"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/filter-rules.js");

function index(ids, complete = true) {
  return {
    ids: new Set(ids),
    complete,
    titles: new Set(),
    titlesComplete: false
  };
}

test("normalizes legacy group objects, duplicate languages, and empty groups", () => {
  const result = rules.normalizeFilter({
    enabled: true,
    showBadges: false,
    groups: [
      { languages: ["zh-hant", "zh-hant", "unknown"] },
      [],
      ["en"]
    ]
  });

  assert.deepEqual(result, {
    version: 1,
    enabled: true,
    showBadges: false,
    groups: [["zh-hant"], ["en"]]
  });
});

test("uses OR inside a condition group", () => {
  const filter = { enabled: true, groups: [["zh-hant", "zh-hans"]] };
  const result = rules.evaluateTitle("100", filter, {
    "zh-hant": index([]),
    "zh-hans": index(["100"])
  });

  assert.equal(result.state, rules.MATCH);
  assert.deepEqual(result.matchedLanguages, ["zh-hans"]);
});

test("uses AND between condition groups", () => {
  const filter = {
    enabled: true,
    groups: [["zh-hant", "zh-hans"], ["en"]]
  };
  const indexes = {
    "zh-hant": index([]),
    "zh-hans": index(["100"]),
    en: index(["100"])
  };

  assert.equal(rules.evaluateTitle("100", filter, indexes).state, rules.MATCH);
  assert.equal(rules.evaluateTitle("200", filter, indexes).state, rules.NO_MATCH);
});

test("fails open when a catalog is incomplete", () => {
  const filter = {
    enabled: true,
    groups: [["zh-hant", "zh-hans"], ["en"]]
  };
  const result = rules.evaluateTitle("100", filter, {
    "zh-hant": index([], false),
    "zh-hans": index([], true),
    en: index(["100"], true)
  });

  assert.equal(result.state, rules.UNKNOWN);
});

test("a known false AND group rejects even when another group is unknown", () => {
  assert.equal(rules.combineAnd([rules.UNKNOWN, rules.NO_MATCH]), rules.NO_MATCH);
  assert.equal(rules.combineOr([rules.UNKNOWN, rules.NO_MATCH]), rules.UNKNOWN);
});

test("disabled filters keep every title visible", () => {
  const result = rules.evaluateTitle("100", { enabled: false, groups: [["en"]] }, {});
  assert.equal(result.state, rules.MATCH);
});

test("matches a whole show by its exact normalized title when no canonical ID is available", () => {
  const filter = { enabled: true, groups: [["zh-hant"]] };
  const indexes = {
    "zh-hant": {
      ids: new Set(["1000"]),
      complete: true,
      titles: new Set(["整部电视剧"]),
      titlesComplete: true
    }
  };

  assert.equal(
    rules.evaluateTitle("", filter, indexes, "  整部电视剧 ").state,
    rules.MATCH
  );
  assert.equal(
    rules.evaluateTitle("", filter, indexes, "另一部电视剧").state,
    rules.NO_MATCH
  );
});

test("canonical show IDs stay authoritative and incomplete title catalogs fail open", () => {
  const filter = { enabled: true, groups: [["zh-hant"]] };
  const indexes = {
    "zh-hant": {
      ids: new Set(["1000"]),
      complete: true,
      titles: new Set(["同名节目"]),
      titlesComplete: false
    }
  };

  assert.equal(rules.evaluateTitle("2000", filter, indexes, "同名节目").state, rules.NO_MATCH);
  assert.equal(rules.evaluateTitle("", filter, indexes, "其他节目").state, rules.UNKNOWN);
});

test("an explicitly empty or invalid rule is disabled instead of silently filtering Chinese", () => {
  assert.equal(rules.normalizeFilter({ enabled: true, groups: [] }).enabled, false);
  assert.equal(rules.normalizeFilter({ enabled: true, groups: [["unknown"]] }).enabled, false);
});
