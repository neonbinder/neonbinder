/**
 * NEO-220 — "how much work is in this reconciliation session?", as a pure
 * function.
 *
 * Same shape and the same reason as `pairing-session-edits.ts`: the dialog
 * writes nothing until Save, its overlay is click-to-close, and a reconcile of
 * a real set is twenty minutes of dragging. The confirm in front of that
 * discard needs a number, and the number has to come from somewhere testable.
 *
 * ## Why this is a DIFF and not a counter
 *
 * The reducer has no "touched" flag and should not grow one: the modal seeds
 * `ready` from `existingRows`, so a session that has done nothing still opens
 * with a screenful of sets. Only the difference between the seeded state and
 * the live one distinguishes "restored 40 sets" from "built 40 sets". Comparing
 * the two states also makes the count self-correcting — an operator who
 * promotes a pair and then disbands it is back to zero, which is exactly what
 * they would expect the dialog to say.
 *
 * ## What counts as one edit
 *
 *  - A set that exists now and did not before (promote).
 *  - A set that existed and no longer does (disband).
 *  - A surviving set whose NB title changed (rename).
 *  - Each marketplace id attached to, or detached from, a surviving set —
 *    counted per id, because that is the granularity the operator works at.
 *  - A surviving set whose metadata changed.
 *
 * Sets are matched by `key`, the reducer's monotonic session-local id: `title`
 * is the operator's to edit, so keying on it would read a rename as a disband
 * plus a promote.
 */

export type ReconciliationEditItem = { platformValue: string };

export type ReconciliationEditSet = {
  key: string;
  title: string;
  bsc: ReadonlyArray<ReconciliationEditItem>;
  sl: ReadonlyArray<ReconciliationEditItem>;
  metadata?: Record<string, unknown>;
};

export type ReconciliationEditState = {
  ready: ReadonlyArray<ReconciliationEditSet>;
};

/**
 * Order- and undefined-insensitive metadata identity.
 *
 * `{ isInsert: true }` and `{ isInsert: true, isParallel: undefined }` are the
 * same statement; the editor produces both depending on which control was
 * touched last, and a naive compare would report an edit for a checkbox that
 * was ticked and unticked again.
 */
function metadataFingerprint(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0 ? "" : JSON.stringify(entries);
}

/** Symmetric difference of two id lists, by count. */
function idDelta(
  before: ReadonlyArray<ReconciliationEditItem>,
  after: ReadonlyArray<ReconciliationEditItem>,
): number {
  const beforeIds = new Set(before.map((i) => i.platformValue));
  const afterIds = new Set(after.map((i) => i.platformValue));
  let delta = 0;
  for (const id of afterIds) if (!beforeIds.has(id)) delta += 1;
  for (const id of beforeIds) if (!afterIds.has(id)) delta += 1;
  return delta;
}

/** How many operator decisions this session would throw away. */
export function countReconciliationEdits(
  initial: ReconciliationEditState,
  current: ReconciliationEditState,
): number {
  const before = new Map(initial.ready.map((set) => [set.key, set]));
  let edits = 0;

  for (const set of current.ready) {
    const seeded = before.get(set.key);
    if (!seeded) {
      edits += 1; // promoted into existence this session
      continue;
    }
    before.delete(set.key);
    if (seeded.title !== set.title) edits += 1;
    edits += idDelta(seeded.bsc, set.bsc);
    edits += idDelta(seeded.sl, set.sl);
    if (metadataFingerprint(seeded.metadata) !== metadataFingerprint(set.metadata)) {
      edits += 1;
    }
  }

  // Whatever is left in `before` was seeded and is gone: disbanded.
  return edits + before.size;
}
