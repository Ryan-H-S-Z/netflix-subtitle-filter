"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeSubtitle,
  parseAss,
  parseSrtOrVtt,
  parseSubtitles,
  parseTimestamp
} = require("../src/subtitle-parser.js");

test("parses SRT cues with indexes and multiline text", () => {
  const result = parseSubtitles(`1
00:00:01,250 --> 00:00:03,500
第一行
第二行

2
00:01:02,000 --> 00:01:04,100
<i>下一句</i>
`, "movie.srt");

  assert.equal(result.format, "srt");
  assert.deepEqual(result.cues, [
    { start: 1.25, end: 3.5, text: "第一行\n第二行" },
    { start: 62, end: 64.1, text: "下一句" }
  ]);
});

test("parses WebVTT without an hour field and ignores cue settings", () => {
  const cues = parseSrtOrVtt(`WEBVTT

intro
00:01.000 --> 00:03.250 align:middle line:80%
你好，Netflix
`);

  assert.deepEqual(cues, [
    { start: 1, end: 3.25, text: "你好，Netflix" }
  ]);
});

test("cleans WebVTT classes, timestamps, breaks, and entities safely", () => {
  const cues = parseSrtOrVtt(`WEBVTT

00:01.000 --> 00:03.250
<c.green>A &amp; B</c><br><00:02.000><lang zh>中文</lang>
`);

  assert.deepEqual(cues, [
    { start: 1, end: 3.25, text: "A & B\n中文" }
  ]);
});

test("keeps out-of-range numeric entities without aborting the file", () => {
  const cues = parseSrtOrVtt(`00:01.000 --> 00:03.000
正常文字 &#1114112; &#x110000;
`);

  assert.equal(cues[0].text, "正常文字 &#1114112; &#x110000;");
});

test("parses ASS dialogue and preserves commas in text", () => {
  const cues = parseAss(`[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:02.10,0:00:05.40,Default,,0,0,0,,{\\an8}你好，世界,欢迎回来\\N第二行
`);

  assert.deepEqual(cues, [
    { start: 2.1, end: 5.4, text: "你好，世界,欢迎回来\n第二行" }
  ]);
});

test("sorts cues and skips invalid ranges", () => {
  const cues = parseSrtOrVtt(`00:05.000 --> 00:06.000
后

00:02.000 --> 00:01.000
无效

00:01.000 --> 00:02.000
前
`);

  assert.deepEqual(cues.map((cue) => cue.text), ["前", "后"]);
});

test("decodes UTF-8 subtitles with a BOM", () => {
  const body = new TextEncoder().encode("中文字幕");
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  assert.equal(decodeSubtitle(bytes, "auto"), "中文字幕");
});

test("auto-detects common Big5 and GB Chinese bytes", () => {
  assert.equal(decodeSubtitle(Uint8Array.from([0xa4, 0xa4]), "auto", "zh-hant"), "中");
  assert.equal(decodeSubtitle(Uint8Array.from([0xd6, 0xd0]), "auto", "zh-hans"), "中");
});

test("parses timestamps used by SRT, VTT, and ASS", () => {
  assert.equal(parseTimestamp("01:02:03,450"), 3723.45);
  assert.equal(parseTimestamp("02:03.500"), 123.5);
  assert.equal(parseTimestamp("0:00:02.10"), 2.1);
  assert.ok(Number.isNaN(parseTimestamp("not-a-time")));
});
