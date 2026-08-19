(function startNetflixChineseHelper() {
  "use strict";

  const config = globalThis.NetflixSubtitleConfig;
  const subtitleTools = globalThis.NetflixSubtitleTools;
  const toolbarTools = globalThis.NetflixSubtitlePlayerToolbar;
  const MAX_SUBTITLE_FILE_BYTES = 16 * 1024 * 1024;
  const MAX_SUBTITLE_CUES = 50_000;

  if (!config || !subtitleTools || !toolbarTools || document.getElementById("nch-extension-host")) {
    return;
  }

  const state = {
    settings: { ...config.DEFAULT_SETTINGS },
    cues: [],
    fileName: "",
    format: "",
    offset: 0,
    currentVideoId: null,
    loadedVideoId: null,
    lastFileBuffer: null,
    lastFileName: "",
    maxCueDuration: 0,
    lastRenderedText: "",
    panelOpen: false,
    forcedToolbarVisible: false,
    toastTimer: null,
    videoElement: null,
    lastVideoScanAt: 0,
    nativeTrack: null,
    nativeTrackElement: null,
    nativeTrackVideo: null,
    nativeTrackSignature: "",
    lastToolbarPointerRevealAt: 0
  };

  const host = document.createElement("div");
  host.id = "nch-extension-host";
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      :host, *, *::before, *::after { box-sizing: border-box; }
      :host { color-scheme: dark; font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
      button, select, input { font: inherit; }
      button { border: 0; }
      [hidden] { display: none !important; }

      .subtitle-layer {
        align-items: flex-end;
        bottom: var(--nch-subtitle-bottom, 12vh);
        display: flex;
        justify-content: center;
        left: 6vw;
        pointer-events: none;
        position: fixed;
        right: 6vw;
        text-align: center;
        z-index: 20;
      }

      .subtitle-text {
        background: var(--nch-subtitle-bg, rgba(0, 0, 0, .68));
        border-radius: 7px;
        color: #fff;
        display: inline;
        font-size: var(--nch-subtitle-size, 38px);
        font-weight: 650;
        letter-spacing: .015em;
        line-height: 1.42;
        max-width: min(1200px, 92vw);
        padding: .12em .38em .18em;
        text-shadow: 0 2px 5px #000, 0 0 2px #000;
        white-space: pre-line;
      }

      .toolbar {
        bottom: 18px;
        display: flex;
        filter: drop-shadow(0 9px 24px rgba(0, 0, 0, .45));
        gap: 7px;
        pointer-events: auto;
        position: fixed;
        right: 18px;
        z-index: 30;
      }

      .toolbar.is-collapsed { gap: 0; }

      .pill {
        align-items: center;
        background: rgba(20, 20, 20, .94);
        border: 1px solid rgba(255, 255, 255, .18);
        border-radius: 999px;
        color: #fff;
        cursor: pointer;
        display: inline-flex;
        gap: 7px;
        min-height: 42px;
        padding: 0 15px;
        transition: background .16s ease, border-color .16s ease, transform .16s ease;
      }

      .pill:hover { background: #272727; border-color: rgba(255, 255, 255, .34); transform: translateY(-1px); }
      .pill:focus-visible, .panel button:focus-visible, .panel select:focus-visible, .panel input:focus-visible {
        outline: 3px solid rgba(229, 9, 20, .45);
        outline-offset: 2px;
      }
      .pill.primary {
        background: #e50914;
        border-color: #e50914;
        font-weight: 750;
        max-width: 240px;
        overflow: hidden;
        white-space: nowrap;
        transition:
          background .16s ease,
          border-color .16s ease,
          border-width .22s ease,
          max-width .22s ease,
          opacity .16s ease,
          padding .22s ease,
          transform .16s ease,
          visibility 0s linear;
      }
      .pill.primary:hover { background: #f31a25; }
      .toolbar.is-collapsed .pill.primary {
        border-left-width: 0;
        border-right-width: 0;
        max-width: 0;
        opacity: 0;
        padding-left: 0;
        padding-right: 0;
        pointer-events: none;
        transform: translateX(8px);
        visibility: hidden;
        transition:
          background .16s ease,
          border-color .16s ease,
          border-width .22s ease,
          max-width .22s ease,
          opacity .16s ease,
          padding .22s ease,
          transform .16s ease,
          visibility 0s linear .22s;
      }
      .pill.icon { justify-content: center; padding: 0; width: 42px; }
      .pill svg { height: 18px; width: 18px; }

      .panel {
        background: rgba(18, 18, 18, .98);
        border: 1px solid rgba(255, 255, 255, .16);
        border-radius: 16px;
        bottom: 52px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, .62);
        color: #fff;
        max-height: calc(100dvh - 84px);
        overflow-y: auto;
        padding: 18px;
        position: absolute;
        right: 0;
        width: min(352px, calc(100vw - 28px));
      }

      .panel h2 { font-size: 17px; line-height: 1.25; margin: 0 0 7px; }
      .panel p { color: #b9b9b9; font-size: 12px; line-height: 1.55; margin: 0 0 14px; }
      .panel .privacy { color: #8fd7a8; margin-top: 10px; }
      .panel-section + .panel-section { border-top: 1px solid rgba(255, 255, 255, .1); margin-top: 14px; padding-top: 14px; }
      .field-label { color: #d9d9d9; display: block; font-size: 12px; margin: 0 0 7px; }
      .row { align-items: center; display: flex; gap: 8px; margin-top: 10px; }
      .row.spread { justify-content: space-between; }
      .row.wrap { flex-wrap: wrap; }

      .panel button, .file-label, .panel select {
        background: #303030;
        border: 1px solid rgba(255, 255, 255, .14);
        border-radius: 9px;
        color: #fff;
        cursor: pointer;
        min-height: 36px;
        padding: 7px 11px;
      }
      .panel button:hover, .file-label:hover, .panel select:hover { background: #3b3b3b; }
      .panel button.accent, .file-label.accent { background: #e50914; border-color: #e50914; font-weight: 700; }
      .panel button.wide, .file-label.wide { display: flex; justify-content: center; width: 100%; }
      .panel button.danger { color: #ff9ca2; }
      .panel button.active { background: #fff; color: #141414; font-weight: 750; }
      .panel select { min-width: 128px; }
      .file-label { position: relative; }
      .file-label input {
        height: 1px;
        left: 50%;
        opacity: 0;
        position: absolute;
        top: 50%;
        width: 1px;
      }
      .file-label:focus-within { outline: 3px solid rgba(229, 9, 20, .45); outline-offset: 2px; }
      .value { color: #fff; font-size: 12px; min-width: 52px; text-align: center; }
      .file-status { color: #ddd; font-size: 12px; line-height: 1.4; margin-top: 9px; overflow-wrap: anywhere; }

      .switch { align-items: center; cursor: pointer; display: flex; gap: 9px; }
      .switch input { accent-color: #e50914; height: 17px; width: 17px; }

      .toast {
        background: rgba(16, 16, 16, .96);
        border: 1px solid rgba(255, 255, 255, .2);
        border-radius: 10px;
        bottom: 76px;
        color: #fff;
        font-size: 13px;
        left: 50%;
        max-width: min(520px, calc(100vw - 32px));
        padding: 10px 14px;
        pointer-events: none;
        position: fixed;
        transform: translateX(-50%);
        z-index: 40;
      }

      @media (max-width: 700px) {
        .toolbar { bottom: 10px; right: 10px; }
        .subtitle-layer { left: 3vw; right: 3vw; }
        .subtitle-text { font-size: min(var(--nch-subtitle-size, 38px), 7vw); }
      }

      @media (prefers-reduced-motion: reduce) {
        .pill, .pill.primary, .toolbar.is-collapsed .pill.primary { transition: none; }
      }
    </style>

    <div class="subtitle-layer" id="subtitle-layer" hidden>
      <span class="subtitle-text" id="subtitle-text"></span>
    </div>

    <div class="toolbar" id="toolbar" hidden>
      <button class="pill primary" id="primary-action" type="button"></button>
      <button class="pill icon" id="panel-toggle" type="button" aria-label="本地字幕设置和导入" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v10h16V7H4Zm2 3h5v2H6v-2Zm0 4h8v2H6v-2Zm10-4h2v2h-2v-2Z"/></svg>
      </button>

      <section class="panel" id="panel" hidden>
        <div id="watch-controls" hidden>
          <h2>本地字幕</h2>
          <p>支持 SRT、VTT、ASS/SSA。文件只在此电脑中读取，不会上传。</p>

          <label class="file-label accent wide">
            选择字幕文件
            <input id="subtitle-file" type="file" accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/plain">
          </label>
          <div class="file-status" id="file-status">尚未导入字幕</div>

          <div class="panel-section">
            <label class="field-label" for="encoding">文件编码</label>
            <select id="encoding">
              <option value="auto">自动（推荐）</option>
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">简中 GB18030</option>
              <option value="big5">繁中 Big5</option>
              <option value="utf-16le">UTF-16 LE</option>
            </select>
          </div>

          <div class="panel-section">
            <span class="field-label">时间同步</span>
            <div class="row">
              <button type="button" data-offset="-0.5">字幕提前</button>
              <span class="value" id="offset-value">0.0 秒</span>
              <button type="button" data-offset="0.5">字幕延后</button>
            </div>
            <div class="row">
              <button type="button" id="offset-reset">重置时间</button>
            </div>
          </div>

          <div class="panel-section">
            <div class="row spread">
              <span class="field-label">字体大小</span>
              <div class="row">
                <button type="button" data-font="-2" aria-label="减小字体">−</button>
                <span class="value" id="font-value"></span>
                <button type="button" data-font="2" aria-label="增大字体">＋</button>
              </div>
            </div>
            <div class="row spread">
              <span class="field-label">字幕高度</span>
              <div class="row">
                <button type="button" data-bottom="-2" aria-label="降低字幕">↓</button>
                <span class="value" id="bottom-value"></span>
                <button type="button" data-bottom="2" aria-label="升高字幕">↑</button>
              </div>
            </div>
            <label class="switch row">
              <input id="subtitle-background" type="checkbox">
              <span>显示黑色字幕底</span>
            </label>
          </div>

          <div class="panel-section">
            <button class="danger wide" id="remove-subtitles" type="button">移除本地字幕</button>
          </div>
        </div>
      </section>
    </div>

    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  `;

  const elements = {
    subtitleLayer: shadow.getElementById("subtitle-layer"),
    subtitleText: shadow.getElementById("subtitle-text"),
    toolbar: shadow.getElementById("toolbar"),
    primaryAction: shadow.getElementById("primary-action"),
    panelToggle: shadow.getElementById("panel-toggle"),
    panel: shadow.getElementById("panel"),
    watchControls: shadow.getElementById("watch-controls"),
    fileInput: shadow.getElementById("subtitle-file"),
    fileStatus: shadow.getElementById("file-status"),
    encoding: shadow.getElementById("encoding"),
    offsetValue: shadow.getElementById("offset-value"),
    fontValue: shadow.getElementById("font-value"),
    bottomValue: shadow.getElementById("bottom-value"),
    background: shadow.getElementById("subtitle-background"),
    removeSubtitles: shadow.getElementById("remove-subtitles"),
    toast: shadow.getElementById("toast")
  };

  const toolbarAutoCollapse = toolbarTools.createAutoCollapseController({
    onChange(collapsed) {
      toolbarTools.applyCollapsedState(elements, collapsed);
    },
    setTimer: window.setTimeout.bind(window),
    clearTimer: window.clearTimeout.bind(window)
  });

  function isWatchPage() {
    return /^\/watch\/\d+/.test(location.pathname);
  }

  function isSupportedRoute() {
    return isWatchPage();
  }

  function getVideoId() {
    return location.pathname.match(/^\/watch\/(\d+)/)?.[1] || null;
  }

  function mountHost() {
    const fullscreenElement = document.fullscreenElement;
    const target = fullscreenElement && fullscreenElement.tagName !== "VIDEO"
      ? fullscreenElement
      : document.documentElement;

    if (target && host.parentNode !== target) {
      target.appendChild(host);
    }
  }

  function isVideoFullscreen(video) {
    const fullscreenElement = document.fullscreenElement;
    if (!fullscreenElement || fullscreenElement.tagName !== "VIDEO") {
      return false;
    }
    return !video || fullscreenElement === video;
  }

  function removeNativeTrackCues(track) {
    if (!track?.cues) {
      return;
    }

    for (const cue of Array.from(track.cues)) {
      try {
        track.removeCue(cue);
      } catch (_error) {
        // A detached video can invalidate its TextTrack while Netflix switches playback.
      }
    }
  }

  function destroyNativeTrack() {
    if (state.nativeTrack) {
      removeNativeTrackCues(state.nativeTrack);
      state.nativeTrack.mode = "disabled";
    }

    state.nativeTrackElement?.remove();
    state.nativeTrack = null;
    state.nativeTrackElement = null;
    state.nativeTrackVideo = null;
    state.nativeTrackSignature = "";
  }

  function ensureNativeTrack(video) {
    if (!video || typeof VTTCue !== "function") {
      destroyNativeTrack();
      return null;
    }

    if (
      state.nativeTrack
      && state.nativeTrackElement?.isConnected
      && state.nativeTrackVideo === video
    ) {
      return state.nativeTrack;
    }

    destroyNativeTrack();

    const trackElement = document.createElement("track");
    trackElement.kind = "subtitles";
    trackElement.label = "本地字幕";
    trackElement.srclang = "zh";
    video.appendChild(trackElement);

    state.nativeTrackElement = trackElement;
    state.nativeTrack = trackElement.track;
    state.nativeTrackVideo = video;
    state.nativeTrack.mode = "showing";
    return state.nativeTrack;
  }

  function updateNativeFullscreenCues(video) {
    if (!video || !isVideoFullscreen(video) || !state.cues.length) {
      destroyNativeTrack();
      return;
    }

    const track = ensureNativeTrack(video);
    if (!track) {
      return;
    }

    const subtitleTime = video.currentTime - state.offset;
    const activeCues = findActiveCues(subtitleTime);
    const signature = activeCues
      .map((cue) => `${cue.start}|${cue.end}|${cue.text}`)
      .join("\u0000");

    if (signature !== state.nativeTrackSignature) {
      removeNativeTrackCues(track);

      for (const cue of activeCues) {
        const start = Math.max(0, cue.start + state.offset);
        const end = cue.end + state.offset;
        if (end <= start) {
          continue;
        }

        try {
          track.addCue(new VTTCue(start, end, cue.text));
        } catch (_error) {
          // Ignore a malformed current cue while keeping playback usable.
        }
      }

      state.nativeTrackSignature = signature;
    }

    track.mode = "showing";
  }

  function syncFullscreenPresentation() {
    mountHost();

    const fullscreenVideo = document.fullscreenElement?.tagName === "VIDEO"
      ? document.fullscreenElement
      : null;

    if (fullscreenVideo && state.cues.length) {
      state.videoElement = fullscreenVideo;
      updateNativeFullscreenCues(fullscreenVideo);
      elements.subtitleLayer.hidden = true;
    } else {
      destroyNativeTrack();
    }

    if (fullscreenVideo && state.panelOpen) {
      setPanelOpen(false);
    }
    updateMode();
  }

  function showToast(message, duration = 2600) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, duration);
  }

  function setPanelOpen(open) {
    state.panelOpen = Boolean(open);
    elements.panel.hidden = !state.panelOpen;
    elements.panelToggle.setAttribute("aria-expanded", String(state.panelOpen));

    if (state.panelOpen) {
      toolbarAutoCollapse.hold("panel");
    } else {
      toolbarAutoCollapse.release("panel");
    }

    if (!state.panelOpen && state.forcedToolbarVisible) {
      state.forcedToolbarVisible = false;
      updateMode();
    }
  }

  function updateStyleControls() {
    const fontSize = Number(state.settings.subtitleFontSize);
    const bottom = Number(state.settings.subtitleBottom);
    host.style.setProperty("--nch-subtitle-size", `${fontSize}px`);
    host.style.setProperty("--nch-subtitle-bottom", `${bottom}vh`);
    host.style.setProperty(
      "--nch-subtitle-bg",
      state.settings.subtitleBackground ? "rgba(0, 0, 0, .68)" : "transparent"
    );
    elements.fontValue.textContent = `${fontSize}px`;
    elements.bottomValue.textContent = `${bottom}%`;
    elements.background.checked = Boolean(state.settings.subtitleBackground);
    elements.encoding.value = state.settings.subtitleEncoding;
  }

  function updateOffsetLabel() {
    const prefix = state.offset > 0 ? "+" : "";
    elements.offsetValue.textContent = `${prefix}${state.offset.toFixed(1)} 秒`;
  }

  function updateFileStatus() {
    if (!state.cues.length) {
      elements.fileStatus.textContent = "尚未导入字幕";
      return;
    }

    elements.fileStatus.textContent = `${state.fileName} · ${state.cues.length} 条 · ${state.format.toUpperCase()}`;
  }

  function restoreToolbarInteractionHolds() {
    if (elements.toolbar.matches(":hover")) {
      toolbarAutoCollapse.hold("pointer");
    }
    if (shadow.activeElement && elements.toolbar.contains(shadow.activeElement)) {
      toolbarAutoCollapse.hold("focus");
    }
    if (document.hidden) {
      toolbarAutoCollapse.hold("document-hidden");
    }
    if (state.panelOpen) {
      toolbarAutoCollapse.hold("panel");
    }
  }

  function updateMode() {
    const watching = isWatchPage();
    const nextVideoId = getVideoId();
    const previousVideoId = state.currentVideoId;
    const changedAwayFromImportedVideo = Boolean(
      state.cues.length
      && state.loadedVideoId
      && state.loadedVideoId !== nextVideoId
    );

    if (changedAwayFromImportedVideo) {
      const movedToAnotherVideo = Boolean(nextVideoId);
      clearSubtitles(false);
      if (movedToAnotherVideo) {
        showToast("影片已切换，请为新影片重新导入字幕");
      }
    }

    state.currentVideoId = nextVideoId;
    elements.watchControls.hidden = !watching;

    if (watching) {
      elements.primaryAction.textContent = state.cues.length ? "本地字幕已加载" : "导入本地字幕";
    } else {
      elements.subtitleLayer.hidden = true;
    }

    const showToolbar = isSupportedRoute()
      && (state.settings.showFloatingButton || state.forcedToolbarVisible)
      && !isVideoFullscreen();

    if (!showToolbar && state.panelOpen) {
      setPanelOpen(false);
    }
    elements.toolbar.hidden = !showToolbar;

    if (!showToolbar) {
      toolbarAutoCollapse.stop();
    } else if (!toolbarAutoCollapse.isActive() || previousVideoId !== nextVideoId) {
      toolbarAutoCollapse.start();
      restoreToolbarInteractionHolds();
    }
  }

  function chooseLargestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) {
      return null;
    }

    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return { video, area: rect.width * rect.height };
      })
      .filter(({ video, area }) => video.isConnected && area > 10_000)
      .sort((a, b) => b.area - a.area)[0]?.video || null;
  }

  function findActiveCues(time) {
    const earliestPossibleStart = time - state.maxCueDuration;
    let low = 0;
    let high = state.cues.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (state.cues[middle].start < earliestPossibleStart) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    const active = [];
    for (let index = low; index < state.cues.length; index += 1) {
      const cue = state.cues[index];
      if (cue.start > time) {
        break;
      }
      if (cue.end >= time) {
        active.push(cue);
      }
    }

    return active;
  }

  function renderSubtitles() {
    if (!isWatchPage() || !state.cues.length || state.loadedVideoId !== getVideoId()) {
      if (!elements.subtitleLayer.hidden) {
        elements.subtitleLayer.hidden = true;
      }
      return;
    }

    const now = performance.now();
    if (!state.videoElement || !state.videoElement.isConnected || now - state.lastVideoScanAt > 1200) {
      const nextVideo = chooseLargestVideo();
      if (nextVideo && nextVideo !== state.videoElement) {
        state.videoElement = nextVideo;
        if (state.nativeTrackVideo && state.nativeTrackVideo !== nextVideo) {
          destroyNativeTrack();
        }
      }
      state.lastVideoScanAt = now;
    }

    const video = state.videoElement;
    if (!video || !Number.isFinite(video.currentTime)) {
      elements.subtitleLayer.hidden = true;
      return;
    }

    if (isVideoFullscreen(video)) {
      updateNativeFullscreenCues(video);
      elements.subtitleLayer.hidden = true;
      return;
    }

    if (state.nativeTrack) {
      destroyNativeTrack();
    }

    const subtitleTime = video.currentTime - state.offset;
    const activeText = findActiveCues(subtitleTime).map((cue) => cue.text).join("\n");

    if (activeText !== state.lastRenderedText) {
      state.lastRenderedText = activeText;
      elements.subtitleText.textContent = activeText;
    }

    elements.subtitleLayer.hidden = !activeText;
  }

  function clearSubtitles(withToast = true) {
    state.cues = [];
    state.fileName = "";
    state.format = "";
    state.offset = 0;
    state.loadedVideoId = null;
    state.lastFileBuffer = null;
    state.lastFileName = "";
    state.maxCueDuration = 0;
    state.lastRenderedText = "";
    destroyNativeTrack();
    elements.subtitleText.textContent = "";
    elements.subtitleLayer.hidden = true;
    updateFileStatus();
    updateOffsetLabel();
    updateMode();

    if (withToast) {
      showToast("本地字幕已移除");
    }
  }

  function parseSubtitleBuffer(buffer, fileName, resetOffset) {
    const text = subtitleTools.decodeSubtitle(
      buffer,
      state.settings.subtitleEncoding,
      state.settings.preferredLanguage
    );
    const result = subtitleTools.parseSubtitles(text, fileName);

    if (!result.cues.length) {
      throw new Error("没有识别到有效的字幕时间轴");
    }

    if (result.cues.length > MAX_SUBTITLE_CUES) {
      throw new Error(`字幕条目超过 ${MAX_SUBTITLE_CUES.toLocaleString()} 条限制`);
    }

    state.cues = result.cues;
    state.fileName = fileName;
    state.format = result.format;
    state.loadedVideoId = getVideoId();
    state.lastFileBuffer = buffer;
    state.lastFileName = fileName;
    state.maxCueDuration = result.cues.reduce(
      (maximum, cue) => Math.max(maximum, cue.end - cue.start),
      0
    );
    state.lastRenderedText = "";

    if (resetOffset) {
      state.offset = 0;
    }

    state.videoElement = chooseLargestVideo();
    state.lastVideoScanAt = performance.now();
    updateFileStatus();
    updateOffsetLabel();
    updateMode();

    if (isVideoFullscreen()) {
      updateNativeFullscreenCues(state.videoElement);
    }

    return result;
  }

  async function importSubtitleFile(file) {
    if (!file) {
      return;
    }

    try {
      if (file.size > MAX_SUBTITLE_FILE_BYTES) {
        throw new Error("字幕文件不能超过 16 MB");
      }

      const buffer = await file.arrayBuffer();
      const result = parseSubtitleBuffer(buffer, file.name, true);
      showToast(`已导入 ${result.cues.length} 条字幕`);
    } catch (error) {
      showToast(`字幕导入失败：${error.message || "文件格式不支持"}`, 4200);
    } finally {
      elements.fileInput.value = "";
    }
  }

  function reparseImportedSubtitle() {
    if (!state.lastFileBuffer || !state.lastFileName) {
      return;
    }

    try {
      const result = parseSubtitleBuffer(state.lastFileBuffer, state.lastFileName, false);
      showToast(`已用新编码重新读取 ${result.cues.length} 条字幕`);
    } catch (error) {
      showToast(`重新读取失败：${error.message || "编码不兼容"}`, 4200);
    }
  }

  async function saveSettings(partial) {
    Object.assign(state.settings, partial);
    updateStyleControls();
    updateMode();
    await chrome.storage.sync.set(partial);
  }

  elements.primaryAction.addEventListener("click", () => {
    if (isWatchPage()) {
      setPanelOpen(!state.panelOpen);
    }
  });

  elements.panelToggle.addEventListener("click", () => setPanelOpen(!state.panelOpen));

  elements.toolbar.addEventListener("pointerenter", () => {
    toolbarAutoCollapse.hold("pointer");
  });

  elements.toolbar.addEventListener("pointerleave", () => {
    toolbarAutoCollapse.release("pointer");
  });

  elements.toolbar.addEventListener("focusin", () => {
    toolbarAutoCollapse.hold("focus");
  });

  elements.toolbar.addEventListener("focusout", (event) => {
    if (!elements.toolbar.contains(event.relatedTarget)) {
      toolbarAutoCollapse.release("focus");
    }
  });

  document.addEventListener("pointermove", (event) => {
    const revealWidth = Math.min(320, Math.max(220, window.innerWidth * 0.18));
    const nearToolbar = event.clientX >= window.innerWidth - revealWidth
      && event.clientY >= window.innerHeight - 150;
    const now = performance.now();
    if (
      nearToolbar
      && !elements.toolbar.hidden
      && now - state.lastToolbarPointerRevealAt >= 300
    ) {
      state.lastToolbarPointerRevealAt = now;
      toolbarAutoCollapse.reveal(2_800);
    }
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    if (state.panelOpen && !event.composedPath().includes(host)) {
      setPanelOpen(false);
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.panelOpen) {
      event.preventDefault();
      setPanelOpen(false);
      elements.panelToggle.focus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      toolbarAutoCollapse.hold("document-hidden");
    } else {
      toolbarAutoCollapse.release("document-hidden");
    }
  });

  elements.fileInput.addEventListener("change", () => importSubtitleFile(elements.fileInput.files?.[0]));

  elements.encoding.addEventListener("change", async () => {
    await saveSettings({ subtitleEncoding: elements.encoding.value });
    reparseImportedSubtitle();
  });

  shadow.querySelectorAll("[data-offset]").forEach((button) => {
    button.addEventListener("click", () => {
      state.offset = Math.max(-30, Math.min(30, state.offset + Number(button.dataset.offset)));
      updateOffsetLabel();
      if (isVideoFullscreen()) {
        state.nativeTrackSignature = "";
        updateNativeFullscreenCues(state.videoElement);
      }
    });
  });

  shadow.getElementById("offset-reset").addEventListener("click", () => {
    state.offset = 0;
    updateOffsetLabel();
    if (isVideoFullscreen()) {
      state.nativeTrackSignature = "";
      updateNativeFullscreenCues(state.videoElement);
    }
  });

  shadow.querySelectorAll("[data-font]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Math.max(18, Math.min(72, Number(state.settings.subtitleFontSize) + Number(button.dataset.font)));
      saveSettings({ subtitleFontSize: next });
    });
  });

  shadow.querySelectorAll("[data-bottom]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Math.max(4, Math.min(40, Number(state.settings.subtitleBottom) + Number(button.dataset.bottom)));
      saveSettings({ subtitleBottom: next });
    });
  });

  elements.background.addEventListener("change", () => {
    saveSettings({ subtitleBackground: elements.background.checked });
  });

  elements.removeSubtitles.addEventListener("click", () => clearSubtitles(true));

  document.addEventListener("fullscreenchange", syncFullscreenPresentation);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    let playerSettingChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key in state.settings && change.newValue !== undefined) {
        state.settings[key] = change.newValue;
        playerSettingChanged = true;
      }
    }

    if (playerSettingChanged) {
      updateStyleControls();
      updateMode();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type === "NCH_OPEN_PLAYER_PANEL"
      && isWatchPage()
      && !isVideoFullscreen()
    ) {
      state.forcedToolbarVisible = true;
      updateMode();
      setPanelOpen(true);
    }
  });

  let previousWatchRoute = `${isWatchPage()}:${getVideoId() || ""}`;
  window.setInterval(() => {
    const nextWatchRoute = `${isWatchPage()}:${getVideoId() || ""}`;
    if (nextWatchRoute !== previousWatchRoute) {
      previousWatchRoute = nextWatchRoute;
      state.videoElement = null;
      state.lastVideoScanAt = 0;
      setPanelOpen(false);
      updateMode();
    }
    mountHost();
  }, 600);

  window.setInterval(renderSubtitles, 80);

  mountHost();
  updateFileStatus();
  updateOffsetLabel();

  chrome.storage.sync.get(config.DEFAULT_SETTINGS).then((savedSettings) => {
    Object.assign(state.settings, savedSettings);
    updateStyleControls();
    updateMode();
  }).catch(() => {
    updateStyleControls();
    updateMode();
  });
})();
