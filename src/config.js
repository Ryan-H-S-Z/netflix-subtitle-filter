(function exposeConfig(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConfig() {
  "use strict";

  const languageEntries = [
    ["zh-hant", "繁體中文", "繁中", "81586250"],
    ["zh-hans", "简体中文", "简中", "81582910"],
    ["en", "英语", "英文", "81582792"],
    ["th", "泰语", "泰文", "81511372"],
    ["ja", "日语", "日文", "81510631"],
    ["ko", "韩语", "韩文", "81511367"],
    ["fr", "法语", "法文", "81582682"],
    ["de", "德语", "德文", "81510841"],
    ["es", "西班牙语", "西语", "81582672"],
    ["pt", "葡萄牙语", "葡语", "81582772"],
    ["it", "意大利语", "意文", "81510847"],
    ["ru", "俄语", "俄文", "81511524"],
    ["uk", "乌克兰语", "乌文", "81628766"],
    ["ar", "阿拉伯语", "阿语", "81509370"],
    ["he", "希伯来语", "希语", "81509373"],
    ["hi", "印地语", "印地", "81508168"],
    ["id", "印度尼西亚语", "印尼", "81510612"],
    ["ms", "马来语", "马来", "81511370"],
    ["vi", "越南语", "越文", "81511560"],
    ["fil", "菲律宾语", "菲语", "81509728"],
    ["ta", "泰米尔语", "泰米尔", "81508170"],
    ["te", "泰卢固语", "泰卢固", "81508172"],
    ["pl", "波兰语", "波兰", "81510848"],
    ["cs", "捷克语", "捷克", "81510845"],
    ["hr", "克罗地亚语", "克语", "81511516"],
    ["ro", "罗马尼亚语", "罗语", "81511522"],
    ["hu", "匈牙利语", "匈语", "81511520"],
    ["el", "希腊语", "希腊", "81510843"],
    ["da", "丹麦语", "丹麦", "81506246"],
    ["fi", "芬兰语", "芬兰", "81506249"],
    ["nb", "挪威语", "挪威", "81506252"],
    ["sv", "瑞典语", "瑞典", "81506257"],
    ["nl", "荷兰语", "荷兰", "81506255"],
    ["is", "冰岛语", "冰岛", "81506259"],
    ["ca", "加泰罗尼亚语", "加泰", "81619048"],
    ["eu", "巴斯克语", "巴斯克", "81619051"],
    ["gl", "加利西亚语", "加利西亚", "81619053"],
    ["fr-ca", "加拿大法语", "加法", "81582685"]
  ];

  const LANGUAGES = Object.freeze(Object.fromEntries(languageEntries.map(
    ([code, label, shortLabel, genreId]) => [
      code,
      Object.freeze({ code, label, shortLabel, genreId })
    ]
  )));

  const DEFAULT_SETTINGS = Object.freeze({
    preferredLanguage: "zh-hant",
    showFloatingButton: true,
    subtitleEncoding: "auto",
    subtitleFontSize: 38,
    subtitleBottom: 12,
    subtitleOffset: 0,
    subtitleBackground: true
  });

  const CATALOG_CACHE_KEY = "nchCatalogCacheV1";
  const DEFAULT_UI_LANGUAGE = "zh-hans";
  const DEFAULT_WEEKLY_CACHE_REFRESH = false;
  const WEEKLY_CACHE_REFRESH_KEY = "weeklyCacheRefresh";
  const CATALOG_LAST_AUTO_REFRESH_KEY = "nchCatalogLastAutoRefreshAt";
  const CATALOG_AUTO_REFRESH_TICK_KEY = "nchCatalogAutoRefreshTick";

  function getLanguage(code) {
    return LANGUAGES[code] || LANGUAGES[DEFAULT_SETTINGS.preferredLanguage];
  }

  function getFilterUrl(code) {
    const language = getLanguage(code);
    if (language.code === "en") {
      return "https://www.netflix.com/browse/subtitles";
    }
    return `https://www.netflix.com/browse/subtitles/${language.genreId}/${language.code}`;
  }

  function isNetflixUrl(url) {
    try {
      return new URL(url).hostname === "www.netflix.com";
    } catch (_error) {
      return false;
    }
  }

  function isCardFilterPath(pathname) {
    const path = String(pathname || "");
    if (/^\/browse\/subtitles(?:\/|$)/.test(path)) {
      return false;
    }
    return /^\/(?:browse|latest|search|title)(?:\/|$)/.test(path);
  }

  function isMovieOnlyPath(pathname) {
    return /^\/browse\/genre\/34399\/?$/.test(String(pathname || ""));
  }

  function normalizeTitle(value) {
    const title = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!title || title.length > 300) {
      return "";
    }
    return title.toLocaleLowerCase();
  }

  return Object.freeze({
    LANGUAGES,
    DEFAULT_SETTINGS,
    DEFAULT_UI_LANGUAGE,
    DEFAULT_WEEKLY_CACHE_REFRESH,
    CATALOG_CACHE_KEY,
    WEEKLY_CACHE_REFRESH_KEY,
    CATALOG_LAST_AUTO_REFRESH_KEY,
    CATALOG_AUTO_REFRESH_TICK_KEY,
    getLanguage,
    getFilterUrl,
    isNetflixUrl,
    isCardFilterPath,
    isMovieOnlyPath,
    normalizeTitle
  });
});
