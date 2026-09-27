(function startHomeBillboardToggle() {
  "use strict";

  const config = globalThis.NetflixSubtitleConfig;
  const HIDDEN_CLASS = "nch-hide-home-billboard";
  const BILLBOARD_SELECTOR = '.billboard-row, .billboard-motion, [data-uia="billboard"]';
  let enabled = config.DEFAULT_SETTINGS.hideHomeBillboard;
  let settingsRevision = 0;

  function isHidden() {
    return enabled && /^\/(?:browse\/?)?$/.test(location.pathname);
  }

  function pausePreview(event) {
    const video = event.target;
    if (isHidden() && video?.tagName === "VIDEO" && video.closest(BILLBOARD_SELECTOR)) {
      video.pause();
    }
  }

  function apply() {
    const hidden = isHidden();
    const root = document.documentElement;
    if (root.classList.contains(HIDDEN_CLASS) === hidden) {
      return;
    }
    root.classList.toggle(HIDDEN_CLASS, hidden);
    if (hidden) {
      for (const video of document.querySelectorAll("video")) {
        pausePreview({ target: video });
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes.hideHomeBillboard) {
      return;
    }
    settingsRevision += 1;
    enabled = changes.hideHomeBillboard.newValue === true;
    apply();
  });

  const initialRevision = settingsRevision;
  chrome.storage.sync.get({ hideHomeBillboard: enabled }).then((settings) => {
    if (settingsRevision === initialRevision) {
      enabled = settings.hideHomeBillboard === true;
      apply();
    }
  }).catch(() => {
    // Leave the original page visible when settings cannot be read.
  });

  // CSS also covers banners inserted after page load. Capture play events so
  // late-loading previews cannot keep playing in the hidden banner.
  document.addEventListener("play", pausePreview, true);
  window.addEventListener("popstate", apply);
  // Netflix navigates with pushState without reloading content scripts.
  window.setInterval(apply, 250);
})();
