/**
 * NEO-500 — the Pick List's rules, pure: how sale lines merge into rows, the
 * order a seller walks them in, the filters, the groups, and the boxes in
 * By the Box. No store, no React, so the demo and the real store pull the
 * same way.
 *
 * Default order (Jason): sport, year newest first, set, variant type (Base,
 * Parallel, Insert, Parallel of an Insert), the insert or parallel's name,
 * then card number in natural order ("BC-2" before "BC-12", "12" before
 * "12a"). A season files under its start year ("2023-24" sorts as 2023):
 * that is the set's `year`. A card number is never assumed unique: rows
 * that tie on it fall through to the player and the line's id.
 */

import { setLabel } from "../data/labels";
import type { Card } from "../data/types";
import type { PickBox, PickGrade, PickOrder, PickSpot, SaleLine } from "./types";

// ---------------------------------------------------------------------------
// Natural order
// ---------------------------------------------------------------------------

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-blind order: "BC-2" < "BC-12", "12" < "12a" < "US150". */
export function naturalCompare(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

// ---------------------------------------------------------------------------
// Variant role
// ---------------------------------------------------------------------------

/** Which divider a card files behind. */
export type VariantRole = "base" | "parallel" | "insert" | "insertParallel";

export const VARIANT_ROLES: readonly VariantRole[] = ["base", "parallel", "insert", "insertParallel"];

/** What each role is called, written beside its colour every time. */
export const VARIANT_ROLE_LABEL: Record<VariantRole, string> = {
  base: "Base",
  parallel: "Parallel",
  insert: "Insert",
  insertParallel: "Insert parallel",
};

const ROLE_RANK: Record<VariantRole, number> = { base: 0, parallel: 1, insert: 2, insertParallel: 3 };

/**
 * A card's divider, from NB's own variant kind: a parallel under an insert
 * is an insert parallel; a variant of no kind ("Promo") reads like an insert.
 */
export function variantRole(card: Pick<Card, "variant">): VariantRole {
  const { kind, insertName } = card.variant;
  if (kind === "base") return "base";
  if (kind === "parallel") return insertName ? "insertParallel" : "parallel";
  return "insert";
}

/** "Pennant Flyers", "Gold Refractor", "Pennant Flyers Gold"; null for Base. */
export function variantName(card: Pick<Card, "variant">): string | null {
  const { kind, name, insertName } = card.variant;
  if (kind === "base" || !name) return null;
  return insertName ? `${insertName} ${name}` : name;
}

// ---------------------------------------------------------------------------
// Rows: sale lines merged
// ---------------------------------------------------------------------------

/** One row of the list: one or more sale lines for the same copy kind. */
export interface PickRow {
  key: string;
  lines: readonly SaleLine[];
  card: Card | null;
  sportCode: string | null;
  listingTitle: string;
  problem?: string;
  /** Copies to pull across every merged line. */
  quantity: number;
  condition: string;
  serial?: string;
  grade?: PickGrade;
  /** Every order it fills, in first-seen order. */
  orders: readonly PickOrder[];
  lastOnes: boolean;
  /** Copies short across every merged line; 0 when none. */
  short: number;
  isNew: boolean;
  spot?: PickSpot;
}

function gradeKey(g: PickGrade | undefined): string {
  return g ? `${g.grader}|${g.grade}|${g.cert}` : "";
}

/**
 * The same card in the same condition across orders is one row (qty 2,
 * both order numbers). Slabs and numbered copies are each their own copy,
 * so a different cert or serial never merges; a line NB could not match
 * never merges; a new line stays with the new ones. `bySpot` (By the Box)
 * also keeps copies in different boxes or slots apart.
 */
export function mergeKey(line: SaleLine, bySpot = false): string {
  if (!line.card) return `line:${line.id}`;
  const parts = [line.card.id, line.condition.toLowerCase(), gradeKey(line.grade), line.serial ?? "", line.isNew ? "new" : ""];
  if (bySpot) parts.push(line.spot?.boxId ?? "", line.spot?.slot === undefined ? "" : String(line.spot.slot));
  return parts.join("|");
}

export function mergeLines(lines: readonly SaleLine[], options: { bySpot?: boolean } = {}): PickRow[] {
  const rows = new Map<string, SaleLine[]>();
  for (const line of lines) {
    const key = mergeKey(line, options.bySpot);
    const group = rows.get(key);
    if (group) group.push(line);
    else rows.set(key, [line]);
  }
  return [...rows].map(([key, group]) => toRow(key, group));
}

function toRow(key: string, group: SaleLine[]): PickRow {
  const first = group[0];
  const orders: PickOrder[] = [];
  for (const line of group) if (!orders.some((o) => o.id === line.order.id)) orders.push(line.order);
  return {
    key,
    lines: group,
    card: first.card,
    sportCode: first.sportCode,
    listingTitle: first.listingTitle,
    problem: first.problem,
    quantity: group.reduce((n, l) => n + l.quantity, 0),
    condition: first.condition,
    serial: first.serial,
    grade: first.grade,
    orders,
    lastOnes: group.some((l) => l.lastOnes),
    short: group.reduce((n, l) => n + (l.short ?? 0), 0),
    isNew: group.every((l) => l.isNew),
    spot: first.spot,
  };
}

/** A row is pulled once every line in it is. */
export function isPulled(row: PickRow, pulled: ReadonlySet<string>): boolean {
  return row.lines.every((l) => pulled.has(l.id));
}

export function lineIds(rows: readonly PickRow[]): string[] {
  return rows.flatMap((r) => r.lines.map((l) => l.id));
}

/** "eBay 12-3456". */
export function orderLabel(order: PickOrder): string {
  return `${order.venue} ${order.number}`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** The columns a seller can sort by. */
export type SortKey = "qty" | "number" | "player" | "set" | "condition" | "detail" | "order";
export type SortDir = "asc" | "desc";

export const SORT_KEYS: readonly SortKey[] = ["qty", "number", "player", "set", "condition", "detail", "order"];

function sportName(row: PickRow): string {
  return row.card?.set.sport.name ?? "";
}

function players(row: PickRow): string {
  return row.card?.players.map((p) => p.name).join(" / ") ?? row.listingTitle;
}

/** The default walking order (see the file comment). */
export function compareDefault(a: PickRow, b: PickRow): number {
  const ca = a.card;
  const cb = b.card;
  if (!ca || !cb) {
    if (ca || cb) return ca ? 1 : -1; // no card first: those are "Can't find it"
    return naturalCompare(orderLabel(a.orders[0]), orderLabel(b.orders[0])) || naturalCompare(a.key, b.key);
  }
  return (
    naturalCompare(ca.set.sport.name, cb.set.sport.name) ||
    cb.set.year - ca.set.year ||
    naturalCompare(ca.set.name, cb.set.name) ||
    naturalCompare(ca.set.id, cb.set.id) ||
    ROLE_RANK[variantRole(ca)] - ROLE_RANK[variantRole(cb)] ||
    naturalCompare(variantName(ca) ?? "", variantName(cb) ?? "") ||
    naturalCompare(ca.cardNumber, cb.cardNumber) ||
    naturalCompare(players(a), players(b)) ||
    naturalCompare(a.condition, b.condition) ||
    naturalCompare(a.serial ?? "", b.serial ?? "") ||
    naturalCompare(a.key, b.key)
  );
}

/** Serial-numbered first by print run, then slabs by grader and grade, then the rest. */
function detailKey(row: PickRow): string {
  if (row.serial) return `0 ${row.serial}`;
  if (row.grade) return `1 ${row.grade.grader} ${row.grade.grade}`;
  return "2";
}

function columnCompare(key: SortKey, a: PickRow, b: PickRow): number {
  switch (key) {
    case "qty":
      return a.quantity - b.quantity;
    case "number":
      return naturalCompare(a.card?.cardNumber ?? "", b.card?.cardNumber ?? "");
    case "player":
      return naturalCompare(players(a), players(b));
    case "set":
      return compareDefault(a, b);
    case "condition":
      return naturalCompare(a.grade ? `${a.grade.grader} ${a.grade.grade}` : a.condition, b.grade ? `${b.grade.grader} ${b.grade.grade}` : b.condition);
    case "detail":
      return naturalCompare(detailKey(a), detailKey(b));
    case "order":
      return naturalCompare(orderLabel(a.orders[0]), orderLabel(b.orders[0]));
  }
}

/** Rows sorted by a column (ties fall back to the default order), or by default. */
export function sortRows(rows: readonly PickRow[], key: SortKey | null, dir: SortDir = "asc"): PickRow[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => (key ? sign * columnCompare(key, a, b) || compareDefault(a, b) : compareDefault(a, b)));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface PickFilters {
  /** Words to find in the number, player, set, variant, listing or order. */
  text?: string;
  /** A sport's id. */
  sport?: string;
  /** A set year, as a string. */
  year?: string;
  variant?: VariantRole;
  condition?: string;
  /** An order's id. */
  order?: string;
  slabs?: boolean;
  numbered?: boolean;
}

export function hasFilters(f: PickFilters): boolean {
  return Boolean(f.text || f.sport || f.year || f.variant || f.condition || f.order || f.slabs || f.numbered);
}

function haystack(row: PickRow): string {
  const c = row.card;
  const parts = [row.listingTitle, row.condition, row.serial ?? "", ...row.orders.map(orderLabel)];
  if (c) parts.push(`#${c.cardNumber}`, c.cardNumber, players(row), setLabel(c.set), variantName(c) ?? "", c.set.sport.name);
  if (row.grade) parts.push(row.grade.grader, row.grade.grade, row.grade.cert);
  return parts.join(" ").toLowerCase();
}

export function filterRows(rows: readonly PickRow[], f: PickFilters): PickRow[] {
  const words = (f.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const c = row.card;
    if (f.sport && c?.set.sport.id !== f.sport) return false;
    if (f.year && String(c?.set.year ?? "") !== f.year) return false;
    if (f.variant && (!c || variantRole(c) !== f.variant)) return false;
    if (f.condition && (row.grade ? "Graded" : row.condition) !== f.condition) return false;
    if (f.order && !row.orders.some((o) => o.id === f.order)) return false;
    if (f.slabs && !row.grade) return false;
    if (f.numbered && !row.serial) return false;
    if (words.length) {
      const text = haystack(row);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

/** What the Condition filter offers for a row: a slab is "Graded". */
export function conditionOf(row: PickRow): string {
  return row.grade ? "Graded" : row.condition;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type PickSection =
  | { kind: "cantFind"; key: string; rows: PickRow[] }
  | { kind: "set"; key: string; sportName: string; sportCode: string | null; title: string; rows: PickRow[] }
  | { kind: "order"; key: string; order: PickOrder; rows: PickRow[] }
  | { kind: "flat"; key: string; rows: PickRow[] }
  | { kind: "new"; key: string; rows: PickRow[] };

export interface SectionOptions {
  sort: SortKey | null;
  dir: SortDir;
  groupByOrder: boolean;
}

/**
 * The list as the seller walks it: "Can't find it" on top, then the rows
 * (one section per set in the default order, one per order when grouped by
 * order, or one flat run when sorted by a column), then anything that sold
 * after the pull began, at the bottom.
 *
 * Grouped by order, a row merged across two orders shows under each, with
 * that order's own lines only.
 */
export function buildSections(lines: readonly SaleLine[], filters: PickFilters, options: SectionOptions): PickSection[] {
  const sections: PickSection[] = [];
  if (options.groupByOrder) {
    const byOrder = new Map<string, { order: PickOrder; lines: SaleLine[] }>();
    for (const line of lines) {
      const entry = byOrder.get(line.order.id);
      if (entry) entry.lines.push(line);
      else byOrder.set(line.order.id, { order: line.order, lines: [line] });
    }
    const orders = [...byOrder.values()].sort((a, b) => naturalCompare(orderLabel(a.order), orderLabel(b.order)));
    for (const { order, lines: own } of orders) {
      const rows = sortRows(filterRows(mergeLines(own), filters), options.sort, options.dir);
      if (rows.length) sections.push({ kind: "order", key: `order:${order.id}`, order, rows });
    }
    return sections;
  }

  const all = filterRows(mergeLines(lines), filters);
  const cantFind = sortRows(all.filter((r) => !r.card), null);
  const fresh = sortRows(all.filter((r) => r.card && r.isNew), null);
  const rest = sortRows(all.filter((r) => r.card && !r.isNew), options.sort, options.dir);

  if (cantFind.length) sections.push({ kind: "cantFind", key: "cantFind", rows: cantFind });
  if (options.sort === null || options.sort === "set") {
    for (const row of rest) {
      const card = row.card!;
      const key = `set:${card.set.id}`;
      const last = sections[sections.length - 1];
      if (last?.kind === "set" && last.key === key) last.rows.push(row);
      else
        sections.push({
          kind: "set",
          key,
          sportName: card.set.sport.name,
          sportCode: row.sportCode,
          title: setLabel(card.set),
          rows: [row],
        });
    }
  } else if (rest.length) {
    sections.push({ kind: "flat", key: "flat", rows: rest });
  }
  if (fresh.length) sections.push({ kind: "new", key: "new", rows: fresh });
  return sections;
}

// ---------------------------------------------------------------------------
// By the Box
// ---------------------------------------------------------------------------

export interface BoxStop {
  box: PickBox;
  rows: PickRow[];
  /** The walk's last stop: the sales NB could not tie to a card, after every box. */
  cantFind?: boolean;
}

/** The `pbox` id of the Can't find it stop; never a box's own id. */
export const CANT_FIND_STOP = "cant-find";

/** The catch-all for a copy filed nowhere, when the store names none. */
export const UNSORTED_BOX: PickBox = { id: "unsorted", name: "Unsorted", unsorted: true };

/** Boxes in natural order by name (Box 2 before Box 10), Unsorted last. */
export function compareBoxes(a: PickBox, b: PickBox): number {
  if (Boolean(a.unsorted) !== Boolean(b.unsorted)) return a.unsorted ? 1 : -1;
  return naturalCompare(a.name, b.name) || naturalCompare(a.id, b.id);
}

/**
 * The walk through the boxes: every box that holds something to pull, in
 * box order, empty ones skipped. A line with no box (or a box the store
 * does not list) goes to Unsorted. Lines NB could not match to a card are
 * in no box and are left out (the list's "Can't find it" has them).
 *
 * Inside a box: slot order when the box keeps slots (rows without one after,
 * in the default order), else the default order.
 */
export function boxWalk(lines: readonly SaleLine[], boxes: readonly PickBox[]): BoxStop[] {
  const known = new Map(boxes.map((b) => [b.id, b]));
  const unsorted = boxes.find((b) => b.unsorted) ?? UNSORTED_BOX;
  const byBox = new Map<string, SaleLine[]>();
  for (const line of lines) {
    if (!line.card) continue;
    const box = (line.spot && known.get(line.spot.boxId)) || unsorted;
    const list = byBox.get(box.id);
    if (list) list.push(line);
    else byBox.set(box.id, [line]);
  }
  const stops: BoxStop[] = [];
  for (const box of [...known.values(), ...(known.has(unsorted.id) ? [] : [unsorted])].sort(compareBoxes)) {
    const own = byBox.get(box.id);
    if (!own?.length) continue;
    stops.push({ box, rows: sortInBox(mergeLines(own, { bySpot: true })) });
  }
  return stops;
}

/**
 * The whole By the Box walk: the boxes in order, then one last stop for the
 * sales NB could not tie to a card (the list's Can't find it), when there are any.
 */
export function boxStops(lines: readonly SaleLine[], boxes: readonly PickBox[]): BoxStop[] {
  const stops = boxWalk(lines, boxes);
  const lost = lines.filter((l) => !l.card);
  if (lost.length) {
    stops.push({
      box: { id: CANT_FIND_STOP, name: "Can't find it" },
      rows: sortRows(mergeLines(lost), null),
      cantFind: true,
    });
  }
  return stops;
}

export function sortInBox(rows: readonly PickRow[]): PickRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.spot?.slot;
    const sb = b.spot?.slot;
    if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
    if ((sa === undefined) !== (sb === undefined)) return sa === undefined ? 1 : -1;
    return compareDefault(a, b);
  });
}

/** Copies still to pull in these rows. */
export function copiesLeft(rows: readonly PickRow[], pulled: ReadonlySet<string>): number {
  let n = 0;
  for (const row of rows) for (const line of row.lines) if (!pulled.has(line.id)) n += line.quantity;
  return n;
}
