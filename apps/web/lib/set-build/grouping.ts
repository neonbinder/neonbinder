/**
 * The Group Parallels session as plain functions: the reducer the modal
 * dispatches to, the tree → state builder it opens on, and the diff it saves.
 *
 * NEO-339 moved these out of `components/SetSelector/ParallelGroupingModal.tsx`
 * with no change in behaviour, so the set-building tool (`tools/setbuild/`)
 * groups rows through the very rules the modal enforces. The modal imports
 * and re-exports them.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports (type imports aside), so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";
import { detectGroupings } from "../../components/SetSelector/parallelDetection";

export type RowId = Id<"selectorOptions">;

export type Placement =
  | { kind: "ungrouped" }
  | { kind: "child"; parentId: RowId };

export type RowInfo = {
  _id: RowId;
  value: string;
  originalKind: "insert" | "parallel";
  originalParentId: RowId | null;
  // True for inserts that had parallel children at modal open. Such rows
  // can't themselves be moved (would orphan their existing parallels and
  // would create a parallels-of-parallels structure the schema doesn't
  // support).
  originalHadParallels: boolean;
};

export type GroupingState = {
  rows: Map<RowId, RowInfo>;
  placement: Map<RowId, Placement>;
  // Rows whose current placement was set by auto-detection. Cleared per row
  // when the user explicitly accepts (Accept All) or moves the row.
  suggested: Set<RowId>;
  /**
   * NEO-300 — the rows picked to move together, in the order they were
   * picked. One row is today's single select; click-to-place and a drag of
   * any picked row move all of them.
   *
   * Only MOVABLE rows are ever in here: a row holding parallels cannot be
   * ticked, a range skips it, and a row that starts holding parallels drops
   * out (see MOVE). So every row in a move is valid by construction, and the
   * reducer's own checks are the backstop, not the gate.
   */
  selected: RowId[];
  /** Where a Shift range starts: the last row clicked, ticked or toggled. */
  anchor: RowId | null;
  /**
   * The selection OUTSIDE the current Shift range, captured when the anchor
   * was set. A second Shift+click from the same anchor replaces the range
   * instead of piling onto it, so it can shrink as well as grow.
   */
  rangeBase: RowId[];
  hasInitialized: boolean;
};

type State = GroupingState;

export type GroupingAction =
  | {
      type: "INIT";
      rows: Map<RowId, RowInfo>;
      placement: Map<RowId, Placement>;
      suggested: Set<RowId>;
    }
  | { type: "RESET" }
  /**
   * Every placement change, one row or many, in ONE dispatch: a drop of six
   * rows is one render and one diff. `fromSelection` says the rows ARE the
   * selection (click-to-place, a drag of a selected row) — the selection is
   * spent. Otherwise (✕, a drag of an unselected row) the selection
   * survives, less any row the move made unmovable.
   */
  | {
      type: "MOVE";
      rowIds: RowId[];
      placement: Placement;
      fromSelection: boolean;
    }
  /** Plain click: this row alone. */
  | { type: "SELECT_ONLY"; rowId: RowId }
  /** Cmd/Ctrl+click, or the row's tick box: in or out. */
  | { type: "TOGGLE"; rowId: RowId }
  /**
   * Shift+click / Shift+Arrow: anchor to `rowId` over `list`, the movable
   * rows of ONE list in rendered order. A range never spans two lists: an
   * anchor in another list (or none) makes `from` — else `rowId` — the new
   * anchor, keeping whatever was already picked.
   */
  | { type: "SELECT_RANGE"; rowId: RowId; list: RowId[]; from?: RowId }
  | { type: "CLEAR_SELECTION" }
  | { type: "ACCEPT_ALL_SUGGESTIONS" };

type Action = GroupingAction;

export const emptyGroupingState: State = {
  rows: new Map(),
  placement: new Map(),
  suggested: new Set(),
  selected: [],
  anchor: null,
  rangeBase: [],
  hasInitialized: false,
};
const emptyState = emptyGroupingState;

const noSelection = {
  selected: [] as RowId[],
  anchor: null,
  rangeBase: [] as RowId[],
};

/**
 * Can this row be picked up at all? Not an insert that had parallels at open
 * (it would orphan them), and not a row holding parallels right now (a
 * parallel of a parallel). Exactly the rows the UI renders as "has
 * parallels" with a disabled row and tick box.
 */
function isMovableIn(state: State, rowId: RowId): boolean {
  const info = state.rows.get(rowId);
  if (!info) return false;
  if (info.originalKind === "insert" && info.originalHadParallels) return false;
  for (const p of state.placement.values()) {
    if (p.kind === "child" && p.parentId === rowId) return false;
  }
  return true;
}

function uniq(ids: RowId[]): RowId[] {
  return [...new Set(ids)];
}

export function groupingReducer(state: State, action: Action): State {
  switch (action.type) {
    case "INIT":
      return {
        rows: action.rows,
        placement: action.placement,
        suggested: action.suggested,
        ...noSelection,
        hasInitialized: true,
      };
    case "RESET":
      return emptyState;
    case "MOVE": {
      const { rowIds, placement } = action;
      if (rowIds.length === 0) return state;
      // NEO-300 — the tree stays one level deep here, not only on the server.
      // Now that a demoted row gets a drop box, "✕ A, drag B under A, drag A
      // under C" is three ordinary gestures, and it would put B under a
      // parallel. The server's own guard reads the rows as they are BEFORE
      // the plan, so it cannot see a chain built entirely inside one plan.
      //
      // A move of several rows is all or nothing. The UI keeps invalid rows
      // out of the selection and makes a selected row's own box refuse the
      // drop, so reaching a refusal here means something upstream slipped;
      // moving part of a selection would leave the operator to work out
      // which part.
      if (placement.kind === "child") {
        const parentId = placement.parentId;
        // No row under itself, and a target that is moving is no target.
        if (rowIds.includes(parentId)) return state;
        // The target must be a top-level row...
        if (state.placement.get(parentId)?.kind !== "ungrouped") return state;
        // ...and no moved row may be holding parallels of its own.
        for (const id of rowIds) {
          if (!isMovableIn(state, id)) return state;
        }
      }
      const next = new Map(state.placement);
      const suggested = new Set(state.suggested);
      for (const id of rowIds) {
        if (!state.rows.has(id)) continue;
        next.set(id, placement);
        suggested.delete(id);
      }
      const moved: State = { ...state, placement: next, suggested };
      if (action.fromSelection) return { ...moved, ...noSelection };
      // A row the operator ticked earlier may have just been handed a
      // parallel (an unselected row dropped under it): it can no longer move,
      // so it can no longer be picked.
      const keep = (id: RowId) => isMovableIn(moved, id);
      const anchor = state.anchor && keep(state.anchor) ? state.anchor : null;
      return {
        ...moved,
        selected: state.selected.filter(keep),
        anchor,
        rangeBase: anchor ? state.rangeBase.filter(keep) : [],
      };
    }
    case "SELECT_ONLY":
      if (!isMovableIn(state, action.rowId)) return state;
      return {
        ...state,
        selected: [action.rowId],
        anchor: action.rowId,
        rangeBase: [],
      };
    case "TOGGLE": {
      const id = action.rowId;
      if (!isMovableIn(state, id)) return state;
      const selected = state.selected.includes(id)
        ? state.selected.filter((s) => s !== id)
        : [...state.selected, id];
      return {
        ...state,
        selected,
        anchor: id,
        rangeBase: selected.filter((s) => s !== id),
      };
    }
    case "SELECT_RANGE": {
      const list = action.list.filter((id) => isMovableIn(state, id));
      const to = list.indexOf(action.rowId);
      if (to < 0) return state;
      let anchor = state.anchor;
      let base = state.rangeBase;
      if (!anchor || !list.includes(anchor)) {
        anchor =
          action.from && list.includes(action.from) ? action.from : action.rowId;
        const start = anchor;
        base = state.selected.filter((s) => s !== start);
      }
      const from = list.indexOf(anchor);
      const range = list.slice(Math.min(from, to), Math.max(from, to) + 1);
      return {
        ...state,
        selected: uniq([...base, ...range]),
        anchor,
        rangeBase: base,
      };
    }
    case "CLEAR_SELECTION":
      if (state.selected.length === 0 && !state.anchor) return state;
      return { ...state, ...noSelection };
    case "ACCEPT_ALL_SUGGESTIONS":
      return { ...state, suggested: new Set() };
    default:
      return state;
  }
}
/** One row of the tree, as much of it as the grouping reads. */
export type InsertTreeRow = { _id: RowId; value: string };

/**
 * `selectorOptions.getInsertTreeByVariantType`'s shape, declared by hand so
 * this module stays free of the generated API (the query's result is
 * assignable to it): every insert under one variant type, each with its
 * parallels.
 */
export type InsertTree = ReadonlyArray<{
  insert: InsertTreeRow;
  parallels: readonly InsertTreeRow[];
}>;

export type InitialGrouping = {
  rows: Map<RowId, RowInfo>;
  placement: Map<RowId, Placement>;
  suggested: Set<RowId>;
  /**
   * NEO-339 — rows suggested as a child that root a family of their own
   * (`detectGroupings`' `familyRoots`): row → the parent it was suggested
   * under. Reported only; the placement is the plain prefix rule's. Empty
   * with `suggest: false`.
   */
  familyRoots: Map<RowId, RowId>;
};

/**
 * The tree as reducer state: every row where it stands now, plus — unless
 * `suggest: false` — the prefix suggestions (`detectGroupings`) placed and
 * marked `suggested`, which is what the modal opens on. The set-build tool's
 * apply passes `suggest: false`: a spec names every move it wants, and a row
 * it does not name stays where it is. Its draft passes `holdFamilyRoots`, the
 * family roots its previews show share no card number with their parent (see
 * `detectGroupings`); the modal never does, so it opens on the plain rule.
 */
export function buildInitialState(
  tree: InsertTree,
  opts: { suggest?: boolean; holdFamilyRoots?: ReadonlySet<RowId> } = {},
): InitialGrouping {
  const rows = new Map<RowId, RowInfo>();
  const placement = new Map<RowId, Placement>();
  const suggested = new Set<RowId>();
  const familyRoots = new Map<RowId, RowId>();

  for (const { insert, parallels } of tree) {
    rows.set(insert._id, {
      _id: insert._id,
      value: insert.value,
      originalKind: "insert",
      originalParentId: null,
      originalHadParallels: parallels.length > 0,
    });
    placement.set(insert._id, { kind: "ungrouped" });
    for (const par of parallels) {
      rows.set(par._id, {
        _id: par._id,
        value: par.value,
        originalKind: "parallel",
        originalParentId: insert._id,
        originalHadParallels: false,
      });
      placement.set(par._id, { kind: "child", parentId: insert._id });
    }
  }

  if (opts.suggest === false) return { rows, placement, suggested, familyRoots };

  // Auto-suggest groupings only among currently-ungrouped inserts. Fixed
  // parents (had parallels at open) can be parents but can't themselves be
  // suggested as children.
  const candidates: Array<{ _id: RowId; value: string }> = [];
  const excludeAsChild = new Set<RowId>();
  for (const [id, info] of rows) {
    if (info.originalKind !== "insert") continue;
    if (placement.get(id)?.kind !== "ungrouped") continue;
    candidates.push({ _id: id, value: info.value });
    if (info.originalHadParallels) excludeAsChild.add(id);
  }
  const detection = detectGroupings(candidates, excludeAsChild, {
    holdFamilyRoots: opts.holdFamilyRoots,
  });
  for (const [parentId, childIds] of detection.suggestions) {
    for (const childId of childIds) {
      placement.set(childId, { kind: "child", parentId });
      suggested.add(childId);
    }
  }
  for (const [root, parent] of detection.familyRoots) familyRoots.set(root, parent);

  return { rows, placement, suggested, familyRoots };
}

export function computeDiff(state: State): {
  promotions: Array<{ insertId: RowId; targetInsertId: RowId }>;
  demotions: Array<{ parallelId: RowId }>;
  reparentings: Array<{ parallelId: RowId; newInsertId: RowId }>;
} {
  const promotions: Array<{ insertId: RowId; targetInsertId: RowId }> = [];
  const demotions: Array<{ parallelId: RowId }> = [];
  const reparentings: Array<{ parallelId: RowId; newInsertId: RowId }> = [];
  for (const [rowId, current] of state.placement) {
    const info = state.rows.get(rowId);
    if (!info) continue;
    if (info.originalKind === "insert") {
      if (current.kind === "child") {
        promotions.push({ insertId: rowId, targetInsertId: current.parentId });
      }
    } else {
      if (current.kind === "ungrouped") {
        demotions.push({ parallelId: rowId });
      } else if (current.parentId !== info.originalParentId) {
        reparentings.push({
          parallelId: rowId,
          newInsertId: current.parentId,
        });
      }
    }
  }
  return { promotions, demotions, reparentings };
}
