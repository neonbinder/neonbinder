import { describe, expect, it } from "vitest";
import { cards as fixtureCards, searchCards, setsInOrder } from "../../prototypes/_shared/data";
import { cardCaption } from "../captions";
import { demoCard, demoVariantId } from "../data/demoStore";
import { compareCards } from "../data/labels";
import { BOX_ROWS, POCKETS_PER_PAGE, pocketSlot, type Card, type Container, type Copy, type Want } from "../data/types";
import { NO_BROWSE_FILTER } from "../store";
import {
  EXTRAS,
  binderPages,
  boxRows,
  cardCount,
  cardPages,
  cardsOnPages,
  containerShareTarget,
  extrasStart,
  filterSets,
  firstPocketVariant,
  followedChecklist,
  followedTally,
  guardPocket,
  havePocketLabel,
  isFiltering,
  movableCopies,
  orderWants,
  paginate,
  pilePages,
  placeWords,
  placesOf,
  pocketFor,
  pocketsOf,
  resolveTyped,
  rowName,
  setPages,
  setShareTarget,
  shareUrl,
  slabLabel,
  slotOf,
  slotRefOf,
  slugify,
  soleCopyId,
  sportsOf,
  stackPages,
  teamRule,
  tradeableCopies,
  wantPages,
  wantSection,
  NO_FILTERS,
  type PageModel,
} from "./model";

const CONTENDERS_SET = "1996-playoff-contenders";
const CONTENDERS = "binder-contenders-96";
const BOX = "box-show";

/** The '96 Contenders base checklist as the store would hand it over, in checklist order. */
const checklist: Card[] = fixtureCards
  .filter((c) => c.setId === CONTENDERS_SET && c.variantPath.type === "Base" && c.variation === null)
  .map((c) => demoCard(c.id)!)
  .sort(compareCards);
const byId = new Map(checklist.map((c) => [c.id, c]));
const [c0, c1, c2, c3, c4] = checklist;

let seq = 0;
const copy = (card: Card, over: Partial<Copy> = {}): Copy => ({
  id: `copy-${++seq}`,
  cardId: card.id,
  variantId: card.variant.id,
  setId: card.set.id,
  homeId: CONTENDERS,
  homeKind: "binder",
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-01-01",
  notes: "",
  ...over,
});
const slotted = (cards: Card[]): Copy[] => cards.map((c, i) => copy(c, { slot: i }));

const container = (over: Partial<Container> & Pick<Container, "id">): Container => ({
  kind: "binder",
  name: over.id,
  count: null,
  ...over,
});
const shelf: Container[] = [
  container({ id: "main", system: "main", name: "Main" }),
  container({ id: "trade", system: "trade", name: "Up for Trade" }),
  container({ id: "want", system: "want", name: "Want List" }),
  container({ id: CONTENDERS, name: "'96 Contenders" }),
  container({ id: BOX, kind: "box", name: "Show box" }),
];

const sectionsOf = (pages: PageModel[]) => pages.map((p) => p.section);

describe("resolveTyped: Enter acts only on exactly one match", () => {
  it("acts on the one card that fits every word", () => {
    expect(resolveTyped([c0])).toEqual({ kind: "one", card: c0 });
  });

  it("asks when two cards fit, never taking the first", () => {
    expect(resolveTyped([c0, c1])).toEqual({ kind: "many", count: 2 });
  });

  it("does nothing on no match", () => {
    expect(resolveTyped([])).toEqual({ kind: "none" });
  });

  it("will not act on a single card from a truncated search: there may be more", () => {
    expect(resolveTyped([c0], true)).toEqual({ kind: "many", count: 1 });
  });

  it("a bare card number is ambiguous in the catalog", () => {
    // #1 exists in many sets and parallels: a number alone never resolves.
    const hits = searchCards("1").map((h) => demoCard(h.card.id)!);
    expect(resolveTyped(hits).kind).toBe("many");
  });
});

describe("pockets and pages", () => {
  it("pads the last page to nine sleeves", () => {
    const pages = paginate(checklist.slice(0, 11).map((card) => ({ content: { kind: "need" as const, card } })), "Base");
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.pockets.length === POCKETS_PER_PAGE)).toBe(true);
    expect(pages[1].pockets.filter((p) => p.content.kind === "empty")).toHaveLength(7);
  });

  it("round-trips a pocket through its slot number", () => {
    const ref = slotRefOf(CONTENDERS, 20);
    expect(ref).toEqual({ binderId: CONTENDERS, page: 2, slot: 2 });
    expect(slotOf(ref)).toBe(20);
    expect(pocketSlot(2, 2)).toBe(20);
  });

  it("lists the cards on the pages once each, in order", () => {
    const pages = stackPages([copy(c1), copy(c0), copy(c1)], byId);
    expect(cardsOnPages(pages)).toEqual([c0.id, c1.id]);
  });

  it("a stack packs one pocket per copy in checklist order", () => {
    const pages = stackPages([copy(c2), copy(c0)], byId);
    expect(pages[0].pockets.slice(0, 2).map((p) => (p.content.kind === "have" ? p.content.card.id : null))).toEqual([c0.id, c2.id]);
  });

  it("leaves out a copy whose card is gone", () => {
    const orphan = { ...copy(c0), cardId: "gone" };
    expect(cardsOnPages(stackPages([orphan], byId))).toEqual([]);
  });

  it("a smart binder lays one pocket per card with every copy together", () => {
    const pages = cardPages([copy(c0), copy(c0), copy(c1)], byId);
    const first = pages[0].pockets[0].content;
    expect(first.kind === "have" && first.copies).toHaveLength(2);
  });
});

describe("All my cards: the pile", () => {
  const all = [copy(c0), copy(c1, { graded: { grader: "PSA", grade: "9" } }), copy(c2, { homeId: BOX, homeKind: "box" })];

  it("drops a line with nothing in it", () => {
    expect(cardsOnPages(pilePages([copy(c0, { quantity: 0 })], byId, "checklist", NO_FILTERS))).toEqual([]);
  });

  it("filters to graded copies", () => {
    expect(cardsOnPages(pilePages(all, byId, "checklist", { ...NO_FILTERS, graded: true }))).toEqual([c1.id]);
  });

  it("filters to for-sale copies by their home being a box", () => {
    expect(cardsOnPages(pilePages(all, byId, "checklist", { ...NO_FILTERS, forSale: true }))).toEqual([c2.id]);
  });

  it("sorts newest first, then by checklist", () => {
    const older = copy(c0, { acquiredAt: "2025-01-01" });
    const newer = copy(c2, { acquiredAt: "2026-06-01" });
    expect(cardsOnPages(pilePages([older, newer], byId, "newest", NO_FILTERS))).toEqual([c2.id, c0.id]);
  });
});

describe("a binder laid out like the real one", () => {
  const list = checklist.slice(0, 24);
  const filled = list.slice(0, 20).map((c, i) => copy(c, { slot: i }));
  const followed = followedChecklist(filled, list)!;

  it("follows the checklist when the pockets hold card N in pocket N", () => {
    expect(followed).toEqual(list.filter((c) => !c.isVariation));
    expect(followedChecklist(filled, [])).toBeNull();
    expect(followedChecklist(filled, undefined)).toBeNull();
  });

  it("does not follow with fewer than three filled pockets or with a card in the wrong pocket", () => {
    expect(followedChecklist(filled.slice(0, 2), list)).toBeNull();
    const wrong = [copy(c0, { slot: 0 }), copy(c1, { slot: 1 }), copy(c3, { slot: 2 })];
    expect(followedChecklist(wrong, list)).toBeNull();
  });

  it("names the checklist the first filled pocket belongs to", () => {
    expect(firstPocketVariant(filled)).toBe(c0.variant.id);
    expect(firstPocketVariant([copy(c0)])).toBeNull();
  });

  it("starts the Extras pages after the checklist's last page", () => {
    expect(extrasStart(list)).toBe(Math.ceil(list.length / POCKETS_PER_PAGE) * POCKETS_PER_PAGE);
  });

  it("sends a duplicate to the first Extras pocket, never a numbered one", () => {
    expect(pocketFor(filled, list[0], followed)).toBe(extrasStart(followed));
  });

  it("sends the card for a free numbered pocket straight to it", () => {
    expect(pocketFor(filled, list[22], followed)).toBe(22);
  });

  it("a binder with no checklist takes the first free pocket", () => {
    expect(pocketFor([copy(c0, { slot: 0 }), copy(c1, { slot: 1 })], c2, null)).toBe(2);
    expect(pocketFor([], c0, null)).toBe(0);
  });

  it("a card dropped on another card's numbered pocket goes to its own spot", () => {
    const free = 22;
    const { slot, savedFor } = guardPocket(filled, free, c0, followed);
    expect(savedFor?.id).toBe(followed[free].id);
    expect(slot).toBe(extrasStart(followed));
    expect(guardPocket(filled, free, followed[free], followed)).toEqual({ slot: free, savedFor: null });
  });

  it("lets any pocket through a binder that follows no checklist", () => {
    expect(guardPocket([], 4, c0, null)).toEqual({ slot: 4, savedFor: null });
  });

  it("lays out Need sleeves for unowned numbered pockets, Extras after, and counts have against need", () => {
    const pages = binderPages({ binderId: CONTENDERS, copies: filled, cards: byId, followed, ownedAnywhere: () => false });
    const needs = pages.flatMap((p) => p.pockets).filter((p) => p.content.kind === "need");
    expect(needs).toHaveLength(followed.length - filled.length);
    expect(pages[0].section).toBe("Base");
    expect(sectionsOf(pages).at(-1)).toBe(EXTRAS);
    expect(followedTally(filled, followed, () => false)).toEqual({ have: filled.length, need: followed.length - filled.length });
  });

  it("does not ask for a card owned elsewhere", () => {
    const owned = new Set([list[22].id]);
    const pages = binderPages({ binderId: CONTENDERS, copies: filled, cards: byId, followed, ownedAnywhere: (id) => owned.has(id) });
    const pocket = pages[Math.floor(22 / POCKETS_PER_PAGE)].pockets[22 % POCKETS_PER_PAGE];
    expect(pocket.content.kind).toBe("empty");
    expect(followedTally(filled, followed, (id) => owned.has(id)).have).toBe(filled.length + 1);
  });

  it("a binder with no pockets still shows a fresh page to fill", () => {
    const pages = binderPages({ binderId: CONTENDERS, copies: [], cards: byId, followed: null });
    expect(pages).toHaveLength(1);
    expect(pages[0].note).toBe("A fresh page");
    expect(pages[0].pockets.every((p) => p.slot && p.content.kind === "empty")).toBe(true);
  });

  it("copies filed here but in no pocket come after, on pages that say so", () => {
    const loose = copy(c3);
    const pages = binderPages({ binderId: CONTENDERS, copies: [copy(c0, { slot: 0 }), loose], cards: byId, followed: null });
    const last = pages.at(-1)!;
    expect(last.note).toBe("Not in a pocket yet");
    expect(cardsOnPages([last])).toEqual([c3.id]);
  });

  it("maps pockets by slot, first copy winning", () => {
    expect([...pocketsOf([copy(c0, { slot: 3 }), copy(c1, { slot: 3 }), copy(c2)]).keys()]).toEqual([3]);
  });
});

describe("a browsed set", () => {
  it("shows what you hold in its sleeve and the rest as needs, starting a page per section", () => {
    const pages = setPages(checklist.slice(0, 3), { [c0.id]: [copy(c0)], [c1.id]: [copy(c1, { quantity: 0 })] }, "pockets");
    expect(pages[0].pockets.slice(0, 3).map((p) => p.content.kind)).toEqual(["have", "need", "need"]);
  });

  it("reads a card whose copies have not loaded as a need", () => {
    const pages = setPages([c0], undefined, "stack");
    expect(pages[0].pockets[0].content.kind).toBe("need");
  });
});

describe("the Want List, opened", () => {
  const nameOf = (id: string) => shelf.find((c) => c.id === id)?.name;
  const wants: Want[] = [
    { cardId: c3.id, binderId: BOX },
    { cardId: c0.id, binderId: null },
    { cardId: c2.id, binderId: CONTENDERS },
    { cardId: c1.id, binderId: null },
    { cardId: c4.id, binderId: CONTENDERS },
  ];

  it("starts each group on a fresh page, unscoped first, then binders and boxes in shelf order", () => {
    const pages = wantPages({ wants, containers: shelf, cards: byId, copiesByCard: { [c1.id]: [copy(c1)] } });
    expect(sectionsOf(pages)).toEqual(["Just want it", "For '96 Contenders", "For Show box"]);
    expect(pages[0].pockets.slice(0, 2).map((p) => p.content.kind)).toEqual(["need", "have"]);
    expect(cardsOnPages(pages)).toEqual([c0.id, c1.id, c2.id, c4.id, c3.id]);
  });

  it("carries which home each want is for on its pocket", () => {
    const pages = wantPages({ wants, containers: shelf, cards: byId, copiesByCard: {} });
    expect(pages[1].pockets[0].wantFor).toBe(CONTENDERS);
    expect(pages[0].pockets[0].wantFor).toBeNull();
  });

  it("treats a want for a binder that is gone as a plain want", () => {
    const pages = wantPages({ wants: [{ cardId: c0.id, binderId: "gone" }], containers: shelf, cards: byId, copiesByCard: {} });
    expect(sectionsOf(pages)).toEqual(["Just want it"]);
  });

  it("leaves out a want whose card is not loaded", () => {
    expect(wantPages({ wants: [{ cardId: "nope", binderId: null }], containers: shelf, cards: byId, copiesByCard: {} })).toEqual([]);
  });

  it("orders wants the way the pages are laid out, so a prefix pages the same as the whole", () => {
    const ordered = orderWants(wants, shelf, byId);
    expect(ordered.map((w) => w.cardId)).toEqual([c0.id, c1.id, c2.id, c4.id, c3.id]);
  });

  it("names a group whose binder is gone without crashing", () => {
    expect(wantSection("binder-gone", () => undefined)).toBe("For a binder");
    expect(wantSection(null, nameOf)).toBe("Just want it");
  });
});

describe("a box's rows", () => {
  it("sorts the copies into five rows, each in checklist order, and the rest into the unsorted strip", () => {
    const rows = boxRows(
      [
        copy(c2, { homeId: BOX, homeKind: "box", slot: 0 }),
        copy(c0, { homeId: BOX, homeKind: "box", slot: 0 }),
        copy(c1, { homeId: BOX, homeKind: "box", slot: 4 }),
        copy(c3, { homeId: BOX, homeKind: "box" }),
        copy(c4, { homeId: BOX, homeKind: "box", slot: 9 }),
      ],
      byId,
    );
    expect(rows.rows).toHaveLength(BOX_ROWS);
    expect(rows.rows[0].map((c) => c.cardId)).toEqual([c0.id, c2.id]);
    expect(rows.rows[4].map((c) => c.cardId)).toEqual([c1.id]);
    expect(rows.unsorted.map((c) => c.cardId)).toEqual([c3.id, c4.id]);
  });

  it("counts rows the way a collector does", () => {
    expect([0, 4].map(rowName)).toEqual(["Row 1", "Row 5"]);
  });
});

describe("where a card lives (the hunt tray)", () => {
  const inPocket = copy(c0, { slot: 12 });
  const inRow = copy(c0, { homeId: BOX, homeKind: "box", homeName: "Show box", slot: 1, quantity: 2 });
  const inRow2 = copy(c0, { homeId: BOX, homeKind: "box", homeName: "Show box", slot: 1 });
  const main = copy(c0, { homeId: "main", quantity: 2 });

  it("lists a pocket with its page and number, a row, and a plain home with its count", () => {
    const places = placesOf([main, inRow, inPocket], shelf);
    expect(places.map(placeWords)).toEqual(["Main ×2", "'96 Contenders, page 2, pocket 4", "Show box, row 2 ×2"]);
  });

  it("puts a box's lines in one row together", () => {
    const [place] = placesOf([inRow, inRow2], shelf);
    expect(place).toMatchObject({ box: true, row: 1, quantity: 3, copyIds: [inRow.id, inRow2.id] });
  });

  it("calls a box line in no row a plain place", () => {
    const [place] = placesOf([copy(c0, { homeId: BOX, homeKind: "box", homeName: "Show box" })], shelf);
    expect(placeWords(place)).toBe("Show box");
  });

  it("skips an emptied line", () => {
    expect(placesOf([copy(c0, { quantity: 0 })], shelf)).toEqual([]);
  });

  it("names a home the shelf has not loaded from the copy itself", () => {
    expect(placeWords(placesOf([copy(c0, { homeId: "x", homeName: "Slab case" })], [])[0])).toBe("Slab case");
  });

  it("offers only the copies not already in the destination to move, and the unflagged to trade", () => {
    expect(movableCopies([main, inRow], BOX)).toEqual([main]);
    expect(movableCopies([copy(c0, { quantity: 0 })], BOX)).toEqual([]);
    const flagged = copy(c0, { upForTrade: true });
    expect(tradeableCopies([flagged, main])).toEqual([main]);
  });

  it("finds the one copy a per-copy pocket holds", () => {
    expect(soleCopyId([main])).toBe(main.id);
    expect(soleCopyId([main, inRow])).toBeUndefined();
  });
});

describe("words", () => {
  it("labels a slab, and nothing for a raw copy", () => {
    expect(slabLabel({ graded: { grader: "PSA", grade: "9" } })).toBe("PSA 9");
    expect(slabLabel({})).toBeNull();
  });

  it("reads a pocket's name with its quantity, serial, sale and trade state", () => {
    const label = havePocketLabel(c0, [copy(c0, { serialNumber: "3/50", homeKind: "box", upForTrade: true })]);
    expect(label).toContain("serial 3/50");
    expect(label).toContain("for sale");
    expect(label).toContain("up for trade");
    expect(havePocketLabel(c0, [copy(c0, { quantity: 2 })])).toContain("2 copies");
    expect(havePocketLabel(c0, [copy(c0)])).not.toMatch(/for sale|trade/);
  });

  it("counts cards", () => {
    expect([1, 12, 1200].map(cardCount)).toEqual(["1 card", "12 cards", "1,200 cards"]);
  });

  it("writes the caption under a thumbnail: season, set, then the insert or parallel", () => {
    const base = demoCard(fixtureCards.find((c) => c.variantPath.type === "Base" && !c.variation)!.id)!;
    expect(cardCaption(base)).not.toMatch(/Base|#/);
    const gold = fixtureCards.find((c) => c.setId === "2024-topps-chrome-baseball" && c.variantPath.name === "Gold Refractor")!;
    expect(cardCaption(demoCard(gold.id)!)).toBe("2024 Topps Chrome Gold Refractor");
    expect(demoVariantId("x", { type: "Base", name: null })).toBe("x|Base|");
  });
});

describe("the smart binder's team rule", () => {
  it("defaults to the team on the card", () => {
    expect(teamRule("t1", false)).toEqual({ kind: "teamOnCard", teamId: "t1" });
  });

  it("opting in also counts anyone who played for them", () => {
    expect(teamRule("t1", true)).toEqual({
      kind: "or",
      rules: [
        { kind: "teamOnCard", teamId: "t1" },
        { kind: "playedFor", teamId: "t1" },
      ],
    });
  });
});

describe("share links (demo only)", () => {
  it("slugs a name into something a person can read", () => {
    expect(slugify("'96 Contenders")).toBe("96-contenders");
    expect(slugify("Score, minus the low numbers")).toBe("score-minus-the-low-numbers");
    expect(slugify("Café & Crème")).toBe("cafe-and-creme");
    expect(slugify("!!!")).toBe("binder");
  });

  it("gives the Want List its own path by role, not by name", () => {
    expect(containerShareTarget({ kind: "binder", system: "want", name: "Whatever" })).toEqual({ what: "your Want List", path: "want-list" });
  });

  it("puts a box under boxes and a binder under binders", () => {
    expect(containerShareTarget({ kind: "box", name: "Show box" }).path).toBe("boxes/show-box");
    expect(containerShareTarget({ kind: "binder", name: "Ohtani rainbow" }).path).toBe("binders/ohtani-rainbow");
    expect(shareUrl(containerShareTarget({ kind: "binder", name: "Ohtani rainbow" }))).toBe("neonbinder.io/@you/binders/ohtani-rainbow");
  });

  it("shares a set by its label", () => {
    expect(setShareTarget({ season: "2000", name: "Topps" }).path).toBe("sets/2000-topps");
  });
});

describe("Browse a set's filters", () => {
  const all = setsInOrder().map((s) => ({
    id: s.id,
    name: s.name,
    season: s.season,
    year: s.year,
    brand: { id: s.brandId, name: s.brandId },
    sport: { id: s.sportId, name: s.sportId },
  }));

  it("narrows by sport, by an inclusive year range either way round, and by every word of the name", () => {
    expect(filterSets(all, NO_BROWSE_FILTER)).toHaveLength(all.length);
    expect(filterSets(all, { ...NO_BROWSE_FILTER, sport: "hockey" }).every((x) => x.sport.id === "hockey")).toBe(true);
    const range = filterSets(all, { ...NO_BROWSE_FILTER, from: 2000, to: 1996 });
    expect(range.length).toBeGreaterThan(0);
    expect(range.every((x) => x.year >= 1996 && x.year <= 2000)).toBe(true);
    expect(filterSets(all, { ...NO_BROWSE_FILTER, q: "96 playoff" }).map((x) => x.name)).toEqual(["Playoff Contenders"]);
    expect(filterSets(all, { ...NO_BROWSE_FILTER, q: "zzz" })).toEqual([]);
  });

  it("knows when it is filtering", () => {
    expect(isFiltering(NO_BROWSE_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_BROWSE_FILTER, q: " " })).toBe(false);
    expect(isFiltering({ ...NO_BROWSE_FILTER, to: 2000 })).toBe(true);
  });

  it("lists each sport once, in shelf order", () => {
    const sports = sportsOf(all);
    expect(new Set(sports.map((s) => s.id)).size).toBe(sports.length);
  });
});
