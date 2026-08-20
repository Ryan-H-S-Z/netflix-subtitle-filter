"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../src/netflix-catalog.js");

test("builds the Falcor genre reference path", () => {
  assert.deepEqual(catalog.buildCatalogPath("81582792", 200, 399), [
    "genres",
    81582792,
    "su",
    { from: 200, to: 399 },
    "reference"
  ]);
});

test("builds a bounded Falcor title keyset path", () => {
  assert.deepEqual(catalog.buildTitlePath(["1000", "2000", "1000"]), [
    "videos",
    [1000, 2000],
    "title"
  ]);
  assert.throws(() => catalog.buildTitlePath(["bad"]), /无效编号/);
});

test("parses a complete localized title batch and rejects partial data", () => {
  const payload = {
    paths: [["videos"]],
    jsonGraph: {
      videos: {
        1000: { title: { $type: "atom", value: "  整部电视剧  " } },
        2000: { title: { $type: "atom", value: "ＡＢＣ" } }
      }
    }
  };
  assert.deepEqual(catalog.parseTitleBatch(payload, ["1000", "2000"]), [
    "整部电视剧",
    "abc"
  ]);
  assert.throws(
    () => catalog.parseTitleBatch(payload, ["1000", "3000"]),
    /不完整/
  );
  assert.deepEqual(
    catalog.parseTitleBatchEvidence(payload, ["1000", "3000"]),
    {
      titles: ["整部电视剧"],
      resolvedIds: ["1000"],
      missingIds: ["3000"],
      complete: false
    }
  );
});

test("extracts only validated video references from a catalog response", () => {
  const payload = {
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            0: { reference: { $type: "ref", value: ["videos", "81414001"] } },
            1: { $type: "ref", value: ["videos", "70155590"] },
            2: { reference: { $type: "ref", value: ["people", "12"] } },
            3: { reference: { $type: "ref", value: ["videos", "bad"] } }
          }
        }
      }
    }
  };

  assert.deepEqual(catalog.extractVideoIds(payload, "81582792"), {
    ids: ["81414001", "70155590"],
    referenceCount: 3,
    slotCount: 4,
    hasError: true
  });
});

test("rejects an invalid video reference ID instead of completing the catalog", () => {
  const payload = {
    paths: [["genres"]],
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            0: { reference: { $type: "ref", value: ["videos", "81414001"] } },
            1: { reference: { $type: "ref", value: ["videos", "bad"] } }
          }
        }
      }
    }
  };

  assert.throws(
    () => catalog.parseCatalogRange(payload, "81582792", 0, 1),
    /不完整/
  );
});

test("rejects a malformed HTTP 200 body instead of treating it as an empty complete catalog", () => {
  assert.throws(
    () => catalog.parseCatalogRange({ paths: [], jsonGraph: {} }, "81582792", 0, 1),
    /无法识别/
  );

  const emptyFirstRange = {
    paths: [["genres"]],
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            0: { reference: { $type: "atom" } },
            1: { reference: { $type: "atom" } }
          }
        }
      }
    }
  };
  assert.throws(
    () => catalog.parseCatalogRange(emptyFirstRange, "81582792", 0, 1),
    /空结果/
  );

  const validSlotsWithTopLevelError = {
    ...emptyFirstRange,
    errors: [{ message: "partial Falcor failure" }]
  };
  assert.throws(
    () => catalog.parseCatalogRange(validSlotsWithTopLevelError, "81582792", 0, 1),
    /无法识别/
  );

  const invalidErrorShape = {
    ...emptyFirstRange,
    errors: { message: "partial Falcor failure" }
  };
  assert.throws(
    () => catalog.parseCatalogRange(invalidErrorShape, "81582792", 0, 1),
    /无法识别/
  );

  const wrongNumericRange = {
    paths: [["genres"]],
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            200: { reference: { $type: "ref", value: ["videos", "81414001"] } },
            999: { reference: { $type: "atom" } }
          }
        }
      }
    }
  };
  assert.throws(
    () => catalog.parseCatalogRange(wrongNumericRange, "81582792", 200, 201),
    /不完整/
  );
});

test("accepts only consecutive video references followed by materialized terminal atoms", () => {
  const validTerminalRange = {
    paths: [["genres"]],
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            200: { reference: { $type: "ref", value: ["videos", "81414001"] } },
            201: { reference: { $type: "ref", value: ["videos", "70155590"] } },
            202: { reference: { $type: "atom" } },
            203: { reference: { $type: "atom" } }
          }
        }
      }
    }
  };

  assert.deepEqual(
    catalog.parseCatalogRange(validTerminalRange, "81582792", 200, 203),
    {
      ids: ["81414001", "70155590"],
      referenceCount: 2,
      slotCount: 4,
      hasError: false
    }
  );

  const allTerminalRange = {
    paths: [["genres"]],
    jsonGraph: {
      genres: {
        "81582792": {
          su: {
            400: { reference: { $type: "atom" } },
            401: { reference: { $type: "atom" } }
          }
        }
      }
    }
  };
  assert.deepEqual(
    catalog.parseCatalogRange(allTerminalRange, "81582792", 400, 401),
    { ids: [], referenceCount: 0, slotCount: 2, hasError: false }
  );

  const videoAfterTerminal = structuredClone(validTerminalRange);
  videoAfterTerminal.jsonGraph.genres["81582792"].su[203] = {
    reference: { $type: "ref", value: ["videos", "80000001"] }
  };
  assert.throws(
    () => catalog.parseCatalogRange(videoAfterTerminal, "81582792", 200, 203),
    /不完整/
  );

  const nonVideoReference = structuredClone(validTerminalRange);
  nonVideoReference.jsonGraph.genres["81582792"].su[201] = {
    reference: { $type: "ref", value: ["people", "70155590"] }
  };
  assert.throws(
    () => catalog.parseCatalogRange(nonVideoReference, "81582792", 200, 203),
    /不完整/
  );

  const unknownAtomShape = structuredClone(validTerminalRange);
  unknownAtomShape.jsonGraph.genres["81582792"].su[202] = {
    reference: { $type: "atom", value: null }
  };
  assert.throws(
    () => catalog.parseCatalogRange(unknownAtomShape, "81582792", 200, 203),
    /不完整/
  );
});

test("requires both country and profile scope before using the catalog cache", () => {
  const completeDocument = {
    documentElement: { lang: "zh-Hant" },
    scripts: [{
      src: "",
      textContent: '{"authURL":"auth","currentCountry":"TH","user":"user: profile-a"}'
    }]
  };
  const context = catalog.extractMemberContext(completeDocument);
  assert.equal(context.country, "TH");
  assert.equal(context.locale, "zh-hant");
  assert.match(context.scope, /^TH-/);
  assert.doesNotMatch(context.scope, /profile-a/);

  const missingCountry = structuredClone(completeDocument);
  missingCountry.scripts[0].textContent = '{"authURL":"auth","user":"user: profile-a"}';
  assert.throws(
    () => catalog.extractMemberContext(missingCountry),
    /暂停字幕筛选/
  );

  const missingProfile = structuredClone(completeDocument);
  missingProfile.scripts[0].textContent = '{"authURL":"auth","currentCountry":"TH"}';
  assert.throws(
    () => catalog.extractMemberContext(missingProfile),
    /暂停字幕筛选/
  );

  const missingLocale = structuredClone(completeDocument);
  missingLocale.documentElement.lang = "";
  assert.throws(
    () => catalog.extractMemberContext(missingLocale),
    /界面语言/
  );
});

test("decodes Netflix inline-script escape sequences without evaluating code", () => {
  assert.equal(
    catalog.decodeEmbeddedString("https:\\x2F\\x2Fwww.netflix.com\\/browse"),
    "https://www.netflix.com/browse"
  );
});

test("distinguishes an internal catalog timeout from a user-initiated abort", () => {
  const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(catalog.normalizeLanguageLoadError(abortError, false), abortError);

  const timeoutError = catalog.normalizeLanguageLoadError(abortError, true);
  assert.equal(timeoutError.name, "TimeoutError");
  assert.match(timeoutError.message, /超时/);
});

test("allows larger subtitle catalogs and never treats a truncated index as ready", () => {
  assert.equal(catalog.MAX_CATALOG_ITEMS, 50_000);

  const incomplete = {
    ids: new Set(["1000"]),
    complete: false,
    error: "catalog truncated"
  };
  const error = catalog.languageIndexError(incomplete);
  assert.equal(error.name, "IncompleteCatalogError");
  assert.equal(error.message, "catalog truncated");
  assert.equal(catalog.languageIndexError({ complete: true }), null);
});

test("keeps a freshly fetched complete index authoritative when only caching fails", () => {
  const fetched = {
    ids: new Set(["1000", "2000"]),
    titles: new Set(["one", "two"]),
    complete: true,
    titlesComplete: true
  };
  const index = catalog.uncachedFetchedIndex(fetched, "storage full");

  assert.equal(index.complete, true);
  assert.equal(index.titlesComplete, true);
  assert.equal(index.cached, false);
  assert.equal(index.uncached, true);
  assert.equal(index.cacheError, "storage full");
  assert.equal(catalog.languageIndexError(index), null);
});

test("keeps complete cache records until manual refresh for the same profile scope", () => {
  const now = Date.now();
  const record = {
    version: 5,
    generation: 4,
    code: "en",
    scope: "TH-test",
    genreId: "81582792",
    complete: true,
    ids: ["1000"],
    titles: ["whole show"],
    titlesComplete: true,
    titleSourceCount: 1,
    builtAt: now - (365 * 24 * 60 * 60 * 1000)
  };

  assert.equal(catalog.validCacheRecord(record, "en", "TH-test", now, 4), true);
  assert.equal(catalog.validCacheRecord(record, "en", "TH-test", now, 5), false);
  assert.equal(catalog.validCacheRecord({ ...record, complete: false }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({
    ...record,
    ids: [],
    titles: [],
    titlesComplete: false,
    titleSourceCount: 0
  }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord(record, "en", "TH-other", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, ids: ["bad"] }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, ids: [1000] }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, ids: ["1000", "1000"], titleSourceCount: 2 }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, titles: [""] }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, titles: [], titlesComplete: true }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, titleSourceCount: 0 }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, titleSourceCount: 2 }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({
    ...record,
    titlesComplete: false,
    titleSourceCount: 0
  }, "en", "TH-test", now), true);
  assert.equal(catalog.validCacheRecord({ ...record, genreId: "old" }, "en", "TH-test", now), false);
  assert.equal(catalog.validCacheRecord({ ...record, version: 4 }, "en", "TH-test", now), false);
});

test("uses generation-specific per-language storage keys", () => {
  assert.equal(
    catalog.cacheRecordStorageKey("TH-test", "en", 4),
    `${catalog.CACHE_RECORD_PREFIX}g4:TH-test:en`
  );
});

test("refreshes only records built before the latest weekly refresh tick", () => {
  assert.equal(catalog.cacheNeedsAutoRefresh({ builtAt: 1000 }, 1001), true);
  assert.equal(catalog.cacheNeedsAutoRefresh({ builtAt: 1001 }, 1001), false);
  assert.equal(catalog.cacheNeedsAutoRefresh({ builtAt: 2000 }, 1001), false);
  assert.equal(catalog.cacheNeedsAutoRefresh({ builtAt: 1000 }, 0), false);
});

test("keeps stale complete names only as positive evidence when name refresh fails", () => {
  const refreshed = {
    code: "zh-hant",
    ids: new Set(["1000", "2000"]),
    titles: new Set(),
    complete: true,
    titlesComplete: false,
    titleSourceCount: 0
  };
  const staleRecord = {
    ids: ["1000", "2000"],
    titles: ["old localized show"],
    titlesComplete: true,
    titleSourceCount: 1
  };

  const merged = catalog.preserveStalePositiveTitles(refreshed, staleRecord);
  assert.deepEqual(Array.from(merged.ids), ["1000", "2000"]);
  assert.deepEqual(Array.from(merged.titles), ["old localized show"]);
  assert.equal(merged.titlesComplete, false);
  assert.equal(merged.staleTitles, true);

  const partialUnion = catalog.preserveStalePositiveTitles({
    ...refreshed,
    titles: new Set(["new partial show"]),
    titleSourceCount: 2
  }, {
    ids: ["1000", "2000"],
    titles: ["old partial show"],
    titlesComplete: false,
    titleSourceCount: 2
  });
  assert.deepEqual(
    Array.from(partialUnion.titles),
    ["new partial show", "old partial show"]
  );
  assert.equal(partialUnion.titleSourceCount, 2);

  const completeRefresh = {
    ...refreshed,
    titles: new Set(["new localized show"]),
    titlesComplete: true,
    titleSourceCount: 2
  };
  assert.equal(
    catalog.preserveStalePositiveTitles(completeRefresh, staleRecord),
    completeRefresh
  );
});

test("converts a serialized cache winner back into an authoritative index", () => {
  const record = {
    ids: ["1000", "2000"],
    titles: ["show one"],
    titlesComplete: false,
    titleSourceCount: 1,
    builtAt: 1234
  };
  const index = catalog.cacheRecordToIndex(record, true);
  assert.deepEqual(Array.from(index.ids), ["1000", "2000"]);
  assert.deepEqual(Array.from(index.titles), ["show one"]);
  assert.equal(index.complete, true);
  assert.equal(index.titlesComplete, false);
  assert.equal(index.cached, true);
});
