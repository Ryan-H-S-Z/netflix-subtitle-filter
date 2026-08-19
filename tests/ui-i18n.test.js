"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const i18n = require("../src/ui-i18n.js");

test("normalizes the three supported interface languages", () => {
  assert.equal(i18n.normalizeUiLanguage("zh-hans"), "zh-hans");
  assert.equal(i18n.normalizeUiLanguage("ZH-HANT"), "zh-hant");
  assert.equal(i18n.normalizeUiLanguage("en"), "en");
  assert.equal(i18n.normalizeUiLanguage("fr"), "zh-hans");
});

test("translates and interpolates popup and page status text", () => {
  assert.equal(i18n.t("zh-hans", "stateOn"), "已开启");
  assert.equal(i18n.t("zh-hant", "stateOn"), "已開啟");
  assert.equal(i18n.t("en", "stateOn"), "On");
  assert.equal(
    i18n.t("en", "filterStatusReady", { matched: 12, total: 20 }),
    "Subtitle filter: showing 12 of 20 titles"
  );
});

test("keeps every translated interface dictionary in sync", () => {
  assert.deepEqual(i18n.messageKeys("zh-hant"), i18n.messageKeys("zh-hans"));
  assert.deepEqual(i18n.messageKeys("en"), i18n.messageKeys("zh-hans"));
});

test("localizes common full and short subtitle language names", () => {
  assert.equal(i18n.languageName("zh-hant", "zh-hans", { short: true }), "簡中");
  assert.equal(i18n.languageName("en", "zh-hant", { short: true }), "Trad. Chinese");
  assert.equal(i18n.languageName("en", "th"), "Thai");
});
