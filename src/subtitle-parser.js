(function exposeSubtitleTools(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSubtitleTools() {
  "use strict";

  const FORMAT_TAGS = /<\/?(?:b|i|u|font|c(?:\.[^>\s]+)*|v|ruby|rt|lang)(?:\s[^>]*)?>/gi;
  const INLINE_TIMESTAMPS = /<\d{1,3}:\d{2}(?::\d{2})?[,.]\d{3}>/g;
  const ASS_TAGS = /\{[^}]*\}/g;
  const ENTITY_VALUES = Object.freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    lrm: "",
    lt: "<",
    nbsp: " ",
    quot: '"',
    rlm: ""
  });

  function parseTimestamp(value) {
    const normalized = String(value || "").trim().replace(",", ".");
    const parts = normalized.split(":");

    if (parts.length < 2 || parts.length > 3) {
      return Number.NaN;
    }

    const secondsPart = parts.pop();
    const minutesPart = parts.pop();
    const hoursPart = parts.pop() || "0";
    const seconds = Number(secondsPart);
    const minutes = Number(minutesPart);
    const hours = Number(hoursPart);

    if (![seconds, minutes, hours].every(Number.isFinite)) {
      return Number.NaN;
    }

    return hours * 3600 + minutes * 60 + seconds;
  }

  function cleanCueText(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(FORMAT_TAGS, "")
      .replace(INLINE_TIMESTAMPS, "")
      .replace(/&#(\d+);|&#x([\da-f]+);|&([a-z]+);/gi, (match, decimal, hexadecimal, named) => {
        if (decimal) {
          const codePoint = Number(decimal);
          return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : match;
        }
        if (hexadecimal) {
          const codePoint = Number.parseInt(hexadecimal, 16);
          return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : match;
        }
        return Object.prototype.hasOwnProperty.call(ENTITY_VALUES, named.toLowerCase())
          ? ENTITY_VALUES[named.toLowerCase()]
          : match;
      })
      .trim();
  }

  function parseSrtOrVtt(text) {
    const normalized = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/i, "");

    const blocks = normalized.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trimEnd());
      const timestampIndex = lines.findIndex((line) => line.includes("-->"));

      if (timestampIndex < 0) {
        continue;
      }

      const match = lines[timestampIndex].match(
        /^((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3})/
      );

      if (!match) {
        continue;
      }

      const start = parseTimestamp(match[1]);
      const end = parseTimestamp(match[2]);
      const cueText = cleanCueText(lines.slice(timestampIndex + 1).join("\n"));

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) {
        continue;
      }

      cues.push({ start, end, text: cueText });
    }

    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function splitAssFields(line, fieldCount) {
    const fields = [];
    let remainder = line;

    for (let index = 0; index < fieldCount - 1; index += 1) {
      const commaIndex = remainder.indexOf(",");
      if (commaIndex < 0) {
        return null;
      }
      fields.push(remainder.slice(0, commaIndex));
      remainder = remainder.slice(commaIndex + 1);
    }

    fields.push(remainder);
    return fields;
  }

  function parseAss(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    const cues = [];
    let inEvents = false;
    let format = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (/^\[events\]$/i.test(line)) {
        inEvents = true;
        continue;
      }

      if (/^\[.+\]$/.test(line)) {
        inEvents = false;
        continue;
      }

      if (!inEvents) {
        continue;
      }

      if (/^format\s*:/i.test(line)) {
        format = line
          .replace(/^format\s*:/i, "")
          .split(",")
          .map((field) => field.trim().toLowerCase());
        continue;
      }

      if (!/^dialogue\s*:/i.test(line)) {
        continue;
      }

      const fields = splitAssFields(line.replace(/^dialogue\s*:/i, "").trim(), format.length);
      if (!fields) {
        continue;
      }

      const row = Object.fromEntries(format.map((field, index) => [field, fields[index] || ""]));
      const start = parseTimestamp(row.start);
      const end = parseTimestamp(row.end);
      const cueText = cleanCueText(
        row.text
          .replace(ASS_TAGS, "")
          .replace(/\\N/gi, "\n")
          .replace(/\\h/gi, " ")
      );

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) {
        continue;
      }

      cues.push({ start, end, text: cueText });
    }

    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function detectFormat(text, fileName) {
    const extension = String(fileName || "").split(".").pop().toLowerCase();
    if (extension === "ass" || extension === "ssa" || /^\s*\[script info\]/i.test(text)) {
      return "ass";
    }
    if (extension === "vtt" || /^\s*WEBVTT/i.test(text)) {
      return "vtt";
    }
    return "srt";
  }

  function parseSubtitles(text, fileName) {
    const format = detectFormat(text, fileName);
    const cues = format === "ass" ? parseAss(text) : parseSrtOrVtt(text);
    return { format, cues };
  }

  function scoreDecodedText(text, languageHint) {
    const sample = String(text || "").slice(0, 120000);
    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const controlCount = (sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) || []).length;
    const kanaCount = (sample.match(/[\u3040-\u30FF]/g) || []).length;
    const hangulCount = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
    const commonChineseCount = (sample.match(/[的一是不了在人有我他這这中大來来上個个們们到說说國国和地也子時时道出而要於于就下得可你年生自會会那後后能對对著着事其裡里所去行過过家用發发天如然作方成者多日都小無无同麼么經经法當当起與与好看學学進进種种將将還还分此心前面又定見见只主沒没公從从問问明新走長长]/g) || []).length;
    const chinesePunctuationCount = (sample.match(/[，。！？；：「」『』、…]/g) || []).length;
    const traditionalMarkerCount = (sample.match(/[體臺灣裡與為這個們說時會後對過發學進種將還見沒從問長]/g) || []).length;
    const simplifiedMarkerCount = (sample.match(/[体台湾里与为这个们说时会后对过发学进种将还见没从问长]/g) || []).length;
    const hintBias = languageHint === "zh-hant"
      ? traditionalMarkerCount * 0.8 - simplifiedMarkerCount * 0.15
      : languageHint === "zh-hans"
        ? simplifiedMarkerCount * 0.8 - traditionalMarkerCount * 0.15
        : 0;

    return (
      cjkCount * 0.16
      + commonChineseCount * 1.35
      + chinesePunctuationCount * 0.6
      + hintBias
      - kanaCount * 1.4
      - hangulCount * 1.4
      - replacementCount * 16
      - controlCount * 12
    );
  }

  function decodeLegacyChinese(bytes, languageHint) {
    const candidates = ["gb18030", "big5"].map((encoding) => {
      let text;
      let fatal = true;

      try {
        text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch (_error) {
        fatal = false;
        text = new TextDecoder(encoding).decode(bytes);
      }

      const preferenceBias = languageHint === "zh-hant" && encoding === "big5"
        ? 2
        : languageHint === "zh-hans" && encoding === "gb18030"
          ? 2
          : 0;

      return {
        encoding,
        fatal,
        score: scoreDecodedText(text, languageHint) + preferenceBias + (fatal ? 1 : -8),
        text
      };
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  function decodeSubtitle(buffer, requestedEncoding, languageHint) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const encoding = String(requestedEncoding || "auto").toLowerCase();

    if (encoding !== "auto") {
      return new TextDecoder(encoding).decode(bytes);
    }

    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }

    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }

    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      return decodeLegacyChinese(bytes, languageHint);
    }
  }

  return Object.freeze({
    cleanCueText,
    decodeLegacyChinese,
    decodeSubtitle,
    detectFormat,
    parseAss,
    parseSrtOrVtt,
    parseSubtitles,
    parseTimestamp,
    scoreDecodedText
  });
});
