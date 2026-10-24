import { useDrill, useSetPath } from "../data/store";
import type { DrillItem } from "../data/types";
import { checklistItem, cutAt, EMPTY_DRILL, parentsFor, type Drill, type DrillStep } from "./drill";

/**
 * NEO-358 — a drill read off the URL, checked against the catalog.
 *
 * The URL carries ids only. From a set down it names the set (`set`) and
 * what is under it; the set's own path (`useSetPath`) fills in the sport,
 * year and brand above. Each picked id is then checked against its column
 * (`useDrill`), top to bottom: an id its column does not hold stops the
 * drill there, quietly, at the deepest level that still makes sense. While
 * a column is still loading its pick is kept (the drill is `pending`).
 *
 * Each column is one read of its own, never a set's whole card list.
 */

export interface DrillColumn {
  step: DrillStep;
  /** The column's name, which is also its listbox's name ("Sports", "Parallels"). */
  title: string;
  /** `undefined` while it loads. */
  items: DrillItem[] | undefined;
  selectedId: string | null;
}

export interface DrillState {
  /** The drill as far as the catalog bears it out, sport to sub-parallel. */
  drill: Drill;
  /** The columns on screen, in order. */
  columns: DrillColumn[];
  /** The picked row that opens a checklist (its `variantId`), or null. */
  checklist: DrillItem | null;
  /** What the checklist is called: "2024 Topps Chrome Base". */
  checklistTitle: string | null;
  /** What the drill points at, for the page title; null at the top. */
  title: string | null;
  /** True while a pick is still waiting on its column or the set's path. */
  pending: boolean;
}

const TITLES: Record<"sport" | "year" | "brand" | "set" | "type", string> = {
  sport: "Sports",
  year: "Years",
  brand: "Brands",
  set: "Sets",
  type: "Variant Types",
};

/**
 * `enabled: false` reads nothing (another tab is showing) and answers the
 * empty drill.
 */
export function useDrillState(url: Drill, enabled = true): DrillState {
  const path = useSetPath(enabled ? url.set : null);
  // What the checks below settle, built up column by column in this render.
  const acc: { drill: Drill; pending: boolean } = { drill: enabled ? { ...url } : { ...EMPTY_DRILL }, pending: false };
  if (acc.drill.set) {
    if (path === undefined) acc.pending = true;
    else if (path === null) acc.drill = { ...EMPTY_DRILL };
    else acc.drill = { ...acc.drill, sport: path.sport.id, year: path.year.id, brand: path.brand.id };
  }

  const picked: Partial<Record<DrillStep, DrillItem>> = {};
  const columns: DrillColumn[] = [];

  /** Checks the pick at `step` against its column; true when the column under it shows. */
  const settle = (step: DrillStep, items: DrillItem[] | undefined, title: string, shown: boolean): boolean => {
    if (!shown) return false;
    columns.push({ step, title, items, selectedId: acc.drill[step] });
    const id = acc.drill[step];
    if (id === null) return false;
    if (items === undefined) {
      acc.pending = true;
      return true;
    }
    const item = items.find((i) => i.id === id);
    if (!item) {
      acc.drill = cutAt(acc.drill, step);
      columns[columns.length - 1] = { step, title, items, selectedId: null };
      return false;
    }
    picked[step] = item;
    return item.hasChildren;
  };

  // A set's path is in hand before its columns are asked for, so a deep link
  // never flashes the Sports list open.
  const ready = enabled && !(acc.drill.set && path === undefined);

  const sports = useDrill(ready ? "sport" : null, {});
  const yearShown = settle("sport", sports, TITLES.sport, ready);
  const years = useDrill(yearShown ? "year" : null, parentsFor(acc.drill, "year"));
  const brandShown = settle("year", years, TITLES.year, yearShown);
  const brands = useDrill(brandShown ? "brand" : null, parentsFor(acc.drill, "brand"));
  const setShown = settle("brand", brands, TITLES.brand, brandShown);
  const sets = useDrill(setShown ? "set" : null, parentsFor(acc.drill, "set"));
  const typeShown = settle("set", sets, TITLES.set, setShown);
  const types = useDrill(typeShown ? "variantType" : null, parentsFor(acc.drill, "type"));
  const variantShown = settle("type", types, TITLES.type, typeShown);
  const variants = useDrill(variantShown ? "variant" : null, parentsFor(acc.drill, "variant"));
  const typeName = picked.type?.name ?? "Variants";
  const subShown = settle("variant", variants, typeName, variantShown);
  const subs = useDrill(subShown ? "subVariant" : null, parentsFor(acc.drill, "sub"));
  settle("sub", subs, `${picked.variant?.name ?? "Insert"} parallels`, subShown);

  const season = picked.year?.name ?? path?.year.name ?? null;
  const setName = picked.set?.name ?? path?.set.name ?? null;
  const { drill, pending } = acc;
  const setTitle = drill.set && season && setName ? `${season} ${setName}` : null;
  const checklist = checklistItem([picked.type, picked.variant, picked.sub]);

  let checklistTitle: string | null = null;
  if (checklist && setTitle) {
    // "Inserts" and "Parallels" are steps, not part of what a checklist is
    // called; a parallel under an insert reads after it ("Pennant Flyers Gold").
    const name =
      checklist === picked.sub && picked.variant
        ? `${picked.variant.name} ${checklist.name}`
        : checklist.name;
    checklistTitle = `${setTitle} ${name}`;
  }

  let title: string | null = null;
  if (drill.set) {
    title = checklistTitle ?? (setTitle ? (picked.type ? `${setTitle} ${picked.type.name}` : setTitle) : null);
  } else if (picked.sport) {
    if (!picked.year) title = picked.sport.name;
    else if (!picked.brand) title = `${picked.year.name} ${picked.sport.name}`;
    else title = `${picked.year.name} ${picked.brand.name}`;
  }

  return { drill, columns, checklist, checklistTitle, title, pending };
}
