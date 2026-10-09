/**
 * NEO-325 — Save is blocked while two NeonBinder sets in the reconciler would
 * be saved under one parent with the same title.
 *
 * "Make its own set" on two SportLots twins ("Anime" ×3 in one year) makes
 * Ready sets that all start out with the marketplace's shared name. Saved like
 * that they become sibling rows nobody can tell apart in a column, a picker or
 * a checklist header, and the store cannot tell them apart by name either. The
 * operator renames one; Save comes back the moment the titles differ.
 *
 * The comparison is `nameKey` — the fold `sharedTitleLabels` uses — so
 * "Anime" and " anime " are the same title, exactly as they are to the
 * accessible names the reconciler already gives same-titled rows.
 *
 * ## Titles the operator is still typing
 *
 * A Ready row's title input commits on blur / Enter (a keystroke-level RENAME
 * would re-render every row and column of the dialog). The caller passes the
 * live drafts in `drafts`, so a rename that resolves a clash re-enables Save
 * before the field is left, and one that creates a clash disables it at once.
 * An empty draft does not count: committing it snaps back to the old title.
 *
 * ## Rows already saved under the parent
 *
 * The modal knows the parent's saved rows from `existingRows`. A row with
 * marketplace ids is seeded into Ready (its live title is in `ready`); a row
 * with none is not, and neither is a seeded one the operator removed with ✕
 * (the store never deletes it, so it stays under the parent with its saved
 * name). Those are `existing` here, and a Ready set clashes with one only
 * when saving would really put a second row with that name beside it:
 *
 *  - they share a marketplace id → no clash: the store matches the Ready set
 *    to that row by id, so it IS that row;
 *  - the Ready set was made with "Make its own set" (`ownSet`, sent as
 *    `identityOnly`) → clash: the store never matches it by name and would
 *    insert it as a new same-named row;
 *  - otherwise the store matches by name: onto a row with no ids, which links
 *    it (no clash — the ordinary way a hand-made row picks up its marketplace
 *    ids); or not onto a row that holds other ids, which it withholds rather
 *    than save (a clash: the operator renames this one so it saves).
 */
import { nameKey } from "./marketplace-item-label";

export type ClashReadySet = {
  key: string;
  title: string;
  /** Made with "Make its own set" — saved by identity only. */
  ownSet?: boolean;
  bsc: ReadonlyArray<{ platformValue: string }>;
  sl: ReadonlyArray<{ platformValue: string }>;
};

export type ClashExistingRow = {
  /** The saved NeonBinder name. */
  name: string;
  bsc: readonly string[];
  sportlots: readonly string[];
  /**
   * The Ready key this row was seeded as, when it had ids to seed. While that
   * Ready set exists its live title speaks for the row; once it is removed,
   * the row stands under its saved `name`.
   */
  seededKey?: string;
};

export type TitleClash = {
  /** The shared title, folded (`nameKey`). Stable while the clash lasts. */
  key: string;
  /** The title as the first clashing Ready set spells it, trimmed. */
  title: string;
  /** Every Ready set carrying the title, in Ready order. */
  readyKeys: string[];
  /** Saved rows under the parent that would sit beside them with it. */
  existingCount: number;
};

function shareAnId(set: ClashReadySet, row: ClashExistingRow): boolean {
  const bsc = new Set(row.bsc);
  const sl = new Set(row.sportlots);
  return (
    set.bsc.some((i) => bsc.has(i.platformValue)) ||
    set.sl.some((i) => sl.has(i.platformValue))
  );
}

function savingBesideIt(set: ClashReadySet, row: ClashExistingRow): boolean {
  if (shareAnId(set, row)) return false;
  if (set.ownSet) return true;
  return row.bsc.length > 0 || row.sportlots.length > 0;
}

/** The title a Ready set will save under, counting an uncommitted draft. */
function liveTitle(
  set: ClashReadySet,
  drafts: ReadonlyMap<string, string>,
): string {
  const draft = drafts.get(set.key);
  return draft !== undefined && draft.trim() ? draft : set.title;
}

export function readyTitleClashes(
  ready: ReadonlyArray<ClashReadySet>,
  drafts: ReadonlyMap<string, string> = new Map(),
  existing: ReadonlyArray<ClashExistingRow> = [],
): TitleClash[] {
  const byKey = new Map<string, { title: string; sets: ClashReadySet[] }>();
  for (const set of ready) {
    const title = liveTitle(set, drafts).trim();
    const key = nameKey(title);
    if (!key) continue;
    const group = byKey.get(key);
    if (group) group.sets.push(set);
    else byKey.set(key, { title, sets: [set] });
  }

  const readyKeys = new Set(ready.map((s) => s.key));
  const standing = existing.filter(
    (row) => row.seededKey === undefined || !readyKeys.has(row.seededKey),
  );

  const clashes: TitleClash[] = [];
  for (const [key, { title, sets }] of byKey) {
    const namesakes = standing.filter((row) => nameKey(row.name) === key);
    if (sets.length >= 2) {
      clashes.push({
        key,
        title,
        readyKeys: sets.map((s) => s.key),
        // A saved row one of these sets matches by id IS that set, so it is
        // not counted a second time.
        existingCount: namesakes.filter(
          (row) =>
            !sets.some((set) => shareAnId(set, row)) &&
            sets.some((set) => savingBesideIt(set, row)),
        ).length,
      });
      continue;
    }
    const [only] = sets;
    const besideIt = namesakes.filter((row) => savingBesideIt(only, row));
    if (besideIt.length > 0) {
      clashes.push({
        key,
        title,
        readyKeys: [only.key],
        existingCount: besideIt.length,
      });
    }
  }
  return clashes;
}

/**
 * A string that changes exactly when the clashes (and anything their message
 * says) change. Lets the modal re-render on a draft keystroke ONLY when that
 * keystroke starts or ends a clash, not on every character.
 */
export function titleClashSignature(clashes: ReadonlyArray<TitleClash>): string {
  return clashes
    .map(
      (c) =>
        `${c.key}\u0000${c.title}\u0000${c.readyKeys.join(",")}\u0000${c.existingCount}`,
    )
    .join("\u0001");
}

/**
 * The sentence beside Save. Two Ready sets: Jason's accepted wording. Three or
 * more: the count. One Ready set beside a saved row: names the saved one, since
 * only the Ready one can be renamed here, and says WHERE it is when the caller
 * knows the parent's name (`scope`, e.g. "2024 Topps Chrome › Inserts").
 *
 * Names are quoted with curly quotes, the house style for a quoted name.
 *
 * Jason accepted the two-set sentence (NEO-325; the quotes were straight
 * then); the other two are DRAFT, pending his sign-off.
 */
export function titleClashMessage(clash: TitleClash, scope?: string): string {
  const total = clash.readyKeys.length + clash.existingCount;
  if (clash.readyKeys.length === 1) {
    const where = scope ? `under ${scope}` : "here";
    return `There's already a set named “${clash.title}” ${where}. Rename this one so you can tell them apart.`;
  }
  if (total === 2) {
    return `Two sets are both named “${clash.title}”. Rename one so you can tell them apart.`;
  }
  return `${total} sets are all named “${clash.title}”. Rename them so you can tell them apart.`;
}

/**
 * NEO-325 — the short line under a clashing title or name field, so the clash
 * is not marked by the field's pink border alone. The footer sentence still
 * says which name and why Save waits; this says which FIELDS.
 * DRAFT, pending Jason's sign-off.
 */
export const TITLE_CLASH_ROW_LINE = "Same name as another set.";

/**
 * NEO-325 — the hint beside a rename that has to tell twins apart. A tip,
 * never a prefill: the name is the operator's to choose.
 * DRAFT, pending Jason's sign-off.
 */
export const RENAME_TIP = "Tip: add the release, like “Series 1” or “Update”.";
