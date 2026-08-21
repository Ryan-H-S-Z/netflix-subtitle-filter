(function startNetflixCardFilter() {
  "use strict";

  const config = globalThis.NetflixSubtitleConfig;
  const uiI18n = globalThis.NetflixSubtitleUiI18n;
  const rules = globalThis.NetflixSubtitleFilterRules;
  const catalog = globalThis.NetflixSubtitleCatalog;
  const videoIdentity = globalThis.NetflixSubtitleVideoIdentity;
  const metadataChannel = globalThis.NetflixSubtitleMetadataChannel;
  const cardLayout = globalThis.NetflixSubtitleCardLayout;
  const HOST_ID = "nch-card-filter-host";
  const CARD_LINK_SELECTOR = 'a[href*="jbv="], a[href*="/watch/"], a[href*="/title/"]';
  const CARD_TITLE_TEXT_SELECTOR = cardLayout?.TITLE_TEXT_SELECTORS?.join(",") || "";
  const CARD_TITLE_IMAGE_SELECTOR = cardLayout?.TITLE_IMAGE_SELECTOR || "";
  const TRUSTED_CARD_LINK_SELECTOR = cardLayout?.TRUSTED_CARD_LINK_SELECTORS?.join(",") || "";
  const CARD_CONTENT_SIGNAL_SELECTOR = [
    CARD_LINK_SELECTOR,
    CARD_TITLE_TEXT_SELECTOR,
    CARD_TITLE_IMAGE_SELECTOR
  ].filter(Boolean).join(",");
  const MEMBER_SURFACE_SELECTOR = [
    ".lolomo",
    ".lolomoRow",
    '[data-uia="slider"]',
    '[data-uia="billboard"]',
    '[data-uia="member-header"]',
    ".pinning-header .secondary-navigation",
    ".main-header .secondary-navigation",
    ".account-dropdown-button",
    'a[href="/browse/my-list"]'
  ].join(", ");
  let memberBootstrapDetected = false;

  if (
    !config
    || !uiI18n
    || !rules
    || !catalog
    || !videoIdentity
    || !metadataChannel
    || !cardLayout
    || typeof cardLayout.extractCardTitle !== "function"
    || typeof uiI18n.languageBadgePresentation !== "function"
    || typeof uiI18n.unsupportedBadgePresentation !== "function"
    || typeof uiI18n.createUiLanguageController !== "function"
    || document.getElementById(HOST_ID)
  ) {
    return;
  }

  const state = {
    uiLanguage: uiI18n.DEFAULT_UI_LANGUAGE,
    filter: rules.normalizeFilter(rules.DEFAULT_CARD_FILTER),
    indexes: {},
    videoIdMap: metadataChannel.getMap(),
    loadSequence: 0,
    previousHref: location.href,
    routeActive: isCardRoute(),
    status: {
      phase: "disabled",
      text: "",
      total: 0,
      matched: 0,
      hidden: 0,
      marked: 0,
      unknown: 0
    },
    statusLocalization: null,
    renderScheduled: false,
    loading: false,
    cacheMode: "none",
    abortController: null,
    retryTimer: null,
    storageRebuildTimer: null,
    cacheRebuildTimer: null,
    suppressFilterSignature: null,
    localCacheRefreshActive: false,
    selfRefreshGeneration: null
  };
  const uiLanguageController = uiI18n.createUiLanguageController(
    state.uiLanguage,
    (nextLanguage) => {
      state.uiLanguage = nextLanguage;
      relocalizeBadges();
      relocalizeStatus();
    }
  );

  const statusHost = document.createElement("div");
  statusHost.id = HOST_ID;
  const statusShadow = statusHost.attachShadow({ mode: "closed" });
  statusShadow.innerHTML = `
    <style>
      :host { all: initial; }
      .status {
        align-items: center;
        backdrop-filter: blur(14px);
        background: rgba(18, 18, 18, .94);
        border: 1px solid rgba(255, 255, 255, .2);
        border-radius: 999px;
        bottom: 18px;
        box-shadow: 0 9px 26px rgba(0, 0, 0, .46);
        color: #fff;
        display: flex;
        font: 650 12px/1.25 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        gap: 8px;
        max-width: min(430px, calc(100vw - 32px));
        min-height: 40px;
        padding: 0 14px;
        pointer-events: none;
        position: fixed;
        right: 18px;
        z-index: 2147483646;
      }
      .status[hidden] { display: none; }
      .dot { background: #777; border-radius: 50%; height: 8px; width: 8px; }
      .status[data-phase="loading"] .dot { animation: pulse 1s infinite alternate; background: #f5b642; }
      .status[data-phase="ready"] .dot { background: #46c778; }
      .status[data-phase="partial"] .dot { background: #f5b642; }
      .status[data-phase="error"] .dot { background: #ff6b72; }
      @keyframes pulse { to { opacity: .35; } }
      @media (max-width: 700px) { .status { bottom: 10px; right: 10px; } }
    </style>
    <div class="status" id="status" hidden>
      <span class="dot" aria-hidden="true"></span>
      <span id="status-text"></span>
    </div>
  `;

  const statusElement = statusShadow.getElementById("status");
  const statusText = statusShadow.getElementById("status-text");
  document.documentElement.appendChild(statusHost);

  function hasMemberBootstrap() {
    if (memberBootstrapDetected) {
      return true;
    }
    memberBootstrapDetected = Array.from(document.scripts || []).some((script) => {
      const text = !script.src && typeof script.textContent === "string"
        ? script.textContent
        : "";
      return text.includes('"authURL"')
        && text.includes('"currentCountry"')
        && /"user":"user:(?:\\x20|\s)*((?:\\.|[^"\\])+?)"/.test(text);
    });
    return memberBootstrapDetected;
  }

  function isCardRoute() {
    const hasMemberSurface = location.pathname === "/" && config.isMemberCardSurface({
      hasMemberNavigation: Boolean(document.querySelector(MEMBER_SURFACE_SELECTOR)),
      hasMemberBootstrap: hasMemberBootstrap(),
      cardLinkCount: document.querySelectorAll(CARD_LINK_SELECTOR).length
    });
    return config.isCardFilterPath(location.pathname, hasMemberSurface);
  }

  function t(key, values) {
    return uiI18n.t(state.uiLanguage, key, values);
  }

  function languageLabel(code, short = false) {
    return uiI18n.languageName(state.uiLanguage, code, { short });
  }

  function setStatus(phase, text, counts = {}) {
    state.statusLocalization = null;
    Object.assign(state.status, counts, { phase, text });
    statusHost.dataset.nchPhase = phase;
    statusHost.dataset.nchTotal = String(state.status.total || 0);
    statusHost.dataset.nchMatched = String(state.status.matched || 0);
    statusHost.dataset.nchHidden = String(state.status.hidden || 0);
    statusHost.dataset.nchMarked = String(state.status.marked || 0);
    statusHost.dataset.nchUnknown = String(state.status.unknown || 0);
    statusElement.dataset.phase = phase;
    statusText.textContent = text;
    statusElement.hidden = phase === "disabled" || !isCardRoute();
  }

  function setLocalizedStatus(
    phase,
    key,
    valuesOrFactory = {},
    counts = {},
    suffixKey = ""
  ) {
    const values = typeof valuesOrFactory === "function"
      ? valuesOrFactory()
      : valuesOrFactory;
    setStatus(phase, `${t(key, values)}${suffixKey ? t(suffixKey) : ""}`, counts);
    state.statusLocalization = {
      phase,
      key,
      valuesOrFactory,
      counts: { ...counts },
      suffixKey
    };
  }

  function relocalizeStatus() {
    const localization = state.statusLocalization;
    if (!localization) {
      return;
    }
    setLocalizedStatus(
      localization.phase,
      localization.key,
      localization.valuesOrFactory,
      localization.counts,
      localization.suffixKey
    );
  }

  function statusSnapshot(extra = {}) {
    const supportedRoute = isCardRoute();
    return {
      ...state.status,
      supportedRoute,
      enabled: state.filter.enabled,
      started: supportedRoute && state.filter.enabled,
      ...extra
    };
  }

  function cardLinksWithin(element) {
    const links = [];
    if (element.matches?.(CARD_LINK_SELECTOR)) {
      links.push(element);
    }
    links.push(...element.querySelectorAll(CARD_LINK_SELECTOR));
    return links;
  }

  function identitiesWithin(element, cache) {
    if (cache?.has(element)) {
      return cache.get(element);
    }
    const explicitIds = new Set();
    const watchIds = new Set();
    for (const link of cardLinksWithin(element)) {
      const identity = videoIdentity.idsFromHref(link.getAttribute("href") || link.href, location.href);
      identity.explicitIds.forEach((id) => explicitIds.add(id));
      // A Netflix link can contain both a canonical jbv/title ID and an
      // episode watch ID. The explicit ID is authoritative for that link;
      // counting both makes one homepage card look like a compound card.
      if (!identity.explicitIds.length && identity.watchId) {
        watchIds.add(identity.watchId);
      }
    }
    const result = {
      explicitIds,
      watchIds,
      structuralIds: videoIdentity.resolveStructuralIds(
        explicitIds,
        watchIds,
        state.videoIdMap
      )
    };
    cache?.set(element, result);
    return result;
  }

  function resolveCardScope(link) {
    return link.closest(
      'section, [data-uia="slider"], .lolomoRow, main, [role="main"], #appMountPoint'
    );
  }

  function collectCards() {
    const cards = new Map();
    const identityCache = new WeakMap();
    const requestedStructuralIds = new Set();
    const links = document.querySelectorAll(CARD_LINK_SELECTOR);

    for (const link of links) {
      const identity = videoIdentity.idsFromHref(
        link.getAttribute("href") || link.href,
        location.href
      );
      if (identity.explicitIds.length) {
        identity.explicitIds.forEach((id) => requestedStructuralIds.add(id));
      } else if (identity.watchId) {
        requestedStructuralIds.add(identity.watchId);
      }
    }
    metadataChannel.request(requestedStructuralIds);

    for (const link of links) {
      const scope = resolveCardScope(link);
      if (!scope) {
        continue;
      }

      const root = cardLayout.findCardRoot(
        link,
        scope,
        (element) => identitiesWithin(element, identityCache).structuralIds
      );
      if (!root) {
        continue;
      }

      const rootIdentity = identitiesWithin(root, identityCache);
      let titleId = null;
      if (rootIdentity.explicitIds.size) {
        const canonicalExplicitIds = new Set(
          Array.from(rootIdentity.explicitIds, (id) => state.videoIdMap.get(id) || id)
        );
        if (canonicalExplicitIds.size === 1) {
          titleId = Array.from(canonicalExplicitIds)[0];
        }
      } else if (rootIdentity.explicitIds.size === 0 && rootIdentity.watchIds.size === 1) {
        const watchId = Array.from(rootIdentity.watchIds)[0];
        titleId = state.videoIdMap.get(watchId)
          || (config.isMovieOnlyPath(location.pathname) ? watchId : null);
      }

      if (!cards.has(root)) {
        cards.set(root, {
          root,
          scope,
          titleId,
          title: cardLayout.extractCardTitle(
            root,
            cardLinksWithin(root),
            config.normalizeTitle
          )
        });
      }
    }

    return { cards: Array.from(cards.values()), candidateCount: links.length };
  }

  function clearAppliedState() {
    for (const element of document.querySelectorAll("[data-nch-card-filter-state]")) {
      element.classList.remove(
        "nch-card-filter-hidden",
        "nch-card-filter-match",
        "nch-card-filter-marked",
        "nch-card-filter-unknown"
      );
      delete element.dataset.nchCardFilterState;
      element.querySelector(":scope > [data-nch-language-badge]")?.remove();
      element.querySelector(":scope > [data-nch-unsupported-badge]")?.remove();
    }
  }

  function addBadge(root, languageCodes) {
    if (!languageCodes.length) {
      return;
    }

    const presentation = uiI18n.languageBadgePresentation(state.uiLanguage, languageCodes);
    if (!presentation.text) {
      return;
    }

    const badge = document.createElement("span");
    badge.dataset.nchLanguageBadge = "true";
    badge.dataset.nchLanguageCodes = presentation.codes.join(",");
    badge.className = "nch-card-filter-badge";
    badge.lang = presentation.lang;
    badge.textContent = presentation.text;
    badge.title = presentation.title;
    badge.setAttribute("aria-hidden", "true");
    root.appendChild(badge);
  }

  function addUnsupportedBadge(root) {
    const presentation = uiI18n.unsupportedBadgePresentation(state.uiLanguage);
    const badge = document.createElement("span");
    badge.dataset.nchUnsupportedBadge = "true";
    badge.className = "nch-card-filter-badge nch-card-filter-unsupported-badge";
    badge.lang = presentation.lang;
    badge.textContent = presentation.text;
    badge.title = presentation.title;
    badge.setAttribute("aria-hidden", "true");
    root.appendChild(badge);
  }

  function relocalizeBadges() {
    for (const badge of document.querySelectorAll("[data-nch-language-badge]")) {
      const codes = String(badge.dataset.nchLanguageCodes || "")
        .split(",")
        .filter(Boolean);
      const presentation = uiI18n.languageBadgePresentation(state.uiLanguage, codes);
      if (!presentation.text) {
        badge.remove();
        continue;
      }
      badge.lang = presentation.lang;
      badge.textContent = presentation.text;
      badge.title = presentation.title;
    }
    for (const badge of document.querySelectorAll("[data-nch-unsupported-badge]")) {
      const presentation = uiI18n.unsupportedBadgePresentation(state.uiLanguage);
      badge.lang = presentation.lang;
      badge.textContent = presentation.text;
      badge.title = presentation.title;
    }
  }

  function applyUiLanguage(value) {
    return uiLanguageController.apply(value);
  }

  function applyFilter() {
    clearAppliedState();

    if (!state.filter.enabled || !isCardRoute()) {
      metadataChannel.request([]);
      setStatus("disabled", "");
      return;
    }

    const collection = collectCards();
    const cards = collection.cards;
    let matched = 0;
    let hidden = 0;
    let marked = 0;
    let unknown = 0;

    for (const card of cards) {
      const result = card.titleId
        ? rules.evaluateTitle(card.titleId, state.filter, state.indexes, card.title)
        : rules.evaluateTitle("", state.filter, state.indexes, card.title);
      const display = rules.resolveCardDisplay(result.state, state.filter);
      card.root.dataset.nchCardFilterState = result.state;

      if (display.hidden) {
        card.root.classList.add("nch-card-filter-hidden");
        hidden += 1;
      } else if (display.markUnsupported) {
        card.root.classList.add("nch-card-filter-marked");
        addUnsupportedBadge(card.root);
        marked += 1;
      } else if (result.state === rules.MATCH) {
        card.root.classList.add("nch-card-filter-match");
        if (display.showLanguageBadge) {
          addBadge(card.root, result.matchedLanguages);
        }
        matched += 1;
      } else {
        card.root.classList.add("nch-card-filter-unknown");
        // An incomplete AND condition can still contain languages that were
        // positively confirmed. Show that truthful partial evidence while the
        // card itself remains visible under the fail-open policy.
        if (display.showLanguageBadge) {
          addBadge(card.root, result.matchedLanguages);
        }
        unknown += 1;
      }

    }

    const counts = { total: cards.length, matched, hidden, marked, unknown };
    if (state.loading) {
      Object.assign(state.status, counts);
    } else if (!cards.length && collection.candidateCount) {
      setLocalizedStatus("partial", "pageNoIdentity", {}, counts);
    } else if (unknown) {
      setLocalizedStatus(
        "partial",
        marked ? "filterStatusPartialMarked" : "filterStatusPartial",
        { matched, marked, unknown },
        counts,
        state.cacheMode === "cached" ? "pageCachedSuffix" : ""
      );
    } else {
      setLocalizedStatus(
        "ready",
        marked ? "filterStatusReadyMarked" : "filterStatusReady",
        { matched, marked, total: cards.length },
        counts,
        state.cacheMode === "cached" ? "pageCachedSuffix" : ""
      );
    }
  }

  function observeDom() {
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "aria-label", "alt", "data-uia"],
      attributeOldValue: true
    });
  }

  function scheduleApply() {
    if (state.renderScheduled) {
      return;
    }
    state.renderScheduled = true;
    window.requestAnimationFrame(() => {
      state.renderScheduled = false;
      observer.disconnect();
      applyFilter();
      observeDom();
    });
  }

  function containsCardContentSignal(node) {
    if (node?.nodeType === 3) {
      return Boolean(node.parentElement?.matches?.(CARD_TITLE_TEXT_SELECTOR));
    }
    return node instanceof Element && (
      node.matches(CARD_CONTENT_SIGNAL_SELECTOR)
      || Boolean(node.querySelector(CARD_CONTENT_SIGNAL_SELECTOR))
      || node.hasAttribute("data-nch-card-filter-state")
    );
  }

  const observer = new MutationObserver((records) => {
    const nextRouteActive = isCardRoute();
    if (nextRouteActive !== state.routeActive) {
      state.routeActive = nextRouteActive;
      rebuildIndexes();
      return;
    }

    const relevant = records.some((record) => {
      if (record.type === "attributes") {
        if (!(record.target instanceof Element)) {
          return false;
        }
        if (record.attributeName === "href") {
          return record.target.tagName === "A"
            && (
              record.target.matches(CARD_LINK_SELECTOR)
              || /(?:jbv=|\/watch\/|\/title\/)/.test(record.oldValue || "")
            );
        }
        if (record.attributeName === "aria-label") {
          return record.target.tagName === "A" && record.target.matches(CARD_LINK_SELECTOR);
        }
        if (record.attributeName === "data-uia") {
          return record.target.tagName === "A"
            && record.target.matches(CARD_LINK_SELECTOR)
            && (
              Boolean(TRUSTED_CARD_LINK_SELECTOR && record.target.matches(TRUSTED_CARD_LINK_SELECTOR))
              || /^(?:standard|progress|ranked)-card$/.test(record.oldValue || "")
            );
        }
        return record.attributeName === "alt"
          && record.target.tagName === "IMG"
          && Boolean(record.target.closest("[data-nch-card-filter-state]"));
      }
      if (record.type === "characterData") {
        return Boolean(record.target.parentElement?.matches?.(CARD_TITLE_TEXT_SELECTOR));
      }
      return (
        record.target instanceof Element
        && (
          record.target.matches(CARD_TITLE_TEXT_SELECTOR)
          // Netflix may reconcile a card after we append a badge and remove
          // that foreign child. Re-apply when a managed root's direct
          // children change so the selected language/red badge is restored.
          || record.target.hasAttribute("data-nch-card-filter-state")
        )
      ) || [...record.addedNodes, ...record.removedNodes].some(containsCardContentSignal);
    });
    if (relevant) {
      scheduleApply();
    }
  });

  function completeFailedLoad({ indexes = {}, errors = [], retryAttempt = 0 } = {}) {
    state.indexes = indexes;
    state.loading = false;
    state.cacheMode = "none";
    observer.disconnect();
    applyFilter();
    observeDom();

    const wasAborted = errors.some((error) => config.isAbortError(error));
    const delay = wasAborted ? null : config.catalogRetryDelay(retryAttempt);
    if (delay == null) {
      setLocalizedStatus("error", "filterStatusError");
      return;
    }

    setLocalizedStatus("error", "filterStatusRetrying", {
      seconds: Math.ceil(delay / 1000),
      attempt: retryAttempt + 1,
      max: config.CATALOG_RETRY_DELAYS_MS.length
    });
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      if (state.filter.enabled && isCardRoute()) {
        rebuildIndexes({ retryAttempt: retryAttempt + 1 });
      }
    }, delay);
  }

  async function rebuildIndexes({ force = false, retryAttempt = 0 } = {}) {
    window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.abortController?.abort();
    const abortController = new AbortController();
    state.abortController = abortController;
    const sequence = state.loadSequence + 1;
    state.loadSequence = sequence;
    state.indexes = {};
    state.loading = false;
    state.cacheMode = "none";
    scheduleApply();

    state.routeActive = isCardRoute();
    if (!state.filter.enabled || !state.routeActive) {
      setStatus("disabled", "");
      return statusSnapshot({ started: false });
    }

    const selected = rules.getSelectedLanguages(state.filter);
    const ready = new Set();
    const cached = new Set();
    const languageErrors = [];
    state.loading = true;
    setLocalizedStatus("loading", "pageLoadingCatalogs", { ready: 0, total: selected.length });

    try {
      const indexes = await catalog.loadIndexes(selected, {
        force,
        signal: abortController.signal,
        onProgress: ({ code, loaded }) => {
          if (state.loadSequence === sequence) {
            setLocalizedStatus("loading", "pageLoadingLanguage", () => ({
              language: languageLabel(code, true),
              count: loaded.toLocaleString(uiI18n.UI_LANGUAGE_TAGS[state.uiLanguage])
            }));
          }
        },
        onLanguageReady: ({ code, cached: usedCache, index }) => {
          ready.add(code);
          if (usedCache) {
            cached.add(code);
          }
          if (state.loadSequence === sequence) {
            if (index) {
              state.indexes = { ...state.indexes, [code]: index };
              scheduleApply();
            }
            setLocalizedStatus("loading", "pageLoadingCatalogs", {
              ready: ready.size,
              total: selected.length
            });
          }
        },
        onLanguageError: ({ code, error, index }) => {
          ready.add(code);
          languageErrors.push(error);
          if (state.loadSequence === sequence && index) {
            state.indexes = { ...state.indexes, [code]: index };
            scheduleApply();
          }
        }
      });

      if (state.loadSequence !== sequence) {
        return statusSnapshot({ started: false });
      }

      state.indexes = indexes;
      state.loading = false;
      state.cacheMode = selected.length > 0 && cached.size === selected.length
        ? "cached"
        : "updated";
      if (languageErrors.length) {
        completeFailedLoad({ indexes, errors: languageErrors, retryAttempt });
        return statusSnapshot();
      }
      scheduleApply();
      return statusSnapshot();
    } catch (error) {
      if (state.loadSequence === sequence) {
        completeFailedLoad({ errors: [error], retryAttempt });
      }
      return statusSnapshot();
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local"
      && (
        changes[config.CATALOG_CACHE_KEY]
        || changes[config.CATALOG_AUTO_REFRESH_TICK_KEY]
      )
    ) {
      const cacheChange = changes[config.CATALOG_CACHE_KEY];
      const previousGeneration = cacheChange?.oldValue?.generation;
      const generation = cacheChange?.newValue?.generation;
      if (cacheChange && previousGeneration == null && generation === 0) {
        return;
      }
      if (
        cacheChange
        && (state.localCacheRefreshActive || generation === state.selfRefreshGeneration)
      ) {
        return;
      }

      state.abortController?.abort();
      state.indexes = {};
      state.loading = false;
      scheduleApply();
      window.clearTimeout(state.cacheRebuildTimer);
      state.cacheRebuildTimer = window.setTimeout(() => {
        state.cacheRebuildTimer = null;
        rebuildIndexes();
      }, 150);
      return;
    }

    if (areaName !== "sync") {
      return;
    }
    if (changes.uiLanguage) {
      applyUiLanguage(changes.uiLanguage.newValue);
    }
    if (!changes.cardFilter) {
      return;
    }
    const nextFilter = rules.normalizeFilter(changes.cardFilter.newValue);
    const nextSignature = JSON.stringify(nextFilter);
    if (nextSignature === state.suppressFilterSignature) {
      state.suppressFilterSignature = null;
      state.filter = nextFilter;
      return;
    }
    state.filter = nextFilter;
    window.clearTimeout(state.storageRebuildTimer);
    state.storageRebuildTimer = window.setTimeout(() => {
      state.storageRebuildTimer = null;
      rebuildIndexes();
    }, 100);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NCH_GET_CARD_FILTER_STATUS") {
      sendResponse(statusSnapshot());
      return;
    }

    if (message?.type === "NCH_APPLY_CARD_FILTER") {
      window.clearTimeout(state.storageRebuildTimer);
      state.storageRebuildTimer = null;
      chrome.storage.sync.get({ cardFilter: rules.DEFAULT_CARD_FILTER }).then(({ cardFilter }) => {
        window.clearTimeout(state.storageRebuildTimer);
        state.storageRebuildTimer = null;
        state.filter = rules.normalizeFilter(cardFilter);
        const suppressedSignature = JSON.stringify(state.filter);
        state.suppressFilterSignature = suppressedSignature;
        window.setTimeout(() => {
          if (state.suppressFilterSignature === suppressedSignature) {
            state.suppressFilterSignature = null;
          }
        }, 1000);
        const started = isCardRoute() && state.filter.enabled;
        rebuildIndexes();
        sendResponse(statusSnapshot({ started }));
      });
      return true;
    }

    if (message?.type === "NCH_REFRESH_CARD_FILTER") {
      window.clearTimeout(state.storageRebuildTimer);
      state.storageRebuildTimer = null;
      chrome.storage.sync.get({ cardFilter: rules.DEFAULT_CARD_FILTER })
        .then(async ({ cardFilter }) => {
          window.clearTimeout(state.storageRebuildTimer);
          state.storageRebuildTimer = null;
          state.filter = rules.normalizeFilter(cardFilter);
          const suppressedSignature = JSON.stringify(state.filter);
          state.suppressFilterSignature = suppressedSignature;
          window.setTimeout(() => {
            if (state.suppressFilterSignature === suppressedSignature) {
              state.suppressFilterSignature = null;
            }
          }, 1000);
          state.localCacheRefreshActive = true;
          let refreshedGeneration;
          try {
            refreshedGeneration = await catalog.clearCache();
          } finally {
            state.localCacheRefreshActive = false;
          }
          state.selfRefreshGeneration = refreshedGeneration;
          window.setTimeout(() => {
            if (state.selfRefreshGeneration === refreshedGeneration) {
              state.selfRefreshGeneration = null;
            }
          }, 2000);
          window.clearTimeout(state.storageRebuildTimer);
          state.storageRebuildTimer = null;
          window.clearTimeout(state.cacheRebuildTimer);
          state.cacheRebuildTimer = null;
          const started = isCardRoute() && state.filter.enabled;
          rebuildIndexes({ force: true });
          sendResponse(statusSnapshot({ started }));
        })
        .catch((error) => sendResponse({
          ...statusSnapshot({ started: false }),
          phase: "error",
          text: t("refreshFailed")
        }));
      return true;
    }
  });

  window.setInterval(() => {
    if (location.href === state.previousHref) {
      return;
    }
    state.previousHref = location.href;
    const nextRouteActive = isCardRoute();
    if (nextRouteActive !== state.routeActive) {
      state.routeActive = nextRouteActive;
      rebuildIndexes();
    } else if (nextRouteActive && state.status.phase === "error") {
      rebuildIndexes();
    } else {
      scheduleApply();
    }
  }, 700);

  metadataChannel.subscribe((map) => {
    state.videoIdMap = map;
    scheduleApply();
  });
  observeDom();
  const initialUiLanguageRevision = uiLanguageController.revision;
  chrome.storage.sync.get({
    cardFilter: rules.DEFAULT_CARD_FILTER,
    uiLanguage: uiI18n.DEFAULT_UI_LANGUAGE
  }).then(({ cardFilter, uiLanguage }) => {
    uiLanguageController.hydrate(uiLanguage, initialUiLanguageRevision);
    state.filter = rules.normalizeFilter(cardFilter);
    rebuildIndexes();
  });
})();
