"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_COLLAPSE_MS,
  QUICK_COLLAPSE_MS,
  applyCollapsedState,
  createAutoCollapseController
} = require("../src/player-toolbar.js");

function createFakeTimers() {
  let nextId = 1;
  const tasks = new Map();

  return {
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delay, cancelled: false });
      return id;
    },
    clearTimer(id) {
      const task = tasks.get(id);
      if (task) {
        task.cancelled = true;
      }
    },
    latestId() {
      return nextId - 1;
    },
    get(id) {
      return tasks.get(id);
    },
    run(id, includeCancelled = false) {
      const task = tasks.get(id);
      if (task && (includeCancelled || !task.cancelled)) {
        task.callback();
      }
    }
  };
}

function createController() {
  const timers = createFakeTimers();
  const changes = [];
  const controller = createAutoCollapseController({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onChange(collapsed) {
      changes.push(collapsed);
    }
  });
  return { controller, timers, changes };
}

test("collapses the import prompt after the initial watch-page delay", () => {
  const { controller, timers, changes } = createController();

  controller.start();
  assert.equal(timers.get(timers.latestId()).delay, AUTO_COLLAPSE_MS);
  assert.equal(controller.isCollapsed(), false);

  timers.run(timers.latestId());
  assert.equal(controller.isCollapsed(), true);
  assert.deepEqual(changes, [true]);
});

test("keeps the prompt expanded while hovered or while the panel is open", () => {
  const { controller, timers } = createController();

  controller.start();
  const initialTimer = timers.latestId();
  controller.hold("pointer");
  timers.run(initialTimer, true);
  assert.equal(controller.isCollapsed(), false);

  controller.hold("panel");
  controller.release("pointer");
  controller.release("panel");
  assert.equal(timers.get(timers.latestId()).delay, QUICK_COLLAPSE_MS);
  timers.run(timers.latestId());
  assert.equal(controller.isCollapsed(), true);
});

test("a stale timer cannot collapse the prompt after a route restart", () => {
  const { controller, timers } = createController();

  controller.start();
  const oldTimer = timers.latestId();
  controller.stop();
  controller.start();
  const currentTimer = timers.latestId();

  timers.run(oldTimer, true);
  assert.equal(controller.isCollapsed(), false);
  timers.run(currentTimer);
  assert.equal(controller.isCollapsed(), true);
});

test("nearby pointer activity reveals a collapsed prompt for a bounded time", () => {
  const { controller, timers } = createController();

  controller.start();
  timers.run(timers.latestId());
  assert.equal(controller.isCollapsed(), true);

  controller.reveal(2_800);
  assert.equal(controller.isCollapsed(), false);
  assert.equal(timers.get(timers.latestId()).delay, 2_800);
  timers.run(timers.latestId());
  assert.equal(controller.isCollapsed(), true);
});

test("collapsed view hides only the text action and keeps the toolbar available", () => {
  const classes = new Set();
  const attributes = {};
  const elements = {
    toolbar: {
      hidden: false,
      classList: {
        toggle(name, enabled) {
          if (enabled) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        }
      }
    },
    primaryAction: {
      tabIndex: 0,
      setAttribute(name, value) {
        attributes[name] = value;
      }
    }
  };

  applyCollapsedState(elements, true);
  assert.equal(elements.toolbar.hidden, false);
  assert.equal(classes.has("is-collapsed"), true);
  assert.equal(elements.primaryAction.tabIndex, -1);
  assert.equal(attributes["aria-hidden"], "true");

  applyCollapsedState(elements, false);
  assert.equal(classes.has("is-collapsed"), false);
  assert.equal(elements.primaryAction.tabIndex, 0);
  assert.equal(attributes["aria-hidden"], "false");
});
