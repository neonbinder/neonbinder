import { describe, expect, it } from "vitest";
import {
  cardLabel,
  compareCards,
  LIVERY_FALLBACK,
  playerInitials,
  setAndVariant,
  shortCardName,
  teamTextColor,
  variantLabel,
} from "./labels";
import type { Card, VariantRef } from "./types";

/**
 * NEO-358 — card names over the hydrated view model, including the shapes
 * only the real catalog has: a sub-parallel under an insert, a variant type
 * of no kind, a card NB knows no player or team for.
 */

const SET = { id: "s", name: "Topps Chrome", season: "2024", year: 2024, brand: { id: "b", name: "Topps" }, sport: { id: "sp", name: "Baseball" } };

function variant(over: Partial<VariantRef>): VariantRef {
  return {
    id: "v",
    kind: "base",
    name: null,
    insertName: null,
    printRun: null,
    order: 0,
    path: { typeId: "t", variantId: null, subVariantId: null },
    finish: { kind: "standard" },
    ...over,
  };
}

function card(over: Partial<Card> = {}): Card {
  return {
    id: "c",
    set: SET,
    variant: variant({}),
    cardNumber: "1",
    players: [{ id: "p", name: "Shohei Ohtani" }],
    teams: [{ id: "t", name: "Dodgers", location: "Los Angeles", primary: "#005A9C", secondary: "#EF3E42" }],
    printRun: null,
    features: [],
    cardVariation: null,
    isVariation: false,
    sortOrder: 0,
    finish: { kind: "standard" },
    ...over,
  };
}

describe("cardLabel", () => {
  it("names a base card by set, number, player and team", () => {
    expect(cardLabel(card())).toBe("2024 Topps Chrome #1 Shohei Ohtani, Dodgers");
  });

  it("puts an insert in the set's name, and a parallel with its run after the team", () => {
    expect(cardLabel(card({ variant: variant({ kind: "insert", name: "Future Stars" }) }))).toBe(
      "2024 Topps Chrome Future Stars #1 Shohei Ohtani, Dodgers",
    );
    expect(cardLabel(card({ printRun: 50, variant: variant({ kind: "parallel", name: "Gold Refractor" }) }))).toBe(
      "2024 Topps Chrome #1 Shohei Ohtani, Dodgers, Gold Refractor /50",
    );
  });

  it("reads a sub-parallel under its insert", () => {
    const sub = card({ variant: variant({ kind: "parallel", name: "Refractor", insertName: "Future Stars" }) });
    expect(cardLabel(sub)).toBe("2024 Topps Chrome Future Stars #1 Shohei Ohtani, Dodgers, Refractor");
    expect(variantLabel(sub.variant)).toBe("Future Stars Refractor");
    expect(setAndVariant(sub)).toBe("2024 Topps Chrome Future Stars Refractor");
  });

  it("reads a variant type of no kind like an insert", () => {
    expect(cardLabel(card({ variant: variant({ kind: "other", name: "Promo" }) }))).toBe(
      "2024 Topps Chrome Promo #1 Shohei Ohtani, Dodgers",
    );
  });

  it("leaves out a player or team NB does not know, rather than a blank", () => {
    expect(cardLabel(card({ players: [], teams: [] }))).toBe("2024 Topps Chrome #1");
    expect(shortCardName(card({ players: [], cardVariation: "Sliding" }))).toBe("#1, Sliding variation");
  });
});

describe("compareCards", () => {
  it("orders Base, inserts, parallels, then the checklist's own order, the variation last", () => {
    const base2 = card({ id: "b2", cardNumber: "2", sortOrder: 1 });
    const base13b = card({ id: "b13", cardNumber: "13", sortOrder: 2, cardVariation: "Sliding", isVariation: true });
    const base13 = card({ id: "b13r", cardNumber: "13", sortOrder: 2 });
    const insert = card({ id: "i", variant: variant({ id: "vi", kind: "insert", name: "Future Stars" }) });
    const gold = card({ id: "g", variant: variant({ id: "vg", kind: "parallel", name: "Gold" }) });
    const promo = card({ id: "p", variant: variant({ id: "vp", kind: "other", name: "Promo" }) });
    const sorted = [promo, gold, base13b, insert, base13, base2].sort(compareCards).map((c) => c.id);
    expect(sorted).toEqual(["b2", "b13r", "b13", "i", "g", "p"]);
  });
});

describe("livery and initials", () => {
  it("falls back to the label ink for a team with no colours", () => {
    expect(teamTextColor({}, "#0F172A")).toBe(LIVERY_FALLBACK);
    expect(teamTextColor(undefined)).toBe(LIVERY_FALLBACK);
  });

  it("drops suffixes and survives an empty name", () => {
    expect(playerInitials("Ken Griffey Jr.")).toBe("KG");
    expect(playerInitials("")).toBe("?");
  });
});
