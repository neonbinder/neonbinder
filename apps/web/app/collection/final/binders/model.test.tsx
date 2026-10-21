import { describe, expect, it } from "vitest";
import {
  cards,
  evaluateRule,
  setsInOrder,
  getCard,
  searchCards,
  type Copy,
  type ManualBinder,
  type SearchHit,
} from "../../prototypes/_shared/data";
import { cardCaption } from "../captions";
import {
  initialCollectionState,
  MAIN_BINDER_ID,
  NO_BROWSE_FILTER,
  TRADE_BINDER_ID,
  WANT_BINDER_ID,
} from "../store";
import {
  binderTally,
  buildBinderPages,
  cardsOnPages,
  EXTRAS,
  extrasStart,
  filterSets,
  followedChecklist,
  guardPocket,
  isFiltering,
  liveryOf,
  movableCopies,
  placesOf,
  placeWords,
  pocketFor,
  resolveTyped,
  shareLink,
  slugify,
  teamRule,
  wantPages,
  wantSection,
} from "./model";

const hit = (cardId: string, matchedAll = true): SearchHit => ({
  card: getCard(cardId),
  score: 1,
  matchedAll,
});

describe("resolveTyped: Enter acts only on exactly one match", () => {
  it("acts on the one card that fits every word", () => {
    const only = cards[0];
    expect(resolveTyped([hit(only.id)])).toEqual({ kind: "one", card: only });
  });

  it("asks when two cards fit, never taking the first", () => {
    expect(resolveTyped([hit(cards[0].id), hit(cards[1].id)])).toEqual({ kind: "many", count: 2 });
  });

  it("does nothing on closest calls that miss a word", () => {
    expect(resolveTyped([hit(cards[0].id, false)])).toEqual({ kind: "none" });
    expect(resolveTyped([])).toEqual({ kind: "none" });
  });

  it("a bare card number is ambiguous in the catalog", () => {
    // #1 exists in many sets and parallels: a number alone never resolves.
    const typed = resolveTyped(searchCards("1"));
    expect(typed.kind).toBe("many");
  });
});

describe("share links", () => {
  it("slugs a binder name into something a person can read", () => {
    expect(slugify("'96 Contenders")).toBe("96-contenders");
    expect(slugify("Ohtani rainbow")).toBe("ohtani-rainbow");
    expect(slugify("Score, minus the low numbers")).toBe("score-minus-the-low-numbers");
    expect(slugify("Café & Crème")).toBe("cafe-and-creme");
    expect(slugify("!!!")).toBe("binder");
  });

  it("gives the Want List its own path, by role not by name", () => {
    const state = initialCollectionState();
    const want = state.binders.find((b) => b.id === WANT_BINDER_ID)!;
    expect(shareLink(want)).toBe("neonbinder.io/@jason/want-list");
    expect(shareLink({ ...want, name: "Renamed somehow" })).toBe("neonbinder.io/@jason/want-list");
    const ohtani = state.binders.find((b) => b.name === "Ohtani rainbow")!;
    expect(shareLink(ohtani)).toBe("neonbinder.io/@jason/binders/ohtani-rainbow");
  });
});

describe("the smart binder's team rule", () => {
  const team = getCard(cards[0].id).teamIds[0];

  it("defaults to the team on the card", () => {
    expect(teamRule(team, false)).toEqual({ kind: "teamOnCard", teamId: team });
  });

  it("opting in also counts anyone who played for them", () => {
    const rule = teamRule(team, true);
    expect(rule).toEqual({
      kind: "or",
      rules: [
        { kind: "teamOnCard", teamId: team },
        { kind: "playedFor", teamId: team },
      ],
    });
    // Widening never drops a card the narrow rule held.
    const narrow = cards.filter((c) => evaluateRule(teamRule(team, false), c));
    expect(narrow.every((c) => evaluateRule(rule, c))).toBe(true);
  });

  it("keeps the team's colours on the spine either way", () => {
    const base = { id: "x", kind: "smart" as const, name: "X" };
    expect(liveryOf({ ...base, rule: teamRule(team, true) })).toEqual(
      liveryOf({ ...base, rule: teamRule(team, false) }),
    );
  });
});

describe("the special shelf's colours", () => {
  it("come from the binder's role, not its name", () => {
    const state = initialCollectionState();
    const of = (id: string) => liveryOf(state.binders.find((b) => b.id === id)!);
    expect(of(WANT_BINDER_ID).secondary).toBe("#FF2E9A");
    expect(of(TRADE_BINDER_ID).secondary).toBe("#FFE600");
    expect(of(MAIN_BINDER_ID).secondary).toBe("#00D558");
  });
});

describe("the Want List, opened", () => {
  const state = initialCollectionState();
  const nameOf = (id: string) => state.binders.find((b) => b.id === id)?.name;
  const [a, b, c] = cards.filter((x) => !state.copies.some((cp) => cp.cardId === x.id));

  it("starts each group on a fresh page, unscoped first, owned wants in their sleeve", () => {
    const owned = state.copies[0];
    const groups = [
      { binderId: null, cards: [a, getCard(owned.cardId)] },
      { binderId: MAIN_BINDER_ID, cards: [b, c] },
    ];
    const pages = wantPages(groups, state.copies, nameOf);
    expect(pages).toHaveLength(2);
    expect(pages[0].section).toBe("Just want it");
    expect(pages[1].section).toBe(`For ${nameOf(MAIN_BINDER_ID)}`);
    expect(pages[0].pockets.map((p) => p.content.kind)).toEqual([
      "need",
      "have",
      ...Array(7).fill("empty"),
    ]);
    expect(cardsOnPages(pages)).toEqual([a.id, owned.cardId, b.id, c.id]);
  });

  it("names a group whose binder is gone without crashing", () => {
    expect(wantSection("binder-gone", () => undefined)).toBe("For a binder");
  });
});

describe("a checklist binder keeps its numbers when a second copy goes in", () => {
  const CONTENDERS = "binder-contenders-96";
  const state = initialCollectionState();
  const binder = state.binders.find((b) => b.id === CONTENDERS) as ManualBinder;
  const list = followedChecklist(binder, state.copies)!;

  /** File one more copy of `card` where pocketFor sends it. */
  function slotAnother(cardId: string) {
    const card = getCard(cardId);
    const at = pocketFor(binder, card, state.copies);
    const copy: Copy = { ...state.copies[0], id: "extra-copy", cardId, quantity: 1, binderIds: [CONTENDERS] };
    const layout = (binder.layout ?? []).map((p) => ({ slots: [...p.slots] }));
    while (layout.length <= at.page) layout.push({ slots: Array(9).fill(null) });
    layout[at.page].slots[at.slot] = copy.id;
    return { at, binder: { ...binder, layout }, copies: [...state.copies, copy] };
  }

  it("follows the set before anything is added", () => {
    expect(list).not.toBeNull();
    expect(binderTally(binder, state.copies)).toMatchObject({ have: 24, need: 16 });
  });

  it("sends a duplicate to the first Extras page, never a numbered pocket", () => {
    const owned = list[0];
    const { at, binder: after, copies } = slotAnother(owned.id);
    expect(at.page * 9 + at.slot).toBe(extrasStart(list));
    expect(followedChecklist(after, copies)).toEqual(list);
    const tally = binderTally(after, copies);
    expect(tally).toMatchObject({ have: 24, need: 16 });
    expect(tally.cards).toBe(binderTally(binder, state.copies).cards + 1);

    const pages = buildBinderPages({
      view: { kind: "binder", binderId: CONTENDERS },
      mode: "pockets",
      copies,
      binders: state.binders.map((b) => (b.id === CONTENDERS ? after : b)),
      sort: "checklist",
      filters: { graded: false, forSale: false, rookies: false },
    });
    expect(pages[at.page].section).toBe(EXTRAS);
    expect(pages[0].section).toBe("Base");
    const needs = pages.flatMap((p) => p.pockets).filter((p) => p.content.kind === "need");
    expect(needs).toHaveLength(16);
  });

  it("a card dropped on another card's numbered pocket goes to its own spot", () => {
    const needIndex = list.findIndex((c) => !state.copies.some((cp) => cp.cardId === c.id));
    const stranger = list[0];
    const aimed = { binderId: CONTENDERS, page: Math.floor(needIndex / 9), slot: needIndex % 9 };
    const { slot, savedFor } = guardPocket(binder, aimed, stranger, state.copies);
    expect(savedFor?.id).toBe(list[needIndex].id);
    expect(slot.page * 9 + slot.slot).toBe(extrasStart(list));
    // The card that pocket is saved for goes straight in.
    expect(guardPocket(binder, aimed, list[needIndex], state.copies)).toEqual({ slot: aimed, savedFor: null });
  });
});

describe("the caption under a thumbnail", () => {
  it("reads season, set, then the insert or parallel; base says just the set", () => {
    const base = cards.find((c) => c.variantPath.type === "Base" && !c.variation)!;
    expect(cardCaption(base)).not.toMatch(/Base|#/);
    const parallel = cards.find((c) => c.variantPath.type === "Parallels" && c.variantPath.name)!;
    expect(cardCaption(parallel).endsWith(parallel.variantPath.name!)).toBe(true);
    const gold = cards.find(
      (c) => c.setId === "2024-topps-chrome-baseball" && c.variantPath.name === "Gold Refractor",
    )!;
    expect(cardCaption(gold)).toBe("2024 Topps Chrome Gold Refractor");
  });
});

describe("where a card lives (the hunt tray)", () => {
  const s = initialCollectionState();
  // #4 Reggie White, '96 Contenders: one in its pocket, one PSA 9 in the slab case.
  const reggie = s.copies.find((c) => c.binderIds.includes("binder-slab-case") && c.graded?.grade === "9")!.cardId;

  it("lists a pocket with its page and number, and a binder without pages by name", () => {
    expect(placesOf(reggie, s.copies, s.binders).map(placeWords)).toEqual([
      "'96 Contenders, page 1, pocket 4",
      "Slab case",
    ]);
  });

  it("counts a stack in one binder as one place", () => {
    const yzerman = s.copies.find((c) => c.quantity === 3)!;
    const places = placesOf(yzerman.cardId, s.copies, s.binders);
    expect(places.map(placeWords)).toContain("Up for Trade ×3");
  });

  it("offers only the copies not already in the binder to move", () => {
    expect(movableCopies(reggie, s.copies, "binder-slab-case").map((c) => c.binderIds)).toEqual([
      ["binder-contenders-96"],
    ]);
    expect(movableCopies(reggie, s.copies, MAIN_BINDER_ID)).toHaveLength(2);
  });
});

describe("Browse a set's filters", () => {
  const all = setsInOrder();

  it("narrows by sport, by an inclusive year range either way round, and by every word of the name", () => {
    expect(filterSets(all, NO_BROWSE_FILTER)).toHaveLength(all.length);
    expect(filterSets(all, { ...NO_BROWSE_FILTER, sport: "hockey" }).every((x) => x.sportId === "hockey")).toBe(true);
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
});
