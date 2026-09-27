"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const config = require("../src/config.js");
const script = fs.readFileSync(require.resolve("../src/home-billboard.js"), "utf8");

async function setup({ pathname = "/browse", saved = false, delayed = false } = {}) {
  const classes = new Set();
  const listeners = {};
  let storageChanged;
  let tick;
  let resolveSettings;
  let previewPauses = 0;
  let playerPauses = 0;
  const preview = { tagName: "VIDEO", closest: () => ({}), pause: () => previewPauses++ };
  const player = { tagName: "VIDEO", closest: () => null, pause: () => playerPauses++ };
  const location = { pathname };
  vm.runInNewContext(script, {
    NetflixSubtitleConfig: config,
    location,
    document: {
      documentElement: { classList: {
        contains: (name) => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
      } },
      querySelectorAll: () => [preview, player],
      addEventListener: (name, fn) => { listeners[name] = fn; }
    },
    chrome: {
      storage: {
        onChanged: { addListener: (fn) => { storageChanged = fn; } },
        sync: { get: () => delayed
          ? new Promise((resolve) => { resolveSettings = resolve; })
          : Promise.resolve({ hideHomeBillboard: saved }) }
      }
    },
    window: {
      addEventListener: (name, fn) => { listeners[name] = fn; },
      setInterval: (fn) => { tick = fn; }
    }
  });
  await Promise.resolve();
  return {
    hidden: () => classes.has("nch-hide-home-billboard"),
    change: (value, area = "sync") => storageChanged({ hideHomeBillboard: { newValue: value } }, area),
    navigate: (path) => { location.pathname = path; tick(); },
    playPreview: () => listeners.play({ target: preview }),
    pauses: () => ({ preview: previewPauses, player: playerPauses }),
    resolveSettings: async (value) => { resolveSettings({ hideHomeBillboard: value }); await Promise.resolve(); }
  };
}

test("home banner defaults to visible and toggles without subtitle filtering", async () => {
  const page = await setup();
  assert.equal(config.DEFAULT_SETTINGS.hideHomeBillboard, false);
  assert.equal(page.hidden(), false);
  page.change(true);
  assert.equal(page.hidden(), true);
  assert.deepEqual(page.pauses(), { preview: 1, player: 0 });
  page.playPreview();
  assert.equal(page.pauses().preview, 2);
  page.change(false);
  page.playPreview();
  assert.equal(page.hidden(), false);
  assert.equal(page.pauses().preview, 2);
});

test("saved preference follows SPA navigation and excludes non-home routes", async () => {
  const page = await setup({ saved: true });
  assert.equal(page.hidden(), true);
  for (const route of ["/browse/genre/34399", "/browse/genre/83", "/browse/my-list", "/browse/subtitles", "/watch/123", "/search", "/latest", "/title/123"]) {
    page.navigate(route);
    assert.equal(page.hidden(), false, route);
  }
  for (const route of ["/", "/browse/", "/browse"]) {
    page.navigate(route);
    assert.equal(page.hidden(), true, route);
  }
});

test("ignores local changes and restores banner when sync preference is removed", async () => {
  const page = await setup({ saved: true });
  page.change(false, "local");
  assert.equal(page.hidden(), true);
  page.change(undefined);
  assert.equal(page.hidden(), false);
});

test("late initial settings cannot overwrite a newer toggle", async () => {
  const page = await setup({ delayed: true });
  page.change(true);
  await page.resolveSettings(false);
  assert.equal(page.hidden(), true);
});
