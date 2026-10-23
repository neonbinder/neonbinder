import type { Completion } from "../data/types";

/**
 * NEO-358 — how a checklist's progress reads. The base pair (cards without an
 * image variation) is what every view shows by default.
 *
 * A checklist whose size the catalog has not counted yet comes through with
 * a total of 0: say what is owned ("3 owned") and never "3 of 0" or a
 * percentage of nothing.
 */
export function totalKnown(c: Pick<Completion, "total">): boolean {
  return c.total > 0;
}

/** "Have 3 of 51" or, with no known total, "3 owned". */
export function haveLine(c: Pick<Completion, "owned" | "total">): string {
  return totalKnown(c) ? `Have ${c.owned} of ${c.total}` : `${c.owned} owned`;
}

/** "3/51" or "3 owned": the short form beside a strip. */
export function haveShort(c: Pick<Completion, "owned" | "total">): string {
  return totalKnown(c) ? `${c.owned}/${c.total}` : `${c.owned} owned`;
}

export function isComplete(c: Pick<Completion, "owned" | "total">): boolean {
  return c.total > 0 && c.owned >= c.total;
}

/** "1 card" / "51 cards". */
export function cardsCount(n: number): string {
  return `${n} ${n === 1 ? "card" : "cards"}`;
}
