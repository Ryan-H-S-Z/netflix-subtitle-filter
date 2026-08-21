"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const i18n = require("../src/ui-i18n.js");

test("normalizes the three supported interface languages", () => {
  assert.equal(i18n.DEFAULT_UI_LANGUAGE, "en");
  assert.equal(i18n.normalizeUiLanguage("zh-hans"), "zh-hans");
  assert.equal(i18n.normalizeUiLanguage("ZH-HANT"), "zh-hant");
  assert.equal(i18n.normalizeUiLanguage("en"), "en");
  assert.equal(i18n.normalizeUiLanguage("fr"), "en");
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

test("keeps the English product name in every interface language", () => {
  for (const locale of ["en", "zh-hans", "zh-hant"]) {
    assert.equal(i18n.t(locale, "documentTitle"), "Netflix Subtitle Filter");
    assert.equal(i18n.t(locale, "headerTitle"), "Netflix Subtitle Filter");
  }
});

test("localizes common full and short subtitle language names", () => {
  assert.equal(i18n.languageName("zh-hant", "zh-hans", { short: true }), "簡中");
  assert.equal(i18n.languageName("en", "zh-hant", { short: true }), "Trad. Chinese");
  assert.equal(i18n.languageName("en", "th"), "Thai");
});

test("builds card badge text and title in the selected interface language", () => {
  assert.deepEqual(
    i18n.languageBadgePresentation("zh-hans", ["zh-hans", "en"]),
    {
      codes: ["zh-hans", "en"],
      lang: "zh-CN",
      text: "简中 · 英文",
      title: "已确认字幕：简中 · 英文"
    }
  );
  assert.deepEqual(
    i18n.languageBadgePresentation("zh-hant", ["zh-hans", "en"]),
    {
      codes: ["zh-hans", "en"],
      lang: "zh-TW",
      text: "簡中 · 英文",
      title: "已確認字幕：簡中 · 英文"
    }
  );
  assert.deepEqual(
    i18n.languageBadgePresentation("en", ["zh-hans", "en"]),
    {
      codes: ["zh-hans", "en"],
      lang: "en",
      text: "Simpl. Chinese · English",
      title: "Confirmed subtitles: Simpl. Chinese · English"
    }
  );
});

test("builds localized red badges for titles confirmed not to match", () => {
  assert.deepEqual(i18n.unsupportedBadgePresentation("zh-hans"), {
    lang: "zh-CN",
    text: "不符合所选字幕",
    title: "已确认不符合所选字幕条件"
  });
  assert.deepEqual(i18n.unsupportedBadgePresentation("zh-hant"), {
    lang: "zh-TW",
    text: "不符合所選字幕",
    title: "已確認不符合所選字幕條件"
  });
  assert.deepEqual(i18n.unsupportedBadgePresentation("en"), {
    lang: "en",
    text: "Subtitle rule not met",
    title: "Confirmed not to match the selected subtitle rule"
  });
});

test("keeps a newer language change when an older initial read finishes later", () => {
  const changes = [];
  const controller = i18n.createUiLanguageController("zh-hans", (next) => changes.push(next));
  const initialRevision = controller.revision;

  assert.equal(controller.apply("en").value, "en");
  assert.equal(controller.hydrate("zh-hans", initialRevision).applied, false);
  assert.equal(controller.value, "en");
  assert.deepEqual(changes, ["en"]);

  const currentRevision = controller.revision;
  assert.equal(controller.hydrate("zh-hant", currentRevision).applied, true);
  assert.equal(controller.value, "zh-hant");
  assert.deepEqual(changes, ["en", "zh-hant"]);
});
