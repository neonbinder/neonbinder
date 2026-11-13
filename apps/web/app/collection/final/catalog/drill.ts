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

/**
 * NEO-527 — a pick in the brand column. A brand row picks the brand. A set
 * listed there in place of the year's brand-unknown row (it carries that
 * row's id as `brandId`; the row itself is never shown) picks that brand and
 * the set at once, so the drill goes straight on to the set's variant types.
 */
export function pickInBrandColumn(drill: Drill, item: Pick<DrillItem, "id" | "brandId">): Drill {
  if (!item.brandId) return pick(drill, "brand", item.id);
  return { ...pick(drill, "brand", item.brandId), set: item.id };
}

/**
 * NEO-527 — the brand column's item that reads as picked: the brand row
 * itself, or, when the drill stands on the brand-unknown row, the set listed
 * in its place. Undefined when the column holds neither.
 */
export function brandColumnPick(
  items: readonly DrillItem[],
  brand: string | null,
  set: string | null,
): DrillItem | undefined {
  if (brand === null) return undefined;
  const row = items.find((i) => !i.brandId && i.id === brand);
  if (row) return row;
  return set === null ? undefined : items.find((i) => i.brandId === brand && i.id === set);
}

/** What the brand column is called (`brandColumnTitle`). */
export type BrandColumnTitle = "Brands" | "Sets" | "Brands and sets";

/**
 * NEO-527 — what the brand column is called, truthfully: "Brands" when it
 * holds only brand rows (or nothing), "Sets" when every row is a set listed
 * in place of the brand-unknown row, "Brands and sets" when it holds both.
 * Still loading, it could be any of them: "Brands and sets".
 */
export function brandColumnTitle(items: readonly DrillItem[] | undefined): BrandColumnTitle {
  if (items === undefined) return "Brands and sets";
  const loose = items.filter((i) => i.brandId).length;
  if (loose === 0) return "Brands";
  return loose === items.length ? "Sets" : "Brands and sets";
}

/**
 * NEO-527 — the brand column's form-field label, singular, by the same rule
 * as its title: "Brand", "Set" or "Brand or set".
 */
export function brandFieldLabel(items: readonly DrillItem[] | undefined): "Brand" | "Set" | "Brand or set" {
  const title = brandColumnTitle(items);
  return title === "Brands" ? "Brand" : title === "Sets" ? "Set" : "Brand or set";
}

/**
 * NEO-527 — what a picked row in the brand column is, for its summary card
 * ("Sets: Pacific Legends, change"): a set listed there is a set, never a
 * brand, whatever else the column holds.
 */
export function brandColumnPickTitle(item: Pick<DrillItem, "brandId">): "Brands" | "Sets" {
  return item.brandId ? "Sets" : "Brands";
}

/** NEO-527 — the quiet label over the loose sets that follow the brands. Never "Unknown". */
export const LOOSE_SETS_LABEL = "More sets";

/**
 * NEO-527 — majors first: the brand column split into its `main` rows (the
 * brand rows) and the `more` rows that follow them under `LOOSE_SETS_LABEL`
 * (the sets listed in place of the brand-unknown row), each keeping its
 * order. A column with no brand row is all `main`: a "Sets" column needs no
 * divider.
 */
export function splitBrandColumn<T extends Pick<DrillItem, "brandId">>(
  items: readonly T[],
): { main: T[]; more: T[] } {
  const brands = items.filter((i) => !i.brandId);
  if (brands.length === 0) return { main: [...items], more: [] };
  return { main: brands, more: items.filter((i) => i.brandId) };
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
