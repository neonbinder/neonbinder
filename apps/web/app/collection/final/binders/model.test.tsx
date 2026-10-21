import { describe, expect, it } from "vitest";
import { cards, evaluateRule, getCard, searchCards, type SearchHit } from "../../prototypes/_shared/data";
import { initialCollectionState, MAIN_BINDER_ID, TRADE_BINDER_ID, WANT_BINDER_ID } from "../store";
import {
  cardsOnPages,
  liveryOf,
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
