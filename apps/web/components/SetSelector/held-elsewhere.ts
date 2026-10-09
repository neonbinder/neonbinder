import { slotIds, type SlotBearingRow } from "../../convex/platformSlots";
import type {
  HeldElsewhereEntry,
  RenameRefusedEntry,
  WithheldElsewhereEntry,
  WithheldSiblingEntry,
} from "../../convex/selectorSyncStore";
import type { SiblingWithholdReason } from "../../convex/selectorSyncMatch";
import { sharedTitleLabels } from "./marketplace-item-label";

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
  /**
   * NEO-312 — NB names from the holder's set down to its parent, when the
   * STORE named a holder anywhere in the set or brand. Drawn as a breadcrumb
   * ending in `name`, and takes the place of `parentName`.
   */
  path?: string[];
  /**
   * NEO-312 — the store named this holder OUTSIDE the column's own scope (for
   * Sync Inserts: anything but a parallel in this variant type), so the note's
   * summary cannot say "grouped as a parallel" about it.
   */
  elsewhere?: true;
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

/** NEO-312 — what separates the steps of a holder's breadcrumb (house style). */
export const HOLDER_PATH_SEPARATOR = " › ";

/**
 * NEO-312 — the store's NB path down to a holder (set › type › insert), or
 * `null` when it sent none: an older result, or a holder that IS a set, whose
 * path is empty because its own name is the whole answer.
 */
export function holderPathOf(e: { path?: string[] }): string[] | null {
  return e.path && e.path.length > 0 ? e.path : null;
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
    (r) =>
      r.bsc.some((id) => bsc.has(id)) || r.sportlots.some((id) => sl.has(id)),
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

/**
 * NEO-300 — fold the STORE's own account of what it left alone into what the
 * client already filtered.
 *
 * The client filter runs against the insert tree it has loaded; the store
 * re-checks against the database in its own transaction, so it can catch a row
 * the client missed (a grouping that landed after the tree loaded, say). Those
 * extras must reach the operator through the same note — a skip the server
 * made silently is still a silent skip.
 *
 * `total` is the true count: every client row, plus the server's total less
 * the entries it listed that the client had already counted. The server's list
 * is a capped sample, so `total` can exceed `rows.length`; the note says how
 * many it is not naming. `extra` is how many the client did NOT know about —
 * the caller holds its panel open on that, and only that.
 */
export function mergeServerHeld(
  clientRows: ReadonlyArray<HeldRow>,
  server:
    | {
        heldElsewhere?: ReadonlyArray<HeldElsewhereEntry>;
        heldElsewhereTotal?: number;
      }
    | null
    | undefined,
  /**
   * NEO-312 — whether a store-named holder sits inside the caller's own scope,
   * read off its NB parent id and level only. Absent, or an entry with no
   * `path` (an older store), and the row is local.
   */
  isLocal?: (e: HeldElsewhereEntry) => boolean,
): { rows: HeldRow[]; total: number; extra: number } {
  const listed = server?.heldElsewhere ?? [];
  const serverTotal = Math.max(server?.heldElsewhereTotal ?? 0, listed.length);
  const known = new Set(clientRows.map((r) => r.key));
  const rows: HeldRow[] = [...clientRows];
  let overlap = 0;
  for (const e of listed) {
    const key = String(e.id);
    if (known.has(key)) {
      overlap++;
      continue;
    }
    known.add(key);
    const path = holderPathOf(e);
    rows.push({
      key,
      name: e.value,
      // NEO-312: the store can name a holder in another variant type or set,
      // so it sends the NB path down to it, and that is what is shown. An
      // older store result has none: a parallel is then named with its
      // insert, and an insert on its own (its parent is the variant type,
      // which is where the operator already is).
      ...(path
        ? { path }
        : e.level === "parallel"
          ? { parentName: e.parentValue }
          : {}),
      // Only a result that carries `path` can name a row outside the scope:
      // an older store walked the variant type alone, so its rows are local.
      ...(e.path !== undefined && isLocal && !isLocal(e)
        ? { elsewhere: true as const }
        : {}),
      // The store names rows, not the ids that matched; nothing downstream of
      // the note needs them.
      bsc: [],
      sportlots: [],
    });
  }
  const extra = serverTotal - overlap;
  return { rows, total: clientRows.length + extra, extra };
}

/**
 * NEO-300 — what the store WITHHELD and whether it could check the subtree at
 * all, read off a (drained, last-page) store result. `null` when there is
 * nothing to tell the operator, so a caller can gate "keep the panel open" on
 * it directly.
 *
 *  - `withheld`: items the store did not add because their marketplace id is
 *    already on 2+ rows, or because the row they point at carries different
 *    ids — the operator fixes the duplicate holder and syncs again. NEO-312:
 *    or that it could not check against the rest of the set (`notChecked`),
 *    or that matched a row here while one of their links stays on the row
 *    that already had it (`linkHeldElsewhere`).
 *  - `subtreeWalkSkipped`: the set was too big for the store to check new
 *    links against, so it WITHHELD them (NEO-312; it used to fall back to
 *    siblings only and could re-add rows). Each one is also in `withheld`, as
 *    `notChecked`.
 */
export type StoreHolds = {
  withheld: WithheldElsewhereEntry[];
  withheldTotal: number;
  subtreeWalkSkipped: boolean;
  /**
   * NEO-325 — items withheld against this parent's OWN rows: not saved, so
   * their links were not stored. Until NEO-325 the store only logged these,
   * and a SportLots twin saved after its namesake simply vanished.
   * Optional (absent = none) so a holds value built before NEO-325 still
   * reads; `storeHoldsOf` always sets all four.
   */
  siblings?: SiblingHold[];
  siblingsTotal?: number;
  /**
   * NEO-325 — title edits the store refused. The set and its links were
   * saved; only its name stayed as it was.
   */
  renames?: RefusedRename[];
  renamesTotal?: number;
};

/** NEO-325 — one withheld item, as the notice names it. */
export type SiblingHold = {
  /**
   * The title it was sent under — followed by its marketplace ids when
   * another line in the same save carried that title (two SportLots twins
   * both still called "Anime"), in the reconciler's own `(#id)` form.
   */
  label: string;
  reason: SiblingWithholdReason;
  /** The rows here it clashed with, by NB name. */
  rows: Array<{ id: string; value: string }>;
};

/** NEO-325 — one refused rename, as the notice names it. */
export type RefusedRename = {
  /** The name the set KEPT, with its ids when another refusal shares it. */
  label: string;
  /** The name the operator asked for. */
  requested: string;
  reason: "clash" | "invalid";
  /** The row that already has `requested`, for a clash. */
  clashWith?: string;
};

/** What the form sent, so a withheld line can be named by its own ids. */
export type SentReconciledItem = {
  value: string;
  platformData: { bsc?: string | string[]; sportlots?: string | string[] };
};

const wireIds = (v: string | string[] | undefined): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v : [];

/**
 * `index → label` for `entries`, each titled by `titleOf` and carrying the ids
 * of the line it points at in `sent`: a title only one entry has is left as
 * it is; a shared one gains its ids (`sharedTitleLabels`).
 */
function labelsWithIds<T extends { itemIndex: number }>(
  entries: ReadonlyArray<T>,
  titleOf: (entry: T) => string,
  sent: ReadonlyArray<SentReconciledItem> | undefined,
  sharedAcross: "entries" | "sent",
): string[] {
  const pv = (ids: string[]) => ids.map((platformValue) => ({ platformValue }));
  const idsOf = (index: number) => {
    const item = sent?.[index];
    return {
      bsc: pv(wireIds(item?.platformData.bsc)),
      sl: pv(wireIds(item?.platformData.sportlots)),
    };
  };
  if (sharedAcross === "sent" && sent) {
    // Shared across everything SENT: a twin is ambiguous even when only one
    // of the two was withheld — that is exactly the case to name.
    const labels = sharedTitleLabels(
      sent.map((item, index) => ({
        key: String(index),
        title: item.value,
        ...idsOf(index),
      })),
    );
    return entries.map(
      (e) => labels.get(String(e.itemIndex)) ?? titleOf(e),
    );
  }
  const labels = sharedTitleLabels(
    entries.map((e, i) => ({
      key: String(i),
      title: titleOf(e),
      ...idsOf(e.itemIndex),
    })),
  );
  return entries.map((e, i) => labels.get(String(i)) ?? titleOf(e));
}

export function storeHoldsOf(
  stored:
    | {
        withheldElsewhere?: ReadonlyArray<WithheldElsewhereEntry>;
        withheldElsewhereTotal?: number;
        subtreeWalkSkipped?: boolean;
        withheldSiblings?: ReadonlyArray<WithheldSiblingEntry>;
        withheldSiblingsTotal?: number;
        renameRefused?: ReadonlyArray<RenameRefusedEntry>;
        renameRefusedTotal?: number;
      }
    | null
    | undefined,
  /**
   * NEO-325 — the `reconciledItems` the form sent, in order. Optional: with
   * it, a withheld twin is named by its ids; without it, by its title.
   */
  sent?: ReadonlyArray<SentReconciledItem>,
): StoreHolds | null {
  const withheld = [...(stored?.withheldElsewhere ?? [])];
  const withheldTotal = Math.max(
    stored?.withheldElsewhereTotal ?? 0,
    withheld.length,
  );
  const subtreeWalkSkipped = stored?.subtreeWalkSkipped === true;

  const siblingEntries = stored?.withheldSiblings ?? [];
  const siblingLabels = labelsWithIds(
    siblingEntries,
    (e) => e.label,
    sent,
    "sent",
  );
  const siblings: SiblingHold[] = siblingEntries.map((e, i) => ({
    label: siblingLabels[i],
    reason: e.reason,
    rows: e.rows.map((r) => ({ id: String(r.id), value: r.value })),
  }));
  const siblingsTotal = Math.max(
    stored?.withheldSiblingsTotal ?? 0,
    siblings.length,
  );

  const renameEntries = stored?.renameRefused ?? [];
  const renameLabels = labelsWithIds(
    renameEntries,
    (e) => e.value,
    sent,
    "entries",
  );
  const renames: RefusedRename[] = renameEntries.map((e, i) => ({
    label: renameLabels[i],
    requested: e.requested,
    reason: e.reason,
    ...(e.clashWith ? { clashWith: e.clashWith.value } : {}),
  }));
  const renamesTotal = Math.max(
    stored?.renameRefusedTotal ?? 0,
    renames.length,
  );

  if (
    withheldTotal === 0 &&
    !subtreeWalkSkipped &&
    siblingsTotal === 0 &&
    renamesTotal === 0
  ) {
    return null;
  }
  return {
    withheld,
    withheldTotal,
    subtreeWalkSkipped,
    siblings,
    siblingsTotal,
    renames,
    renamesTotal,
  };
}
