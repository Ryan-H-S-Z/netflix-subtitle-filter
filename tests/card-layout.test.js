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
  const section = new FakeElement();
  const track = new FakeElement();
  const cards = Array.from({ length: 13 }, () => new FakeElement());
  const spacers = Array.from({ length: 7 }, () => new FakeElement({ width: 0, height: 0 }));
  const links = cards.map(() => new FakeElement({ tagName: "A" }));
  cards.forEach((card, index) => card.append(links[index]));
  section.append(track.append(...cards, ...spacers));

  const entries = [];
  cards.forEach((card, index) => {
    const id = String(1000 + index);
    entries.push([card, [id]], [links[index], [id]]);
  });

  const getIds = makeIdReader(entries);
  links.forEach((link, index) => {
    assert.equal(cardLayout.findCardRoot(link, section, getIds), cards[index]);
  });
  spacers.forEach((spacer) => {
    assert.equal(cardLayout.isRepeatedCardItem(spacer, track, getIds), false);
  });
});

test("rejects a row where canonical cards are only half of the children", () => {
  const section = new FakeElement();
  const track = new FakeElement();
  const cards = Array.from({ length: 3 }, () => new FakeElement());
  const unrelated = Array.from({ length: 3 }, () => new FakeElement());
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
