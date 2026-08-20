(function exposeUiI18n(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleUiI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createUiI18n() {
  "use strict";

  const DEFAULT_UI_LANGUAGE = "zh-hans";
  const UI_LANGUAGE_TAGS = Object.freeze({
    "zh-hans": "zh-CN",
    "zh-hant": "zh-TW",
    en: "en"
  });

  const messages = Object.freeze({
    "zh-hans": Object.freeze({
      documentTitle: "Netflix 浏览页字幕筛选助手",
      headerTitle: "Netflix 字幕筛选",
      headerSubtitle: "自动隐藏已确认不符合字幕条件的影片",
      statusSettingsLoading: "正在读取当前设置…",
      uiLanguage: "界面语言",
      uiLanguageHint: "用于设置弹窗、筛选状态和影片语言标签",
      autoFilter: "自动筛选",
      autoFilterHint: "切换后立即生效；适用于首页、电影、节目、最新、片单和搜索",
      howTo: "怎么用",
      howStep1: "① 选择一个快捷条件或在下方自定义",
      howStep2: "② 点击红色的“保存并立即筛选”",
      howStep3: "以后打开 Netflix 会自动使用，不必重复点击",
      chooseConditions: "选择字幕条件",
      presets: "快捷选择",
      presetAria: "快捷字幕条件",
      presetChinese: "有中文即可",
      presetChineseEnglish: "中文 + 英文",
      presetSimplifiedEnglish: "简中 + 英文",
      presetTraditionalEnglish: "繁中 + 英文",
      presetChineseThai: "中文 + 泰文",
      logicAria: "条件组合规则",
      sameBoxLabel: "同一个框：",
      sameBoxText: "有任意一种即可",
      differentBoxLabel: "不同框：",
      differentBoxText: "每个框都必须满足",
      addGroup: "＋ 增加一个“还必须包含”的条件",
      showBadges: "在影片卡片显示匹配语言",
      showBadgesHint: "仅显示您条件中已确认支持的语言",
      unsupportedModeLabel: "已确认不符合条件的影片",
      unsupportedModeHint: "资料未知的影片始终保持显示，避免误判",
      unsupportedModeHide: "隐藏卡片",
      unsupportedModeMark: "显示并标红",
      saveApply: "保存并立即筛选",
      saving: "正在保存并读取…",
      manualRefresh: "结果不对？清除全部缓存并重新读取",
      weeklyRefresh: "每周自动更新字幕资料",
      weeklyRefreshHintOff: "关闭时仅在您手动点击更新后重新读取",
      weeklyRefreshHintPending: "已开启；Chrome 正在安排下一次更新",
      weeklyRefreshHintNext: "下次检查：{date}；只更新当前规则使用的语言",
      cacheHint: "字幕编号与节目名称按地区、Netflix 资料、界面语言和字幕语言长期保存在本机。每周更新只处理当前规则使用且到期的语言；Netflix 未提供可靠的真正增量接口。",
      playerSummary: "播放时导入本地字幕",
      optionalFeature: "可选功能",
      playerIntro: "导入 SRT、VTT、ASS/SSA。中文字形会影响本地字幕编码判断及下方备用官方目录，不会改变上面的卡片筛选条件。",
      localLanguageAria: "本地字幕首选中文字形",
      traditionalChinese: "繁體中文",
      big5Hint: "Big5 自动判断优先",
      simplifiedChinese: "简体中文",
      gb18030Hint: "GB18030 自动判断优先",
      floatingButton: "播放页悬浮字幕按钮",
      floatingButtonHint: "在播放页面显示导入入口",
      openPlayerPanel: "打开播放页字幕面板",
      openOfficialCatalog: "备用：按所选中文字形打开官方字幕目录",
      stateLoading: "读取中",
      statePending: "待保存",
      stateOn: "已开启",
      stateOff: "已关闭",
      draftChanged: "字幕条件已修改。点击红色的“保存并立即筛选”后生效。",
      groupNeedsLanguage: "每个条件组至少需要一种语言；请先添加新语言。",
      removeLanguage: "移除{language}",
      firstGroupTitle: "满足以下任意一种字幕",
      nextGroupTitle: "还必须满足以下任意一种",
      delete: "删除",
      addLanguageAria: "为条件组 {number} 添加语言",
      chooseLanguage: "再选择一种字幕语言…",
      addToGroup: "加入此框",
      chooseLanguageFirst: "请先选择一种字幕语言。",
      andDivider: "并且还要",
      orWord: " 或 ",
      andWord: " 且 ",
      savingStatus: "正在保存设置并读取 Netflix 字幕资料…",
      savedOpenNetflix: "设置已保存：{expression}。打开 Netflix 浏览页后会自动筛选。",
      filterDisabled: "自动筛选已关闭，所有 Netflix 浏览页会恢复影片卡片。",
      savedEnterBrowse: "设置已保存：{expression}。进入 Netflix 浏览页即可查看。",
      savedFiltering: "设置已保存：{expression}。当前页面正在筛选。",
      maxLanguages: "已经达到可用语言上限。",
      saveFailed: "保存筛选条件失败，请重试。",
      settingsLoadFailed: "无法读取已保存的设置。请关闭弹窗后重试；为避免覆盖原设置，当前控件已锁定。",
      toggleFailed: "切换自动筛选失败，请重试。",
      refreshing: "正在清除缓存并重新读取字幕目录…",
      cacheClearedOpen: "缓存已清除。打开任一 Netflix 浏览页后会自动重新读取。",
      refreshFailed: "刷新失败。",
      cacheClearedEnable: "缓存已清除；开启自动筛选后会重新读取。",
      cacheClearedEnter: "缓存已清除。进入任一 Netflix 浏览页后会自动重新读取。",
      refreshStarted: "已开始重新读取；进度会显示在当前 Netflix 页面右下角。",
      refreshUnavailable: "无法刷新字幕目录，请先刷新 Netflix 页面。",
      encodingPriority: "本地字幕编码优先设为{language}",
      floatingShown: "已显示播放页字幕按钮",
      floatingHidden: "已隐藏播放页字幕按钮",
      openWatchFirst: "请先在 Netflix 播放页使用此功能。",
      refreshWatchFirst: "请刷新 Netflix 播放页后再试。",
      officialCatalogFailed: "无法打开 Netflix 官方字幕目录。",
      filterEnabledInitial: "自动筛选已开启；进入支持的 Netflix 浏览页后会自动应用。",
      filterDisabledInitial: "自动筛选已关闭。开启后会在所有支持的 Netflix 浏览页自动应用。",
      uiLanguageSaved: "界面语言已更新。",
      scheduleEnabled: "每周自动更新已开启。",
      scheduleDisabled: "每周自动更新已关闭；仍可随时手动更新。",
      scheduleFailed: "无法保存自动更新设置，请重试。",
      scheduleResetFailed: "字幕资料已更新，但无法重置下次每周检查时间；请关闭再重新开启每周更新。",
      filterStatusLoading: "正在读取 Netflix 字幕资料…",
      filterStatusReady: "字幕筛选：显示 {matched} / {total} 部影片",
      filterStatusReadyMarked: "字幕筛选：匹配 {matched} · 标红 {marked} 部不符合影片",
      filterStatusPartial: "字幕筛选：匹配 {matched} · 暂时保留 {unknown} 部未知影片",
      filterStatusPartialMarked: "字幕筛选：匹配 {matched} · 标红 {marked} · 暂时保留 {unknown} 部未知影片",
      filterStatusError: "暂时无法读取 Netflix 字幕资料，未知影片保持显示；切换页面或手动更新可重试",
      filterStatusRetrying: "字幕资料暂时不完整，未知影片保持显示；{seconds} 秒后重试（{attempt}/{max}）",
      pageNoIdentity: "字幕筛选：无法安全确认此页影片编号，已保留全部影片",
      pageLoadingCatalogs: "正在读取字幕目录 {ready} / {total}",
      pageLoadingLanguage: "正在读取{language}字幕目录 · {count} 部",
      pageConfirmedSubtitles: "已确认字幕：{languages}",
      pageUnsupportedBadge: "不符合条件",
      pageUnsupportedBadgeTitle: "已确认不符合所选字幕条件",
      pageCachedSuffix: " · 已使用缓存"
    }),
    "zh-hant": Object.freeze({
      documentTitle: "Netflix 瀏覽頁字幕篩選助手",
      headerTitle: "Netflix 字幕篩選",
      headerSubtitle: "自動隱藏已確認不符合字幕條件的影片",
      statusSettingsLoading: "正在讀取目前設定…",
      uiLanguage: "介面語言",
      uiLanguageHint: "用於設定彈窗、篩選狀態和影片語言標籤",
      autoFilter: "自動篩選",
      autoFilterHint: "切換後立即生效；適用於首頁、電影、節目、最新、片單和搜尋",
      howTo: "怎麼用",
      howStep1: "① 選擇一個快速條件或在下方自訂",
      howStep2: "② 點擊紅色的「儲存並立即篩選」",
      howStep3: "以後開啟 Netflix 會自動使用，不必重複點擊",
      chooseConditions: "選擇字幕條件",
      presets: "快速選擇",
      presetAria: "快速字幕條件",
      presetChinese: "有中文即可",
      presetChineseEnglish: "中文 + 英文",
      presetSimplifiedEnglish: "簡中 + 英文",
      presetTraditionalEnglish: "繁中 + 英文",
      presetChineseThai: "中文 + 泰文",
      logicAria: "條件組合規則",
      sameBoxLabel: "同一個框：",
      sameBoxText: "有任意一種即可",
      differentBoxLabel: "不同框：",
      differentBoxText: "每個框都必須滿足",
      addGroup: "＋ 增加一個「還必須包含」的條件",
      showBadges: "在影片卡片顯示符合語言",
      showBadgesHint: "只顯示條件中已確認支援的語言",
      unsupportedModeLabel: "已確認不符合條件的影片",
      unsupportedModeHint: "資料未知的影片一律保持顯示，避免誤判",
      unsupportedModeHide: "隱藏卡片",
      unsupportedModeMark: "顯示並標紅",
      saveApply: "儲存並立即篩選",
      saving: "正在儲存並讀取…",
      manualRefresh: "結果不對？清除全部快取並重新讀取",
      weeklyRefresh: "每週自動更新字幕資料",
      weeklyRefreshHintOff: "關閉時只會在您手動點擊更新後重新讀取",
      weeklyRefreshHintPending: "已開啟；Chrome 正在安排下一次更新",
      weeklyRefreshHintNext: "下次檢查：{date}；只更新目前規則使用的語言",
      cacheHint: "字幕編號與節目名稱會按地區、Netflix 使用者、介面語言和字幕語言長期保存在本機。每週更新只處理目前規則使用且到期的語言；Netflix 未提供可靠的真正增量介面。",
      playerSummary: "播放時匯入本機字幕",
      optionalFeature: "選用功能",
      playerIntro: "匯入 SRT、VTT、ASS/SSA。中文字形會影響本機字幕編碼判斷及下方備用官方目錄，不會改變上面的卡片篩選條件。",
      localLanguageAria: "本機字幕偏好中文字形",
      traditionalChinese: "繁體中文",
      big5Hint: "優先判斷 Big5",
      simplifiedChinese: "簡體中文",
      gb18030Hint: "優先判斷 GB18030",
      floatingButton: "播放頁浮動字幕按鈕",
      floatingButtonHint: "在播放頁面顯示匯入入口",
      openPlayerPanel: "開啟播放頁字幕面板",
      openOfficialCatalog: "備用：按所選中文字形開啟官方字幕目錄",
      stateLoading: "讀取中",
      statePending: "待儲存",
      stateOn: "已開啟",
      stateOff: "已關閉",
      draftChanged: "字幕條件已修改。點擊紅色的「儲存並立即篩選」後生效。",
      groupNeedsLanguage: "每個條件組至少需要一種語言；請先加入新語言。",
      removeLanguage: "移除{language}",
      firstGroupTitle: "符合以下任意一種字幕",
      nextGroupTitle: "還必須符合以下任意一種",
      delete: "刪除",
      addLanguageAria: "為條件組 {number} 加入語言",
      chooseLanguage: "再選擇一種字幕語言…",
      addToGroup: "加入此框",
      chooseLanguageFirst: "請先選擇一種字幕語言。",
      andDivider: "並且還要",
      orWord: " 或 ",
      andWord: " 且 ",
      savingStatus: "正在儲存設定並讀取 Netflix 字幕資料…",
      savedOpenNetflix: "設定已儲存：{expression}。開啟 Netflix 瀏覽頁後會自動篩選。",
      filterDisabled: "自動篩選已關閉，所有 Netflix 瀏覽頁會恢復影片卡片。",
      savedEnterBrowse: "設定已儲存：{expression}。進入 Netflix 瀏覽頁即可查看。",
      savedFiltering: "設定已儲存：{expression}。目前頁面正在篩選。",
      maxLanguages: "已達可用語言上限。",
      saveFailed: "儲存篩選條件失敗，請重試。",
      settingsLoadFailed: "無法讀取已儲存的設定。請關閉彈窗後重試；為避免覆蓋原設定，目前控制項已鎖定。",
      toggleFailed: "切換自動篩選失敗，請重試。",
      refreshing: "正在清除快取並重新讀取字幕目錄…",
      cacheClearedOpen: "快取已清除。開啟任一 Netflix 瀏覽頁後會自動重新讀取。",
      refreshFailed: "更新失敗。",
      cacheClearedEnable: "快取已清除；開啟自動篩選後會重新讀取。",
      cacheClearedEnter: "快取已清除。進入任一 Netflix 瀏覽頁後會自動重新讀取。",
      refreshStarted: "已開始重新讀取；進度會顯示在目前 Netflix 頁面右下角。",
      refreshUnavailable: "無法更新字幕目錄，請先重新整理 Netflix 頁面。",
      encodingPriority: "本機字幕編碼優先設為{language}",
      floatingShown: "已顯示播放頁字幕按鈕",
      floatingHidden: "已隱藏播放頁字幕按鈕",
      openWatchFirst: "請先在 Netflix 播放頁使用此功能。",
      refreshWatchFirst: "請重新整理 Netflix 播放頁後再試。",
      officialCatalogFailed: "無法開啟 Netflix 官方字幕目錄。",
      filterEnabledInitial: "自動篩選已開啟；進入支援的 Netflix 瀏覽頁後會自動套用。",
      filterDisabledInitial: "自動篩選已關閉。開啟後會在所有支援的 Netflix 瀏覽頁自動套用。",
      uiLanguageSaved: "介面語言已更新。",
      scheduleEnabled: "每週自動更新已開啟。",
      scheduleDisabled: "每週自動更新已關閉；仍可隨時手動更新。",
      scheduleFailed: "無法儲存自動更新設定，請重試。",
      scheduleResetFailed: "字幕資料已更新，但無法重設下次每週檢查時間；請關閉再重新開啟每週更新。",
      filterStatusLoading: "正在讀取 Netflix 字幕資料…",
      filterStatusReady: "字幕篩選：顯示 {matched} / {total} 部影片",
      filterStatusReadyMarked: "字幕篩選：符合 {matched} · 標紅 {marked} 部不符合影片",
      filterStatusPartial: "字幕篩選：符合 {matched} · 暫時保留 {unknown} 部未知影片",
      filterStatusPartialMarked: "字幕篩選：符合 {matched} · 標紅 {marked} · 暫時保留 {unknown} 部未知影片",
      filterStatusError: "暫時無法讀取 Netflix 字幕資料，未知影片會保持顯示；切換頁面或手動更新可重試",
      filterStatusRetrying: "字幕資料暫時不完整，未知影片會保持顯示；{seconds} 秒後重試（{attempt}/{max}）",
      pageNoIdentity: "字幕篩選：無法安全確認此頁影片編號，已保留全部影片",
      pageLoadingCatalogs: "正在讀取字幕目錄 {ready} / {total}",
      pageLoadingLanguage: "正在讀取{language}字幕目錄 · {count} 部",
      pageConfirmedSubtitles: "已確認字幕：{languages}",
      pageUnsupportedBadge: "不符合條件",
      pageUnsupportedBadgeTitle: "已確認不符合所選字幕條件",
      pageCachedSuffix: " · 已使用快取"
    }),
    en: Object.freeze({
      documentTitle: "Netflix Subtitle Filter",
      headerTitle: "Netflix Subtitle Filter",
      headerSubtitle: "Automatically hide titles confirmed not to match your subtitle rules",
      statusSettingsLoading: "Loading settings…",
      uiLanguage: "Interface language",
      uiLanguageHint: "Used for settings, filter status, and language badges",
      autoFilter: "Automatic filtering",
      autoFilterHint: "Applies immediately on Home, Movies, TV Shows, New & Popular, My List, and Search",
      howTo: "How to use",
      howStep1: "1. Choose a preset or customize the groups below",
      howStep2: "2. Click the red “Save and filter now” button",
      howStep3: "Netflix will use the saved rule automatically next time",
      chooseConditions: "Choose subtitle rules",
      presets: "Presets",
      presetAria: "Subtitle rule presets",
      presetChinese: "Any Chinese",
      presetChineseEnglish: "Chinese + English",
      presetSimplifiedEnglish: "Simplified + English",
      presetTraditionalEnglish: "Traditional + English",
      presetChineseThai: "Chinese + Thai",
      logicAria: "Rule combination logic",
      sameBoxLabel: "Inside one box:",
      sameBoxText: "any one language is enough",
      differentBoxLabel: "Between boxes:",
      differentBoxText: "every box must match",
      addGroup: "+ Add another required group",
      showBadges: "Show matching languages on cards",
      showBadgesHint: "Only shows selected languages confirmed for that title",
      unsupportedModeLabel: "Titles confirmed not to match",
      unsupportedModeHint: "Titles with unknown data always remain visible to avoid false results",
      unsupportedModeHide: "Hide cards",
      unsupportedModeMark: "Show with red tag",
      saveApply: "Save and filter now",
      saving: "Saving and loading…",
      manualRefresh: "Wrong results? Clear all cache and reload",
      weeklyRefresh: "Automatically update subtitle data weekly",
      weeklyRefreshHintOff: "When off, data is reloaded only after a manual update",
      weeklyRefreshHintPending: "Enabled; Chrome is scheduling the next update",
      weeklyRefreshHintNext: "Next check: {date}; only languages used by the current rule",
      cacheHint: "Title IDs and show names are stored locally by region, Netflix profile, interface language, and subtitle language. Weekly updates only process selected languages that are due; Netflix does not provide a reliable true-delta API.",
      playerSummary: "Import local subtitles during playback",
      optionalFeature: "Optional",
      playerIntro: "Import SRT, VTT, ASS, or SSA. The Chinese preference affects local subtitle encoding detection and the fallback official catalog, not card filtering above.",
      localLanguageAria: "Preferred Chinese script for local subtitles",
      traditionalChinese: "Traditional Chinese",
      big5Hint: "Prioritize Big5 during auto detection",
      simplifiedChinese: "Simplified Chinese",
      gb18030Hint: "Prioritize GB18030 during auto detection",
      floatingButton: "Floating subtitle button on player",
      floatingButtonHint: "Shows the local-subtitle entry point while playing",
      openPlayerPanel: "Open subtitle panel on player",
      openOfficialCatalog: "Fallback: open the official subtitle catalog",
      stateLoading: "Loading",
      statePending: "Unsaved",
      stateOn: "On",
      stateOff: "Off",
      draftChanged: "Subtitle rules changed. Click “Save and filter now” to apply them.",
      groupNeedsLanguage: "Each group needs at least one language. Add another language first.",
      removeLanguage: "Remove {language}",
      firstGroupTitle: "Match any subtitle in this group",
      nextGroupTitle: "Also match any subtitle in this group",
      delete: "Delete",
      addLanguageAria: "Add a language to group {number}",
      chooseLanguage: "Choose another subtitle language…",
      addToGroup: "Add to group",
      chooseLanguageFirst: "Choose a subtitle language first.",
      andDivider: "AND",
      orWord: " OR ",
      andWord: " AND ",
      savingStatus: "Saving settings and loading Netflix subtitle data…",
      savedOpenNetflix: "Saved: {expression}. It will filter automatically when you open Netflix.",
      filterDisabled: "Automatic filtering is off. All browsing-page cards will be restored.",
      savedEnterBrowse: "Saved: {expression}. Open a Netflix browsing page to see the result.",
      savedFiltering: "Saved: {expression}. The current page is being filtered.",
      maxLanguages: "The language limit has been reached.",
      saveFailed: "Could not save the filter. Please try again.",
      settingsLoadFailed: "Saved settings could not be read. Close and reopen this popup to retry; controls are locked to avoid overwriting them.",
      toggleFailed: "Could not change automatic filtering. Please try again.",
      refreshing: "Clearing cache and reloading subtitle catalogs…",
      cacheClearedOpen: "Cache cleared. Data will reload when you open a Netflix browsing page.",
      refreshFailed: "Refresh failed.",
      cacheClearedEnable: "Cache cleared. Data will reload after automatic filtering is enabled.",
      cacheClearedEnter: "Cache cleared. Data will reload on the next Netflix browsing page.",
      refreshStarted: "Reload started. Progress appears at the bottom-right of the current Netflix page.",
      refreshUnavailable: "Could not refresh subtitle data. Refresh the Netflix page and try again.",
      encodingPriority: "Local subtitle encoding preference set to {language}",
      floatingShown: "Player subtitle button is visible",
      floatingHidden: "Player subtitle button is hidden",
      openWatchFirst: "Open a Netflix playback page first.",
      refreshWatchFirst: "Refresh the Netflix playback page and try again.",
      officialCatalogFailed: "Could not open the official Netflix subtitle catalog.",
      filterEnabledInitial: "Automatic filtering is on and will apply on supported Netflix browsing pages.",
      filterDisabledInitial: "Automatic filtering is off. Turn it on to apply it on supported browsing pages.",
      uiLanguageSaved: "Interface language updated.",
      scheduleEnabled: "Weekly automatic updates are on.",
      scheduleDisabled: "Weekly automatic updates are off; manual updates remain available.",
      scheduleFailed: "Could not save the automatic update setting. Please try again.",
      scheduleResetFailed: "Subtitle data was updated, but the next weekly check could not be reset. Turn weekly updates off and on again.",
      filterStatusLoading: "Loading Netflix subtitle data…",
      filterStatusReady: "Subtitle filter: showing {matched} of {total} titles",
      filterStatusReadyMarked: "Subtitle filter: {matched} matches · {marked} non-matches marked",
      filterStatusPartial: "Subtitle filter: {matched} matches · keeping {unknown} unknown titles",
      filterStatusPartialMarked: "Subtitle filter: {matched} matches · {marked} marked · keeping {unknown} unknown titles",
      filterStatusError: "Subtitle data is temporarily unavailable; unknown titles remain visible. Navigate or update manually to retry",
      filterStatusRetrying: "Subtitle data is incomplete; unknown titles remain visible. Retrying in {seconds}s ({attempt}/{max})",
      pageNoIdentity: "Subtitle filter: title IDs could not be verified safely; all titles remain visible",
      pageLoadingCatalogs: "Loading subtitle catalogs {ready} / {total}",
      pageLoadingLanguage: "Loading {language} subtitles · {count} titles",
      pageConfirmedSubtitles: "Confirmed subtitles: {languages}",
      pageUnsupportedBadge: "Doesn't match",
      pageUnsupportedBadgeTitle: "Confirmed not to match the selected subtitle rule",
      pageCachedSuffix: " · cached"
    })
  });

  const shortNames = Object.freeze({
    "zh-hans": Object.freeze({ "zh-hant": "繁中", "zh-hans": "简中", en: "英文", th: "泰文" }),
    "zh-hant": Object.freeze({ "zh-hant": "繁中", "zh-hans": "簡中", en: "英文", th: "泰文" }),
    en: Object.freeze({ "zh-hant": "Trad. Chinese", "zh-hans": "Simpl. Chinese", en: "English", th: "Thai" })
  });

  function normalizeUiLanguage(value) {
    const code = String(value || "").toLowerCase();
    return Object.hasOwn(UI_LANGUAGE_TAGS, code) ? code : DEFAULT_UI_LANGUAGE;
  }

  function format(template, values = {}) {
    return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => (
      Object.hasOwn(values, key) ? String(values[key]) : ""
    ));
  }

  function t(locale, key, values) {
    const normalized = normalizeUiLanguage(locale);
    const template = messages[normalized]?.[key] ?? messages[DEFAULT_UI_LANGUAGE]?.[key] ?? key;
    return format(template, values);
  }

  function languageTag(code) {
    const normalized = String(code || "").toLowerCase();
    if (normalized === "zh-hant") {
      return "zh-Hant";
    }
    if (normalized === "zh-hans") {
      return "zh-Hans";
    }
    if (normalized === "fr-ca") {
      return "fr-CA";
    }
    return normalized;
  }

  function languageName(locale, code, options = {}) {
    const normalizedLocale = normalizeUiLanguage(locale);
    const normalizedCode = String(code || "").toLowerCase();
    if (options.short && shortNames[normalizedLocale]?.[normalizedCode]) {
      return shortNames[normalizedLocale][normalizedCode];
    }
    try {
      const displayNames = new Intl.DisplayNames([UI_LANGUAGE_TAGS[normalizedLocale]], {
        type: "language"
      });
      return displayNames.of(languageTag(normalizedCode)) || normalizedCode;
    } catch (_error) {
      return shortNames[normalizedLocale]?.[normalizedCode] || normalizedCode;
    }
  }

  function languageBadgePresentation(locale, codes) {
    const normalizedLocale = normalizeUiLanguage(locale);
    const normalizedCodes = Array.from(new Set(Array.from(codes || [])
      .map((code) => String(code || "").toLowerCase())
      .filter(Boolean)));
    const labels = normalizedCodes
      .map((code) => languageName(normalizedLocale, code, { short: true }))
      .filter(Boolean);
    const text = labels.join(" · ");
    return {
      codes: normalizedCodes,
      lang: UI_LANGUAGE_TAGS[normalizedLocale],
      text,
      title: text ? t(normalizedLocale, "pageConfirmedSubtitles", { languages: text }) : ""
    };
  }

  function unsupportedBadgePresentation(locale) {
    const normalizedLocale = normalizeUiLanguage(locale);
    return {
      lang: UI_LANGUAGE_TAGS[normalizedLocale],
      text: t(normalizedLocale, "pageUnsupportedBadge"),
      title: t(normalizedLocale, "pageUnsupportedBadgeTitle")
    };
  }

  function createUiLanguageController(initialValue = DEFAULT_UI_LANGUAGE, onChange = () => {}) {
    let value = normalizeUiLanguage(initialValue);
    let revision = 0;

    function apply(nextValue) {
      const next = normalizeUiLanguage(nextValue);
      const previous = value;
      value = next;
      revision += 1;
      const changed = next !== previous;
      if (changed && typeof onChange === "function") {
        onChange(next, previous);
      }
      return { applied: true, changed, revision, value };
    }

    return Object.freeze({
      get value() {
        return value;
      },
      get revision() {
        return revision;
      },
      apply,
      hydrate(nextValue, expectedRevision) {
        if (revision !== expectedRevision) {
          return { applied: false, changed: false, revision, value };
        }
        return apply(nextValue);
      }
    });
  }

  function messageKeys(locale) {
    return Object.keys(messages[normalizeUiLanguage(locale)]).sort();
  }

  return Object.freeze({
    DEFAULT_UI_LANGUAGE,
    UI_LANGUAGE_TAGS,
    normalizeUiLanguage,
    t,
    languageName,
    languageBadgePresentation,
    unsupportedBadgePresentation,
    createUiLanguageController,
    messageKeys
  });
});
