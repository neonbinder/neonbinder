/**
 * NEO-358 — what the operator reads when a catalog delete is held back because
 * collectors own the card. Pure, so the Convex guards (`convex/cardRowDelete.ts`,
 * `convex/parallelChecklistBuild.ts`) and the checklist's commit banner
 * (`components/SetSelector/CardChecklist.tsx`) say it the same way.
 *
 * The count is of COLLECTORS (distinct owners), read with a bound
 * (`countCollectors` in convex/cardRowDelete.ts). `atLeast` marks a floor:
 * the read stopped before it had seen every copy, so "20+".
 */

export interface CollectorCount {
  /** Distinct collectors seen. */
  collectors: number;
  /** True when there may be more than `collectors` (the read was bounded). */
  atLeast: boolean;
}

/**
 * "a collector", "3 collectors", "20+ collectors", and whether the verb that
 * follows is singular. One (or a floor of one) reads "a collector", which is
 * true however many more there are.
 */
function who(count: CollectorCount): { text: string; one: boolean } {
  if (count.collectors <= 1) return { text: "a collector", one: true };
  return { text: `${count.collectors.toLocaleString("en-US")}${count.atLeast ? "+" : ""} collectors`, one: false };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `deleteCard`'s refusal: "Hold up! 3 collectors have this card, so it stays in the catalog." */
export function collectedCardRefusal(count: CollectorCount): string {
  const w = who(count);
  return `Hold up! ${capitalised(w.text)} ${w.one ? "has" : "have"} this card, so it stays in the catalog.`;
}

/**
 * Why a parallel rebuild is blocked, after "Gold — blocked: ":
 * "3 collectors own copies of its cards, and a rebuild would pull those cards
 * out from under them".
 */
export function blockedCollectedReason(count: CollectorCount): string {
  const w = who(count);
  return `${w.text} ${w.one ? "owns" : "own"} copies of its cards, and a rebuild would pull those cards out from under them`;
}

/**
 * The checklist commit banner's note for operator deletes it kept:
 * "Kept 2 cards: 5 collectors have them, so they stay in the catalog."
 */
export function keptCollectedNote(cards: number, count: CollectorCount): string {
  const w = who(count);
  const verb = w.one ? "has" : "have";
  return cards === 1
    ? `Kept 1 card: ${w.text} ${verb} it, so it stays in the catalog.`
    : `Kept ${cards.toLocaleString("en-US")} cards: ${w.text} ${verb} them, so they stay in the catalog.`;
}

/**
 * Two counts of possibly overlapping collectors, as one honest floor: the
 * larger, marked `atLeast` because the other may name collectors it does not.
 * Used where pages are counted apart (the checklist commit's finalize pages).
 */
export function mergeCollectorCounts(a: CollectorCount | null, b: CollectorCount): CollectorCount {
  if (!a) return b;
  return { collectors: Math.max(a.collectors, b.collectors), atLeast: true };
}
