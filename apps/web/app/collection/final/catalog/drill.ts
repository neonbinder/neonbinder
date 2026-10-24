/**
 * NEO-358 — the Checklists drill as ids: sport → year → brand → set →
 * variant type → insert or parallel → a parallel under an insert. Copied out
 * of `prototypes/p1/drill.ts` (which stays, for the prototypes) and rewritten
 * over the store's `useDrill`: every step is an opaque id the store handed
 * out (a Convex id for real, a fixture slug in the demo), never a display
 * name, and nothing here knows which store is behind it.
 */

import type { Card, DrillItem, DrillLevel, DrillParents } from "../data/types";

export interface Drill {
  sport: string | null;
  year: string | null;
  brand: string | null;
  set: string | null;
  /** The variant type row (Base, Inserts, Parallels…). */
  type: string | null;
  /** An insert or parallel under the type. */
  variant: string | null;
  /** A parallel under an insert. */
  sub: string | null;
}

export type DrillStep = keyof Drill;

export const DRILL_STEPS: readonly DrillStep[] = ["sport", "year", "brand", "set", "type", "variant", "sub"];

export const EMPTY_DRILL: Drill = {
  sport: null,
  year: null,
  brand: null,
  set: null,
  type: null,
  variant: null,
  sub: null,
};

/** The store's column for each step. */
export const LEVEL_OF: Record<DrillStep, DrillLevel> = {
  sport: "sport",
  year: "year",
  brand: "brand",
  set: "set",
  type: "variantType",
  variant: "variant",
  sub: "subVariant",
};

/** Pick a row at one step: every deeper step clears. */
export function pick(drill: Drill, step: DrillStep, id: string): Drill {
  const next: Drill = { ...drill, [step]: id };
  for (const s of DRILL_STEPS.slice(DRILL_STEPS.indexOf(step) + 1)) next[s] = null;
  return next;
}

/** The drill cut off just above `step` (that step and everything under it cleared). */
export function cutAt(drill: Drill, step: DrillStep): Drill {
  const next: Drill = { ...drill };
  for (const s of DRILL_STEPS.slice(DRILL_STEPS.indexOf(step))) next[s] = null;
  return next;
}

/** The ids picked above `step`, as the store's `useDrill` takes them. */
export function parentsFor(drill: Drill, step: DrillStep): DrillParents {
  const out: DrillParents = {};
  for (const s of DRILL_STEPS.slice(0, DRILL_STEPS.indexOf(step))) {
    const id = drill[s];
    if (id !== null) out[LEVEL_OF[s]] = id;
  }
  return out;
}

/**
 * The drill that opens a card's own checklist. Only the set and below: the
 * set fixes its sport, year and brand, which the page reads back from the
 * set's path.
 */
export function drillToCard(card: Pick<Card, "set" | "variant">): Drill {
  const { typeId, variantId, subVariantId } = card.variant.path;
  return { ...EMPTY_DRILL, set: card.set.id, type: typeId, variant: variantId, sub: subVariantId };
}

/** The deepest picked row that opens a checklist, or null while the drill is above one. */
export function checklistItem(picked: (DrillItem | undefined)[]): DrillItem | null {
  for (let i = picked.length - 1; i >= 0; i--) {
    const item = picked[i];
    if (item?.variantId) return item;
  }
  return null;
}
