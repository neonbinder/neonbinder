import { slotIds, type SlotBearingRow } from "../../convex/platformSlots";

/**
 * NEO-300 — marketplace ids a sync must leave alone because another NB row in
 * the same variant type already holds them.
 *
 * The bug: Group Parallels moves insert rows under another insert as
 * `level=parallel`, keeping their `_id` and their marketplace slots. The next
 * Sync Inserts fetched the same marketplace sets again, saw nothing at the
 * insert level holding them (the forms only looked at inserts), and re-created
 * every grouped row as a top-level insert.
 *
 * Nothing here reads a marketplace NAME. A row is held by its ids alone, and
 * what the operator is shown is the NB row's own name and the NB insert it sits
 * under.
 */
export type HeldRow = {
  /** The holding row's `_id`. */
  key: string;
  /** The holding row's NB name. */
  name: string;
  /** The NB insert it is grouped under, when it is a parallel. */
  parentName?: string;
  bsc: string[];
  sportlots: string[];
};

type TreeRow = Pick<SlotBearingRow, "platformData"> & {
  _id: string;
  value: string;
};

/** The shape `getInsertTreeByVariantType` returns. */
export type InsertTree = ReadonlyArray<{
  insert: TreeRow;
  parallels: ReadonlyArray<TreeRow>;
}>;

function held(row: TreeRow, parentName?: string): HeldRow {
  return {
    key: String(row._id),
    name: row.value,
    ...(parentName !== undefined ? { parentName } : {}),
    bsc: slotIds(row, "bsc"),
    sportlots: slotIds(row, "sportlots"),
  };
}

/**
 * Sync Inserts: every parallel under the variant type's inserts. The inserts
 * themselves are the sync's own rows (they come back as `existingRows`), so
 * they are not "elsewhere".
 */
export function parallelsInTree(tree: InsertTree): HeldRow[] {
  const out: HeldRow[] = [];
  for (const { insert, parallels } of tree) {
    for (const p of parallels) out.push(held(p, insert.value));
  }
  return out;
}

/**
 * Sync Sub-Variants under `insertId`: every OTHER insert in the variant type
 * and every parallel under those. The parent's own parallels are the sync's
 * own rows; the parent itself is left out so a parallel whose id happens to
 * equal its parent's is not hidden from the one place it belongs.
 */
export function rowsOutsideInsert(
  tree: InsertTree,
  insertId: string,
): HeldRow[] {
  const out: HeldRow[] = [];
  for (const { insert, parallels } of tree) {
    if (String(insert._id) === String(insertId)) continue;
    out.push(held(insert));
    for (const p of parallels) out.push(held(p, insert.value));
  }
  return out;
}

type Item = { platformValue: string };

/**
 * The held rows at least one of whose ids the fetch actually returned. The
 * operator is only told about rows this sync would otherwise have duplicated;
 * a grouped parallel the marketplace did not send back is none of its
 * business. Reads every list the fetch carries, not just the option lists, so
 * a pair the reconciler auto-matched is counted however the result is shaped.
 */
export function heldRowsReturnedBy(
  rows: ReadonlyArray<HeldRow>,
  fetched: {
    bscOptions?: ReadonlyArray<Item>;
    slOptions?: ReadonlyArray<Item>;
    unmatchedBsc?: ReadonlyArray<Item>;
    unmatchedSl?: ReadonlyArray<Item>;
    autoMatched?: ReadonlyArray<{ bsc: Item; sl: Item }>;
  },
): HeldRow[] {
  const bsc = new Set<string>();
  const sl = new Set<string>();
  for (const i of fetched.bscOptions ?? []) bsc.add(i.platformValue);
  for (const i of fetched.unmatchedBsc ?? []) bsc.add(i.platformValue);
  for (const i of fetched.slOptions ?? []) sl.add(i.platformValue);
  for (const i of fetched.unmatchedSl ?? []) sl.add(i.platformValue);
  for (const m of fetched.autoMatched ?? []) {
    bsc.add(m.bsc.platformValue);
    sl.add(m.sl.platformValue);
  }
  return rows.filter(
    (r) => r.bsc.some((id) => bsc.has(id)) || r.sportlots.some((id) => sl.has(id)),
  );
}

/** Every id the given rows hold, per side. */
export function heldIdSets(rows: ReadonlyArray<HeldRow>): {
  bsc: Set<string>;
  sportlots: Set<string>;
} {
  const bsc = new Set<string>();
  const sportlots = new Set<string>();
  for (const r of rows) {
    for (const id of r.bsc) bsc.add(id);
    for (const id of r.sportlots) sportlots.add(id);
  }
  return { bsc, sportlots };
}
