/**
 * NEO-339 — the set-reconciliation decisions, as plain functions.
 *
 * Moved out of `ReconciliationModal` with no change in behaviour: the reducer,
 * the opening state the dialog seeds from a fetch plus the rows already saved,
 * and the items its Save hands to `storeReconciledOptions`. The dialog keeps
 * the rendering, drag and focus handling, and re-exports the reducer and the
 * types so existing imports keep working. The set-building tool
 * (`tools/setbuild/`) seeds, drives and saves through the same functions, so
 * the two send the same payload.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";
import {
  heldIdSets,
  type HeldRow,
} from "../../components/SetSelector/held-elsewhere";
import type { ClashExistingRow } from "../../components/SetSelector/ready-title-clashes";

// ===== TYPES =====

export type PlatformItem = {
  value: string;
  platformValue: string;
};

export type MatchedPair = {
  displayName: string;
  bsc: PlatformItem;
  sl: PlatformItem;
  confidence: number;
};

/**
 * What the modal lets an operator say about a set beyond its title and its
 * marketplace mappings. NEO-291: only the card prefix. Insert/Parallel used to
 * be here as checkboxes, but which of those a row IS is a fact of where it sits
 * in the hierarchy (its level and its variant type), not a box to tick.
 */
export type ItemMetadata = {
  cardNumberPrefix?: string;
};

/**
 * A NeonBinder set under construction.
 *
 * NB is the system of record. A set has a title that belongs to US, and maps
 * to 0-N BSC sets and 0-N SportLots sets — the two sides completely
 * independent of each other. A marketplace id on a set records how that
 * marketplace happens to carve up the same cards; it is not an ownership claim
 * and not a scarce resource, so the same id may appear on any number of sets.
 *
 * This replaced a pair-shaped model (`{bsc, sl}`, one id per side) whose every
 * awkwardness came from treating marketplace sets as exclusive: an item with no
 * partner needed a special "keep as platform-only" shelf, and a set wanted by
 * two rows produced a winner and a loser.
 */
export type ReadySet = {
  /** Stable local key. Not persisted — `title` is the identity on save. */
  key: string;
  /**
   * NEO-211 (plan E): the `selectorOptions` row this set ALREADY is, when it was
   * seeded from `existingRows`. Absent for a set the operator just built here.
   *
   * Before this, the modal had no notion of `_id` at all and `title` WAS the
   * identity on save — so editing a title in this dialog was a delete of the old
   * row and an insert of a new one, taking the row's children, its checklist and
   * every cross-listing pointed at it. Carrying the id makes that edit a rename.
   */
  existingId?: Id<"selectorOptions">;
  /** The NeonBinder set name. Operator-editable; this is our data. */
  title: string;
  bsc: PlatformItem[];
  sl: PlatformItem[];
  metadata?: ItemMetadata;
  /** Auto-match score, for display only. 0 once an operator has touched it. */
  confidence: number;
  /**
   * NEO-325 — made with "Make its own set" (PROMOTE_SOLO). Saved with
   * `identityOnly`: the store matches it by its marketplace ids or inserts it,
   * and never folds it into a same-named row by name — which is what withheld
   * a SportLots twin saved after its namesake. Kept through later attaches and
   * renames: the operator still meant it as its own set.
   */
  ownSet?: boolean;
};

export type ReconciliationState = {
  /** Sets that will be written on save. */
  ready: ReadySet[];
  /** Marketplace sets not yet assigned to any NB set. NOT saved. */
  pendingBsc: PlatformItem[];
  pendingSl: PlatformItem[];
  /** Monotonic source of ReadySet keys. Never rewound, so a key is never reused. */
  seq: number;
};

export type Side = "bsc" | "sl";

export type ReconciliationAction =
  // Two pending items become a new set. The 1:1 case, which is 95%+ of real
  // reconciliation and stays a single drag.
  | { type: "PROMOTE_PAIR"; bsc: PlatformItem; sl: PlatformItem }
  // One item becomes a set on its own. Replaces "keep as platform-only":
  // a set with ids on one side only is ordinary, not special.
  | { type: "PROMOTE_SOLO"; side: Side; item: PlatformItem }
  // NEO-300 — "Keep all": every item a column is SHOWING becomes its own set,
  // in ONE action. A column can list 141 BSC sets; N PROMOTE_SOLOs would be N
  // reducer passes each copying the Ready and Pending arrays (quadratic), and
  // one action is also one undo-able step in the operator's head.
  | { type: "PROMOTE_SOLO_MANY"; side: Side; items: PlatformItem[] }
  // An item joins an existing set. This is what makes 0-N per side reachable,
  // in both directions.
  | { type: "ATTACH"; key: string; side: Side; item: PlatformItem }
  | { type: "DETACH"; key: string; side: Side; platformValue: string }
  | { type: "DISBAND"; key: string }
  | { type: "RENAME"; key: string; title: string }
  | { type: "UPDATE_METADATA"; key: string; metadata: ItemMetadata };

export type ReconciledResult = {
  items: Array<{
    /**
     * NEO-211 (plan E): present when this item came from an existing NB row.
     * The store treats it as the tier-0 match, so a title changed in this dialog
     * renames that row rather than replacing it.
     */
    existingId?: Id<"selectorOptions">;
    value: string;
    // Arrays, not single ids: a set maps to 0-N per side. The mutation has
    // accepted `string | string[]` all along and allocates one slot per
    // element on insert — it was only this modal that could not express it.
    platformData: {
      bsc?: string[];
      sportlots?: string[];
    };
    // Marketplace display name per id, so each slot gets a meaningful label.
    // With several sets on a side, "which one is this" is otherwise unanswerable.
    platformLabels?: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    };
    metadata?: ItemMetadata;
    /**
     * NEO-325 — the operator made this set with "Make its own set". The store
     * matches it by identity only and otherwise inserts it; see
     * `ReadySet.ownSet`. Absent on every other set.
     */
    identityOnly?: true;
  }>;
};

/**
 * Remove an item from a Pending column IF it is there.
 *
 * An item being mapped does NOT consume it: a marketplace set may back any
 * number of NB sets, so the same item can be mapped again later from the
 * "already mapped" reveal. Only the first mapping empties it out of Pending;
 * subsequent ones find nothing to remove and leave the column alone.
 */
function withoutPending(
  list: PlatformItem[],
  item: PlatformItem,
): PlatformItem[] {
  return list.some((i) => i.platformValue === item.platformValue)
    ? list.filter((i) => i.platformValue !== item.platformValue)
    : list;
}

/**
 * Return items to a Pending column, skipping any id already there.
 *
 * NEO-325: Pending is keyed by `platformValue` (React keys, dnd ids, selection),
 * so the same id twice in one column is a key collision. It happens when a
 * marketplace set mapped by two NB sets is detached from, or disbanded out of,
 * both — each return used to append another copy.
 */
function withPendingAdded(
  list: PlatformItem[],
  items: PlatformItem[],
): PlatformItem[] {
  const have = new Set(list.map((i) => i.platformValue));
  const added: PlatformItem[] = [];
  for (const item of items) {
    if (have.has(item.platformValue)) continue;
    have.add(item.platformValue);
    added.push(item);
  }
  return added.length === 0 ? list : [...list, ...added];
}

/**
 * The dialog's reducer. Exported for its unit test and for the set-building
 * tool, which drives the same actions the dialog dispatches.
 */
export function reconciliationReducer(
  state: ReconciliationState,
  action: ReconciliationAction,
): ReconciliationState {
  switch (action.type) {
    case "PROMOTE_PAIR": {
      return {
        ...state,
        seq: state.seq + 1,
        ready: [
          ...state.ready,
          {
            key: `set-${state.seq}`,
            // BSC names are closer to how collectors say a set's name, so it
            // wins the default. The operator can rename — the title is ours.
            title: action.bsc.value,
            bsc: [action.bsc],
            sl: [action.sl],
            confidence: 0,
          },
        ],
        pendingBsc: withoutPending(state.pendingBsc, action.bsc),
        pendingSl: withoutPending(state.pendingSl, action.sl),
      };
    }
    case "PROMOTE_SOLO": {
      return {
        ...state,
        seq: state.seq + 1,
        ready: [
          ...state.ready,
          {
            key: `set-${state.seq}`,
            title: action.item.value,
            bsc: action.side === "bsc" ? [action.item] : [],
            sl: action.side === "sl" ? [action.item] : [],
            confidence: 0,
            ownSet: true,
          },
        ],
        pendingBsc:
          action.side === "bsc"
            ? withoutPending(state.pendingBsc, action.item)
            : state.pendingBsc,
        pendingSl:
          action.side === "sl"
            ? withoutPending(state.pendingSl, action.item)
            : state.pendingSl,
      };
    }
    case "PROMOTE_SOLO_MANY": {
      // Exactly PROMOTE_SOLO applied to each item in order — same title, same
      // one-sided mapping, keys drawn from the same never-rewound `seq` — but
      // one pass. An item listed twice becomes one set, not two.
      const seen = new Set<string>();
      const items = action.items.filter((i) => {
        if (seen.has(i.platformValue)) return false;
        seen.add(i.platformValue);
        return true;
      });
      if (items.length === 0) return state;
      const created: ReadySet[] = items.map((item, n) => ({
        key: `set-${state.seq + n}`,
        title: item.value,
        bsc: action.side === "bsc" ? [item] : [],
        sl: action.side === "sl" ? [item] : [],
        confidence: 0,
        // NEO-325 — "Keep all" is "Make its own set" on every row, so each
        // set it makes is saved by identity (`identityOnly`) the same way.
        ownSet: true,
      }));
      const drop = (list: PlatformItem[]) =>
        list.filter((i) => !seen.has(i.platformValue));
      return {
        ...state,
        seq: state.seq + items.length,
        ready: [...state.ready, ...created],
        pendingBsc: action.side === "bsc" ? drop(state.pendingBsc) : state.pendingBsc,
        pendingSl: action.side === "sl" ? drop(state.pendingSl) : state.pendingSl,
      };
    }
    case "ATTACH": {
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      // Same marketplace id twice on ONE set would make two slots pointing at
      // the same place. Across DIFFERENT sets it is fine and expected — that is
      // the 1996 Score case, where one SportLots set legitimately backs two NB
      // sets — so this check is per-set, never global.
      const existing = action.side === "bsc" ? target.bsc : target.sl;
      if (existing.some((i) => i.platformValue === action.item.platformValue)) {
        return state;
      }
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key
            ? {
                ...s,
                bsc: action.side === "bsc" ? [...s.bsc, action.item] : s.bsc,
                sl: action.side === "sl" ? [...s.sl, action.item] : s.sl,
              }
            : s,
        ),
        pendingBsc:
          action.side === "bsc"
            ? withoutPending(state.pendingBsc, action.item)
            : state.pendingBsc,
        pendingSl:
          action.side === "sl"
            ? withoutPending(state.pendingSl, action.item)
            : state.pendingSl,
      };
    }
    case "DETACH": {
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      const from = action.side === "bsc" ? target.bsc : target.sl;
      const item = from.find((i) => i.platformValue === action.platformValue);
      if (!item) return state;
      const remaining = from.filter(
        (i) => i.platformValue !== action.platformValue,
      );
      const nextSet: ReadySet = {
        ...target,
        bsc: action.side === "bsc" ? remaining : target.bsc,
        sl: action.side === "sl" ? remaining : target.sl,
      };
      // A set with nothing mapped has no reason to exist — it would save as a
      // row with an empty platformData and never sync anything.
      const emptied = nextSet.bsc.length === 0 && nextSet.sl.length === 0;
      return {
        ...state,
        ready: emptied
          ? state.ready.filter((s) => s.key !== action.key)
          : state.ready.map((s) => (s.key === action.key ? nextSet : s)),
        pendingBsc:
          action.side === "bsc"
            ? withPendingAdded(state.pendingBsc, [item])
            : state.pendingBsc,
        pendingSl:
          action.side === "sl"
            ? withPendingAdded(state.pendingSl, [item])
            : state.pendingSl,
      };
    }
    case "DISBAND": {
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      return {
        ...state,
        ready: state.ready.filter((s) => s.key !== action.key),
        pendingBsc: withPendingAdded(state.pendingBsc, target.bsc),
        pendingSl: withPendingAdded(state.pendingSl, target.sl),
      };
    }
    case "RENAME": {
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key ? { ...s, title: action.title } : s,
        ),
      };
    }
    case "UPDATE_METADATA": {
      return {
        ...state,
        ready: state.ready.map((s) =>
          s.key === action.key
            ? { ...s, metadata: { ...(s.metadata ?? {}), ...action.metadata } }
            : s,
        ),
      };
    }
    default:
      return state;
  }
}

/**
 * A row already saved under the parent, as the dialog's `existingRows` prop
 * carries it.
 */
export type ExistingReconcileRow = {
  /** The row's own `_id` — see `ReadySet.existingId`. Optional so callers
   *  that predate NEO-211 (and the tests that construct rows by hand) keep
   *  working; without it a title edit is still delete-and-insert. */
  existingId?: Id<"selectorOptions">;
  value: string;
  platformData: { bsc?: string | string[]; sportlots?: string | string[] };
  metadata?: ItemMetadata;
};

/** What the dialog opens on: the fetch, and everything that holds back an id. */
export type ReconciliationSeedInput = {
  /** The fetch — `initialData` on the dialog. */
  fetch: {
    autoMatched: MatchedPair[];
    unmatchedBsc: PlatformItem[];
    unmatchedSl: PlatformItem[];
  };
  existingRows?: readonly ExistingReconcileRow[];
  /** NEO-300 — rows outside this level that hold fetched ids. */
  heldElsewhere?: { rows: readonly HeldRow[] };
  /** NEO-305 — rows in another set of the brand that hold fetched ids. */
  heldInBrand?: { rows: readonly HeldRow[] };
  /** The dialog's `usedBscPlatformValues` / `usedSlPlatformValues`. */
  usedIds?: { bsc?: readonly string[]; sportlots?: readonly string[] };
};

export type ReconciliationSeed = {
  state: ReconciliationState;
  /** Every saved row under the parent, for `readyTitleClashes`. */
  savedSiblings: ClashExistingRow[];
};

/**
 * The dialog's opening state, built once from a snapshot of the fetch plus
 * `existingRows`. Moved verbatim from `ReconciliationModal`'s seed `useMemo`.
 *
 * Previously-saved rows come back as Ready sets with ALL of their mappings
 * restored. The old code kept only the first id per side (`firstBsc`), which
 * silently dropped operator-attached extras every time the modal reopened —
 * invisible, because the row still looked plausible with one id.
 *
 * NEO-325: the same pass records every saved row under the parent — the
 * ones seeded into Ready and the ones that were not — so Save can refuse a
 * title that would sit beside one of them (`readyTitleClashes`).
 */
export function seedReconciliationState(
  input: ReconciliationSeedInput,
): ReconciliationSeed {
  const initialData = input.fetch;
  const existingRows = input.existingRows ?? [];
  const heldElsewhere = input.heldElsewhere;
  const heldInBrand = input.heldInBrand;
  const usedBscPlatformValues = input.usedIds?.bsc ?? [];
  const usedSlPlatformValues = input.usedIds?.sportlots ?? [];
  const ready: ReadySet[] = [];
  const savedSiblings: ClashExistingRow[] = [];
  const usedBsc = new Set<string>();
  const usedSl = new Set<string>();
  let seq = 0;

  // platformValue → freshest PlatformItem, so restored rows show the current
  // marketplace display name rather than the NB title we saved them under.
  const bscByPv = new Map<string, PlatformItem>();
  for (const item of initialData.unmatchedBsc) bscByPv.set(item.platformValue, item);
  for (const m of initialData.autoMatched) bscByPv.set(m.bsc.platformValue, m.bsc);
  const slByPv = new Map<string, PlatformItem>();
  for (const item of initialData.unmatchedSl) slByPv.set(item.platformValue, item);
  for (const m of initialData.autoMatched) slByPv.set(m.sl.platformValue, m.sl);

  const toIds = (v: string | string[] | undefined): string[] =>
    typeof v === "string" ? [v] : Array.isArray(v) ? v : [];

  for (const row of existingRows) {
    const bscIds = toIds(row.platformData.bsc);
    const slIds = toIds(row.platformData.sportlots);
    if (bscIds.length === 0 && slIds.length === 0) {
      // Not seeded: a row with no marketplace ids has nothing to reconcile,
      // but it is still a set under this parent with this name.
      savedSiblings.push({ name: row.value, bsc: [], sportlots: [] });
      continue;
    }
    const key = `set-${seq++}`;
    savedSiblings.push({
      name: row.value,
      bsc: bscIds,
      sportlots: slIds,
      seededKey: key,
    });
    ready.push({
      key,
      existingId: row.existingId,
      title: row.value,
      bsc: bscIds.map(
        (id) => bscByPv.get(id) ?? { value: row.value, platformValue: id },
      ),
      sl: slIds.map(
        (id) => slByPv.get(id) ?? { value: row.value, platformValue: id },
      ),
      confidence: 0,
      // NEO-291: project to the one field the modal edits. Callers hand
      // over the row's whole stored metadata (`setNamePrefix`,
      // `isBrandUnknown` and the rest), which tsc accepts structurally but
      // `storeReconciledOptions`' `v.object` rejects at runtime.
      metadata: row.metadata?.cardNumberPrefix
        ? { cardNumberPrefix: row.metadata.cardNumberPrefix }
        : undefined,
    });
    for (const id of bscIds) usedBsc.add(id);
    for (const id of slIds) usedSl.add(id);
  }

  // NEO-300: ids another NB row already holds (a grouped parallel, for
  // Sync Inserts). Seeded AFTER the restored rows so they never stop this
  // level's own rows coming back, and BEFORE the auto-matches so a grouped
  // set is not handed back as a fresh Ready set — which is exactly how a
  // Sync Inserts after Group Parallels re-created every grouped row.
  // NEO-305: ids another set in the brand holds are held the same way.
  const held = heldIdSets([
    ...(heldElsewhere?.rows ?? []),
    ...(heldInBrand?.rows ?? []),
  ]);
  // NEO-312: ids the caller says rows ELSEWHERE in the set hold
  // (`used*PlatformValues`) are held too. Before, they only trimmed Pending,
  // so after "Make insert of…" moved a SportLots link to another variant
  // type, the next sync auto-matched it straight back into Ready and Save
  // put that one link on a second NB row. Less the ids this sync's own
  // restored rows carry: a Sub-Variants caller's list includes its own
  // parallels, and those must keep coming back as this sync's rows.
  // `usedBsc`/`usedSl` hold exactly the restored ids at this point.
  for (const id of usedBscPlatformValues) {
    if (!usedBsc.has(id)) held.bsc.add(id);
  }
  for (const id of usedSlPlatformValues) {
    if (!usedSl.has(id)) held.sportlots.add(id);
  }
  for (const id of held.bsc) usedBsc.add(id);
  for (const id of held.sportlots) usedSl.add(id);
  // The unheld half of an auto-match whose other half is held: an ordinary
  // unassigned marketplace set, so it goes to Pending rather than vanishing.
  const releasedBsc: PlatformItem[] = [];
  const releasedSl: PlatformItem[] = [];
  // Only the rows restored from `existingRows` take an attached half below;
  // the auto-match sets pushed after them are the reconciler's guesses, not
  // our data, and a second guess is not joined onto a first.
  const restoredCount = ready.length;

  // Auto-matches. These are suggestions the reconciler made; a pair that
  // collides with nothing arrives as a Ready set because 95%+ of them are
  // right, and a wrong one is one ✕ away from Pending. A pair that collides
  // on ONE half is not skipped whole: its other half is attached or released
  // (NEO-306, below), because a skipped half is a link nobody can make.
  for (const m of initialData.autoMatched) {
    const bscHeld = held.bsc.has(m.bsc.platformValue);
    const slHeld = held.sportlots.has(m.sl.platformValue);
    if (bscHeld !== slHeld) {
      if (!bscHeld) releasedBsc.push(m.bsc);
      if (!slHeld) releasedSl.push(m.sl);
    }
    // A held half is never attached anywhere, and its unheld partner was
    // just released above: the NEO-300/305 path, untouched by NEO-306.
    if (bscHeld || slHeld) continue;
    const bscUsed = usedBsc.has(m.bsc.platformValue);
    const slUsed = usedSl.has(m.sl.platformValue);
    if (bscUsed && slUsed) continue;
    if (bscUsed || slUsed) {
      // Exactly one half is already mapped. NEO-306: the SportLots review
      // files "Blue" as a parallel holding its SL id, and the next Sync
      // Parallels auto-matches BSC "Blue" with that same SL id. Skipping
      // the whole pair (the old behaviour) dropped BSC Blue on the floor:
      // in neither Ready nor Pending, so it could never be linked.
      //
      // The free half joins the ONE restored row that carries the used
      // half's id — matched by id, never by name — as an ordinary attached
      // chip the operator can ✕ back to Pending. The free half is held or
      // placed nowhere (`used*` holds every held and restored id and every
      // id placed so far), so the attach duplicates nothing. A free half the
      // caller's `used*PlatformValues` names never reaches here: it is held
      // (NEO-312, above) and took the held branch. In every case with no
      // single row to join — no restored row carries that id (an earlier
      // auto-match placed it), or two do (a shared marketplace id) — it goes
      // to Pending, where it is handled like any loose item.
      const side: Side = bscUsed ? "sl" : "bsc";
      const usedPv = bscUsed ? m.bsc.platformValue : m.sl.platformValue;
      const free = side === "bsc" ? m.bsc : m.sl;
      const owners: number[] = [];
      for (let i = 0; i < restoredCount; i++) {
        const mapped = bscUsed ? ready[i].bsc : ready[i].sl;
        if (mapped.some((it) => it.platformValue === usedPv)) owners.push(i);
      }
      if (owners.length === 1) {
        const row = ready[owners[0]];
        ready[owners[0]] =
          side === "bsc"
            ? { ...row, bsc: [...row.bsc, free] }
            : { ...row, sl: [...row.sl, free] };
        (side === "bsc" ? usedBsc : usedSl).add(free.platformValue);
      } else {
        (side === "bsc" ? releasedBsc : releasedSl).push(free);
      }
      continue;
    }
    ready.push({
      key: `set-${seq++}`,
      title: m.displayName,
      bsc: [m.bsc],
      sl: [m.sl],
      confidence: m.confidence,
    });
    usedBsc.add(m.bsc.platformValue);
    usedSl.add(m.sl.platformValue);
  }

  const pendingOf = (items: PlatformItem[], used: Set<string>) => {
    const seen = new Set<string>();
    return items.filter((it) => {
      if (used.has(it.platformValue) || seen.has(it.platformValue)) {
        return false;
      }
      seen.add(it.platformValue);
      return true;
    });
  };
  const state: ReconciliationState = {
    ready,
    pendingBsc: pendingOf([...initialData.unmatchedBsc, ...releasedBsc], usedBsc),
    pendingSl: pendingOf([...initialData.unmatchedSl, ...releasedSl], usedSl),
    seq,
  };
  return { state, savedSiblings };
}

/**
 * The items Save hands to `storeReconciledOptions`, one per Ready set, in
 * Ready order. Moved verbatim from `ReconciliationModal`'s `handleConfirm`.
 *
 * Anything left in Pending is intentionally not here — SL especially returns
 * siblings from other variantTypes that don't belong.
 */
export function buildReconciledItems(
  ready: readonly ReadySet[],
): ReconciledResult["items"] {
  return ready.map((set) => {
    const bscLabels: Record<string, string> = {};
    for (const i of set.bsc) bscLabels[i.platformValue] = i.value;
    const slLabels: Record<string, string> = {};
    for (const i of set.sl) slLabels[i.platformValue] = i.value;

    return {
      // Undefined for a set built in this dialog, which is exactly right:
      // the store then falls through to its id/value matcher.
      existingId: set.existingId,
      value: set.title.trim() || set.bsc[0]?.value || set.sl[0]?.value || "",
      platformData: {
        ...(set.bsc.length > 0
          ? { bsc: set.bsc.map((i) => i.platformValue) }
          : {}),
        ...(set.sl.length > 0
          ? { sportlots: set.sl.map((i) => i.platformValue) }
          : {}),
      },
      ...(set.bsc.length > 0 || set.sl.length > 0
        ? {
            platformLabels: {
              ...(set.bsc.length > 0 ? { bsc: bscLabels } : {}),
              ...(set.sl.length > 0 ? { sportlots: slLabels } : {}),
            },
          }
        : {}),
      metadata: set.metadata,
      // NEO-325: a set the operator made its own is matched by identity
      // only, so a SportLots twin saved after its namesake is stored as
      // its own row rather than withheld against the namesake by name.
      ...(set.ownSet ? { identityOnly: true as const } : {}),
    };
  });
}

// ===== EXPLICIT PAIRS (set-building tool only) =====

/**
 * One NB set the spec asks for, named by marketplace id. The dialog has no
 * equivalent value — this is what an operator's drags add up to.
 */
export type ExplicitPair = {
  /** The NB set's title. */
  name: string;
  bsc?: readonly string[];
  sportlots?: readonly string[];
};

/** What to do with one marketplace set the spec leaves out of every pair. */
export type ExplicitPending = {
  side: "bsc" | "sportlots";
  id: string;
  /** "own-set" is the row's "Make its own set"; "leave" leaves it in Pending, which Save discards. */
  decision: "own-set" | "leave";
};

export type ExplicitPairsOutcome = {
  /** The state after every pair and pending decision that could be applied. */
  state: ReconciliationState;
  /**
   * Pairs naming an id that is not in the dialog (or, with `opts.fetched`, not
   * in the fetch), or naming no id at all. NOT applied, not even in part:
   * an id is never matched to its nearest neighbour.
   */
  unmatchedPairs: Array<{
    pair: ExplicitPair;
    missing: Array<{ side: "bsc" | "sportlots"; id: string }>;
  }>;
  /** Pairs whose exact ids two or more Ready sets carry. NOT applied. */
  ambiguousPairs: ExplicitPair[];
  /** Pending decisions whose id is not waiting in Pending once the pairs are placed. NOT applied. */
  unmatchedPending: Array<{
    entry: ExplicitPending;
    reason: "not-in-fetch" | "not-pending";
  }>;
  /** Marketplace sets still in Pending that no pending decision names. */
  unaddressedPending: Array<{ side: "bsc" | "sportlots"; item: PlatformItem }>;
  /** Restored rows (`existingId`) no pair names. Left exactly as they were. */
  unaddressedReady: ReadySet[];
  /** Auto-matched Ready sets no pair names, sent back to Pending (the row's ✕). */
  disbanded: ReadySet[];
};

const toReducerSide = (side: "bsc" | "sportlots"): Side =>
  side === "bsc" ? "bsc" : "sl";
const fromReducerSide = (side: Side): "bsc" | "sportlots" =>
  side === "bsc" ? "bsc" : "sportlots";

function sameIds(items: readonly PlatformItem[], ids: readonly string[]): boolean {
  const have = new Set(items.map((i) => i.platformValue));
  const want = new Set(ids);
  if (have.size !== want.size) return false;
  for (const id of want) if (!have.has(id)) return false;
  return true;
}

/**
 * NEO-339 — apply a spec's explicit pairs to a seeded state, through the same
 * reducer actions the dialog's drags dispatch. Set-building tool only; the
 * dialog never calls it.
 *
 * Nothing here is decided by position or by name:
 *  - every id is looked up exactly; one that is not in the dialog (or not in
 *    `opts.fetched`, when given) makes its whole pair unmatched;
 *  - a pair whose ids exactly equal ONE Ready set's ids claims that set (a
 *    restored row keeps its `existingId`) and renames it when the title
 *    differs; two such sets make the pair ambiguous;
 *  - an auto-matched Ready set (no `existingId`) that no pair claims is
 *    disbanded — the spec lists every set it wants, so one it leaves out is
 *    the operator's ✕ — and its ids land in Pending, where a pending decision
 *    has to name them;
 *  - a restored row no pair claims is left alone and reported;
 *  - every other pair becomes a new set: `PROMOTE_PAIR` on its first id per
 *    side (or `PROMOTE_SOLO` when it has one side, which is "Make its own
 *    set"), `ATTACH` for the rest, then `RENAME`. An id that already sits in
 *    a Ready set is shared, not moved — a marketplace set may back any
 *    number of NB sets, exactly as the dialog's "already mapped" reveal
 *    allows;
 *  - pending decisions run last, in order: "own-set" is `PROMOTE_SOLO`,
 *    "leave" does nothing.
 *
 * New sets are appended in pair order, which is the order Save sends them.
 */
export function applyExplicitPairs(
  initial: ReconciliationState,
  pairs: readonly ExplicitPair[],
  pending: readonly ExplicitPending[],
  opts: { fetched?: { bsc: Iterable<string>; sportlots: Iterable<string> } } = {},
): ExplicitPairsOutcome {
  let state = initial;
  const dispatch = (action: ReconciliationAction) => {
    state = reconciliationReducer(state, action);
  };

  // Every item the dialog can place, by side and id: Pending first, then any
  // Ready set (an id a set already holds can still be mapped again).
  const known: Record<Side, Map<string, PlatformItem>> = {
    bsc: new Map(),
    sl: new Map(),
  };
  for (const set of initial.ready) {
    for (const item of set.bsc) known.bsc.set(item.platformValue, item);
    for (const item of set.sl) known.sl.set(item.platformValue, item);
  }
  for (const item of initial.pendingBsc) known.bsc.set(item.platformValue, item);
  for (const item of initial.pendingSl) known.sl.set(item.platformValue, item);
  const fetched = opts.fetched
    ? { bsc: new Set(opts.fetched.bsc), sl: new Set(opts.fetched.sportlots) }
    : null;
  const present = (side: Side, id: string) =>
    known[side].has(id) && (!fetched || fetched[side].has(id));

  const unmatchedPairs: ExplicitPairsOutcome["unmatchedPairs"] = [];
  const ambiguousPairs: ExplicitPair[] = [];
  const valid: ExplicitPair[] = [];
  for (const pair of pairs) {
    const bsc = pair.bsc ?? [];
    const sl = pair.sportlots ?? [];
    const missing = [
      ...bsc
        .filter((id) => !present("bsc", id))
        .map((id) => ({ side: "bsc" as const, id })),
      ...sl
        .filter((id) => !present("sl", id))
        .map((id) => ({ side: "sportlots" as const, id })),
    ];
    if (missing.length > 0 || bsc.length + sl.length === 0) {
      unmatchedPairs.push({ pair, missing });
    } else {
      valid.push(pair);
    }
  }

  // Claim the Ready sets the spec names exactly.
  const claimed = new Map<ExplicitPair, string>();
  const claimedKeys = new Set<string>();
  for (const pair of valid) {
    const matches = initial.ready.filter(
      (set) =>
        !claimedKeys.has(set.key) &&
        sameIds(set.bsc, pair.bsc ?? []) &&
        sameIds(set.sl, pair.sportlots ?? []),
    );
    if (matches.length > 1) {
      ambiguousPairs.push(pair);
      continue;
    }
    if (matches.length === 1) {
      claimed.set(pair, matches[0].key);
      claimedKeys.add(matches[0].key);
    }
  }

  // Auto-matches the spec leaves out go back to Pending; restored rows stay.
  const disbanded: ReadySet[] = [];
  const unaddressedReady: ReadySet[] = [];
  for (const set of initial.ready) {
    if (claimedKeys.has(set.key)) continue;
    if (set.existingId) {
      unaddressedReady.push(set);
      continue;
    }
    disbanded.push(set);
    dispatch({ type: "DISBAND", key: set.key });
  }

  const ambiguous = new Set(ambiguousPairs);
  for (const pair of valid) {
    if (ambiguous.has(pair)) continue;
    const claimedKey = claimed.get(pair);
    if (claimedKey !== undefined) {
      const set = state.ready.find((s) => s.key === claimedKey);
      if (set && set.title !== pair.name) {
        dispatch({ type: "RENAME", key: claimedKey, title: pair.name });
      }
      continue;
    }
    const bsc = (pair.bsc ?? []).map((id) => known.bsc.get(id)!);
    const sl = (pair.sportlots ?? []).map((id) => known.sl.get(id)!);
    const key = `set-${state.seq}`;
    if (bsc.length > 0 && sl.length > 0) {
      dispatch({ type: "PROMOTE_PAIR", bsc: bsc[0], sl: sl[0] });
      for (const item of bsc.slice(1)) dispatch({ type: "ATTACH", key, side: "bsc", item });
      for (const item of sl.slice(1)) dispatch({ type: "ATTACH", key, side: "sl", item });
    } else {
      const side: Side = bsc.length > 0 ? "bsc" : "sl";
      const items = bsc.length > 0 ? bsc : sl;
      dispatch({ type: "PROMOTE_SOLO", side, item: items[0] });
      for (const item of items.slice(1)) dispatch({ type: "ATTACH", key, side, item });
    }
    const made = state.ready.find((s) => s.key === key);
    if (made && made.title !== pair.name) {
      dispatch({ type: "RENAME", key, title: pair.name });
    }
  }

  const unmatchedPending: ExplicitPairsOutcome["unmatchedPending"] = [];
  const left = { bsc: new Set<string>(), sl: new Set<string>() };
  for (const entry of pending) {
    const side = toReducerSide(entry.side);
    if (!present(side, entry.id)) {
      unmatchedPending.push({ entry, reason: "not-in-fetch" });
      continue;
    }
    const list = side === "bsc" ? state.pendingBsc : state.pendingSl;
    const item = list.find((i) => i.platformValue === entry.id);
    if (!item) {
      unmatchedPending.push({ entry, reason: "not-pending" });
      continue;
    }
    if (entry.decision === "own-set") {
      dispatch({ type: "PROMOTE_SOLO", side, item });
    } else {
      left[side].add(entry.id);
    }
  }

  const unaddressedPending: ExplicitPairsOutcome["unaddressedPending"] = [];
  for (const side of ["bsc", "sl"] as const) {
    const list = side === "bsc" ? state.pendingBsc : state.pendingSl;
    for (const item of list) {
      if (!left[side].has(item.platformValue)) {
        unaddressedPending.push({ side: fromReducerSide(side), item });
      }
    }
  }

  return {
    state,
    unmatchedPairs,
    ambiguousPairs,
    unmatchedPending,
    unaddressedPending,
    unaddressedReady,
    disbanded,
  };
}
