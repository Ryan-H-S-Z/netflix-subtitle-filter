(function exposeCacheSchedule(root, factory) {
  const config = typeof module === "object" && module.exports
    ? require("./config.js")
    : root.NetflixSubtitleConfig;
  const api = factory(config);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleCacheSchedule = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCacheSchedule(config) {
  "use strict";

  const ALARM_NAME = "nch-weekly-catalog-refresh";
  const WEEK_MINUTES = 7 * 24 * 60;
  const WEEK_MS = WEEK_MINUTES * 60 * 1000;

  function validTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function nextDueAt(lastRefreshAt, now = Date.now()) {
    const last = validTimestamp(lastRefreshAt);
    return (last || now) + WEEK_MS;
  }

  function isDue(lastRefreshAt, now = Date.now()) {
    const last = validTimestamp(lastRefreshAt);
    return Boolean(last) && now >= last + WEEK_MS;
  }

  function alarmMatches(alarm, lastRefreshAt, now = Date.now()) {
    if (!alarm || alarm.name !== ALARM_NAME || alarm.periodInMinutes !== WEEK_MINUTES) {
      return false;
    }
    const dueAt = nextDueAt(lastRefreshAt, now);
    return Math.abs(Number(alarm.scheduledTime) - dueAt) <= 60 * 1000;
  }

  return Object.freeze({
    ALARM_NAME,
    WEEK_MINUTES,
    WEEK_MS,
    AUTO_REFRESH_KEY: config.WEEKLY_CACHE_REFRESH_KEY,
    LAST_REFRESH_KEY: config.CATALOG_LAST_AUTO_REFRESH_KEY,
    REFRESH_TICK_KEY: config.CATALOG_AUTO_REFRESH_TICK_KEY,
    validTimestamp,
    nextDueAt,
    isDue,
    alarmMatches
  });
});
