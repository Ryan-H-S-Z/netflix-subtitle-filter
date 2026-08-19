(function exposeFilterRules(root, factory) {
  const config = typeof module === "object" && module.exports
    ? require("./config.js")
    : root.NetflixSubtitleConfig;
  const api = factory(config);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleFilterRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createFilterRules(config) {
  "use strict";

  const MATCH = "match";
  const NO_MATCH = "no-match";
  const UNKNOWN = "unknown";
  const MAX_GROUPS = 6;
  const MAX_LANGUAGES_PER_GROUP = 8;
  const MAX_UNIQUE_LANGUAGES = 8;

  const DEFAULT_CARD_FILTER = Object.freeze({
    version: 1,
    enabled: false,
    showBadges: true,
    groups: Object.freeze([
      Object.freeze(["zh-hant", "zh-hans"])
    ])
  });

  function knownLanguageCodes(explicitCodes) {
    const codes = explicitCodes || Object.keys(config?.LANGUAGES || {});
    return new Set(codes);
  }

  function normalizeFilter(value, explicitCodes) {
    const knownCodes = knownLanguageCodes(explicitCodes);
    const hasExplicitGroups = Array.isArray(value?.groups);
    const sourceGroups = hasExplicitGroups
      ? value.groups
      : DEFAULT_CARD_FILTER.groups;
    const groups = [];
    const globallyUsed = new Set();

    for (const sourceGroup of sourceGroups.slice(0, MAX_GROUPS)) {
      const sourceLanguages = Array.isArray(sourceGroup)
        ? sourceGroup
        : sourceGroup?.languages;

      if (!Array.isArray(sourceLanguages)) {
        continue;
      }

      const group = [];
      for (const rawCode of sourceLanguages) {
        const code = String(rawCode || "").toLowerCase();
        if (
          !knownCodes.has(code)
          || group.includes(code)
          || group.length >= MAX_LANGUAGES_PER_GROUP
        ) {
          continue;
        }

        if (!globallyUsed.has(code) && globallyUsed.size >= MAX_UNIQUE_LANGUAGES) {
          continue;
        }

        group.push(code);
        globallyUsed.add(code);
      }

      if (group.length) {
        groups.push(group);
      }
    }

    const hasValidGroups = groups.length > 0;
    if (!hasValidGroups) {
      groups.push([...DEFAULT_CARD_FILTER.groups[0]]);
    }

    return {
      version: 1,
      enabled: Boolean(value?.enabled) && (!hasExplicitGroups || hasValidGroups),
      showBadges: value?.showBadges !== false,
      groups
    };
  }

  function getSelectedLanguages(filter) {
    return Array.from(new Set(normalizeFilter(filter).groups.flat()));
  }

  function hasId(index, titleId) {
    if (index?.ids instanceof Set) {
      return index.ids.has(titleId);
    }
    if (Array.isArray(index?.ids)) {
      return index.ids.includes(titleId);
    }
    return false;
  }

  function hasTitle(index, title) {
    if (index?.titles instanceof Set) {
      return index.titles.has(title);
    }
    if (Array.isArray(index?.titles)) {
      return index.titles.includes(title);
    }
    return false;
  }

  function evaluateLanguage(titleId, index) {
    if (hasId(index, titleId)) {
      return MATCH;
    }
    return index?.complete === true ? NO_MATCH : UNKNOWN;
  }

  function evaluateLanguageIdentity(titleId, title, index) {
    if (titleId) {
      return evaluateLanguage(String(titleId), index);
    }
    if (!title) {
      return UNKNOWN;
    }
    if (hasTitle(index, title)) {
      return MATCH;
    }
    return index?.titlesComplete === true ? NO_MATCH : UNKNOWN;
  }

  function combineOr(states) {
    if (states.includes(MATCH)) {
      return MATCH;
    }
    if (states.length && states.every((state) => state === NO_MATCH)) {
      return NO_MATCH;
    }
    return UNKNOWN;
  }

  function combineAnd(states) {
    if (states.includes(NO_MATCH)) {
      return NO_MATCH;
    }
    if (states.length && states.every((state) => state === MATCH)) {
      return MATCH;
    }
    return UNKNOWN;
  }

  function evaluateTitle(titleId, filter, indexes = {}, titleName = "") {
    const normalized = normalizeFilter(filter);
    if (!normalized.enabled) {
      return { state: MATCH, matchedLanguages: [], groupStates: [] };
    }

    const normalizedTitle = config.normalizeTitle(titleName);

    const matchedLanguages = [];
    const groupStates = normalized.groups.map((group) => {
      const languageStates = group.map((code) => {
        const state = evaluateLanguageIdentity(
          titleId ? String(titleId) : "",
          normalizedTitle,
          indexes[code]
        );
        if (state === MATCH) {
          matchedLanguages.push(code);
        }
        return state;
      });
      return combineOr(languageStates);
    });

    return {
      state: combineAnd(groupStates),
      matchedLanguages: Array.from(new Set(matchedLanguages)),
      groupStates
    };
  }

  return Object.freeze({
    MATCH,
    NO_MATCH,
    UNKNOWN,
    MAX_GROUPS,
    MAX_LANGUAGES_PER_GROUP,
    MAX_UNIQUE_LANGUAGES,
    DEFAULT_CARD_FILTER,
    normalizeFilter,
    getSelectedLanguages,
    evaluateLanguage,
    evaluateLanguageIdentity,
    combineOr,
    combineAnd,
    evaluateTitle
  });
});
