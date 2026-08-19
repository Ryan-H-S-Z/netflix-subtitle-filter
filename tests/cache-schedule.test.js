"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schedule = require("../src/cache-schedule.js");

test("uses a fixed seven-day schedule", () => {
  assert.equal(schedule.WEEK_MINUTES, 10_080);
  assert.equal(schedule.WEEK_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(schedule.nextDueAt(1_000, 5_000), 1_000 + schedule.WEEK_MS);
});

test("detects due timestamps and rejects invalid timestamps", () => {
  const now = 2_000_000_000_000;
  assert.equal(schedule.isDue(now - schedule.WEEK_MS, now), true);
  assert.equal(schedule.isDue(now - schedule.WEEK_MS + 1, now), false);
  assert.equal(schedule.isDue(0, now), false);
  assert.equal(schedule.validTimestamp("bad"), 0);
});

test("keeps only an alarm with the correct period and scheduled time", () => {
  const now = 2_000_000_000_000;
  const last = now - 1000;
  const due = schedule.nextDueAt(last, now);
  assert.equal(schedule.alarmMatches({
    name: schedule.ALARM_NAME,
    periodInMinutes: schedule.WEEK_MINUTES,
    scheduledTime: due
  }, last, now), true);
  assert.equal(schedule.alarmMatches({
    name: schedule.ALARM_NAME,
    periodInMinutes: 60,
    scheduledTime: due
  }, last, now), false);
});
