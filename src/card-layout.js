(function exposeCardLayout(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.NetflixSubtitleCardLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCardLayout() {
  "use strict";

  const STRONG_ROOT_SELECTORS = Object.freeze([
    '[data-uia="slider-item"]',
    ".slider-item"
  ]);
  const STRONG_ROOT_SELECTOR = STRONG_ROOT_SELECTORS.join(",");
  const TRUSTED_CARD_LINK_SELECTORS = Object.freeze([
    'a[data-uia="standard-card"]',
    'a[data-uia="progress-card"]',
    'a[data-uia="ranked-card"]'
  ]);
  const TRUSTED_CARD_LINK_SELECTOR = TRUSTED_CARD_LINK_SELECTORS.join(",");
  const TITLE_TEXT_SELECTORS = Object.freeze([
    ".fallback-text",
    ".image-fallback-text",
    ".titleCard-title_text"
  ]);
  const TITLE_TEXT_SELECTOR = TITLE_TEXT_SELECTORS.join(",");
  const TITLE_IMAGE_SELECTOR = [
    'a[data-uia="standard-card"] img[alt]',
    'a[data-uia="progress-card"] img[alt]',
    'a[data-uia="ranked-card"] img[alt]',
    ".boxart-container img[alt]",
    ".titleCard-imageWrapper img[alt]",
    "img.boxart-image[alt]",
    "img.boxart-image-in-padded-container[alt]"
  ].join(",");
  const MAX_TYPED_ROOT_ASCENT = 5;
  const MAX_TYPED_ROOT_SCALE = 1.6;
  const MAX_TYPED_ROOT_AREA_SCALE = 2.25;

  function hasSingleId(element, getIds) {
    return getIds(element).size === 1;
  }

  function findStrongRoot(link, section, getIds) {
    let candidate = null;
    for (let node = link; node && node !== section; node = node.parentElement) {
      if (!node.matches?.(STRONG_ROOT_SELECTOR)) {
        continue;
      }
      const ids = getIds(node);
      if (ids.size > 1) {
        return { blocked: true, root: null };
      }
      if (ids.size === 1 && section.contains(node)) {
        // Prefer the outermost unambiguous Netflix slider item. This avoids
        // hiding an inner image/link wrapper while leaving its layout slot.
        candidate = node;
      }
    }
    return { blocked: false, root: candidate };
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function isRepeatedCardItem(candidate, parent, getIds) {
    const children = Array.from(parent?.children || []);
    if (!children.includes(candidate) || children.length < 3) {
      return false;
    }

    // Netflix virtualizes carousel tracks by leaving unmounted slots in the
    // child list. Those slots have no rendered area and must not dilute the
    // card ratio; visible non-card siblings still count against it.
    const renderedChildren = children.filter((child) => {
      const rect = child.getBoundingClientRect?.();
      return !rect || (rect.width > 0 && rect.height > 0);
    });
    const cardLike = renderedChildren.filter((child) => hasSingleId(child, getIds));
    const distinctIds = new Set(cardLike.flatMap((child) => [...getIds(child)]));
    if (
      cardLike.length < 3
      || distinctIds.size < 3
      // Sixty percent still requires a clear majority among actually rendered
      // siblings, in addition to the distinct-ID and size checks below.
      || cardLike.length / renderedChildren.length < 0.6
      || !hasSingleId(candidate, getIds)
    ) {
      return false;
    }

    const sameTagCount = cardLike.filter((child) => child.tagName === candidate.tagName).length;
    if (sameTagCount / cardLike.length < 0.8) {
      return false;
    }

    const candidateRect = candidate.getBoundingClientRect?.();
    if (!candidateRect || candidateRect.width < 80 || candidateRect.height < 45) {
      return false;
    }

    const rects = cardLike
      .map((child) => child.getBoundingClientRect?.())
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
    if (rects.length >= 3) {
      const medianWidth = median(rects.map((rect) => rect.width));
      const medianHeight = median(rects.map((rect) => rect.height));
      if (
        candidateRect.width < medianWidth * 0.55
        || candidateRect.width > medianWidth * 1.8
        || candidateRect.height < medianHeight * 0.55
        || candidateRect.height > medianHeight * 1.8
      ) {
        return false;
      }
    }

    return true;
  }

  function renderedRect(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0
        ? rect
        : null;
    } catch (_error) {
      return null;
    }
  }

  function isCardSizedAncestor(candidate, anchorRect) {
    const candidateRect = renderedRect(candidate);
    if (!candidateRect || !anchorRect) {
      return false;
    }

    const maximumWidth = Math.max(
      anchorRect.width * MAX_TYPED_ROOT_SCALE,
      anchorRect.width + 64
    );
    const maximumHeight = Math.max(
      anchorRect.height * MAX_TYPED_ROOT_SCALE,
      anchorRect.height + 64
    );
    return candidateRect.width >= anchorRect.width * 0.8
      && candidateRect.height >= anchorRect.height * 0.8
      && candidateRect.width <= maximumWidth
      && candidateRect.height <= maximumHeight
      && candidateRect.width * candidateRect.height
        <= anchorRect.width * anchorRect.height * MAX_TYPED_ROOT_AREA_SCALE;
  }

  function findTypedCardRoot(link, section, getIds) {
    if (!link.matches?.(TRUSTED_CARD_LINK_SELECTOR)) {
      return null;
    }

    const linkIds = getIds(link);
    if (linkIds.size !== 1) {
      return null;
    }
    const expectedId = Array.from(linkIds)[0];
    const anchorRect = renderedRect(link);
    let candidate = link;
    let node = link.parentElement;

    // A typed Netflix card can sit inside one or more anonymous wrappers. If
    // only the anchor is hidden, a fixed-size flex/grid wrapper remains as a
    // black slot. Promote through a short chain only while every ancestor is
    // still the same single title and remains card-sized. A row/track is much
    // larger, while an aggregate or unresolved wrapper has zero or many IDs;
    // either condition stops the ascent before it can hide unrelated cards.
    for (
      let depth = 0;
      node && node !== section && depth < MAX_TYPED_ROOT_ASCENT;
      depth += 1, node = node.parentElement
    ) {
      if (!section.contains(node)) {
        break;
      }
      const nodeIds = getIds(node);
      if (
        nodeIds.size !== 1
        || !nodeIds.has(expectedId)
        || !isCardSizedAncestor(node, anchorRect)
      ) {
        break;
      }
      candidate = node;
    }

    return candidate;
  }

  function findCardRoot(link, section, getIds) {
    const strongResult = findStrongRoot(link, section, getIds);
    if (strongResult.blocked) {
      return null;
    }
    if (strongResult.root) {
      return strongResult.root;
    }

    let node = link;
    let provenRoot = null;
    while (node && node !== section && node.parentElement) {
      const parent = node.parentElement;
      if (!section.contains(parent) && parent !== section) {
        break;
      }

      const nodeIds = getIds(node);
      if (nodeIds.size > 1) {
        break;
      }
      if (isRepeatedCardItem(node, parent, getIds)) {
        provenRoot = node;
      }
      if (parent === section) {
        break;
      }
      node = parent;
    }

    if (provenRoot) {
      return provenRoot;
    }

    // Netflix's current homepage does not always retain a slider-item wrapper.
    // Use the typed card anchor as a semantic fallback, promoting it through
    // only a bounded, single-title, card-sized wrapper chain so hiding the card
    // also collapses its layout slot.
    return findTypedCardRoot(link, section, getIds);
  }

  function normalizedValues(elements, readValue, normalizeTitle) {
    const values = new Set();
    for (const element of Array.from(elements || [])) {
      let value = "";
      try {
        value = normalizeTitle(readValue(element));
      } catch (_error) {
        value = "";
      }
      if (value) {
        values.add(value);
      }
    }
    return values;
  }

  function extractCardTitle(root, links, normalizeTitle) {
    if (!root?.querySelectorAll || typeof normalizeTitle !== "function") {
      return "";
    }

    const trustedAriaTitles = normalizedValues(
      Array.from(links || []).filter((link) => link.matches?.(TRUSTED_CARD_LINK_SELECTOR)),
      (link) => link.getAttribute?.("aria-label"),
      normalizeTitle
    );
    if (trustedAriaTitles.size > 1) {
      return "";
    }
    if (trustedAriaTitles.size === 1) {
      // The current homepage, progress, ranked and search cards expose their
      // title only through the card link's aria-label. Prefer that explicit
      // accessible name over incidental text or artwork nested in the card.
      return Array.from(trustedAriaTitles)[0];
    }

    const ariaTitles = normalizedValues(
      links,
      (link) => link.getAttribute?.("aria-label"),
      normalizeTitle
    );
    const fallbackSources = [
      normalizedValues(
        root.querySelectorAll(TITLE_TEXT_SELECTOR),
        (element) => element.textContent,
        normalizeTitle
      ),
      normalizedValues(
        root.querySelectorAll(TITLE_IMAGE_SELECTOR),
        (image) => image.getAttribute?.("alt"),
        normalizeTitle
      )
    ];

    // Without an accessible card name, every fallback source must identify one
    // title and the available sources must agree.
    if (ariaTitles.size > 1 || fallbackSources.some((source) => source.size > 1)) {
      return "";
    }
    const fallbackCandidates = new Set(
      fallbackSources
        .filter((source) => source.size === 1)
        .map((source) => Array.from(source)[0])
    );
    if (fallbackCandidates.size !== 1) {
      return "";
    }
    const fallbackTitle = Array.from(fallbackCandidates)[0];
    return ariaTitles.size === 0 || ariaTitles.has(fallbackTitle)
      ? fallbackTitle
      : "";
  }

  return Object.freeze({
    STRONG_ROOT_SELECTORS,
    TRUSTED_CARD_LINK_SELECTORS,
    TITLE_TEXT_SELECTORS,
    TITLE_IMAGE_SELECTOR,
    MAX_TYPED_ROOT_ASCENT,
    isRepeatedCardItem,
    findCardRoot,
    extractCardTitle
  });
});
