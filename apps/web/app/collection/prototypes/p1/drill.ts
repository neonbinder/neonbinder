/**
 * The cascade for prototype 1: Sport → Year → Brand → Set → Variant type →
 * insert or parallel, read off the fake catalog the way the admin Set
 * Builder reads selectorOptions. Every step is keyed by an id; display names
 * only label rows.
 */

import {
  cardsInSet,
  getBrand,
  setsInOrder,
  sports,
  type BrandId,
  type CardSet,
  type Completion,
  type SetId,
  type SportId,
  type VariantFilter,
  type VariantType,
} from "../_shared/data";

export interface Drill {
  sport: SportId | null;
  year: number | null;
  brand: BrandId | null;
  set: SetId | null;
  variantType: VariantType | null;
  /** Insert or parallel name; only set under Inserts / Parallels. */
  variant: string | null;
}

export const EMPTY_DRILL: Drill = {
  sport: null,
  year: null,
  brand: null,
  set: null,
  variantType: null,
  variant: null,
};

export type Level = "sport" | "year" | "brand" | "set" | "variantType" | "variant";
export const LEVELS: Level[] = ["sport", "year", "brand", "set", "variantType", "variant"];

export interface ColumnItem {
  id: string;
  name: string;
  description?: string;
}

const allSets = (): CardSet[] => setsInOrder();

export function sportItems(): ColumnItem[] {
  const used = new Set(allSets().map((s) => s.sportId));
  return sports.filter((s) => used.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
}

export function yearItems(sport: SportId): ColumnItem[] {
  const seen = new Map<number, string>();
  for (const s of allSets()) if (s.sportId === sport) seen.set(s.year, s.season);
  return [...seen].map(([year, season]) => ({ id: String(year), name: season }));
}

export function brandItems(sport: SportId, year: number): ColumnItem[] {
  const seen = new Set<BrandId>();
  for (const s of allSets()) if (s.sportId === sport && s.year === year) seen.add(s.brandId);
  return [...seen].map((id) => ({ id, name: getBrand(id).name }));
}

export function setItems(
  sport: SportId,
  year: number,
  brand: BrandId,
  completion: (setId: SetId, v?: VariantFilter) => Completion,
): ColumnItem[] {
  return allSets()
    .filter((s) => s.sportId === sport && s.year === year && s.brandId === brand)
    .map((s) => {
      const c = completion(s.id, { type: "Base" });
      return {
        id: s.id,
        name: s.name,
        description: c.owned > 0 ? `Have ${c.owned} of ${c.total} base` : `${c.total} base cards`,
      };
    });
}

export function variantTypeItems(set: CardSet): ColumnItem[] {
  const out: ColumnItem[] = [];
  for (const type of ["Base", "Inserts", "Parallels"] as VariantType[]) {
    const variants = set.variants.filter((v) => v.path.type === type);
    if (variants.length === 0) continue;
    const description =
      type === "Base"
        ? `${cardsInSet(set.id, { type: "Base" }).length} cards`
        : `${variants.length} ${variants.length === 1 ? type.slice(0, -1).toLowerCase() : type.toLowerCase()}`;
    out.push({ id: type, name: type, description });
  }
  return out;
}

export function variantItems(
  set: CardSet,
  type: VariantType,
  completion: (setId: SetId, v?: VariantFilter) => Completion,
): ColumnItem[] {
  return set.variants
    .filter((v) => v.path.type === type && v.path.name)
    .map((v) => {
      const name = v.path.name!;
      const c = completion(set.id, { type, name });
      const run = v.printRun === null ? null : v.printRun === 1 ? "1/1" : `/${v.printRun}`;
      const have = c.owned > 0 ? `have ${c.owned} of ${c.total}` : `${c.total} cards`;
      return { id: name, name, description: run ? `${run} · ${have}` : capitalise(have) };
    });
}

function capitalise(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

/** The checklist the drill points at, or null while it is still above one. */
export function terminalFilter(drill: Drill): VariantFilter | null {
  if (!drill.set || !drill.variantType) return null;
  if (drill.variantType === "Base") return { type: "Base", name: null };
  if (!drill.variant) return null;
  return { type: drill.variantType, name: drill.variant };
}

/** Pick a value at one level: deeper levels clear. */
export function pick(drill: Drill, level: Level, id: string): Drill {
  const next: Drill = { ...drill };
  const index = LEVELS.indexOf(level);
  for (const l of LEVELS.slice(index + 1)) (next as Record<Level, unknown>)[l] = null;
  switch (level) {
    case "sport":
      next.sport = id as SportId;
      break;
    case "year":
      next.year = Number(id);
      break;
    case "brand":
      next.brand = id;
      break;
    case "set":
      next.set = id;
      break;
    case "variantType":
      next.variantType = id as VariantType;
      break;
    case "variant":
      next.variant = id;
      break;
  }
  return next;
}

/** A drill pointing straight at one card's checklist (search → "Open checklist"). */
export function drillTo(set: CardSet, filter: VariantFilter): Drill {
  return {
    sport: set.sportId,
    year: set.year,
    brand: set.brandId,
    set: set.id,
    variantType: filter.type,
    variant: filter.type === "Base" ? null : (filter.name ?? null),
  };
}
