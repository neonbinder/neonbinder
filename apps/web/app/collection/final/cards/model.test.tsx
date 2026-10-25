import { describe, expect, it } from "vitest";
import { emptyCopyDetails } from "../data/store";
import type { Card, Copy } from "../data/types";
import { blockedMessage, pickFirstLabel, rangeSelection, runPlan, tilePress, wallName, wantedFirst } from "./model";
import { parseRange } from "./range";

const SET = {
  id: "set-chrome",
  name: "Topps Chrome",
  season: "2024",
  year: 2024,
  brand: { id: "brand-topps", name: "Topps" },
  sport: { id: "baseball", name: "Baseball" },
};
const BASE = {
  id: "v-base",
  kind: "base" as const,
  name: null,
  insertName: null,
  printRun: null,
  order: 0,
  path: { typeId: "t-base", variantId: null, subVariantId: null },
  finish: { kind: "standard" as const },
};

function card(n: number | string, variation: string | null = null): Card {
  const id = `card-${n}${variation ? `-${variation.toLowerCase()}` : ""}`;
  return {
    id,
    set: SET,
    variant: BASE,
    cardNumber: String(n),
    players: [{ id: `p-${n}`, name: `Player ${n}` }],
    teams: [],
    printRun: null,
    features: [],
    cardVariation: variation,
    isVariation: variation !== null,
    sortOrder: Number.parseInt(String(n), 10),
    finish: BASE.finish,
  };
}

/** A base row where #13 is on two cards: the regular one and its Sliding image variation. */
const ROW: Card[] = [card(1), card(2), card(3), card(4), card(5), card(13), card(13, "Sliding"), card(14)];

function copy(id: string, cardId: string, quantity: number): Copy {
  return { ...emptyCopyDetails(), id, cardId, quantity, variantId: BASE.id, setId: SET.id, homeId: "main", homeKind: "binder", upForTrade: false };
}

/** A number two cards share in one row (the regular card and its image variation). */
function sharedNumber(): { row: Card[]; number: string } {
  return { row: ROW, number: "13" };
}

describe("tilePress", () => {
  it("adds when nothing is in scope", () => {
    expect(tilePress([])).toEqual({ kind: "add" });
  });

  it("removes the one line item when it holds exactly one card", () => {
    const only = copy("a", "card", 1);
    expect(tilePress([only])).toEqual({ kind: "remove", copy: only });
  });

  it("never removes several line items at once: it asks", () => {
    expect(tilePress([copy("a", "card", 1), copy("b", "card", 1)])).toEqual({ kind: "pick", owned: 2 });
  });

  it("never removes a stack of five in one press: it asks", () => {
    expect(tilePress([copy("a", "card", 5)])).toEqual({ kind: "pick", owned: 5 });
  });
});

describe("rangeSelection", () => {
  it("adds nothing for a shared number until the collector picks", () => {
    const { row, number } = sharedNumber();
    const range = parseRange(number, row);
    expect(range.shared).toHaveLength(1);
    const none = rangeSelection(range, new Set());
    expect(none.cards).toEqual([]);
    expect(none.unanswered.map((s) => s.number)).toEqual([number]);
  });

  it("adds only the card picked for a shared number, and every single", () => {
    const { row, number } = sharedNumber();
    const range = parseRange(`1-3, ${number}`, row);
    const pickedCard = range.shared[0].cards[1];
    const out = rangeSelection(range, new Set([pickedCard.id]));
    expect(out.unanswered).toEqual([]);
    expect(out.cards).toContain(pickedCard);
    expect(out.cards).not.toContain(range.shared[0].cards[0]);
    for (const c of range.single) expect(out.cards).toContain(c);
  });

  it("is empty with no range", () => {
    expect(rangeSelection(null, new Set())).toEqual({ cards: [], unanswered: [] });
  });
});

describe("runPlan (stop and ask)", () => {
  const none = () => false;

  it("holds the whole run, singles too, while a shared number is unanswered", () => {
    const { row, number } = sharedNumber();
    const plan = runPlan(parseRange(`1-3, ${number}`, row), new Set(), none);
    expect(plan.blocked).toBe(true);
    expect(plan.unanswered.map((s) => s.number)).toEqual([number]);
    expect(pickFirstLabel(plan)).toBe(`Pick your #${number} first`);
    expect(blockedMessage(plan)).toBe(
      `One number is on more than one card. Pick yours below and the run goes in. Got neither? Add -${number} to leave it out.`,
    );
  });

  it("lets the run go once the shared number is picked", () => {
    const { row, number } = sharedNumber();
    const range = parseRange(`1-3, ${number}`, row);
    const pick = range.shared[0].cards[0];
    const plan = runPlan(range, new Set([pick.id]), none);
    expect(plan.blocked).toBe(false);
    expect(pickFirstLabel(plan)).toBeNull();
    expect(blockedMessage(plan)).toBeNull();
    expect(plan.toAdd).toContain(pick);
    expect(plan.toAdd).toHaveLength(range.single.length + 1);
  });

  it("lets the run go once the shared number is taken out with -N", () => {
    const { row, number } = sharedNumber();
    const plan = runPlan(parseRange(`1-3, ${number}, -${number}`, row), new Set(), none);
    expect(plan.blocked).toBe(false);
    expect(plan.toAdd.some((c) => c.cardNumber === number)).toBe(false);
  });

  it("counts owned cards as already had, not to add", () => {
    const range = parseRange("1-3", ROW);
    const owned = new Set([range.single[0].id]);
    const plan = runPlan(range, new Set(), (id) => owned.has(id));
    expect(plan.already).toBe(1);
    expect(plan.toAdd).toHaveLength(range.single.length - 1);
  });
});

describe("wantedFirst", () => {
  it("puts wanted cards first and keeps checklist order in each half", () => {
    const row = ROW.slice(0, 5);
    const wanted = new Set([row[3].id, row[1].id]);
    const out = wantedFirst(row, (id) => wanted.has(id));
    expect(out.map((c) => c.id)).toEqual([row[1], row[3], row[0], row[2], row[4]].map((c) => c.id));
  });
});

describe("wallName", () => {
  it("names the checklist, the number, a variation and the player", () => {
    expect(wallName(card(4), "Reggie White")).toBe("Base #4 Reggie White");
    expect(wallName(card(13, "Sliding"), "Elly De La Cruz")).toBe("Base #13 (Sliding) Elly De La Cruz");
    expect(wallName(card(7), "")).toBe("Base #7");
  });
});

describe("parseRange (moved to final/cards/range)", () => {
  it("never guesses a shared number: both cards come back to ask about", () => {
    const range = parseRange("12-14", ROW);
    expect(range.single.map((c) => c.cardNumber)).toEqual(["14"]);
    expect(range.shared).toEqual([{ number: "13", cards: [ROW[5], ROW[6]] }]);
    expect(range.unknown).toEqual([]);
  });

  it("reports what is not on the checklist, and refuses text it cannot read", () => {
    expect(parseRange("1, 99", ROW).unknown).toEqual(["99"]);
    expect(parseRange("zzz", ROW).invalid).toBe(true);
  });
});
