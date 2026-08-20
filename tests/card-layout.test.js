"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cardLayout = require("../src/card-layout.js");

class FakeElement {
  constructor({ tagName = "DIV", classes = [], dataUia = "", width = 240, height = 135 } = {}) {
    this.tagName = tagName;
    this.classes = new Set(classes);
    this.dataUia = dataUia;
    this.width = width;
    this.height = height;
    this.children = [];
    this.parentElement = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  contains(element) {
    for (let node = element; node; node = node.parentElement) {
      if (node === this) {
        return true;
      }
    }
    return false;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value === ".slider-item") {
        return this.classes.has("slider-item");
      }
      if (value === '[data-uia="slider-item"]') {
        return this.dataUia === "slider-item";
      }
      if (value === '[data-uia^="slider-item-"]') {
        return this.dataUia.startsWith("slider-item-");
      }
      const trustedCard = value.match(/^a\[data-uia="(standard-card|progress-card|ranked-card)"\]$/);
      if (trustedCard) {
        return this.tagName === "A" && this.dataUia === trustedCard[1];
      }
      return false;
    });
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) {
        return node;
      }
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }
}

function makeIdReader(entries) {
  const ids = new Map(entries);
  return (element) => new Set(ids.get(element) || []);
}

function makeVirtualRow(mountedCount, totalSlots = 20) {
  const section = new FakeElement();
  const track = new FakeElement();
  const cards = Array.from({ length: mountedCount }, () => new FakeElement());
  const spacers = Array.from(
    { length: totalSlots - mountedCount },
    () => new FakeElement({ width: 0, height: 0 })
  );
  const links = cards.map(() => new FakeElement({ tagName: "A" }));
  cards.forEach((card, index) => card.append(links[index]));
  section.append(track.append(...cards, ...spacers));

  const entries = [];
  cards.forEach((card, index) => {
    const id = String(1000 + index);
    entries.push([card, [id]], [links[index], [id]]);
  });

  return { section, track, cards, spacers, links, getIds: makeIdReader(entries) };
}

test("selects a verified Netflix slider item instead of its inner link", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const item = new FakeElement({ classes: ["slider-item"] });
  const link = new FakeElement({ tagName: "A" });
  section.append(track.append(item.append(link)));
  const getIds = makeIdReader([[item, ["1000"]], [link, ["1000"]]]);

  assert.equal(cardLayout.findCardRoot(link, section, getIds), item);
});

test("keeps an inner slider-item image wrapper inside the outer card slot", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const item = new FakeElement({ classes: ["slider-item"] });
  const imageWrapper = new FakeElement({ dataUia: "slider-item-image" });
  const link = new FakeElement({ tagName: "A" });
  section.append(track.append(item.append(imageWrapper.append(link))));
  const getIds = makeIdReader([
    [item, ["1000"]],
    [imageWrapper, ["1000"]],
    [link, ["1000"]]
  ]);

  assert.equal(cardLayout.findCardRoot(link, section, getIds), item);
});

test("rejects a nested list item and a two-link compound CTA group", () => {
  const section = new FakeElement();
  const panel = new FakeElement();
  const first = new FakeElement({ tagName: "A", width: 100, height: 32 });
  const second = new FakeElement({ tagName: "A", width: 100, height: 32 });
  section.append(panel.append(first, second));
  const getIds = makeIdReader([[first, ["1000"]], [second, ["2000"]]]);

  assert.equal(cardLayout.findCardRoot(first, section, getIds), null);
});

test("proves a repeated generic carousel only when card siblings dominate", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const cards = ["1000", "2000", "3000", "4000"].map(() => new FakeElement());
  const links = cards.map(() => new FakeElement({ tagName: "A" }));
  cards.forEach((card, index) => card.append(links[index]));
  section.append(track.append(...cards));
  const entries = [];
  cards.forEach((card, index) => {
    const id = String((index + 1) * 1000);
    entries.push([card, [id]], [links[index], [id]]);
  });

  assert.equal(cardLayout.findCardRoot(links[1], section, makeIdReader(entries)), cards[1]);
});

test("accepts a Netflix virtual row with 13 mounted cards and 7 unresolved slots", () => {
  const { section, track, cards, spacers, links, getIds } = makeVirtualRow(13);
  links.forEach((link, index) => {
    assert.equal(cardLayout.findCardRoot(link, section, getIds), cards[index]);
  });
  spacers.forEach((spacer) => {
    assert.equal(cardLayout.isRepeatedCardItem(spacer, track, getIds), false);
  });
});

test("accepts sparse 20-slot virtual rows with 5, 6, or 8 rendered cards", () => {
  for (const mountedCount of [5, 6, 8]) {
    const { section, cards, spacers, links, getIds } = makeVirtualRow(mountedCount);
    links.forEach((link, index) => {
      assert.equal(
        cardLayout.findCardRoot(link, section, getIds),
        cards[index],
        `${mountedCount}/20 row should select card ${index}`
      );
    });
    spacers.forEach((spacer) => {
      assert.equal(cardLayout.isRepeatedCardItem(spacer, spacer.parentElement, getIds), false);
    });
  }
});

test("rejects three canonical cards mixed with three visible non-card siblings", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const cards = Array.from({ length: 3 }, () => new FakeElement());
  const unrelated = Array.from(
    { length: 3 },
    () => new FakeElement({ width: 240, height: 135 })
  );
  const links = cards.map(() => new FakeElement({ tagName: "A" }));
  cards.forEach((card, index) => card.append(links[index]));
  section.append(track.append(...cards, ...unrelated));

  const entries = [];
  cards.forEach((card, index) => {
    const id = String(2000 + index);
    entries.push([card, [id]], [links[index], [id]]);
  });

  assert.equal(cardLayout.findCardRoot(links[0], section, makeIdReader(entries)), null);
});

test("fails open for a single generic virtual item and an aggregate root", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const item = new FakeElement();
  const link = new FakeElement({ tagName: "A" });
  section.append(track.append(item.append(link)));
  assert.equal(
    cardLayout.findCardRoot(link, section, makeIdReader([[item, ["1000"]], [link, ["1000"]]])),
    null
  );

  const strong = new FakeElement({ classes: ["slider-item"] });
  const aggregateLink = new FakeElement({ tagName: "A" });
  section.append(strong.append(aggregateLink));
  assert.equal(
    cardLayout.findCardRoot(
      aggregateLink,
      section,
      makeIdReader([[strong, ["1000", "2000"]], [aggregateLink, ["1000"]]])
    ),
    null
  );
});

test("promotes current homepage card anchors to a same-title outer wrapper", () => {
  for (const dataUia of ["standard-card", "progress-card", "ranked-card"]) {
    const section = new FakeElement();
    const wrapper = new FakeElement();
    const link = new FakeElement({ tagName: "A", dataUia });
    section.append(wrapper.append(link));
    const getIds = makeIdReader([[wrapper, ["1000"]], [link, ["1000"]]]);

    assert.equal(cardLayout.findCardRoot(link, section, getIds), wrapper);
  }
});

test("promotes through card-sized wrappers but stops before a same-title row container", () => {
  const section = new FakeElement({ width: 1280, height: 500 });
  const row = new FakeElement({ width: 1200, height: 160 });
  const slot = new FakeElement({ width: 248, height: 144 });
  const frame = new FakeElement({ width: 242, height: 138 });
  const link = new FakeElement({
    tagName: "A",
    dataUia: "standard-card",
    width: 240,
    height: 135
  });
  section.append(row.append(slot.append(frame.append(link))));
  const getIds = makeIdReader([
    [row, ["1000"]],
    [slot, ["1000"]],
    [frame, ["1000"]],
    [link, ["1000"]]
  ]);

  assert.equal(cardLayout.findCardRoot(link, section, getIds), slot);
});

test("keeps the typed anchor when an outer wrapper is unresolved or conflicting", () => {
  for (const wrapperIds of [[], ["1000", "2000"]]) {
    const section = new FakeElement();
    const wrapper = new FakeElement();
    const link = new FakeElement({ tagName: "A", dataUia: "standard-card" });
    section.append(wrapper.append(link));
    const getIds = makeIdReader([
      [wrapper, wrapperIds],
      [link, ["1000"]]
    ]);

    assert.equal(cardLayout.findCardRoot(link, section, getIds), link);
  }
});

test("does not promote a typed anchor into an oversized single-title container", () => {
  const section = new FakeElement({ width: 1280, height: 600 });
  const container = new FakeElement({ width: 1100, height: 420 });
  const link = new FakeElement({
    tagName: "A",
    dataUia: "standard-card",
    width: 240,
    height: 135
  });
  section.append(container.append(link));
  const getIds = makeIdReader([
    [container, ["1000"]],
    [link, ["1000"]]
  ]);

  assert.equal(cardLayout.findCardRoot(link, section, getIds), link);
});

test("bounds typed-card wrapper promotion even when every ancestor looks card-sized", () => {
  const section = new FakeElement();
  const link = new FakeElement({ tagName: "A", dataUia: "standard-card" });
  const wrappers = Array.from(
    { length: cardLayout.MAX_TYPED_ROOT_ASCENT + 2 },
    () => new FakeElement()
  );
  let child = link;
  for (const wrapper of wrappers) {
    wrapper.append(child);
    child = wrapper;
  }
  section.append(child);
  const getIds = makeIdReader([
    [link, ["1000"]],
    ...wrappers.map((wrapper) => [wrapper, ["1000"]])
  ]);

  assert.equal(
    cardLayout.findCardRoot(link, section, getIds),
    wrappers[cardLayout.MAX_TYPED_ROOT_ASCENT - 1]
  );
});

test("prefers a proven outer slot over a current homepage card anchor", () => {
  const { section, cards, links } = makeVirtualRow(5, 5);
  links.forEach((link) => {
    link.dataUia = "standard-card";
  });
  const entries = [];
  cards.forEach((card, index) => {
    const id = String(3000 + index);
    entries.push([card, [id]], [links[index], [id]]);
  });

  assert.equal(cardLayout.findCardRoot(links[2], section, makeIdReader(entries)), cards[2]);
});

test("rejects a typed homepage anchor that still contains multiple identities", () => {
  const section = new FakeElement();
  const link = new FakeElement({ tagName: "A", dataUia: "standard-card" });
  section.append(link);

  assert.equal(
    cardLayout.findCardRoot(link, section, makeIdReader([[link, ["1000", "2000"]]])),
    null
  );
});

function titleElement({ text = "", ariaLabel = null, alt = null, trusted = false } = {}) {
  return {
    textContent: text,
    matches(selector) {
      return trusted && selector === cardLayout.TRUSTED_CARD_LINK_SELECTORS.join(",");
    },
    getAttribute(name) {
      if (name === "aria-label") {
        return ariaLabel;
      }
      if (name === "alt") {
        return alt;
      }
      return null;
    }
  };
}

function titleRoot({ textNodes = [], images = [] } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === cardLayout.TITLE_TEXT_SELECTORS.join(",")) {
        return textNodes;
      }
      if (selector === cardLayout.TITLE_IMAGE_SELECTOR) {
        return images;
      }
      return [];
    }
  };
}

function normalizeTitle(value) {
  return String(value || "").trim().toLowerCase();
}

test("extracts a title from each supported Netflix card layout", () => {
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot({ textNodes: [titleElement({ text: "Legacy Card" })] }),
      [],
      normalizeTitle
    ),
    "legacy card"
  );
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot({ images: [titleElement({ alt: "Image-only Card" })] }),
      [],
      normalizeTitle
    ),
    "image-only card"
  );
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot(),
      [titleElement({ ariaLabel: "Accessible Card", trusted: true })],
      normalizeTitle
    ),
    "accessible card"
  );
});

test("prefers a unique accessible card title and rejects ambiguous fallback cards", () => {
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot({
        textNodes: [titleElement({ text: "Same Title" })],
        images: [titleElement({ alt: " same title " })]
      }),
      [titleElement({ ariaLabel: "SAME TITLE" })],
      normalizeTitle
    ),
    "same title"
  );
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot({ images: [titleElement({ alt: "First" }), titleElement({ alt: "Second" })] }),
      [],
      normalizeTitle
    ),
    ""
  );
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot({ textNodes: [titleElement({ text: "Text Title" })] }),
      [titleElement({ ariaLabel: "Different Title" })],
      normalizeTitle
    ),
    ""
  );
  assert.equal(
    cardLayout.extractCardTitle(
      titleRoot(),
      [
        titleElement({ ariaLabel: "First Title" }),
        titleElement({ ariaLabel: "Second Title" })
      ],
      normalizeTitle
    ),
    ""
  );
});
