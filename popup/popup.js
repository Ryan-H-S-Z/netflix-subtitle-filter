(function startPopup() {
  "use strict";

  const config = globalThis.NetflixSubtitleConfig;
  const uiI18n = globalThis.NetflixSubtitleUiI18n;
  const cacheSchedule = globalThis.NetflixSubtitleCacheSchedule;
  const rules = globalThis.NetflixSubtitleFilterRules;
  const catalog = globalThis.NetflixSubtitleCatalog;
  const filterEnabledInput = document.getElementById("filter-enabled");
  const showBadgesInput = document.getElementById("show-badges");
  const groupsContainer = document.getElementById("filter-groups");
  const addGroupButton = document.getElementById("add-group");
  const applyFilterButton = document.getElementById("apply-filter");
  const refreshFilterButton = document.getElementById("refresh-filter");
  const presetButtons = [
    document.getElementById("preset-chinese"),
    document.getElementById("preset-chinese-english"),
    document.getElementById("preset-simplified-english"),
    document.getElementById("preset-traditional-english"),
    document.getElementById("preset-chinese-thai")
  ];
  const openPlayerPanelButton = document.getElementById("open-player-panel");
  const openOfficialCatalogButton = document.getElementById("open-official-catalog");
  const showFloatingInput = document.getElementById("show-floating");
  const filterStateLabel = document.getElementById("filter-state-label");
  const status = document.getElementById("status");
  const uiLanguageSelect = document.getElementById("ui-language");
  const weeklyCacheRefreshInput = document.getElementById("weekly-cache-refresh");
  const weeklyRefreshHint = document.getElementById("weekly-refresh-hint");
  const preferredLanguageInputs = Array.from(document.querySelectorAll('input[name="preferred-language"]'));
  const languageList = Object.values(config.LANGUAGES);
  let uiLanguage = uiI18n.DEFAULT_UI_LANGUAGE;
  let preferredLanguage = config.DEFAULT_SETTINGS.preferredLanguage;
  let filterDraft = rules.normalizeFilter(rules.DEFAULT_CARD_FILTER);
  let initialized = false;
  let filterDraftDirty = false;
  let filterDraftRevision = 0;
  let busyOperation = null;
  let nextBusyOperationId = 0;
  let weeklyHintRevision = 0;

  function t(key, values) {
    return uiI18n.t(uiLanguage, key, values);
  }

  function languageLabel(code, short = false) {
    return uiI18n.languageName(uiLanguage, code, { short });
  }

  function applyStaticTranslations() {
    document.documentElement.lang = uiI18n.UI_LANGUAGE_TAGS[uiLanguage];
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    }
  }

  function localizedFilterStatus(filterStatus) {
    if (!filterStatus) {
      return null;
    }
    if (filterStatus.phase === "error") {
      return t("filterStatusError");
    }
    if (filterStatus.phase === "loading") {
      return t("filterStatusLoading");
    }
    if (filterStatus.phase === "partial") {
      return t("filterStatusPartial", {
        matched: Number(filterStatus.matched || 0),
        unknown: Number(filterStatus.unknown || 0)
      });
    }
    if (filterStatus.phase === "ready") {
      return t("filterStatusReady", {
        matched: Number(filterStatus.matched || 0),
        total: Number(filterStatus.total || 0)
      });
    }
    return null;
  }

  async function updateWeeklyRefreshHint() {
    const revision = ++weeklyHintRevision;
    const languageAtRequest = uiLanguage;
    const translate = (key, values) => uiI18n.t(languageAtRequest, key, values);
    if (!weeklyCacheRefreshInput.checked) {
      weeklyRefreshHint.textContent = translate("weeklyRefreshHintOff");
      return;
    }
    try {
      const alarm = await chrome.alarms.get(cacheSchedule.ALARM_NAME);
      if (revision !== weeklyHintRevision) {
        return;
      }
      if (!alarm?.scheduledTime) {
        weeklyRefreshHint.textContent = translate("weeklyRefreshHintPending");
        return;
      }
      const date = new Intl.DateTimeFormat(uiI18n.UI_LANGUAGE_TAGS[languageAtRequest], {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(alarm.scheduledTime));
      weeklyRefreshHint.textContent = translate("weeklyRefreshHintNext", { date });
    } catch (_error) {
      if (revision === weeklyHintRevision) {
        weeklyRefreshHint.textContent = translate("weeklyRefreshHintPending");
      }
    }
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.style.color = isError ? "#ff9ca2" : "#b9e8c9";
    status.style.background = isError ? "rgba(229, 9, 20, .1)" : "rgba(70, 199, 120, .1)";
    status.style.borderColor = isError ? "rgba(229, 9, 20, .3)" : "rgba(70, 199, 120, .23)";
  }

  function updateFilterStateLabel() {
    filterStateLabel.textContent = filterDraftDirty
      ? t("statePending")
      : (filterEnabledInput.checked ? t("stateOn") : t("stateOff"));
  }

  function markFilterDraftChanged() {
    filterDraftDirty = true;
    filterDraftRevision += 1;
    updateFilterStateLabel();
    syncControlStates();
    setStatus(t("draftChanged"));
  }

  function controlsLocked() {
    return !initialized || busyOperation !== null;
  }

  function syncControlStates() {
    const locked = controlsLocked();
    const globallySelected = selectedCodes();

    uiLanguageSelect.disabled = locked;
    weeklyCacheRefreshInput.disabled = locked;
    filterEnabledInput.disabled = locked;
    showBadgesInput.disabled = locked;
    presetButtons.forEach((button) => {
      button.disabled = locked;
    });
    applyFilterButton.disabled = locked;
    refreshFilterButton.disabled = locked || filterDraftDirty;
    preferredLanguageInputs.forEach((input) => {
      input.disabled = locked;
    });
    showFloatingInput.disabled = locked;
    openPlayerPanelButton.disabled = locked;
    openOfficialCatalogButton.disabled = locked;

    addGroupButton.disabled = locked
      || filterDraft.groups.length >= rules.MAX_GROUPS
      || globallySelected.size >= rules.MAX_UNIQUE_LANGUAGES;
    for (const button of groupsContainer.querySelectorAll(".group-remove")) {
      button.disabled = locked || filterDraft.groups.length === 1;
    }
    for (const button of groupsContainer.querySelectorAll(".chip button")) {
      button.disabled = locked;
    }
    for (const select of groupsContainer.querySelectorAll(".add-language-row select")) {
      select.disabled = locked;
    }
    for (const button of groupsContainer.querySelectorAll(".add-language-row button")) {
      const select = button.parentElement?.querySelector("select");
      button.disabled = locked
        || !select
        || select.options.length <= 1
        || globallySelected.size >= rules.MAX_UNIQUE_LANGUAGES;
    }
  }

  function beginBusyOperation(name) {
    if (!initialized || busyOperation !== null) {
      return null;
    }
    const operation = {
      id: ++nextBusyOperationId,
      name
    };
    busyOperation = operation;
    filterDraftRevision += 1;
    syncControlStates();
    return operation;
  }

  function endBusyOperation(operation) {
    if (!operation || busyOperation?.id !== operation.id) {
      return;
    }
    busyOperation = null;
    syncControlStates();
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToActiveNetflix(message) {
    try {
      const tab = await getActiveTab();
      if (!tab?.id || !config.isNetflixUrl(tab.url || "")) {
        return null;
      }
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (_error) {
      return null;
    }
  }

  async function openNetflixUrl(url) {
    const tab = await getActiveTab();
    if (tab?.id && config.isNetflixUrl(tab.url || "")) {
      await chrome.tabs.update(tab.id, { url });
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  }

  function selectedCodes() {
    return new Set(filterDraft.groups.flat());
  }

  function applyPreset(groups) {
    filterDraft = rules.normalizeFilter({
      ...filterDraft,
      enabled: true,
      groups
    });
    filterEnabledInput.checked = true;
    updateFilterStateLabel();
    renderGroups();
    markFilterDraftChanged();
  }

  function removeLanguage(groupIndex, code) {
    const group = filterDraft.groups[groupIndex];
    if (group.length === 1) {
      if (filterDraft.groups.length > 1) {
        filterDraft.groups.splice(groupIndex, 1);
        renderGroups();
        markFilterDraftChanged();
      } else {
        setStatus(t("groupNeedsLanguage"), true);
      }
      return;
    }
    filterDraft.groups[groupIndex] = group.filter((item) => item !== code);
    renderGroups();
    markFilterDraftChanged();
  }

  function createChip(groupIndex, language) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = languageLabel(language.code);
    chip.append(document.createTextNode(label));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", t("removeLanguage", { language: label }));
    remove.title = t("removeLanguage", { language: label });
    remove.textContent = "×";
    remove.disabled = controlsLocked();
    remove.addEventListener("click", () => removeLanguage(groupIndex, language.code));
    chip.appendChild(remove);
    return chip;
  }

  function createGroup(group, groupIndex, globallySelected) {
    const wrapper = document.createElement("section");
    wrapper.className = "condition-group";

    const head = document.createElement("div");
    head.className = "group-head";
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = groupIndex === 0
      ? t("firstGroupTitle")
      : t("nextGroupTitle");
    head.appendChild(title);

    const removeGroup = document.createElement("button");
    removeGroup.className = "group-remove";
    removeGroup.type = "button";
    removeGroup.textContent = t("delete");
    removeGroup.disabled = controlsLocked() || filterDraft.groups.length === 1;
    removeGroup.addEventListener("click", () => {
      filterDraft.groups.splice(groupIndex, 1);
      renderGroups();
      markFilterDraftChanged();
    });
    head.appendChild(removeGroup);
    wrapper.appendChild(head);

    const chips = document.createElement("div");
    chips.className = "chips";
    for (const code of group) {
      const language = config.LANGUAGES[code];
      if (language) {
        chips.appendChild(createChip(groupIndex, language));
      }
    }
    wrapper.appendChild(chips);

    const addRow = document.createElement("div");
    addRow.className = "add-language-row";
    const select = document.createElement("select");
    select.setAttribute("aria-label", t("addLanguageAria", { number: groupIndex + 1 }));
    select.disabled = controlsLocked();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("chooseLanguage");
    select.appendChild(placeholder);

    const available = languageList.filter((language) => !globallySelected.has(language.code));
    for (const language of available) {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = `${languageLabel(language.code)} (${language.code})`;
      select.appendChild(option);
    }

    const addLanguage = document.createElement("button");
    addLanguage.type = "button";
    addLanguage.textContent = t("addToGroup");
    addLanguage.disabled = controlsLocked()
      || !available.length
      || globallySelected.size >= rules.MAX_UNIQUE_LANGUAGES;
    addLanguage.addEventListener("click", () => {
      if (!select.value) {
        setStatus(t("chooseLanguageFirst"), true);
        return;
      }
      filterDraft.groups[groupIndex].push(select.value);
      renderGroups();
      markFilterDraftChanged();
    });
    addRow.append(select, addLanguage);
    wrapper.appendChild(addRow);
    return wrapper;
  }

  function renderGroups() {
    groupsContainer.replaceChildren();
    const globallySelected = selectedCodes();

    filterDraft.groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        const divider = document.createElement("div");
        divider.className = "and-divider";
        divider.textContent = t("andDivider");
        groupsContainer.appendChild(divider);
      }
      groupsContainer.appendChild(createGroup(group, groupIndex, globallySelected));
    });

    syncControlStates();
  }

  function expressionLabel(filter) {
    return filter.groups
      .map((group) => {
        const labels = group.map((code) => languageLabel(code, true));
        return labels.length > 1 ? `(${labels.join(t("orWord"))})` : labels[0];
      })
      .join(t("andWord"));
  }

  async function saveFilter(errorMessageKey) {
    const operation = beginBusyOperation("save-filter");
    if (!operation) {
      return;
    }
    applyFilterButton.textContent = t("saving");
    setStatus(t("savingStatus"));
    try {
      const filterToSave = rules.normalizeFilter({
        ...filterDraft,
        enabled: filterEnabledInput.checked,
        showBadges: showBadgesInput.checked
      });
      filterDraft = filterToSave;
      await chrome.storage.sync.set({ cardFilter: filterToSave });
      filterDraftDirty = false;
      updateFilterStateLabel();

      const active = await sendToActiveNetflix({ type: "NCH_APPLY_CARD_FILTER" });
      if (!active) {
        setStatus(t("savedOpenNetflix", { expression: expressionLabel(filterToSave) }));
      } else if (!filterToSave.enabled) {
        setStatus(t("filterDisabled"));
      } else if (!active.supportedRoute) {
        setStatus(t("savedEnterBrowse", { expression: expressionLabel(filterToSave) }));
      } else if (localizedFilterStatus(active)) {
        setStatus(localizedFilterStatus(active), active.phase === "error");
      } else {
        setStatus(t("savedFiltering", { expression: expressionLabel(filterToSave) }));
      }
    } catch (_error) {
      filterDraftDirty = true;
      updateFilterStateLabel();
      setStatus(t(errorMessageKey), true);
    } finally {
      applyFilterButton.textContent = t("saveApply");
      endBusyOperation(operation);
    }
  }

  addGroupButton.addEventListener("click", () => {
    const used = selectedCodes();
    const preferredOrder = ["en", "th", "ja", "ko", "fr", "de", "es", "pt"];
    const nextCode = preferredOrder.find((code) => !used.has(code))
      || languageList.find((language) => !used.has(language.code))?.code;
    if (!nextCode) {
      setStatus(t("maxLanguages"), true);
      return;
    }
    filterDraft.groups.push([nextCode]);
    renderGroups();
    markFilterDraftChanged();
  });

  document.getElementById("preset-chinese").addEventListener("click", () => {
    applyPreset([["zh-hant", "zh-hans"]]);
  });
  document.getElementById("preset-chinese-english").addEventListener("click", () => {
    applyPreset([["zh-hant", "zh-hans"], ["en"]]);
  });
  document.getElementById("preset-simplified-english").addEventListener("click", () => {
    applyPreset([["zh-hans"], ["en"]]);
  });
  document.getElementById("preset-traditional-english").addEventListener("click", () => {
    applyPreset([["zh-hant"], ["en"]]);
  });
  document.getElementById("preset-chinese-thai").addEventListener("click", () => {
    applyPreset([["zh-hant", "zh-hans"], ["th"]]);
  });

  applyFilterButton.addEventListener("click", () => {
    saveFilter("saveFailed");
  });

  filterEnabledInput.addEventListener("change", () => {
    if (!initialized) {
      return;
    }
    updateFilterStateLabel();
    saveFilter("toggleFailed");
  });

  showBadgesInput.addEventListener("change", () => {
    if (initialized) {
      markFilterDraftChanged();
    }
  });

  uiLanguageSelect.addEventListener("change", async () => {
    if (!initialized) {
      return;
    }
    const previousUiLanguage = uiLanguage;
    const requestedUiLanguage = uiI18n.normalizeUiLanguage(uiLanguageSelect.value);
    const operation = beginBusyOperation("ui-language");
    if (!operation) {
      uiLanguageSelect.value = previousUiLanguage;
      return;
    }
    try {
      const saveUiLanguage = chrome.storage.sync.set({
        uiLanguage: requestedUiLanguage
      });
      uiLanguage = requestedUiLanguage;
      uiLanguageSelect.value = uiLanguage;
      applyStaticTranslations();
      updateFilterStateLabel();
      renderGroups();
      await saveUiLanguage;
      await updateWeeklyRefreshHint();
      setStatus(t("uiLanguageSaved"));
    } catch (_error) {
      uiLanguage = previousUiLanguage;
      uiLanguageSelect.value = uiLanguage;
      applyStaticTranslations();
      updateFilterStateLabel();
      renderGroups();
      await updateWeeklyRefreshHint();
      setStatus(t("saveFailed"), true);
    } finally {
      endBusyOperation(operation);
    }
  });

  weeklyCacheRefreshInput.addEventListener("change", async () => {
    if (!initialized) {
      return;
    }
    const enabled = weeklyCacheRefreshInput.checked;
    const previousEnabled = !enabled;
    const operation = beginBusyOperation("weekly-refresh");
    if (!operation) {
      weeklyCacheRefreshInput.checked = previousEnabled;
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "NCH_SET_WEEKLY_REFRESH_ENABLED",
        enabled
      });
      if (typeof response?.enabled === "boolean") {
        weeklyCacheRefreshInput.checked = response.enabled;
      }
      if (!response?.ok || response.enabled !== enabled) {
        throw new Error("Weekly schedule could not be committed");
      }
      setStatus(enabled ? t("scheduleEnabled") : t("scheduleDisabled"));
      await updateWeeklyRefreshHint();
    } catch (_error) {
      if (weeklyCacheRefreshInput.checked === enabled) {
        weeklyCacheRefreshInput.checked = previousEnabled;
      }
      setStatus(t("scheduleFailed"), true);
      await updateWeeklyRefreshHint();
    } finally {
      endBusyOperation(operation);
    }
  });

  refreshFilterButton.addEventListener("click", async () => {
    const operation = beginBusyOperation("manual-refresh");
    if (!operation) {
      return;
    }
    try {
      setStatus(t("refreshing"));
      const response = await sendToActiveNetflix({ type: "NCH_REFRESH_CARD_FILTER" });
      if (!response) {
        await catalog.clearCache();
        setStatus(t("cacheClearedOpen"));
      } else if (response.phase === "error") {
        setStatus(t("refreshFailed"), true);
        return;
      } else if (!response.enabled) {
        setStatus(t("cacheClearedEnable"));
      } else if (!response.supportedRoute || !response.started) {
        setStatus(t("cacheClearedEnter"));
      } else {
        setStatus(t("refreshStarted"));
      }
      if (weeklyCacheRefreshInput.checked) {
        try {
          const scheduleResponse = await chrome.runtime.sendMessage({
            type: "NCH_RESET_WEEKLY_REFRESH_SCHEDULE"
          });
          if (!scheduleResponse?.ok) {
            throw new Error("Weekly schedule reset failed");
          }
          await updateWeeklyRefreshHint();
        } catch (_error) {
          setStatus(t("scheduleResetFailed"), true);
        }
      }
    } catch (_error) {
      setStatus(t("refreshUnavailable"), true);
    } finally {
      endBusyOperation(operation);
    }
  });

  preferredLanguageInputs.forEach((input) => {
    input.addEventListener("change", async () => {
      if (!input.checked) {
        return;
      }
      const previousPreferredLanguage = preferredLanguage;
      const requestedPreferredLanguage = input.value;
      const operation = beginBusyOperation("preferred-language");
      if (!operation) {
        const previousInput = preferredLanguageInputs.find((item) => item.value === previousPreferredLanguage);
        if (previousInput) {
          previousInput.checked = true;
        }
        return;
      }
      try {
        await chrome.storage.sync.set({ preferredLanguage: requestedPreferredLanguage });
        preferredLanguage = requestedPreferredLanguage;
        setStatus(t("encodingPriority", { language: languageLabel(preferredLanguage) }));
      } catch (_error) {
        const previousInput = preferredLanguageInputs.find((item) => item.value === previousPreferredLanguage);
        if (previousInput) {
          previousInput.checked = true;
        }
        setStatus(t("saveFailed"), true);
      } finally {
        endBusyOperation(operation);
      }
    });
  });

  showFloatingInput.addEventListener("change", async () => {
    const requestedValue = showFloatingInput.checked;
    const operation = beginBusyOperation("floating-button");
    if (!operation) {
      showFloatingInput.checked = !requestedValue;
      return;
    }
    try {
      await chrome.storage.sync.set({ showFloatingButton: requestedValue });
      setStatus(requestedValue ? t("floatingShown") : t("floatingHidden"));
    } catch (_error) {
      showFloatingInput.checked = !requestedValue;
      setStatus(t("saveFailed"), true);
    } finally {
      endBusyOperation(operation);
    }
  });

  openPlayerPanelButton.addEventListener("click", async () => {
    try {
      const tab = await getActiveTab();
      if (!tab?.id || !config.isNetflixUrl(tab.url || "") || !/^\/watch\/\d+/.test(new URL(tab.url).pathname)) {
        setStatus(t("openWatchFirst"), true);
        return;
      }
      await chrome.tabs.sendMessage(tab.id, { type: "NCH_OPEN_PLAYER_PANEL" });
      window.close();
    } catch (_error) {
      setStatus(t("refreshWatchFirst"), true);
    }
  });

  openOfficialCatalogButton.addEventListener("click", () => {
    openNetflixUrl(config.getFilterUrl(preferredLanguage)).catch(() => {
      setStatus(t("officialCatalogFailed"), true);
    });
  });

  const storageDefaults = {
    ...config.DEFAULT_SETTINGS,
    uiLanguage: config.DEFAULT_UI_LANGUAGE,
    [config.WEEKLY_CACHE_REFRESH_KEY]: config.DEFAULT_WEEKLY_CACHE_REFRESH,
    cardFilter: rules.DEFAULT_CARD_FILTER
  };

  function finishInitialization(settings, loadFailed = false) {
    uiLanguage = uiI18n.normalizeUiLanguage(settings.uiLanguage);
    uiLanguageSelect.value = uiLanguage;
    weeklyCacheRefreshInput.checked = settings[config.WEEKLY_CACHE_REFRESH_KEY] === true;
    applyStaticTranslations();
    preferredLanguage = settings.preferredLanguage;
    filterDraft = rules.normalizeFilter(settings.cardFilter);
    filterEnabledInput.checked = filterDraft.enabled;
    filterDraftDirty = false;
    updateFilterStateLabel();
    showBadgesInput.checked = filterDraft.showBadges;
    showFloatingInput.checked = Boolean(settings.showFloatingButton);

    const preferredInput = preferredLanguageInputs.find((input) => input.value === preferredLanguage);
    if (preferredInput) {
      preferredInput.checked = true;
    }
    initialized = !loadFailed;
    renderGroups();
    syncControlStates();
    updateWeeklyRefreshHint();

    if (loadFailed) {
      setStatus(t("settingsLoadFailed"), true);
      return;
    }

    const statusRevision = filterDraftRevision;
    sendToActiveNetflix({ type: "NCH_GET_CARD_FILTER_STATUS" }).then((filterStatus) => {
      if (filterDraftRevision !== statusRevision) {
        return;
      }
      if (localizedFilterStatus(filterStatus)) {
        setStatus(localizedFilterStatus(filterStatus), filterStatus.phase === "error");
      } else if (filterDraft.enabled) {
        setStatus(t("filterEnabledInitial"));
      } else {
        setStatus(t("filterDisabledInitial"));
      }
    });
  }

  syncControlStates();
  chrome.storage.sync.get(storageDefaults).then((settings) => {
    finishInitialization(settings);
  }).catch(() => {
    finishInitialization(storageDefaults, true);
  });
})();
