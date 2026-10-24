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

/**
 * NEO-358 — a checklist's count line, base first so it agrees with "Have 2 of
 * 300" above it (Jason, 2026-10-23): "300 cards", and under it "335 with
 * variations" when the checklist lists image variations too. A filter or a
 * search counts the rows it kept against each total, the same two ways:
 * "2 of 300 cards" / "3 of 335 with variations". With no variations there is
 * no second line.
 *
 * `shown*` are the rows on screen; `base` / `all` the whole checklist. The
 * line reads unfiltered whenever every row is showing.
 */
export function checklistCount({
  shownBase,
  shownAll,
  base,
  all,
}: {
  shownBase: number;
  shownAll: number;
  base: number;
  all: number;
}): { base: string; withVariations: string | null } {
  const filtered = shownAll !== all;
  return {
    base: filtered ? `${shownBase} of ${cardsCount(base)}` : cardsCount(base),
    withVariations: all > base ? (filtered ? `${shownAll} of ${all} with variations` : `${all} with variations`) : null,
  };
}
