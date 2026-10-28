import { describe, expect, it } from "vitest";
import { POCKETS_PER_PAGE, type Card, type Copy } from "../data/types";
import { binderLayout, cardsOnPages, markOutside, placementsOf, sortedPages, type PageModel } from "./model";

/**
 * NEO-362 — a binder that keeps itself sorted: drawn in order on every
 * open, never written per add. Jason's example: cards 1, 2, 3 and 16, 17, 18
 * of one checklist with empty slots on fill page 1's first three pockets and
 * page 2's last three.
 */

const SET = { id: "set-a", year: 1996, season: "1996", name: "Contenders" } as unknown as Card["set"];
const SET_B = { id: "set-b", year: 2001, season: "2001", name: "Topps" } as unknown as Card["set"];
const BASE = { id: "v-base", kind: "base", name: null, order: 0 } as unknown as Card["variant"];
const BASE_B = { id: "v-base-b", kind: "base", name: null, order: 0 } as unknown as Card["variant"];

const person = (id: string, name: string) => ({ id, name });
const team = (id: string, location: string, name: string) => ({ id, location, name });
const FAVRE = person("p-favre", "Brett Favre");
const WHITE = person("p-white", "Reggie White");
const ADAMS = person("p-adams", "Davante Adams");
const PACKERS = team("t-gb", "Green Bay", "Packers");
const EAGLES = team("t-phi", "Philadelphia", "Eagles");

const card = (n: number, over: Partial<Card> = {}): Card =>
  ({
    id: `c${over.set?.id ?? "a"}-${n}`,
    set: SET,
    variant: BASE,
    cardNumber: String(n),
    players: [FAVRE],
    teams: [PACKERS],
    printRun: null,
    features: [],
    cardVariation: null,
    isVariation: false,
    sortOrder: n,
    ...over,
  }) as Card;

let seq = 0;
const copy = (c: Card, over: Partial<Copy> = {}): Copy =>
  ({
    id: `copy-${++seq}`,
    cardId: c.id,
    homeId: "b1",
    homeKind: "binder",
    upForTrade: false,
    quantity: 1,
    acquiredAt: "2026-01-01",
    notes: "",
    ...over,
  }) as Copy;

const checklist = Array.from({ length: 18 }, (_, i) => card(i + 1));
const byId = new Map(checklist.map((c) => [c.id, c]));
const have = [1, 2, 3, 16, 17, 18].map((n) => checklist[n - 1]);
// Stored in no order at all: the sort is drawn, never read from pockets.
const copies = [have[4], have[0], have[5], have[2], have[1], have[3]].map((c, i) => copy(c, { slot: 40 - i }));
const needs = checklist.filter((c) => !have.includes(c));

const kinds = (page: PageModel) => page.pockets.map((p) => p.content.kind);

describe("sortedPages: checklist order", () => {
  it("with empty slots, the missing cards keep their pockets (Jason's 1-2-3 / 16-17-18)", () => {
    const pages = sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: true, needs });
    expect(pages).toHaveLength(2);
    expect(kinds(pages[0])).toEqual(["have", "have", "have", "need", "need", "need", "need", "need", "need"]);
    expect(kinds(pages[1])).toEqual(["need", "need", "need", "need", "need", "need", "have", "have", "have"]);
  });

  it("without empty slots, packs tight in checklist order", () => {
    const pages = sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: false, needs });
    expect(pages).toHaveLength(1);
    expect(cardsOnPages(pages)).toEqual(have.map((c) => c.id));
  });

  it("each checklist starts a fresh page with empty slots, by year then set", () => {
    const other = card(1, { set: SET_B, variant: BASE_B });
    const cards = new Map([...byId, [other.id, other]]);
    const pages = sortedPages({
      copies: [copy(other), ...copies],
      cards,
      sort: "checklist",
      emptySlots: true,
      needs,
    });
    expect(pages).toHaveLength(3);
    expect(pages[2].pockets[0].content).toMatchObject({ kind: "have", card: { id: other.id } });
    expect(pages[2].section).toBe("2001 Topps");
  });

  it("marks a need the collector has in another binder", () => {
    const pages = sortedPages({
      copies,
      cards: byId,
      sort: "checklist",
      emptySlots: true,
      needs,
      heldElsewhere: new Set([checklist[3].id]),
    });
    expect(pages[0].pockets[3].content).toMatchObject({ kind: "need", elsewhere: true });
    expect(pages[0].pockets[4].content).not.toHaveProperty("elsewhere");
  });

  it("never draws a need for a card the binder holds", () => {
    const pages = sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: true, needs: checklist });
    expect(pages.flatMap((p) => p.pockets).filter((p) => p.content.kind === "need")).toHaveLength(12);
  });
});

describe("sortedPages: player and team", () => {
  const favre = card(1);
  const white = card(2, { players: [WHITE], teams: [EAGLES] });
  // Two players on one card: files under the FIRST listed (Jason).
  const combo = card(3, { players: [ADAMS, FAVRE], teams: [PACKERS] });
  const cards = new Map([favre, white, combo].map((c) => [c.id, c]));
  const lines = [copy(favre), copy(white), copy(combo)];

  it("by player: last name, first listed player", () => {
    const pages = sortedPages({ copies: lines, cards, sort: "player", emptySlots: false });
    expect(cardsOnPages(pages)).toEqual([combo.id, favre.id, white.id]);
  });

  it("by player with empty slots: each player starts a fresh page", () => {
    const pages = sortedPages({ copies: lines, cards, sort: "player", emptySlots: true, needs: [] });
    expect(pages.map((p) => p.section)).toEqual(["Davante Adams", "Brett Favre", "Reggie White"]);
  });

  it("by team: the first team listed, by its full name", () => {
    const pages = sortedPages({ copies: lines, cards, sort: "team", emptySlots: true, needs: [] });
    expect(pages.map((p) => p.section)).toEqual(["Green Bay Packers", "Philadelphia Eagles"]);
    expect(cardsOnPages([pages[0]])).toEqual([favre.id, combo.id]);
  });
});

describe("placementsOf: Sort now and turning a sort off", () => {
  it("writes each line's drawn pocket, leaving a need's gap open", () => {
    const pages = sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: true, needs });
    const placed = placementsOf(pages);
    expect(placed).toHaveLength(copies.length);
    const slotOfCard = (c: Card) => placed.find((p) => copies.find((x) => x.id === p.copyId)!.cardId === c.id)!.slot;
    expect(slotOfCard(have[0])).toBe(0);
    expect(slotOfCard(have[3])).toBe(POCKETS_PER_PAGE + 6);
    expect(new Set(placed.map((p) => p.slot)).size).toBe(placed.length);
  });
});

describe("binderLayout: defaults", () => {
  it("unsorted, empty slots on only for a binder that follows a checklist", () => {
    expect(binderLayout({}, true)).toEqual({ sort: null, emptySlots: true });
    expect(binderLayout({}, false)).toEqual({ sort: null, emptySlots: false });
  });

  it("the binder's own settings win", () => {
    expect(binderLayout({ settings: { sort: "team", emptySlots: false } }, true)).toEqual({ sort: "team", emptySlots: false });
  });
});

describe("outside the rule", () => {
  it("marks a card the rule no longer takes in, and only that one", () => {
    const pages = markOutside(
      sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: false }),
      (id) => id !== have[0].id,
    );
    expect(pages[0].pockets[0].outside).toBe(true);
    expect(pages[0].pockets[1].outside).toBeUndefined();
  });

  it("sortedPages marks it too", () => {
    const pages = sortedPages({ copies, cards: byId, sort: "checklist", emptySlots: false, fits: () => false });
    expect(pages[0].pockets.filter((p) => p.outside)).toHaveLength(have.length);
  });
});
