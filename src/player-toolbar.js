(function exposePlayerToolbar(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitlePlayerToolbar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPlayerToolbarTools() {
  "use strict";

  const AUTO_COLLAPSE_MS = 5_000;
  const QUICK_COLLAPSE_MS = 1_600;

  function applyCollapsedState(elements, collapsed) {
    const isCollapsed = Boolean(collapsed);
    elements.toolbar.classList.toggle("is-collapsed", isCollapsed);
    elements.primaryAction.setAttribute("aria-hidden", String(isCollapsed));
    elements.primaryAction.tabIndex = isCollapsed ? -1 : 0;
  }

  function createAutoCollapseController(options = {}) {
    const collapseDelay = Number.isFinite(options.collapseDelay)
      ? Math.max(0, options.collapseDelay)
      : AUTO_COLLAPSE_MS;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const onChange = typeof options.onChange === "function" ? options.onChange : () => {};

    let active = false;
    let collapsed = false;
    let timer = null;
    let timerEpoch = 0;
    const holds = new Set();

    function setCollapsed(nextCollapsed) {
      const next = Boolean(nextCollapsed);
      if (collapsed === next) {
        return;
      }
      collapsed = next;
      onChange(collapsed);
    }

    function cancelTimer() {
      timerEpoch += 1;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    }

    function schedule(delay = collapseDelay) {
      cancelTimer();
      if (!active || holds.size) {
        return;
      }

      const epoch = timerEpoch;
      timer = setTimer(() => {
        if (!active || holds.size || epoch !== timerEpoch) {
          return;
        }
        timer = null;
        setCollapsed(true);
      }, Math.max(0, Number(delay) || 0));
    }

    function start() {
      active = true;
      holds.clear();
      cancelTimer();
      setCollapsed(false);
      schedule(collapseDelay);
    }

    function stop() {
      active = false;
      holds.clear();
      cancelTimer();
      setCollapsed(false);
    }

    function reveal(delay = collapseDelay) {
      if (!active) {
        return;
      }
      setCollapsed(false);
      schedule(delay);
    }

    function hold(reason) {
      if (!active) {
        return;
      }
      holds.add(String(reason || "interaction"));
      cancelTimer();
      setCollapsed(false);
    }

    function release(reason, delay = QUICK_COLLAPSE_MS) {
      holds.delete(String(reason || "interaction"));
      if (active && !holds.size) {
        schedule(delay);
      }
    }

    return Object.freeze({
      start,
      stop,
      reveal,
      hold,
      release,
      isActive: () => active,
      isCollapsed: () => collapsed
    });
  }

  return Object.freeze({
    AUTO_COLLAPSE_MS,
    QUICK_COLLAPSE_MS,
    applyCollapsedState,
    createAutoCollapseController
  });
});
