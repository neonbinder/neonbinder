/**
 * NEO-350 prototype 3 — the wall's shape, pure.
 *
 * The aligned block puts the base row first and every parallel under it, one
 * column per BASE card, so a card's whole rainbow reads down a column.
 * A parallel lands in a column only when its number AND variation match one
 * base card exactly (two #13s live in 2024 Topps Chrome: the regular and the
 * Sliding image variation). Inserts carry their own numbering, so each insert
 * gets its own strip below.
 */

import {
  cardsInSet,
  getSet,
  variantLabel,
  type Card,
  type SetId,
  type SetVariant,
  type VariantFilter,
} from "../_shared/data";

export interface WallRow {
  key: string;
  variant: SetVariant;
  label: string;
  /** One cell per column of the section; null where the variant has no card. */
  cells: (Card | null)[];
}

export interface WallSection {
  key: string;
  columns: number;
  rows: WallRow[];
}

export function variantKey(v: SetVariant): string {
  return `${v.path.type}:${v.path.name ?? ""}`;
}

export function variantFilterOf(v: SetVariant): VariantFilter {
  return { type: v.path.type, name: v.path.name };
}

export function printRunText(v: SetVariant): string | null {
  if (v.printRun === null) return null;
  return v.printRun === 1 ? "1/1" : `/${v.printRun}`;
}

export interface Wall {
  aligned: WallSection;
  inserts: WallSection[];
}

export function buildWall(setId: SetId): Wall {
  const set = getSet(setId);
  const baseVariant = set.variants.find((v) => v.path.type === "Base")!;
  const base = cardsInSet(setId, { type: "Base" });
  const rows: WallRow[] = [
    { key: variantKey(baseVariant), variant: baseVariant, label: "Base", cells: base },
  ];
  for (const v of set.variants) {
    if (v.path.type !== "Parallels") continue;
    const list = cardsInSet(setId, variantFilterOf(v));
    const cells = base.map((b) => {
      const hits = list.filter(
        (c) => c.cardNumber === b.cardNumber && c.variation === b.variation,
      );
      return hits.length === 1 ? hits[0] : null;
    });
    rows.push({ key: variantKey(v), variant: v, label: variantLabel(v.path), cells });
  }
  const inserts: WallSection[] = set.variants
    .filter((v) => v.path.type === "Inserts")
    .map((v) => {
      const list = cardsInSet(setId, variantFilterOf(v));
      return {
        key: variantKey(v),
        columns: list.length,
        rows: [{ key: variantKey(v), variant: v, label: variantLabel(v.path), cells: list }],
      };
    });
  return { aligned: { key: "aligned", columns: base.length, rows }, inserts };
}

export interface WallBlock {
  start: number;
  end: number;
  rows: { row: WallRow; cells: (Card | null)[] }[];
}

/** Cut a section into blocks of `perBlock` columns, dropping rows with nothing in a block. */
export function blocksOf(section: WallSection, perBlock: number): WallBlock[] {
  const out: WallBlock[] = [];
  for (let start = 0; start < section.columns; start += perBlock) {
    const end = Math.min(section.columns, start + perBlock);
    const rows = section.rows
      .map((row) => ({ row, cells: row.cells.slice(start, end) }))
      .filter((r) => r.cells.some(Boolean));
    out.push({ start, end, rows });
  }
  return out;
}

/** Every card on the wall whose number reads exactly `text` (case-folded). */
export function cardsNumbered(setId: SetId, text: string): Card[] {
  const want = text.trim().replace(/^#/, "").toLowerCase();
  if (!want) return [];
  return cardsInSet(setId).filter((c) => c.cardNumber.toLowerCase() === want);
}
