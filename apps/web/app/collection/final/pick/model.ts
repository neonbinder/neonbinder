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
 *
 * NEO-509: a sale NB could not tie to a card still walks with its set when
 * the listing says enough (sport, year, set, number). Every rule reads a
 * row through one accessor, `rowFacts`, so a card and a listing sort,
 * group and filter alike; `row.card` still means "NB matched it".
 */

import { setLabel } from "../data/labels";
import type { Card, SetRef } from "../data/types";
import type { ListedCard, PickBox, PickGrade, PickOrder, PickPhoto, PickSpot, SaleLine } from "./types";

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
  /** NB did not note the box for at least one merged line. */
  boxUnrecorded: boolean;
  /** The first merged line's copy photo, when one has it. */
  photo?: PickPhoto;
  /** NEO-509 — on a row with no card: what the sale says the card is. */
  listed?: ListedCard;
  /** The NB set on the list a `listed` row files behind (`listedSetFor`). */
  joined?: SetOnList;
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

/**
 * `sets` are the NB sets a listed row may file behind; by default the sets
 * of `lines` themselves. A caller merging part of the list (one order, one
 * stop) passes the whole list's, so a listing files the same way everywhere.
 */
export function mergeLines(
  lines: readonly SaleLine[],
  options: { bySpot?: boolean; sets?: readonly SetOnList[] } = {},
): PickRow[] {
  const rows = new Map<string, SaleLine[]>();
  for (const line of lines) {
    const key = mergeKey(line, options.bySpot);
    const group = rows.get(key);
    if (group) group.push(line);
    else rows.set(key, [line]);
  }
  let sets = options.sets;
  return [...rows].map(([key, group]) => {
    const row = toRow(key, group);
    if (row.card || !row.listed) return row;
    sets ??= setsOnList(lines);
    const joined = listedSetFor(row.listed, sets);
    return joined ? { ...row, joined, sportCode: joined.sportCode } : row;
  });
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
    boxUnrecorded: group.some((l) => l.boxUnrecorded),
    photo: group.find((l) => l.photo)?.photo,
    ...(first.card || !first.listed ? {} : { listed: first.listed }),
  };
}

// ---------------------------------------------------------------------------
// Row facts: a card, or what a listing says it is
// ---------------------------------------------------------------------------

/** What every rule reads of a row, whether NB matched it or only the listing says it. */
export interface RowFacts {
  /** NB's sport id; `sport:<word>` for a listing's sport NB has no row for. */
  sportKey: string;
  sportName: string;
  /** The year the set files under. */
  year: number;
  /** The set's own name, without the season. */
  setName: string;
  /** 0 for an NB set, 1 for a listing's own: NB's divider comes first when the names tie. */
  setRank: 0 | 1;
  /** NB's set id, or `listed:<sport>|<year>|<name>` for a listing's own divider. */
  setKey: string;
  /** The divider's title: "2024 Topps Chrome". */
  setTitle: string;
  role: VariantRole;
  /** The insert or parallel's name; null for Base. */
  variantName: string | null;
  cardNumber: string;
  players: string;
}

/** One NB set on the list, with its sport's code (the divider colour). */
export interface SetOnList {
  set: SetRef;
  sportCode: string | null;
}

/** Trimmed, inner spaces collapsed, case-folded. */
function fold(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The years a listing's year may name: anything else is a misread, not a year. */
const FIRST_YEAR = 1800;
const LAST_YEAR = 2100;

interface ListedPlace {
  sportName: string;
  year: number;
  /** The set's name without a leading season. */
  setName: string;
  /** "2021 Score": the season, then the name. */
  setTitle: string;
  cardNumber: string;
}

/**
 * Where a listing files, when it says enough: a year NB can file under, a
 * set name, a card number and a sport (NB's, or the listing's word).
 * Null otherwise: the line stays in "Can't find it".
 */
function listedPlace(listed: ListedCard): ListedPlace | null {
  const { year } = listed;
  if (year === undefined || !Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR) return null;
  const rawSet = listed.setName?.trim();
  const cardNumber = listed.cardNumber?.trim();
  const sportName = listed.sportName?.trim();
  if (!rawSet || !cardNumber || !sportName) return null;
  const season = listed.season?.trim() || String(year);
  // A listing may write its set with the season in front ("2024 Topps Chrome") or without ("Score").
  const setName = fold(rawSet).startsWith(`${fold(season)} `) ? rawSet.slice(season.length).trim() : rawSet;
  if (!setName) return null;
  return { sportName, year, setName, setTitle: `${season} ${setName}`, cardNumber };
}

/**
 * THE one rule for whether a listing files behind an NB set's divider: when
 * exactly one NB set on the list has its sport (NB's id when the sale named
 * one, else the sport's name), its year, and its set name (case-folded, the
 * listing's season dropped). Anything else gets its own divider, titled
 * with the listing's set. Returning null here gives every listing its own.
 */
export function listedSetFor(listed: ListedCard, sets: readonly SetOnList[]): SetOnList | null {
  const place = listedPlace(listed);
  if (!place) return null;
  const name = fold(place.setName);
  const sport = fold(place.sportName);
  const hits = sets.filter(
    ({ set }) =>
      (listed.sportId ? set.sport.id === listed.sportId : fold(set.sport.name) === sport) &&
      set.year === place.year &&
      fold(set.name) === name,
  );
  return hits.length === 1 ? hits[0] : null;
}

/** The NB sets the matched lines name, once each. */
export function setsOnList(lines: readonly SaleLine[]): SetOnList[] {
  const sets = new Map<string, SetOnList>();
  for (const line of lines) {
    if (line.card && !sets.has(line.card.set.id)) sets.set(line.card.set.id, { set: line.card.set, sportCode: line.sportCode });
  }
  return [...sets.values()];
}

const FACTS = new WeakMap<PickRow, RowFacts | null>();

/**
 * What a row is, for every rule that orders, groups or filters: its card's,
 * or its listing's (behind the NB set it joined, when it did). Null for a
 * row that says too little to walk: it goes in "Can't find it".
 */
export function rowFacts(row: PickRow): RowFacts | null {
  if (FACTS.has(row)) return FACTS.get(row) ?? null;
  const facts = factsOf(row);
  FACTS.set(row, facts);
  return facts;
}

function factsOf(row: PickRow): RowFacts | null {
  const c = row.card;
  if (c) {
    return {
      sportKey: c.set.sport.id,
      sportName: c.set.sport.name,
      year: c.set.year,
      setName: c.set.name,
      setRank: 0,
      setKey: c.set.id,
      setTitle: setLabel(c.set),
      role: variantRole(c),
      variantName: variantName(c),
      cardNumber: c.cardNumber,
      players: c.players.map((p) => p.name).join(" / "),
    };
  }
  const listed = row.listed;
  const place = listed ? listedPlace(listed) : null;
  if (!listed || !place) return null;
  const role: VariantRole = listed.role ?? "base";
  const card = {
    role,
    variantName: role === "base" ? null : listed.variantName?.trim() || null,
    cardNumber: place.cardNumber,
    players: listed.players?.trim() ?? "",
  };
  const joined = row.joined?.set;
  if (joined) {
    return {
      sportKey: joined.sport.id,
      sportName: joined.sport.name,
      year: joined.year,
      setName: joined.name,
      setRank: 0,
      setKey: joined.id,
      setTitle: setLabel(joined),
      ...card,
    };
  }
  const sportKey = listed.sportId ?? `sport:${fold(place.sportName)}`;
  return {
    sportKey,
    sportName: place.sportName,
    year: place.year,
    setName: place.setName,
    setRank: 1,
    setKey: `listed:${sportKey}|${place.year}|${fold(place.setName)}`,
    setTitle: place.setTitle,
    ...card,
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

function players(row: PickRow): string {
  return rowFacts(row)?.players ?? row.listingTitle;
}

/** Exact, code-unit order: a set key is an id, never folded, so two keys tie only when equal. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The default walking order (see the file comment). Each step compares one
 * fact of both rows, so the order is a plain lexicographic one: transitive
 * whatever mix of cards and listings it sorts.
 */
export function compareDefault(a: PickRow, b: PickRow): number {
  const fa = rowFacts(a);
  const fb = rowFacts(b);
  if (!fa || !fb) {
    if (fa || fb) return fa ? 1 : -1; // nothing to file by first: those are "Can't find it"
    return naturalCompare(orderLabel(a.orders[0]), orderLabel(b.orders[0])) || naturalCompare(a.key, b.key);
  }
  return (
    naturalCompare(fa.sportName, fb.sportName) ||
    fb.year - fa.year ||
    naturalCompare(fa.setName, fb.setName) ||
    fa.setRank - fb.setRank ||
    compareKeys(fa.setKey, fb.setKey) ||
    ROLE_RANK[fa.role] - ROLE_RANK[fb.role] ||
    naturalCompare(fa.variantName ?? "", fb.variantName ?? "") ||
    naturalCompare(fa.cardNumber, fb.cardNumber) ||
    naturalCompare(fa.players, fb.players) ||
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
      return naturalCompare(rowFacts(a)?.cardNumber ?? "", rowFacts(b)?.cardNumber ?? "");
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
  /** A sport's key (`RowFacts.sportKey`: NB's id, or a listing's sport word). */
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

/** The word a row with a listing but no card wears (and a search finds it by). */
export const UNMATCHED = "Unmatched";

function haystack(row: PickRow): string {
  const facts = rowFacts(row);
  const parts = [row.listingTitle, row.condition, row.serial ?? "", ...row.orders.map(orderLabel)];
  if (facts) parts.push(`#${facts.cardNumber}`, facts.cardNumber, facts.players, facts.setTitle, facts.variantName ?? "", facts.sportName);
  if (!row.card && row.listed) parts.push(UNMATCHED);
  if (row.grade) parts.push(row.grade.grader, row.grade.grade, row.grade.cert);
  return parts.join(" ").toLowerCase();
}

export function filterRows(rows: readonly PickRow[], f: PickFilters): PickRow[] {
  const words = (f.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    const facts = rowFacts(row);
    if (f.sport && facts?.sportKey !== f.sport) return false;
    if (f.year && String(facts?.year ?? "") !== f.year) return false;
    if (f.variant && facts?.role !== f.variant) return false;
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
    const sets = setsOnList(lines);
    for (const { order, lines: own } of orders) {
      const rows = sortRows(filterRows(mergeLines(own, { sets }), filters), options.sort, options.dir);
      if (rows.length) sections.push({ kind: "order", key: `order:${order.id}`, order, rows });
    }
    return sections;
  }

  const all = filterRows(mergeLines(lines), filters);
  const cantFind = sortRows(all.filter((r) => !rowFacts(r)), null);
  const fresh = sortRows(all.filter((r) => rowFacts(r) && r.isNew), null);
  const rest = sortRows(all.filter((r) => rowFacts(r) && !r.isNew), options.sort, options.dir);

  if (cantFind.length) sections.push({ kind: "cantFind", key: "cantFind", rows: cantFind });
  if (options.sort === null || options.sort === "set") {
    for (const row of rest) {
      const facts = rowFacts(row)!;
      const key = `set:${facts.setKey}`;
      const last = sections[sections.length - 1];
      if (last?.kind === "set" && last.key === key) last.rows.push(row);
      else
        sections.push({
          kind: "set",
          key,
          sportName: facts.sportName,
          sportCode: row.sportCode,
          title: facts.setTitle,
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
  /** The stop after the boxes for cards whose box NB did not note (before Can't find it). */
  unrecorded?: boolean;
}

/** The `pbox` id of the Can't find it stop; never a box's own id. */
export const CANT_FIND_STOP = "cant-find";

/** The `pbox` id of the Box not recorded stop; never a box's own id. */
export const BOX_NOT_RECORDED_STOP = "no-box";

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
 * does not list) goes to Unsorted, unless NB never noted its box
 * (`boxUnrecorded`): those are left for the Box not recorded stop. Lines NB
 * could not match to a card are in no box and are left out (the list's
 * "Can't find it" has them).
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
    const spotBox = line.spot && known.get(line.spot.boxId);
    if (!spotBox && line.boxUnrecorded) continue;
    const box = spotBox || unsorted;
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
 * The whole By the Box walk: the boxes in order, then a stop for the cards
 * whose box NB never noted, then one last stop for the sales NB could not
 * tie to a card (the list's Can't find it), each when there are any.
 */
export function boxStops(lines: readonly SaleLine[], boxes: readonly PickBox[]): BoxStop[] {
  const stops = boxWalk(lines, boxes);
  const known = new Set(boxes.map((b) => b.id));
  const loose = lines.filter((l) => l.card && l.boxUnrecorded && !(l.spot && known.has(l.spot.boxId)));
  if (loose.length) {
    stops.push({
      box: { id: BOX_NOT_RECORDED_STOP, name: "Box not recorded" },
      rows: sortRows(mergeLines(loose, { bySpot: true }), null),
      unrecorded: true,
    });
  }
  // No box holds a sale NB could not tie to a card, even one whose listing
  // says what it is: those wait here, the described ones in set order.
  const lost = lines.filter((l) => !l.card);
  if (lost.length) {
    stops.push({
      box: { id: CANT_FIND_STOP, name: "Can't find it" },
      rows: sortRows(mergeLines(lost, { sets: setsOnList(lines) }), null),
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
