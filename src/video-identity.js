(function exposeVideoIdentity(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleVideoIdentity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createVideoIdentity() {
  "use strict";

  const MAX_VIDEO_NODES = 20_000;
  const MAX_PAIRS = 128;
  const MAX_INLINE_SCRIPT_BYTES = 2 * 1024 * 1024;
  const MAX_EVIDENCE_FACTS = 2_048;

  function isValidId(value) {
    return /^\d{4,20}$/.test(String(value || ""));
  }

  function addPair(map, ambiguous, structuralId, canonicalId) {
    const structural = String(structuralId || "");
    const canonical = String(canonicalId || "");
    if (!isValidId(structural) || !isValidId(canonical) || ambiguous.has(structural)) {
      return;
    }
    const existing = map.get(structural);
    if (existing && existing !== canonical) {
      map.delete(structural);
      ambiguous.add(structural);
      return;
    }
    map.set(structural, canonical);
  }

  function analyzePairs(pairs) {
    const map = new Map();
    const ambiguous = new Set();
    for (const pair of Array.isArray(pairs) ? pairs.slice(0, MAX_PAIRS) : []) {
      if (
        !Array.isArray(pair)
        || pair.length !== 2
        || typeof pair[0] !== "string"
        || typeof pair[1] !== "string"
      ) {
        continue;
      }
      addPair(map, ambiguous, pair[0], pair[1]);
    }
    return {
      pairs: Array.from(map.entries()),
      ambiguousIds: Array.from(ambiguous)
    };
  }

  function normalizePairs(pairs) {
    return analyzePairs(pairs).pairs;
  }

  function resolveStructuralIds(explicitIds, watchIds, videoIdMap) {
    const resolved = new Set(explicitIds || []);
    for (const watchId of watchIds || []) {
      resolved.add(videoIdMap?.get(watchId) || watchId);
    }
    return resolved;
  }

  function analyzeVideoNodes(videoNodes, requestedIds = null) {
    if (!videoNodes || typeof videoNodes !== "object" || Array.isArray(videoNodes)) {
      return { pairs: [], ambiguousIds: [], complete: true };
    }

    const requested = requestedIds == null
      ? null
      : new Set(Array.from(requestedIds).filter((id) => typeof id === "string" && isValidId(id)).slice(0, MAX_PAIRS));
    const map = new Map();
    const ambiguous = new Set();
    const verifiedSelfIds = new Set();
    const derivedEpisodeIds = new Set();
    let visited = 0;
    let complete = true;
    for (const canonicalId in videoNodes) {
      if (!Object.prototype.hasOwnProperty.call(videoNodes, canonicalId)) {
        continue;
      }
      visited += 1;
      if (visited > MAX_VIDEO_NODES) {
        complete = false;
        break;
      }
      const node = videoNodes[canonicalId];
      if (!isValidId(canonicalId) || !node || typeof node !== "object") {
        continue;
      }

      const summary = node.summary;
      const type = summary?.value?.type;
      if (
        summary?.$type !== "atom"
        || (type !== "movie" && type !== "show")
        || String(summary.value?.id || "") !== canonicalId
      ) {
        continue;
      }

      if (!requested || requested.has(canonicalId)) {
        addPair(map, ambiguous, canonicalId, canonicalId);
        verifiedSelfIds.add(canonicalId);
      }
      if (type === "show") {
        const current = node.current;
        const reference = current?.$type === "ref" && Array.isArray(current.value)
          ? current.value
          : null;
        const episodeId = String(reference?.[1] || "");
        const episodeSummary = videoNodes[episodeId]?.summary;
        const episodeType = episodeSummary?.value?.type;
        if (
          reference?.length === 2
          && reference[0] === "videos"
          && episodeSummary?.$type === "atom"
          && episodeType === "episode"
          && String(episodeSummary.value?.id || "") === episodeId
          && (!requested || requested.has(episodeId))
        ) {
          addPair(map, ambiguous, episodeId, canonicalId);
          derivedEpisodeIds.add(episodeId);
        }
      }
    }

    if (!complete) {
      const uncertainIds = requested
        ? Array.from(requested).filter((id) => !verifiedSelfIds.has(id))
        : Array.from(derivedEpisodeIds);
      for (const structuralId of uncertainIds) {
        map.delete(structuralId);
        ambiguous.add(structuralId);
      }
    }

    return {
      pairs: Array.from(map.entries()),
      ambiguousIds: Array.from(ambiguous),
      complete
    };
  }

  function pairsFromVideoNodes(videoNodes, requestedIds = null) {
    return analyzeVideoNodes(videoNodes, requestedIds).pairs;
  }

  function analyzePayload(payload, requestedIds = null) {
    const map = new Map();
    const ambiguous = new Set();
    const verifiedSelfIds = new Set();
    const queue = [{ value: payload, depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;
    let videoGraphs = 0;
    let complete = true;
    let traversalComplete = true;

    while (queue.length && visited < 300) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      if (depth > 4) {
        complete = false;
        traversalComplete = false;
        continue;
      }
      seen.add(value);
      visited += 1;

      if (value.videos && typeof value.videos === "object") {
        videoGraphs += 1;
        if (videoGraphs > 4) {
          complete = false;
          traversalComplete = false;
          break;
        }
        const analysis = analyzeVideoNodes(value.videos, requestedIds);
        complete = analysis.complete && complete;
        for (const structuralId of analysis.ambiguousIds) {
          map.delete(structuralId);
          ambiguous.add(structuralId);
          verifiedSelfIds.delete(structuralId);
        }
        for (const [structuralId, canonicalId] of analysis.pairs) {
          addPair(map, ambiguous, structuralId, canonicalId);
          if (structuralId === canonicalId && !ambiguous.has(structuralId)) {
            verifiedSelfIds.add(structuralId);
          }
        }
      }

      if (Array.isArray(value)) {
        if (value.length > 100) {
          complete = false;
          traversalComplete = false;
        }
        value.slice(0, 100).forEach((item) => queue.push({ value: item, depth: depth + 1 }));
        continue;
      }

      for (const key of ["jsonGraph", "value", "data", "result", "payload"]) {
        if (value[key] && typeof value[key] === "object") {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      }
    }

    if (queue.length) {
      complete = false;
      traversalComplete = false;
    }

    if (!complete) {
      const uncertainIds = requestedIds == null
        ? Array.from(map.keys()).filter((id) => (
          !traversalComplete || !verifiedSelfIds.has(id)
        ))
        : Array.from(requestedIds).filter((id) => (
          typeof id === "string"
          && isValidId(id)
          && (!traversalComplete || !verifiedSelfIds.has(id))
        ));
      for (const structuralId of uncertainIds.slice(0, MAX_PAIRS)) {
        map.delete(structuralId);
        ambiguous.add(structuralId);
      }
    }

    return {
      pairs: Array.from(map.entries()).slice(0, MAX_PAIRS),
      ambiguousIds: Array.from(ambiguous).slice(0, MAX_PAIRS),
      complete
    };
  }

  function pairsFromPayload(payload, requestedIds = null) {
    return analyzePayload(payload, requestedIds).pairs;
  }

  function normalizeJavaScriptHexEscapes(text) {
    const input = String(text || "");
    let normalized = "";
    let unchangedStart = 0;

    function isHexDigit(character) {
      const code = character?.charCodeAt(0) ?? -1;
      return (
        (code >= 48 && code <= 57)
        || (code >= 65 && code <= 70)
        || (code >= 97 && code <= 102)
      );
    }

    for (let index = 0; index < input.length;) {
      if (input[index] !== "\\") {
        index += 1;
        continue;
      }

      const slashStart = index;
      while (input[index] === "\\") {
        index += 1;
      }
      const slashCount = index - slashStart;
      if (
        slashCount % 2 === 1
        && input[index] === "x"
        && isHexDigit(input[index + 1])
        && isHexDigit(input[index + 2])
      ) {
        normalized += input.slice(unchangedStart, slashStart);
        normalized += "\\".repeat(slashCount - 1);
        normalized += `\\u00${input.slice(index + 1, index + 3)}`;
        index += 3;
        unchangedStart = index;
      }
    }

    return unchangedStart === 0
      ? input
      : normalized + input.slice(unchangedStart);
  }

  function isLineTerminator(character) {
    return (
      character === "\n"
      || character === "\r"
      || character === "\u2028"
      || character === "\u2029"
    );
  }

  function isJavaScriptWhitespace(character) {
    const code = character?.charCodeAt(0) ?? -1;
    return (
      code === 0x0009
      || code === 0x000a
      || code === 0x000b
      || code === 0x000c
      || code === 0x000d
      || code === 0x0020
      || code === 0x00a0
      || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a)
      || code === 0x2028
      || code === 0x2029
      || code === 0x202f
      || code === 0x205f
      || code === 0x3000
      || code === 0xfeff
    );
  }

  function isAsciiIdentifierStart(character) {
    const code = character?.charCodeAt(0) ?? -1;
    return (
      character === "$"
      || character === "_"
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    );
  }

  function isAsciiIdentifierPart(character) {
    const code = character?.charCodeAt(0) ?? -1;
    return isAsciiIdentifierStart(character) || (code >= 48 && code <= 57);
  }

  function skipLineComment(text, start) {
    let index = start;
    while (index < text.length && !isLineTerminator(text[index])) {
      index += 1;
    }
    return index;
  }

  function skipBlockComment(text, start) {
    const end = text.indexOf("*/", start);
    return end < 0 ? text.length : end + 2;
  }

  function skipQuotedJavaScriptLiteral(text, start, quote) {
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\") {
        if (text[index + 1] === "\r" && text[index + 2] === "\n") {
          index += 2;
        } else {
          index += 1;
        }
      } else if (character === quote) {
        return index + 1;
      } else if (isLineTerminator(character)) {
        return text.length;
      }
    }
    return text.length;
  }

  function skipRegularExpressionLiteral(text, start) {
    let characterClassDepth = 0;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (isLineTerminator(character)) {
        return text.length;
      }
      if (character === "\\") {
        if (isLineTerminator(text[index + 1])) {
          return text.length;
        }
        index += 1;
      } else if (character === "[") {
        characterClassDepth += 1;
      } else if (character === "]" && characterClassDepth > 0) {
        characterClassDepth -= 1;
      } else if (character === "/" && characterClassDepth === 0) {
        index += 1;
        while (isAsciiIdentifierPart(text[index])) {
          index += 1;
        }
        return index;
      }
    }
    return text.length;
  }

  function skipAssignmentWhitespace(text, start) {
    let index = start;
    while (isJavaScriptWhitespace(text[index])) {
      index += 1;
    }
    return index;
  }

  function consumeIdentifier(text, start, identifier) {
    if (!text.startsWith(identifier, start)) {
      return -1;
    }
    const end = start + identifier.length;
    return isAsciiIdentifierPart(text[end]) ? -1 : end;
  }

  function falcorObjectStartAt(text, start, firstIdentifier, firstEnd) {
    if (
      start > 0
      && (
        isAsciiIdentifierPart(text[start - 1])
        || (text.charCodeAt(start - 1) >= 0x80 && !isJavaScriptWhitespace(text[start - 1]))
      )
    ) {
      return -1;
    }

    let index = firstEnd;
    if (firstIdentifier === "window") {
      index = skipAssignmentWhitespace(text, index);
      if (text[index] !== ".") {
        return -1;
      }
      index = skipAssignmentWhitespace(text, index + 1);
      index = consumeIdentifier(text, index, "netflix");
      if (index < 0) {
        return -1;
      }
    } else if (firstIdentifier !== "netflix") {
      return -1;
    }

    index = skipAssignmentWhitespace(text, index);
    if (text[index] !== ".") {
      return -1;
    }
    index = skipAssignmentWhitespace(text, index + 1);
    index = consumeIdentifier(text, index, "falcorCache");
    if (index < 0) {
      return -1;
    }
    index = skipAssignmentWhitespace(text, index);
    if (text[index] !== "=" || text[index + 1] === "=" || text[index + 1] === ">") {
      return -1;
    }
    index = skipAssignmentWhitespace(text, index + 1);
    return text[index] === "{" ? index : -1;
  }

  function endOfJsonObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
    }
    return -1;
  }

  function createCodeContext(templateExpression = false) {
    return {
      type: "code",
      templateExpression,
      braceDepth: templateExpression ? 1 : 0,
      canStartRegex: true,
      parenStack: [],
      lastToken: null
    };
  }

  function parseInlineFalcorCaches(scriptText) {
    const text = String(scriptText || "");
    if (!text || text.length > MAX_INLINE_SCRIPT_BYTES) {
      return [];
    }

    const caches = [];
    const contexts = [createCodeContext()];
    const regexPrefixKeywords = new Set([
      "await", "break", "case", "continue", "debugger", "default", "delete",
      "do", "else", "extends", "in", "instanceof", "new", "of", "return",
      "throw", "typeof", "void", "yield"
    ]);
    const controlParenKeywords = new Set(["catch", "for", "if", "switch", "while", "with"]);
    let index = 0;

    while (index < text.length && caches.length < 4) {
      const context = contexts[contexts.length - 1];
      const character = text[index];

      if (context.type === "template") {
        if (character === "\\") {
          if (text[index + 1] === "\r" && text[index + 2] === "\n") {
            index += 3;
          } else {
            index += 2;
          }
        } else if (character === "`") {
          contexts.pop();
          index += 1;
          const parent = contexts[contexts.length - 1];
          parent.canStartRegex = false;
          parent.lastToken = { type: "value", value: "template" };
        } else if (character === "$" && text[index + 1] === "{") {
          contexts.push(createCodeContext(true));
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }

      if (isJavaScriptWhitespace(character)) {
        index += 1;
        continue;
      }
      if (
        (character === "/" && text[index + 1] === "/")
        || text.startsWith("<!--", index)
        || text.startsWith("-->", index)
        || (index === 0 && text.startsWith("#!", index))
      ) {
        index = skipLineComment(text, index + 2);
        continue;
      }
      if (character === "/" && text[index + 1] === "*") {
        index = skipBlockComment(text, index + 2);
        continue;
      }
      if (character === '"' || character === "'") {
        index = skipQuotedJavaScriptLiteral(text, index, character);
        context.canStartRegex = false;
        context.lastToken = { type: "value", value: "string" };
        continue;
      }
      if (character === "`") {
        contexts.push({ type: "template" });
        index += 1;
        continue;
      }
      if (character === "/") {
        if (context.canStartRegex) {
          index = skipRegularExpressionLiteral(text, index);
          context.canStartRegex = false;
          context.lastToken = { type: "value", value: "regex" };
        } else {
          index += 1;
          context.canStartRegex = true;
          context.lastToken = { type: "operator", value: "/" };
        }
        continue;
      }

      if (context.templateExpression && character === "}") {
        context.braceDepth -= 1;
        index += 1;
        if (context.braceDepth === 0) {
          contexts.pop();
        } else {
          context.canStartRegex = true;
          context.lastToken = { type: "punctuator", value: "}" };
        }
        continue;
      }

      if (isAsciiIdentifierStart(character)) {
        const start = index;
        index += 1;
        while (isAsciiIdentifierPart(text[index])) {
          index += 1;
        }
        const identifier = text.slice(start, index);
        const previousToken = context.lastToken;
        if (
          contexts.length === 1
          && previousToken?.value !== "."
          && (identifier === "window" || identifier === "netflix")
        ) {
          const objectStart = falcorObjectStartAt(text, start, identifier, index);
          if (objectStart >= 0) {
            const objectEnd = endOfJsonObject(text, objectStart);
            if (objectEnd < 0) {
              break;
            }
            let parsed;
            try {
              parsed = JSON.parse(normalizeJavaScriptHexEscapes(text.slice(objectStart, objectEnd)));
            } catch (_error) {
              // A non-JSON object can confuse brace boundaries; stop rather than
              // treating any of its source text as later executable evidence.
              break;
            }
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              caches.push(parsed);
            }
            index = objectEnd;
            context.canStartRegex = false;
            context.lastToken = { type: "value", value: "object" };
            continue;
          }
        }
        context.canStartRegex = regexPrefixKeywords.has(identifier);
        context.lastToken = { type: "identifier", value: identifier };
        continue;
      }

      const code = character.charCodeAt(0);
      if (code >= 48 && code <= 57) {
        index += 1;
        while (
          isAsciiIdentifierPart(text[index])
          || text[index] === "."
        ) {
          index += 1;
        }
        context.canStartRegex = false;
        context.lastToken = { type: "value", value: "number" };
        continue;
      }

      if (character === "(") {
        context.parenStack.push(
          context.lastToken?.type === "identifier"
          && controlParenKeywords.has(context.lastToken.value)
        );
        context.canStartRegex = true;
      } else if (character === ")") {
        context.canStartRegex = context.parenStack.pop() === true;
      } else if (character === "{") {
        if (context.templateExpression) {
          context.braceDepth += 1;
        }
        context.canStartRegex = true;
      } else if (character === "[") {
        context.canStartRegex = true;
      } else if (character === "]") {
        context.canStartRegex = false;
      } else if (
        (character === "+" && text[index + 1] === "+")
        || (character === "-" && text[index + 1] === "-")
      ) {
        context.canStartRegex = false;
        index += 1;
      } else {
        // After a closing block, treating `/` as a regex is conservative: an
        // object-literal division may be skipped, but regex source is never used
        // as metadata evidence.
        context.canStartRegex = character !== ")" && character !== "]";
      }
      context.lastToken = { type: "punctuator", value: character };
      index += 1;
    }
    return caches;
  }

  function factsFromPayload(payload, factLimit = MAX_EVIDENCE_FACTS) {
    const limit = Number.isSafeInteger(factLimit) && factLimit > 0
      ? Math.min(factLimit, MAX_VIDEO_NODES)
      : MAX_EVIDENCE_FACTS;
    const types = new Map();
    const showRefs = new Map();
    const ambiguous = new Set();
    const queue = [{ value: payload, depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;
    let videoGraphs = 0;
    let factCount = 0;
    let complete = true;

    function addType(id, type) {
      const existing = types.get(id);
      if (existing && existing !== type) {
        types.delete(id);
        ambiguous.add(id);
        return;
      }
      if (!ambiguous.has(id) && !existing) {
        types.set(id, type);
        factCount += 1;
      }
    }

    function addShowRef(episodeId, showId) {
      const existing = showRefs.get(episodeId);
      if (existing && existing !== showId) {
        showRefs.delete(episodeId);
        ambiguous.add(episodeId);
        return;
      }
      if (!ambiguous.has(episodeId) && !existing) {
        showRefs.set(episodeId, showId);
        factCount += 1;
      }
    }

    while (queue.length && visited < 300 && complete) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      if (depth > 4) {
        complete = false;
        break;
      }
      seen.add(value);
      visited += 1;

      if (Object.prototype.hasOwnProperty.call(value, "errors")) {
        const errors = value.errors;
        if (errors != null && (!Array.isArray(errors) || errors.length > 0)) {
          complete = false;
          break;
        }
      }

      if (value.videos && typeof value.videos === "object" && !Array.isArray(value.videos)) {
        videoGraphs += 1;
        if (videoGraphs > 4) {
          complete = false;
          break;
        }
        let nodeCount = 0;
        for (const id in value.videos) {
          if (!Object.prototype.hasOwnProperty.call(value.videos, id)) {
            continue;
          }
          nodeCount += 1;
          if (nodeCount > MAX_VIDEO_NODES || factCount > limit) {
            complete = false;
            break;
          }
          const node = value.videos[id];
          const summary = node?.summary;
          const type = summary?.value?.type;
          if (
            !isValidId(id)
            || summary?.$type !== "atom"
            || (type !== "movie" && type !== "show" && type !== "episode")
            || String(summary.value?.id || "") !== id
          ) {
            continue;
          }
          addType(id, type);
          if (type === "show") {
            const reference = node.current?.$type === "ref" && Array.isArray(node.current.value)
              ? node.current.value
              : null;
            const episodeId = String(reference?.[1] || "");
            if (
              reference?.length === 2
              && reference[0] === "videos"
              && isValidId(episodeId)
            ) {
              addShowRef(episodeId, id);
            }
          }
        }
      }

      if (!complete) {
        break;
      }
      if (Array.isArray(value)) {
        if (value.length > 100) {
          complete = false;
          break;
        }
        value.forEach((item) => queue.push({ value: item, depth: depth + 1 }));
        continue;
      }
      for (const key of ["jsonGraph", "value", "data", "result", "payload"]) {
        if (value[key] && typeof value[key] === "object") {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      }
    }

    if (queue.length || factCount > limit) {
      complete = false;
    }
    if (!complete) {
      return { types: [], showRefs: [], ambiguousIds: [], complete: false };
    }

    for (const [episodeId, showId] of Array.from(showRefs)) {
      if (ambiguous.has(episodeId) || ambiguous.has(showId)) {
        showRefs.delete(episodeId);
        ambiguous.add(episodeId);
      }
    }
    return {
      types: Array.from(types.entries()),
      showRefs: Array.from(showRefs.entries()),
      ambiguousIds: Array.from(ambiguous),
      complete: true
    };
  }

  function idsFromHref(href, baseUrl) {
    const explicitIds = [];
    let watchId = null;
    try {
      const base = new URL(baseUrl);
      const url = new URL(href, base);
      if (url.origin !== base.origin || url.hostname !== "www.netflix.com") {
        return { explicitIds, watchId };
      }

      const jbv = url.searchParams.get("jbv");
      if (isValidId(jbv)) {
        explicitIds.push(String(jbv));
      }

      const title = url.pathname.match(/^\/title\/(\d{4,20})\/?$/)?.[1];
      if (title && !explicitIds.includes(title)) {
        explicitIds.push(title);
      }

      watchId = url.pathname.match(/^\/watch\/(\d{4,20})\/?$/)?.[1] || null;
    } catch (_error) {
      // Invalid and cross-origin links deliberately remain unresolved.
    }
    return { explicitIds, watchId };
  }

  return Object.freeze({
    MAX_PAIRS,
    isValidId,
    analyzePairs,
    normalizePairs,
    resolveStructuralIds,
    analyzeVideoNodes,
    pairsFromVideoNodes,
    analyzePayload,
    pairsFromPayload,
    parseInlineFalcorCaches,
    factsFromPayload,
    idsFromHref
  });
});
