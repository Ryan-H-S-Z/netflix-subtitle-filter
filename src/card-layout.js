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

    const cardLike = children.filter((child) => hasSingleId(child, getIds));
    const distinctIds = new Set(cardLike.flatMap((child) => [...getIds(child)]));
    if (
      cardLike.length < 3
      || distinctIds.size < 3
      // Netflix keeps unresolved/virtual spacer slots in the same track. In
      // the current browser UI a 20-slot row commonly has 13 mounted cards,
      // so requiring 70% rejects every real card. Sixty percent still needs
      // a clear majority plus the distinct-ID and size checks below.
      || cardLike.length / children.length < 0.6
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

    return provenRoot;
  }

  return Object.freeze({
    STRONG_ROOT_SELECTORS,
    isRepeatedCardItem,
    findCardRoot
  });
});
