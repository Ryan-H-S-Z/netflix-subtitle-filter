"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const config = require("../src/config.js");
const script = fs.readFileSync(require.resolve("../src/home-billboard.js"), "utf8");

function media({ preview = true, dialog = false, tagName = "VIDEO" } = {}) {
  const attrs = new Map([["src", "blob:preview"], ["preload", "auto"]]);
  return {
    tagName, preview, dialog, attrs, isConnected: true, muted: false,
    defaultMuted: false, autoplay: true, paused: false, srcObject: null,
    pauses: 0, loads: 0, sources: [],
    closest(selector) { return selector.includes('dialog') ? this.dialog : this.preview; },
    getAttribute: (key) => attrs.get(key) ?? null,
    hasAttribute: (key) => attrs.has(key),
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: (key) => attrs.delete(key),
    querySelectorAll() { return this.sources.filter(s => s.hasAttribute("src")); },
    pause() { this.paused = true; this.pauses++; },
    load() { this.loads++; }
  };
}

async function setup({ pathname = "/browse", saved = false, delayed = false, rootPresent = true } = {}) {
  const classes = new Set();
  const listeners = {};
  let storageChanged, tick, mutation, resolveSettings;
  const preview = media();
  const player = media({ preview: false });
  const videos = [preview, player];
  const location = { pathname };
  const document = {
    documentElement: rootPresent ? { classList: {
      contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    } } : null,
    querySelectorAll: () => videos,
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  vm.runInNewContext(script, {
    NetflixSubtitleConfig: config, location, document,
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    chrome: { storage: {
      onChanged: { addListener: fn => { storageChanged = fn; } },
      sync: { get: () => delayed
        ? new Promise(resolve => { resolveSettings = resolve; })
        : Promise.resolve({ hideHomeBillboard: saved }) }
    } },
    window: {
      addEventListener: (name, fn) => { listeners[name] = fn; },
      setInterval: fn => { tick = fn; }
    }
  });
  await Promise.resolve();
  return {
    preview, player, videos, document,
    hidden: () => classes.has("nch-hide-home-billboard"),
    change: (value, area = "sync") => storageChanged({ hideHomeBillboard: { newValue: value } }, area),
    navigate: path => { location.pathname = path; tick(); },
    event: (name, target = preview) => listeners[name]({ target }),
    mutate: () => mutation(), tick: () => tick(),
    resolveSettings: async value => { resolveSettings({ hideHomeBillboard: value }); await Promise.resolve(); }
  };
}

test("disabled by default; enabling unloads only the banner media", async () => {
  const page = await setup();
  assert.equal(config.DEFAULT_SETTINGS.hideHomeBillboard, false);
  assert.equal(page.preview.loads, 0);
  page.change(true);
  assert.equal(page.hidden(), true);
  assert.equal(page.preview.muted, true);
  assert.equal(page.preview.paused, true);
  assert.equal(page.preview.autoplay, false);
  assert.equal(page.preview.getAttribute("preload"), "none");
  assert.equal(page.preview.hasAttribute("src"), false);
  assert.equal(page.preview.loads, 1);
  assert.equal(page.player.loads, 0);
  assert.equal(page.player.muted, false);
});

test("covers browsing tabs and excludes playback, details and account routes", async () => {
  const page = await setup({ saved: true });
  for (const route of ["/watch/123", "/title/123", "/login", "/YourAccount"]) {
    page.navigate(route);
    assert.equal(page.hidden(), false, route);
  }
  for (const route of ["/", "/browse/", "/browse/genre/34399", "/browse/genre/83", "/browse/my-list", "/browse/subtitles", "/search", "/latest", "/games"]) {
    page.navigate(route);
    assert.equal(page.hidden(), true, route);
  }
});

test("cancels sources reassigned to an existing player and replaced players", async () => {
  const page = await setup({ saved: true });
  page.preview.setAttribute("src", "blob:retry");
  page.preview.srcObject = {};
  const source = media();
  page.preview.sources.push(source);
  page.mutate();
  assert.equal(page.preview.srcObject, null);
  assert.equal(source.hasAttribute("src"), false);
  assert.equal(page.preview.loads, 2);
  const replacement = media({ tagName: "AUDIO" });
  page.videos.push(replacement);
  page.mutate();
  assert.equal(replacement.loads, 1);
  page.tick(); page.mutate();
  assert.equal(replacement.loads, 1, "does not loop on its own mutations");
});

test("guards play, playing, loadstart and unmute attempts", async () => {
  const page = await setup({ saved: true });
  for (const event of ["play", "playing", "loadstart", "volumechange", "canplay"]) {
    page.preview.paused = false;
    page.preview.muted = false;
    page.preview.setAttribute("src", "blob:retry");
    page.event(event);
    assert.equal(page.preview.paused, true, event);
    assert.equal(page.preview.muted, true, event);
    assert.equal(page.preview.hasAttribute("src"), false, event);
  }
});

test("does not unload a detail dialog or an ordinary card preview", async () => {
  const page = await setup({ saved: true });
  const dialog = media({ dialog: true });
  page.videos.push(dialog);
  page.mutate(); page.event("play", dialog); page.event("play", page.player);
  assert.equal(dialog.loads, 0);
  assert.equal(page.player.loads, 0);
});

test("releases mute settings on disabling or entering actual playback", async () => {
  const page = await setup({ saved: true });
  page.navigate("/watch/123");
  assert.equal(page.preview.muted, false);
  assert.equal(page.preview.defaultMuted, false);
  assert.equal(page.preview.autoplay, true);
  assert.equal(page.preview.getAttribute("preload"), "auto");
  page.preview.setAttribute("src", "blob:full-movie");
  page.event("play"); page.tick();
  assert.equal(page.preview.getAttribute("src"), "blob:full-movie");
  assert.equal(page.preview.loads, 1);
});

test("ignores local changes and handles removed preferences", async () => {
  const page = await setup({ saved: true });
  page.change(false, "local"); assert.equal(page.hidden(), true);
  page.change(undefined); assert.equal(page.hidden(), false);
  assert.equal(page.preview.muted, false);
});

test("late settings cannot overwrite a newer toggle", async () => {
  const page = await setup({ delayed: true });
  page.change(true); await page.resolveSettings(false);
  assert.equal(page.hidden(), true);
});

test("document_start can run before the root element exists", async () => {
  const page = await setup({ saved: true, rootPresent: false });
  page.mutate();
  assert.equal(page.preview.loads, 1);
});
