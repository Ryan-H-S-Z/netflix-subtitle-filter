"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config.js");

test("builds the verified Netflix Chinese subtitle catalog URLs", () => {
  assert.equal(
    config.getFilterUrl("zh-hant"),
    "https://www.netflix.com/browse/subtitles/81586250/zh-hant"
  );
  assert.equal(
    config.getFilterUrl("zh-hans"),
    "https://www.netflix.com/browse/subtitles/81582910/zh-hans"
  );
  assert.equal(
    config.getFilterUrl("en"),
    "https://www.netflix.com/browse/subtitles"
  );
});

test("falls back to Traditional Chinese for an unknown language", () => {
  assert.equal(config.getLanguage("unknown").code, "zh-hant");
});

test("recognizes only the main Netflix host", () => {
  assert.equal(config.isNetflixUrl("https://www.netflix.com/watch/123"), true);
  assert.equal(config.isNetflixUrl("https://help.netflix.com/en/node/372"), false);
  assert.equal(config.isNetflixUrl("not a url"), false);
});

test("recognizes every supported Netflix card browsing route", () => {
  for (const path of [
    "/browse",
    "/browse/genre/83",
    "/browse/my-list",
    "/latest",
    "/search",
    "/title/81234567"
  ]) {
    assert.equal(config.isCardFilterPath(path), true, path);
  }

  for (const path of [
    "/browse/subtitles",
    "/browse/subtitles/81586250/zh-hant",
    "/watch/81234567",
    "/account",
    "/"
  ]) {
    assert.equal(config.isCardFilterPath(path), false, path);
  }
});

test("promotes watch IDs only on the exact movie-only route", () => {
  assert.equal(config.isMovieOnlyPath("/browse/genre/34399"), true);
  assert.equal(config.isMovieOnlyPath("/browse/genre/34399/"), true);
  assert.equal(config.isMovieOnlyPath("/browse/genre/343990"), false);
  assert.equal(config.isMovieOnlyPath("/browse/genre/83"), false);
  assert.equal(config.isMovieOnlyPath("/browse"), false);
});

test("normalizes exact localized titles without fuzzy matching", () => {
  assert.equal(config.normalizeTitle("  我的\n节目  "), "我的 节目");
  assert.equal(config.normalizeTitle("ＡＢＣ"), "abc");
  assert.equal(config.normalizeTitle(""), "");
});

test("defaults to Simplified Chinese UI with manual-only cache updates", () => {
  assert.equal(config.DEFAULT_UI_LANGUAGE, "zh-hans");
  assert.equal(config.DEFAULT_WEEKLY_CACHE_REFRESH, false);
  assert.equal(config.DEFAULT_SETTINGS.uiLanguage, undefined);
  assert.equal(config.WEEKLY_CACHE_REFRESH_KEY, "weeklyCacheRefresh");
});
