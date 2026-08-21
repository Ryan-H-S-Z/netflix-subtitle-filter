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
    version: 3,
    enabled: true,
    showBadges: true,
    unsupportedMode: rules.UNSUPPORTED_MODE_MARK,
    groups: [["zh-hant"], ["en"]]
  });
});

test("migrates legacy unsupported-card behavior to hide and accepts mark mode", () => {
  const legacy = rules.normalizeFilter({
    version: 1,
    enabled: true,
    groups: [["en"]]
  });
  const marked = rules.normalizeFilter({
    ...legacy,
    unsupportedMode: "mark"
  });
  const invalid = rules.normalizeFilter({
    ...legacy,
    unsupportedMode: "unexpected"
  });

  assert.equal(legacy.version, 3);
  assert.equal(legacy.unsupportedMode, rules.UNSUPPORTED_MODE_HIDE);
  assert.equal(marked.unsupportedMode, rules.UNSUPPORTED_MODE_MARK);
  assert.equal(invalid.unsupportedMode, rules.UNSUPPORTED_MODE_HIDE);
});

test("migrates the old unchecked language-badge setting to show-and-mark mode", () => {
  const cases = [
    {
      input: { version: 2, showBadges: false, unsupportedMode: "hide" },
      expected: rules.UNSUPPORTED_MODE_MARK
    },
    {
      input: { version: 2, showBadges: true, unsupportedMode: "hide" },
      expected: rules.UNSUPPORTED_MODE_HIDE
    },
    {
      input: { version: 2, showBadges: false, unsupportedMode: "mark" },
      expected: rules.UNSUPPORTED_MODE_MARK
    },
    {
      input: { version: 3, showBadges: false, unsupportedMode: "hide" },
      expected: rules.UNSUPPORTED_MODE_HIDE
    }
  ];

  for (const { input, expected } of cases) {
    const normalized = rules.normalizeFilter({
      ...input,
      enabled: true,
      groups: [["en"]]
    });
    assert.equal(normalized.version, 3);
    assert.equal(normalized.showBadges, true);
    assert.equal(normalized.unsupportedMode, expected);
  }
});

test("maps the hide toggle to hide when checked and red-mark when unchecked", () => {
  assert.equal(
    rules.unsupportedModeFromHideToggle(true),
    rules.UNSUPPORTED_MODE_HIDE
  );
  assert.equal(
    rules.unsupportedModeFromHideToggle(false),
    rules.UNSUPPORTED_MODE_MARK
  );
});

test("resolves unsupported cards to either hide or a red-mark policy", () => {
  const hidden = rules.resolveCardDisplay(rules.NO_MATCH, {
    unsupportedMode: rules.UNSUPPORTED_MODE_HIDE,
    showBadges: true
  });
  const markedWithoutLanguageBadges = rules.resolveCardDisplay(rules.NO_MATCH, {
    unsupportedMode: rules.UNSUPPORTED_MODE_MARK,
    showBadges: false
  });
  const markedWithLanguageBadges = rules.resolveCardDisplay(rules.NO_MATCH, {
    unsupportedMode: rules.UNSUPPORTED_MODE_MARK,
    showBadges: true
  });

  assert.deepEqual(hidden, {
    hidden: true,
    markUnsupported: false,
    showLanguageBadge: false
  });
  assert.deepEqual(markedWithoutLanguageBadges, {
    hidden: false,
    markUnsupported: true,
    showLanguageBadge: false
  });
  assert.deepEqual(markedWithLanguageBadges, markedWithoutLanguageBadges);
});

test("unknown cards fail open and display policies do not retain the prior mode", () => {
  const marked = rules.resolveCardDisplay(rules.NO_MATCH, {
    unsupportedMode: rules.UNSUPPORTED_MODE_MARK,
    showBadges: false
  });
  const hidden = rules.resolveCardDisplay(rules.NO_MATCH, {
    unsupportedMode: rules.UNSUPPORTED_MODE_HIDE,
    showBadges: false
  });
  const unknown = rules.resolveCardDisplay(rules.UNKNOWN, {
    unsupportedMode: rules.UNSUPPORTED_MODE_MARK,
    showBadges: false
  });

  assert.equal(marked.markUnsupported, true);
  assert.deepEqual(hidden, {
    hidden: true,
    markUnsupported: false,
    showLanguageBadge: false
  });
  assert.deepEqual(unknown, {
    hidden: false,
    markUnsupported: false,
    showLanguageBadge: true
  });
  assert.deepEqual(
    rules.resolveCardDisplay(rules.UNKNOWN, {
      unsupportedMode: rules.UNSUPPORTED_MODE_HIDE,
      showBadges: true
    }),
    unknown
  );
});

test("matching and partially known cards always expose confirmed language evidence", () => {
  for (const resultState of [rules.MATCH, rules.UNKNOWN]) {
    assert.deepEqual(rules.resolveCardDisplay(resultState, { showBadges: true }), {
      hidden: false,
      markUnsupported: false,
      showLanguageBadge: true
    });
    assert.deepEqual(rules.resolveCardDisplay(resultState, { showBadges: false }), {
      hidden: false,
      markUnsupported: false,
      showLanguageBadge: true
    });
  }
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

test("retains confirmed languages when another required group is unknown", () => {
  const filter = {
    enabled: true,
    groups: [["zh-hans"], ["en"]]
  };
  const result = rules.evaluateTitle("100", filter, {
    "zh-hans": index(["100"], true),
    en: index([], false)
  });

  assert.equal(result.state, rules.UNKNOWN);
  assert.deepEqual(result.matchedLanguages, ["zh-hans"]);
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
