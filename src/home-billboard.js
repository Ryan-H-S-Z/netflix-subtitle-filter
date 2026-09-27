(function startHomeBillboardToggle() {
  "use strict";

  const config = globalThis.NetflixSubtitleConfig;
  const HIDDEN_CLASS = "nch-hide-home-billboard";
  const BILLBOARD_SELECTOR = '.billboard-row, .billboard-motion, [data-uia="billboard"]';
  const DETAIL_SELECTOR = '[role="dialog"], .previewModal--container';
  const blockedMedia = new Map();
  let enabled = config.DEFAULT_SETTINGS.hideHomeBillboard;
  let settingsRevision = 0;

  function isHidden() {
    return enabled && (location.pathname === "/"
      || /^\/(?:browse|latest|search|games)(?:\/|$)/.test(location.pathname));
  }

  function isPreview(media) {
    return isHidden() && /^(VIDEO|AUDIO)$/.test(media?.tagName || "")
      && media.closest(BILLBOARD_SELECTOR) && !media.closest(DETAIL_SELECTOR);
  }

  function restoreControls(media, previous) {
    media.muted = previous.muted;
    media.defaultMuted = previous.defaultMuted;
    media.autoplay = previous.autoplay;
    if (previous.preload === null) {
      media.removeAttribute("preload");
    } else {
      media.setAttribute("preload", previous.preload);
    }
    // A released MediaSource/blob cannot safely be reattached. Netflix must
    // recreate the preview (refresh the page to restore it after disabling).
  }

  function stopPreview(media) {
    if (!isPreview(media)) {
      return;
    }
    const firstStop = !blockedMedia.has(media);
    if (firstStop) {
      blockedMedia.set(media, {
        muted: media.muted,
        defaultMuted: media.defaultMuted,
        autoplay: media.autoplay,
        preload: media.getAttribute("preload")
      });
    }
    if (!media.muted) media.muted = true;
    if (!media.defaultMuted) media.defaultMuted = true;
    if (media.autoplay) media.autoplay = false;
    if (media.getAttribute("preload") !== "none") media.setAttribute("preload", "none");
    if (!media.paused) media.pause();

    let hasSource = media.hasAttribute("src") || media.srcObject != null;
    if (media.hasAttribute("src")) media.removeAttribute("src");
    if (media.srcObject != null) media.srcObject = null;
    for (const source of media.querySelectorAll("source[src]")) {
      source.removeAttribute("src");
      hasSource = true;
    }
    // load() with no sources aborts the browser's current media load and
    // releases the decoder. Do not repeatedly reset an already-empty player.
    if (firstStop || hasSource) media.load();
  }

  function apply() {
    const root = document.documentElement;
    const hidden = isHidden();
    if (root && root.classList.contains(HIDDEN_CLASS) !== hidden) {
      root.classList.toggle(HIDDEN_CLASS, hidden);
    }
    for (const [media, previous] of blockedMedia) {
      if (!media.isConnected || !isPreview(media)) {
        restoreControls(media, previous);
        blockedMedia.delete(media);
      }
    }
    if (hidden) {
      for (const media of document.querySelectorAll("video, audio")) stopPreview(media);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes.hideHomeBillboard) return;
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

  // Netflix can replace the player or reassign its source after the switch
  // has been applied. Observe those changes instead of only the root class.
  new MutationObserver(apply).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "autoplay", "data-uia"]
  });
  for (const eventName of ["play", "playing", "loadstart", "volumechange", "canplay"]) {
    document.addEventListener(eventName, (event) => stopPreview(event.target), true);
  }
  window.addEventListener("popstate", apply);
  // Also detects Netflix's pushState routes and non-attribute srcObject writes.
  window.setInterval(apply, 250);
})();
