import { describe, expect, it } from "vitest";
import { cardsInSet, emptyCopyDetails, type Card, type Copy } from "../../prototypes/_shared/data";
import { parseRange } from "../../prototypes/p1/range";
import { blockedMessage, pickFirstLabel, rangeSelection, runPlan, tilePress, wantedFirst } from "./model";

const CHROME = "2024-topps-chrome-baseball";

function copy(id: string, cardId: string, quantity: number): Copy {
  return { ...emptyCopyDetails(), id, cardId, quantity, binderIds: ["binder-main"] };
}

/** A number two cards share in one row (the regular card and its image variation). */
function sharedNumber(): { row: Card[]; number: string } {
  const row = cardsInSet(CHROME, { type: "Base" });
  const counts = new Map<string, number>();
  for (const c of row) counts.set(c.cardNumber, (counts.get(c.cardNumber) ?? 0) + 1);
  const number = [...counts].find(([, n]) => n > 1)?.[0];
  if (!number) throw new Error("fixture: expected a shared card number in the Chrome base row");
  return { row, number };
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
    const row = cardsInSet(CHROME, { type: "Base" });
    const range = parseRange("1-3", row);
    const owned = new Set([range.single[0].id]);
    const plan = runPlan(range, new Set(), (id) => owned.has(id));
    expect(plan.already).toBe(1);
    expect(plan.toAdd).toHaveLength(range.single.length - 1);
  });
});

describe("wantedFirst", () => {
  it("puts wanted cards first and keeps checklist order in each half", () => {
    const row = cardsInSet(CHROME, { type: "Base" }).slice(0, 5);
    const wanted = new Set([row[3].id, row[1].id]);
    const out = wantedFirst(row, (id) => wanted.has(id));
    expect(out.map((c) => c.id)).toEqual([row[1], row[3], row[0], row[2], row[4]].map((c) => c.id));
  });
});
