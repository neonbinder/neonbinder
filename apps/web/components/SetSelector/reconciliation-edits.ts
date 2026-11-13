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
 *  - Each item attached to, or detached from, a surviving set, from any
 *    source (a marketplace id; NEO-496, a checklist section) — counted per
 *    id, because that is the granularity the operator works at.
 *  - A surviving set whose metadata changed.
 *
 * Sets are matched by `key`, the reducer's monotonic session-local id: `title`
 * is the operator's to edit, so keying on it would read a rename as a disband
 * plus a promote.
 */

export type ReconciliationEditItem = { platformValue: string };

type LinkList = ReadonlyArray<ReconciliationEditItem>;

/**
 * A set as the count reads it: its key, title and metadata, plus one list of
 * linked items per source, each under that source's name (`bsc`, `sportlots`,
 * …). NEO-496: every array-valued field IS a source's links, so a new source
 * is counted without this file learning its name. The dialog hands its Ready
 * sets over as `{ key, title, metadata, ...set.links }`.
 */
export type ReconciliationEditSet = {
  key: string;
  title: string;
  metadata?: Record<string, unknown>;
  readonly [source: string]:
    | LinkList
    | string
    | Record<string, unknown>
    | undefined;
};

export type ReconciliationEditState = {
  ready: ReadonlyArray<ReconciliationEditSet>;
};

/**
 * Order- and undefined-insensitive metadata identity.
 *
 * `{ cardNumberPrefix: "DK-" }` and `{ cardNumberPrefix: "DK-",
 * setNamePrefix: undefined }` are the same statement; a set's metadata
 * arrives from the stored row on one path and from the editor on another, and
 * a naive compare would report an edit where nothing was typed.
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

/** A set's link lists, by source: its array-valued fields. */
function linkLists(set: ReconciliationEditSet): Map<string, LinkList> {
  const lists = new Map<string, LinkList>();
  for (const [source, value] of Object.entries(set)) {
    if (Array.isArray(value)) lists.set(source, value as LinkList);
  }
  return lists;
}

/** Ids attached plus ids detached, over every source either side links. */
function linkDelta(
  before: ReconciliationEditSet,
  after: ReconciliationEditSet,
): number {
  const beforeLists = linkLists(before);
  const afterLists = linkLists(after);
  let delta = 0;
  for (const source of new Set([...beforeLists.keys(), ...afterLists.keys()])) {
    delta += idDelta(beforeLists.get(source) ?? [], afterLists.get(source) ?? []);
  }
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
    edits += linkDelta(seeded, set);
    if (metadataFingerprint(seeded.metadata) !== metadataFingerprint(set.metadata)) {
      edits += 1;
    }
  }

  // Whatever is left in `before` was seeded and is gone: disbanded.
  return edits + before.size;
}
