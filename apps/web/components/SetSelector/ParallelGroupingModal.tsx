import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { api } from "../../convex/_generated/api";
import {
  buildInitialState,
  computeDiff,
  emptyGroupingState,
  groupingReducer,
  type Placement,
  type RowId,
  type RowInfo,
} from "../../lib/set-build/grouping";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
import { keyboardAwareCollision } from "../../lib/dnd/keyboard-aware-collision";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
import { chunkGroupingPlan } from "../../convex/parallelGroupingPlan";
import { checkFamilyRoots } from "./familyRootEvidence";

/** "1 pending move" / "2 pending moves". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// NEO-339 — the session's state, reducer, tree → state builder and diff live
// in `lib/set-build/grouping.ts` (pure, so the set-building tool groups rows
// through the same rules). Re-exported here for existing importers.
export {
  emptyGroupingState,
  groupingReducer,
  type GroupingAction,
  type GroupingState,
  type Placement,
  type RowInfo,
} from "../../lib/set-build/grouping";

const reducer = groupingReducer;
const emptyState = emptyGroupingState;

// ===== DRAGGABLE ROW =====

/** Which of a row's two selection controls a key or click came from. */
type RowControl = "tick" | "name";

/**
 * How the arrow keys find a row's tick box or name button: a data attribute,
 * NOT a DOM id. maestro-web reports an element's resource-id as
 * `id || aria-label`, so an id on a control hides its accessible name from
 * every flow ("Select <row>" could no longer be tapped by name).
 */
function rowControlKey(rowId: RowId, control: RowControl): string {
  return `${control}-${rowId}`;
}

function DraggableRow({
  info,
  isSuggested,
  isSelected,
  isMovable,
  isRidingAlong,
  onNameClick,
  onTickClick,
  onNavKey,
  onReject,
}: {
  info: RowInfo;
  isSuggested: boolean;
  isSelected: boolean;
  isMovable: boolean;
  /** Another selected row is being dragged, and this one goes with it. */
  isRidingAlong: boolean;
  onNameClick: (e: React.MouseEvent) => void;
  onTickClick: (e: React.MouseEvent) => void;
  onNavKey: (e: React.KeyboardEvent, control: RowControl) => void;
  onReject?: () => void;
}) {
  const nameId = useId();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({
    id: info._id,
    disabled: !isMovable,
    // NEO-300 — NOT dnd-kit's default role="button". This row WRAPS real
    // buttons (select, ✕), and a button inside a button is hidden from the
    // accessibility tree. "group" is a container role, so both stay exposed;
    // `aria-roledescription="draggable"` and the keyboard instructions
    // (aria-describedby) still come from dnd-kit, and the name is the row's
    // own text via aria-labelledby.
    attributes: { role: "group" },
  });

  // Selected wins over Suggested: with several rows picked, a picked row that
  // stayed yellow would read as "not in the move". The "Suggested" badge
  // still shows, and the tick carries the state for anyone who can't tell
  // the colours apart.
  const baseClass = isSelected
    ? "ring-1 ring-neon-blue bg-neon-blue/10 border-neon-blue"
    : isSuggested
      ? "border-yellow-700 bg-yellow-900/20"
      : "bg-gray-800 border-gray-600 hover:border-gray-400";

  // The outer div is the drag source and its own tab stop: Space/Enter on IT
  // starts a keyboard drag (tabIndex and the onKeyDown listener, not the
  // role, are what make that work). It is also the ACTIVATOR node — without
  // that, dnd-kit accepts a Space/Enter bubbling up from any child, calls
  // preventDefault and starts a drag, so pressing Enter on ✕ or on the
  // select button picked the row up instead of pressing the button.
  // Pointer taps on the inner buttons are unaffected: PointerSensor's
  // activationConstraint needs 5px of movement before a drag starts.
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        setActivatorNodeRef(el);
      }}
      {...listeners}
      {...attributes}
      aria-labelledby={nameId}
      style={{ opacity: isDragging || isRidingAlong ? 0.4 : 1 }}
      className={`rounded-lg border text-sm font-medium transition-all select-none flex items-stretch focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B7FF] ${baseClass} ${
        isMovable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      }`}
    >
      {/* NEO-300 — the tick box: the visible, modifier-free way to pick
          several rows (Cmd/Ctrl+click and Shift+click are the shortcuts).
          A 32px-wide hit area around a 16px box. Space toggles it like any
          checkbox; the row's drag handle is the outer div, and dnd-kit only
          starts a drag from a key pressed ON that div (activator node). */}
      <button
        type="button"
        role="checkbox"
        data-grouping-control={rowControlKey(info._id, "tick")}
        aria-checked={isSelected}
        aria-label={`Select ${info.value}`}
        disabled={!isMovable}
        onClick={onTickClick}
        onKeyDown={(e) => onNavKey(e, "tick")}
        className={`group/tick shrink-0 w-8 flex items-center justify-center rounded-l-lg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neon-blue ${
          isMovable ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-4 w-4 rounded-[4px] border flex items-center justify-center transition-colors ${
            isSelected
              ? "bg-neon-blue border-neon-blue text-gray-950"
              : isMovable
                ? "border-gray-400 bg-gray-900 group-hover/tick:border-neon-blue"
                : "border-gray-700 bg-transparent"
          }`}
        >
          {isSelected && (
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
              <path
                d="M3.5 8.5l3 3 6-7"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </button>
      <button
        type="button"
        data-grouping-control={rowControlKey(info._id, "name")}
        onClick={onNameClick}
        onKeyDown={(e) => onNavKey(e, "name")}
        disabled={!isMovable}
        aria-pressed={isSelected}
        className={`flex-1 text-left pl-1 pr-3 py-2 flex items-center gap-2 ${
          isMovable ? "cursor-pointer" : "cursor-default"
        } disabled:opacity-100`}
      >
        <span id={nameId} className="text-gray-200 break-words flex-1">
          {info.value}
        </span>
        {isSuggested && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300 border border-yellow-700">
            Suggested
          </span>
        )}
        {!isMovable && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 border border-gray-600">
            has parallels
          </span>
        )}
      </button>
      {onReject && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
          className="text-xs text-pink-400 hover:text-pink-300 px-3 rounded-r-lg hover:bg-pink-900/20"
          aria-label={`Remove ${info.value} from parallels`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ===== DROP ZONE =====

function DropZone({
  id,
  title,
  subtitle,
  children,
  isClickTarget,
  onClick,
  emptyText,
  highlight,
  refusesDrop,
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  isClickTarget?: boolean;
  onClick?: () => void;
  emptyText?: string;
  highlight?: boolean;
  /**
   * NEO-300 — this box's own row is among the rows being moved, so the box
   * takes no drop (a drop over it lands nowhere) and says why in its
   * subtitle, rather than accepting the drop and then refusing it.
   */
  refusesDrop?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: refusesDrop });
  const showEmpty =
    Array.isArray(children) ? children.length === 0 : !children;
  return (
    <div
      ref={setNodeRef}
      onClick={isClickTarget ? onClick : undefined}
      className={`rounded-lg border-2 transition-colors ${
        isOver
          ? "border-[#00B7FF] bg-[#00B7FF]/5"
          : highlight
            ? "border-yellow-600/50 bg-yellow-900/5"
            : "border-gray-700 bg-gray-900/30"
      } ${isClickTarget ? "cursor-pointer hover:border-gray-500" : ""}`}
    >
      <div className="px-4 pt-3 pb-2 border-b border-gray-700/60">
        <div className="text-sm font-semibold text-gray-200 break-words">
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div className="p-3 space-y-1.5 min-h-[48px]">
        {showEmpty ? (
          <p className="text-xs text-gray-400 italic py-1">
            {emptyText ?? "Drop rows here"}
          </p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// ===== SKELETON =====

function ModalSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-24 rounded-lg border border-gray-700 bg-gray-900/30 animate-pulse" />
      <div className="h-32 rounded-lg border border-gray-700 bg-gray-900/30 animate-pulse" />
      <div className="h-24 rounded-lg border border-gray-700 bg-gray-900/30 animate-pulse" />
    </div>
  );
}

// ===== CARD-NUMBER CHECK =====

type CheckState =
  | { status: "idle" }
  | { status: "checking"; done: number; total: number }
  | { status: "done"; held: number; unknown: number };

type CheckAction =
  | { type: "RESET" }
  | { type: "PROGRESS"; done: number; total: number }
  | { type: "DONE"; held: number; unknown: number };

function checkReducer(_state: CheckState, action: CheckAction): CheckState {
  switch (action.type) {
    case "RESET":
      return { status: "idle" };
    case "PROGRESS":
      return { status: "checking", done: action.done, total: action.total };
    case "DONE":
      return { status: "done", held: action.held, unknown: action.unknown };
  }
}

/** What the check strip says: the offer, the progress, or the answer. */
function checkStripText(check: CheckState, unchecked: number): string {
  if (check.status === "checking") {
    return check.total > 0
      ? `Checking card numbers… ${check.done} of ${check.total} checklists read`
      : "Checking card numbers…";
  }
  if (check.status === "done") {
    const held =
      check.held === 0
        ? "none is an insert of its own, so the suggestions stand."
        : check.held === 1
          ? "1 suggested parallel is an insert of its own, so it stays on top with its parallels under it."
          : `${check.held} suggested parallels are inserts of their own, so they stay on top with their parallels under them.`;
    const unknown =
      check.unknown === 0
        ? ""
        : check.unknown === 1
          ? " 1 couldn't be compared and keeps its name match."
          : ` ${check.unknown} couldn't be compared and keep their name match.`;
    return `Card numbers checked: ${held}${unknown}`;
  }
  return unchecked === 1
    ? "1 suggested parallel has parallels of its own, so it might be an insert. Its card numbers will tell."
    : `${unchecked} suggested parallels have parallels of their own, so they might be inserts. Their card numbers will tell.`;
}

// ===== MAIN =====

type ParallelGroupingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  variantTypeId: RowId;
};

export default function ParallelGroupingModal({
  isOpen,
  onClose,
  variantTypeId,
}: ParallelGroupingModalProps) {
  const tree = useQuery(
    api.selectorOptions.getInsertTreeByVariantType,
    isOpen ? { variantTypeId } : "skip",
  );
  const apply = useMutation(api.selectorOptions.applyParallelGroupings);
  const convex = useConvex();
  const [state, dispatch] = useReducer(reducer, emptyState);
  /**
   * NEO-339 — the family roots this tree reports (`buildInitialState`'s
   * `familyRoots`): a suggested parallel that longer names extend, which may
   * be an insert of its own. The prefix rule places them; "Check card
   * numbers" weighs them with the shared card-number rule
   * (lib/set-build/family-roots.ts, the set-building draft's own), on the
   * operator's press, never on open: a check previews marketplace checklists.
   */
  const familyRootsInTree = useMemo(
    () => (tree ? buildInitialState(tree).familyRoots : new Map<RowId, RowId>()),
    [tree],
  );
  const [check, checkDispatch] = useReducer(checkReducer, { status: "idle" });
  /** Bumped on every (re)open and RESET, so a check that outlives its session lands nowhere. */
  const sessionRef = useRef(0);
  const checkButtonRef = useRef<HTMLButtonElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  /**
   * NEO-300 (a11y) — Save stays FOCUSABLE while the save is in flight.
   *
   * It used native `disabled`, which drops focus to <body> the moment it is
   * pressed; a refusal ("Refractor" is already a parallel of "Chrome".) then
   * arrived as a role="alert" with a keyboard user stranded nowhere near it.
   * `aria-disabled` keeps focus on Save, and this ref is the double-press
   * guard native `disabled` used to be (a state read in the click handler
   * would be one render stale).
   */
  const confirmingRef = useRef(false);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirmingRef = useRef(false);
  /**
   * NEO-220 — is the "throw these moves away?" confirm on screen? Distinct
   * from `confirming` ("the save is in flight"), which is the opposite
   * question.
   */
  const [discardOpen, setDiscardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  /**
   * NEO-308 (a11y, WCAG 2.4.7) — where this dialog PARKS focus: on open,
   * after Clear, and after a save that leaves Save disabled. It used to be
   * the overlay itself, which is `outline-none` (it is the whole backdrop, so
   * a ring on it would sit on the viewport edge) and showed nothing. The
   * heading carries its own ring and names the dialog it is in — the
   * `session-heading` pattern from the placeholder intake page. It sits
   * inside the overlay, so Escape still bubbles to the overlay's handler.
   */
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /** What had focus before this opened, so it can go back there on close
   *  rather than falling to `<body>` (WCAG 2.4.3) — matches CardPairingModal. */
  const triggerRef = useRef<HTMLElement | null>(null);

  // Initialize once when the tree first resolves. Subsequent updates from
  // other tabs are intentionally ignored — re-initializing would discard the
  // user's pending edits. The modal closes after a successful confirm so a
  // re-open will fetch fresh data.
  //
  // NEO-308 — the one-shot init has a second trigger: a PARTIAL save. When a
  // chunk is refused after earlier chunks landed, handleConfirm RESETs while
  // the modal stays open; `hasInitialized` drops to false and this re-INITs
  // from the live tree, which already holds the landed chunks. The pending
  // moves that did not land are discarded with the old state — what is on
  // screen is then exactly what is saved, plus fresh suggestions.
  useEffect(() => {
    if (!isOpen) return;
    if (state.hasInitialized) return;
    if (!tree) return;
    const init = buildInitialState(tree);
    sessionRef.current += 1;
    checkDispatch({ type: "RESET" });
    dispatch({
      type: "INIT",
      rows: init.rows,
      placement: init.placement,
      suggested: init.suggested,
    });
  }, [isOpen, tree, state.hasInitialized]);

  // Reset reducer when the modal closes so a re-open starts fresh.
  useEffect(() => {
    if (!isOpen && state.hasInitialized) {
      sessionRef.current += 1;
      dispatch({ type: "RESET" });
    }
  }, [isOpen, state.hasInitialized]);

  /** Family roots the operator has not touched yet: what a check can still move. */
  const uncheckedRoots = useMemo(
    () => [...familyRootsInTree.keys()].filter((r) => state.suggested.has(r)),
    [familyRootsInTree, state.suggested],
  );

  const handleCheckCardNumbers = useCallback(async () => {
    if (!tree || check.status === "checking") return;
    const session = sessionRef.current;
    checkDispatch({ type: "PROGRESS", done: 0, total: 0 });
    const result = await checkFamilyRoots(
      convex,
      tree,
      familyRootsInTree,
      (done, total) => {
        if (session === sessionRef.current) {
          checkDispatch({ type: "PROGRESS", done, total });
        }
      },
    );
    if (session !== sessionRef.current) return;
    // The reducer folds the answer into the CURRENT session: only rows the
    // operator has not touched move (applyFamilyRootEvidence).
    dispatch({ type: "APPLY_FAMILY_ROOT_EVIDENCE", grouping: result });
    // The button goes once the check is done: keep focus in the dialog.
    if (document.activeElement === checkButtonRef.current) {
      headingRef.current?.focus();
    }
    checkDispatch({
      type: "DONE",
      held: result.held.length,
      unknown: result.unknown.length,
    });
  }, [tree, check.status, convex, familyRootsInTree]);

  // NEO-300 — the body is NEVER scrolled by this component. An effect here
  // used to `scrollIntoView` the LAST ✕ in the list on open and on every
  // placement change (it was added so a Maestro tap on a ✕ would not land on
  // the footer). On a real variant type the last ✕ is at the bottom of a long
  // list, so the dialog opened scrolled to the bottom and jumped there again
  // on every drag, ✕ and "Accept all" — the operator lost their place on
  // every move. A flow that needs a row inside the body's viewport scrolls
  // the body itself. Pinned by ParallelGroupingModal.test.tsx.

  // Top-level rows: current placement "ungrouped". Demoted parallels show up
  // here too (originalKind=parallel) — they become inserts on Save.
  const ungroupedRows = useMemo(() => {
    const out: RowInfo[] = [];
    for (const info of state.rows.values()) {
      if (state.placement.get(info._id)?.kind === "ungrouped") {
        out.push(info);
      }
    }
    out.sort((a, b) => a.value.localeCompare(b.value));
    return out;
  }, [state]);

  // Children grouped by parent insert id (current placement).
  const childrenByParent = useMemo(() => {
    const map = new Map<RowId, RowInfo[]>();
    for (const [rowId, p] of state.placement) {
      if (p.kind !== "child") continue;
      const info = state.rows.get(rowId);
      if (!info) continue;
      const list = map.get(p.parentId) ?? [];
      list.push(info);
      map.set(p.parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.value.localeCompare(b.value));
    }
    return map;
  }, [state]);

  /**
   * NEO-300 — every top-level row gets a "Parallels of …" box, including a
   * parallel demoted in this session.
   *
   * It used to be only rows that were inserts at open, so ✕-ing a saved
   * parallel left it with nowhere to receive parallels until a Save and a
   * re-open. The box list is not widened by this beyond what the operator
   * does: every original top-level insert already had one, and the extra
   * boxes are exactly the rows they demoted, one per ✕ or drag-out. Showing
   * boxes only for rows with children would have been the only way to
   * SHRINK the list, and it would take away the one way to start a group
   * under an insert that has no parallels yet.
   */
  const parentRows = ungroupedRows;

  /** Rows that currently have at least one row placed under them. */
  const parentsWithChildren = useMemo(
    () => new Set(childrenByParent.keys()),
    [childrenByParent],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const selectedSet = useMemo(() => new Set(state.selected), [state.selected]);
  const selectedCount = state.selected.length;

  /**
   * NEO-300 — each row's list, as the movable rows of that list in rendered
   * order: the top-level list, or one "Parallels of …" box. A Shift range
   * and the arrow keys stay inside it. Ranges do not span boxes: "from here
   * to there" across boxes would take in every row of every box between,
   * which is never what a run of look-alike names means.
   */
  const listOfRow = useMemo(() => {
    const map = new Map<RowId, RowId[]>();
    const top = ungroupedRows
      .filter(
        (r) =>
          !(r.originalKind === "insert" && r.originalHadParallels) &&
          !parentsWithChildren.has(r._id),
      )
      .map((r) => r._id);
    for (const r of ungroupedRows) map.set(r._id, top);
    for (const list of childrenByParent.values()) {
      const ids = list.map((r) => r._id);
      for (const id of ids) map.set(id, ids);
    }
    return map;
  }, [ungroupedRows, childrenByParent, parentsWithChildren]);

  /** The rows a drag of `rowId` carries: the whole selection if it is in it. */
  const rowsCarriedBy = useCallback(
    (rowId: RowId): { rowIds: RowId[]; fromSelection: boolean } =>
      selectedSet.has(rowId)
        ? { rowIds: state.selected, fromSelection: true }
        : { rowIds: [rowId], fromSelection: false },
    [selectedSet, state.selected],
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveDragId(e.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;
      const rowId = active.id as RowId;
      const overId = over.id as string;
      if (!state.rows.has(rowId)) return;
      const carried = rowsCarriedBy(rowId);
      if (overId === "drop-ungrouped") {
        dispatch({
          type: "MOVE",
          ...carried,
          placement: { kind: "ungrouped" },
        });
        return;
      }
      if (overId.startsWith("drop-insert-")) {
        const parentId = overId.replace("drop-insert-", "") as RowId;
        dispatch({
          type: "MOVE",
          ...carried,
          placement: { kind: "child", parentId },
        });
      }
    },
    [state.rows, rowsCarriedBy],
  );

  /**
   * NEO-300 — a click on a row's name. Plain: this row alone (today's
   * single select, ready for click-to-place). Cmd (macOS) / Ctrl: in or out
   * of the selection. Shift: the run from the anchor, within this list.
   *
   * stopPropagation: a row sits INSIDE a drop box, and while anything is
   * selected the whole box is a click target. Without it, clicking a row to
   * select it also dropped the previous selection into that row's box.
   */
  const handleNameClick = useCallback(
    (rowId: RowId, e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.shiftKey) {
        dispatch({
          type: "SELECT_RANGE",
          rowId,
          list: listOfRow.get(rowId) ?? [rowId],
        });
      } else if (e.metaKey || e.ctrlKey) {
        dispatch({ type: "TOGGLE", rowId });
      } else {
        dispatch({ type: "SELECT_ONLY", rowId });
      }
    },
    [listOfRow],
  );

  /** The tick box: toggles; Shift extends the run, as the name does. */
  const handleTickClick = useCallback(
    (rowId: RowId, e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.shiftKey) {
        dispatch({
          type: "SELECT_RANGE",
          rowId,
          list: listOfRow.get(rowId) ?? [rowId],
        });
      } else {
        dispatch({ type: "TOGGLE", rowId });
      }
    },
    [listOfRow],
  );

  /**
   * NEO-300 — keyboard parity, on a row's tick box or name button.
   * ↑/↓ moves focus to the same control on the neighbouring row of this
   * list; Shift+↑/↓ also extends the selection from the anchor (the row it
   * started on, if the anchor is elsewhere). Space on the tick box toggles
   * it — a native button press, nothing to handle here. Esc (the dialog's
   * handler) clears. The drag handle is the row's outer div, so none of
   * these collide with dnd-kit's Space-to-lift.
   */
  const handleNavKey = useCallback(
    (rowId: RowId, e: React.KeyboardEvent, control: RowControl) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const list = listOfRow.get(rowId);
      if (!list) return;
      const at = list.indexOf(rowId);
      if (at < 0) return;
      // The arrow is ours either way: never let it scroll the body instead.
      e.preventDefault();
      const next = list[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      if (e.shiftKey) {
        dispatch({ type: "SELECT_RANGE", rowId: next, list, from: rowId });
      }
      overlayRef.current
        ?.querySelector<HTMLElement>(
          `[data-grouping-control="${rowControlKey(next, control)}"]`,
        )
        ?.focus();
    },
    [listOfRow],
  );

  const handleZoneClick = useCallback(
    (placement: Placement) => {
      if (state.selected.length === 0) return;
      dispatch({
        type: "MOVE",
        rowIds: state.selected,
        placement,
        fromSelection: true,
      });
    },
    [state.selected],
  );

  const diff = useMemo(() => computeDiff(state), [state]);
  const totalChanges =
    diff.promotions.length + diff.demotions.length + diff.reparentings.length;

  const handleConfirm = useCallback(async () => {
    if (confirmingRef.current) return;
    if (totalChanges === 0) {
      onClose();
      return;
    }
    confirmingRef.current = true;
    setConfirming(true);
    setError(null);
    // NEO-308 — one call per chunk of at most the server's cap, in the order
    // `chunkGroupingPlan` gives (demotions → reparentings → promotions). Each
    // chunk is applied whole or not at all; there is deliberately no wrapper
    // making the SAVE all-or-nothing (Jason's ruling). Sequential, never
    // parallel: a later chunk's checks rely on the earlier ones having landed.
    // The in-flight guard above (ref, aria-disabled Save) spans the whole loop.
    const chunks = chunkGroupingPlan(diff);
    let applied = 0;
    try {
      for (const chunk of chunks) {
        await apply({ variantTypeId, ...chunk });
        applied += 1;
      }
      // Reset state so re-open rebuilds from fresh tree.
      dispatch({ type: "RESET" });
      onClose();
    } catch (err) {
      // NEO-300: the mutation's refusals are ConvexErrors carrying a sentence
      // written for the operator ("Refractor" is already a parallel of
      // "Chrome".) — `data` crosses intact, while `.message` arrives with the
      // "[CONVEX M(...)] [Request ID: …]" prefix on prod. Anything else keeps
      // the old reading so no failure goes quiet.
      setError(
        userFacingMessage(
          err,
          err instanceof Error ? err.message : "Failed to apply changes",
        ),
      );
      // NEO-308: landed chunks are already in `tree` (a mutation promise
      // resolves only once this client's subscriptions reflect it). Rebuild
      // from it; a refusal with nothing landed keeps the pending moves, as
      // before. `error` is component state, not reducer state, so the
      // refusal stays on screen across the rebuild.
      if (applied > 0) dispatch({ type: "RESET" });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }, [apply, diff, onClose, totalChanges, variantTypeId]);

  // a11y: the focus-park pattern from VariantForm/ParallelForm. Should focus
  // still fall to <body> across the save (a re-render that remounts Save),
  // put it back on Save — beside the footer where a refusal appears — rather
  // than leave a keyboard user at the top of the page. Guarded on the actual
  // blur so it never steals focus the operator moved themselves.
  //
  // NEO-308 — a partial save lands here with the state just RESET, so Save
  // renders natively `disabled` ("No changes") until the rebuild, and a
  // focused button that becomes disabled drops focus to <body> in the
  // browser. Focus on a disabled Save, or on <body> with Save disabled, goes
  // to the dialog's heading instead (as Clear does): still inside the
  // dialog, where Tab and Escape work, and the refusal is announced by its
  // role="alert" either way.
  useEffect(() => {
    const was = wasConfirmingRef.current;
    wasConfirmingRef.current = confirming;
    if (!was || confirming) return;
    const save = saveRef.current;
    const active = document.activeElement;
    if (active !== document.body && !(active === save && save?.disabled)) {
      return;
    }
    if (save && !save.disabled) save.focus();
    else headingRef.current?.focus();
  }, [confirming]);

  /**
   * NEO-220 — the single door out.
   *
   * Backdrop click, footer Cancel and Escape all come through here, so the
   * "would this lose anything?" question is asked once. `totalChanges` is
   * already the number the footer shows, which means the confirm and the
   * footer can never disagree about how much work is on screen.
   */
  const requestClose = useCallback(() => {
    if (confirming) return;
    if (totalChanges === 0) {
      onClose();
      return;
    }
    setDiscardOpen(true);
  }, [confirming, onClose, totalChanges]);

  /**
   * NEO-220 — focus opens inside the dialog, and returns to whatever opened
   * it on close. NEO-308: on the heading, not the container — see
   * `headingRef`.
   *
   * The focus-in-and-back-out half is what makes the root `onKeyDown` below
   * reachable at all: Escape is handled on the overlay element now, not on
   * `window`, and a keypress only reaches it if focus is inside. The window
   * listener it replaced fired wherever focus happened to be, including
   * inside the discard confirm this dialog now renders — one Escape would
   * have dismissed the confirm AND the session it was protecting.
   *
   * Capture-trigger-restore-on-close mirrors CardPairingModal's own effect —
   * without it, closing (Cancel, Confirm, or the discard confirm) drops focus
   * to `<body>` instead of back to the "Group Parallels" button that opened
   * this dialog.
   */
  useEffect(() => {
    if (!isOpen) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // NEO-308 — also loading while the state is not built from the tree: a
  // partial save RESETs and the INIT effect rebuilds one commit later, and
  // without this the body painted zero rows for that commit.
  const isLoading = tree === undefined || !state.hasInitialized;
  const suggestionCount = state.suggested.size;
  const showCheckStrip = check.status !== "idle" || uncheckedRoots.length > 0;
  const hasSuggestions = suggestionCount > 0;

  const activeDragValue = activeDragId
    ? state.rows.get(activeDragId as RowId)?.value
    : null;
  /** How many rows the drag in flight carries (1 for a lone row). */
  const dragCount =
    activeDragId && selectedSet.has(activeDragId as RowId) ? selectedCount : 1;
  /**
   * The rows a drop or a box click would move right now: the dragged rows
   * during a drag, the selection otherwise. A box whose own row is among
   * them takes no drop and no click.
   */
  const movingSet: Set<RowId> = activeDragId
    ? selectedSet.has(activeDragId as RowId)
      ? selectedSet
      : new Set([activeDragId as RowId])
    : selectedSet;

  // Box subtitles while a selection is up. The one-row wording is unchanged
  // (a Maestro flow waits on it); the several-row wording is NEO-300 DRAFT
  // copy for Jason.
  const topLevelHint =
    selectedCount === 1
      ? "Click here to place the selected row at the top level"
      : `Click here to place the ${selectedCount} selected rows at the top level`;
  const boxHint =
    selectedCount === 1
      ? "Click here to make the selected row a parallel"
      : `Click here to make the ${selectedCount} selected rows parallels`;
  const othersSelected = selectedCount - 1;
  const ownBoxHint =
    selectedCount === 1
      ? "This row is selected"
      : othersSelected === 1
        ? "This row is selected. Untick it to drop the other row here."
        : `This row is selected. Untick it to drop the other ${othersSelected} rows here.`;

  const renderRow = (
    info: RowInfo,
    isMovable: boolean,
    onReject?: () => void,
  ) => (
    <DraggableRow
      key={info._id}
      info={info}
      isSuggested={state.suggested.has(info._id)}
      isSelected={selectedSet.has(info._id)}
      isMovable={isMovable}
      isRidingAlong={
        dragCount > 1 &&
        activeDragId !== info._id &&
        selectedSet.has(info._id)
      }
      onNameClick={(e) => handleNameClick(info._id, e)}
      onTickClick={(e) => handleTickClick(info._id, e)}
      onNavKey={(e, control) => handleNavKey(info._id, e, control)}
      onReject={onReject}
    />
  );

  return createPortal(
    // NEO-71-74 QA fix: see BaseSetPicker.tsx for why this nested <Theme> is
    // needed — createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 outline-none"
      // NEO-220 a11y fix: this dialog announced itself to nothing — no role,
      // no accessible name, and (until the Tab trap below) no keyboard
      // containment, unlike every sibling dialog in this directory.
      role="dialog"
      aria-modal="true"
      aria-labelledby="parallel-grouping-heading"
      ref={overlayRef}
      // Focusable only programmatically — it exists so Escape has somewhere to
      // land inside this dialog rather than on `window`. NEO-308: nothing
      // parks focus here any more (see `headingRef`); it stays focusable so a
      // pointer click on the panel's blank space keeps focus in the dialog.
      tabIndex={-1}
      onClick={requestClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // The discard confirm is a sibling in this portal and owns Escape
          // while it is open.
          if (discardOpen) return;
          // D8: Escape inside a text field means something smaller and local.
          if (isEditableTarget(e.target)) return;
          // Escape during a drag cancels the DRAG (dnd-kit's own document
          // listener); one keypress must not also end the session.
          if (activeDragId) return;
          e.preventDefault();
          // NEO-300 — Escape peels one layer at a time: a selection first,
          // then the dialog (through the discard guard, as before).
          if (state.selected.length > 0) {
            dispatch({ type: "CLEAR_SELECTION" });
            return;
          }
          requestClose();
          return;
        }
        if (e.key !== "Tab") return;
        // Keep Tab inside the dialog — aria-modal="true" promises this.
        // Copied from ReconciliationModal / CardPairingModal's own trap.
        const root = overlayRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // NEO-308 — the heading (and the overlay) are parked-focus targets
        // outside that list: Shift+Tab from one of them would otherwise walk
        // out of the dialog, since nothing focusable precedes the heading.
        const offList = !Array.from(focusable).includes(
          document.activeElement as HTMLElement,
        );
        if (e.shiftKey && (document.activeElement === first || offList)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex items-start justify-between gap-4">
          <div>
            <h2
              id="parallel-grouping-heading"
              ref={headingRef}
              // NEO-308 — the parked-focus target (see `headingRef`), so it
              // needs a visible ring of its own (WCAG 2.4.7).
              tabIndex={-1}
              className="text-xl font-semibold text-white rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-blue"
            >
              Group Parallels
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Drag inserts under a parent to make them parallels. Drag
              parallels back to "Top-level" to demote them.
            </p>
          </div>
          {hasSuggestions && (
            <NeonButton
              secondary
              onClick={() => dispatch({ type: "ACCEPT_ALL_SUGGESTIONS" })}
            >
              Accept all suggestions ({suggestionCount})
            </NeonButton>
          )}
        </div>

        {/* NEO-339 — the card-number check: offered while a suggested
            parallel that roots its own family is still untouched, run only
            on the press. The status line is always mounted so the progress
            and the answer are announced. */}
        {!isLoading && (
          <div
            className={
              showCheckStrip
                ? "px-6 py-3 border-b border-gray-700 bg-gray-800/40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
                : "sr-only"
            }
          >
            <p role="status" className="text-sm text-gray-300">
              {showCheckStrip ? checkStripText(check, uncheckedRoots.length) : ""}
            </p>
            {showCheckStrip && check.status !== "done" && (
              <NeonButton
                ref={checkButtonRef}
                secondary
                aria-disabled={check.status === "checking" || undefined}
                onClick={() => void handleCheckCardNumbers()}
              >
                Check card numbers
              </NeonButton>
            )}
          </div>
        )}

        {/* Body */}
        <div
          className="flex-1 overflow-y-auto px-6 py-4"
          data-grouping-body
        >
          {isLoading ? (
            <ModalSkeleton />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={keyboardAwareCollision}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="space-y-4">
                {/* Top-level / Ungrouped pool */}
                <DropZone
                  id="drop-ungrouped"
                  title="Top-level inserts"
                  subtitle={
                    selectedCount > 0
                      ? topLevelHint
                      : "Demoted parallels appear here. They become inserts on Save."
                  }
                  isClickTarget={selectedCount > 0}
                  onClick={() => handleZoneClick({ kind: "ungrouped" })}
                  emptyText="(no top-level inserts)"
                >
                  {ungroupedRows.map((info) => {
                    const isFixedParent =
                      info.originalKind === "insert" &&
                      info.originalHadParallels;
                    // NEO-300: a row holding parallels in this session is a
                    // parent too, for as long as it holds them — see MOVE.
                    const isParentNow = parentsWithChildren.has(info._id);
                    return renderRow(info, !isFixedParent && !isParentNow);
                  })}
                </DropZone>

                {/* Per-insert "Parallels of X" cards */}
                {parentRows.map((parent) => {
                  const children = childrenByParent.get(parent._id) ?? [];
                  const hasYellow = children.some((c) =>
                    state.suggested.has(c._id),
                  );
                  const isOwnRowMoving = movingSet.has(parent._id);
                  return (
                    <DropZone
                      key={parent._id}
                      id={`drop-insert-${parent._id}`}
                      title={`Parallels of "${parent.value}"`}
                      subtitle={
                        selectedCount === 0
                          ? `${children.length} parallel${children.length === 1 ? "" : "s"}`
                          : selectedSet.has(parent._id)
                            ? ownBoxHint
                            : boxHint
                      }
                      isClickTarget={
                        selectedCount > 0 && !selectedSet.has(parent._id)
                      }
                      refusesDrop={isOwnRowMoving}
                      onClick={() =>
                        handleZoneClick({
                          kind: "child",
                          parentId: parent._id,
                        })
                      }
                      emptyText="(no parallels — drop rows here to make them parallels)"
                      highlight={hasYellow}
                    >
                      {children.map((info) =>
                        renderRow(info, true, () =>
                          dispatch({
                            type: "MOVE",
                            rowIds: [info._id],
                            placement: { kind: "ungrouped" },
                            fromSelection: false,
                          }),
                        ),
                      )}
                    </DropZone>
                  );
                })}
              </div>

              <DragOverlay>
                {activeDragValue &&
                  (dragCount > 1 ? (
                    // NEO-300 — several rows ride on one drag: a small stack
                    // of cards, the grabbed row on top and the count on its
                    // corner. Static offsets, no animation.
                    <div className="relative">
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 translate-x-2 translate-y-2 rotate-[1.5deg] rounded-lg border border-neon-blue/35 bg-gray-800"
                      />
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 translate-x-1 translate-y-1 rotate-[0.75deg] rounded-lg border border-neon-blue/60 bg-gray-800"
                      />
                      <div className="relative px-3 py-2 rounded-lg border bg-gray-800 border-neon-blue ring-2 ring-neon-blue shadow-lg text-sm font-medium flex items-center gap-3">
                        <span className="text-gray-200 break-words flex-1">
                          {activeDragValue}
                        </span>
                        <span className="shrink-0 rounded-full bg-neon-blue px-2 py-0.5 text-[11px] font-bold leading-4 text-gray-950 tabular-nums">
                          {dragCount} rows
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                      <span className="text-gray-200">{activeDragValue}</span>
                    </div>
                  ))}
              </DragOverlay>
            </DndContext>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex flex-wrap items-center justify-between gap-3">
          {/* The counts keep their own element: a Maestro flow reads
              "0 promotions, 1 demotion, 1 re-parented" off exactly this. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="text-xs text-gray-400">
            {error ? (
              // role="alert": the operator pressed Save and is watching the
              // button, so a refusal has to be announced, not just painted.
              <span role="alert" className="text-red-300">
                {error}
              </span>
            ) : totalChanges > 0 ? (
              <>
                {diff.promotions.length} promotion
                {diff.promotions.length === 1 ? "" : "s"},{" "}
                {diff.demotions.length} demotion
                {diff.demotions.length === 1 ? "" : "s"}
                {diff.reparentings.length > 0
                  ? `, ${diff.reparentings.length} re-parented`
                  : ""}
              </>
            ) : (
              <span className="text-gray-400">No changes yet</span>
            )}
          </div>
          {/* NEO-300 — the selection count, in the footer because the footer
              never scrolls away and never moves the rows above it. The
              status region is always mounted so each change is announced;
              Clear sits outside it so it is not read out as part of the
              count. */}
          <div className="flex items-center gap-2 text-xs">
            <span
              role="status"
              data-selection-count
              className={
                selectedCount > 0
                  ? "rounded-full border border-neon-blue/60 bg-neon-blue/10 px-2.5 py-0.5 font-semibold text-neon-blue tabular-nums"
                  : "sr-only"
              }
            >
              {selectedCount > 0 ? `${selectedCount} selected` : ""}
            </span>
            {selectedCount > 0 && (
              <button
                type="button"
                aria-label="Clear selection"
                onClick={() => {
                  dispatch({ type: "CLEAR_SELECTION" });
                  // The button goes with the selection; keep focus inside
                  // the dialog, where Escape and Tab still work.
                  headingRef.current?.focus();
                }}
                className="rounded-sm px-1 text-gray-300 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-blue"
              >
                Clear
              </button>
            )}
          </div>
          </div>
          <div className="flex gap-3">
            <NeonButton cancel onClick={requestClose} disabled={confirming}>
              Cancel
            </NeonButton>
            <NeonButton
              ref={saveRef}
              onClick={handleConfirm}
              // In flight: aria-disabled, not `disabled` — see confirmingRef.
              // The not-actionable states (loading, nothing to save) keep
              // native `disabled`; focus is never on Save when they begin.
              aria-disabled={confirming || undefined}
              disabled={isLoading || totalChanges === 0}
            >
              {confirming
                ? "Saving..."
                : totalChanges === 0
                  ? "No changes"
                  : `Save ${totalChanges} change${totalChanges === 1 ? "" : "s"}`}
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
    {/* NEO-220 — a SIBLING of the overlay, not a child of it: this overlay
        closes on backdrop click, and a confirm nested inside it would hand
        its own backdrop click straight to the thing it is protecting. */}
    {discardOpen && (
      <ConfirmDialog
        title={`Discard ${plural(totalChanges, "pending move")}?`}
        description="Closing puts every parallel back where it was. Nothing has been saved yet."
        confirmLabel={`Discard ${plural(totalChanges, "pending move")}`}
        // Nothing is written on this path, so there is no in-flight window.
        busyLabel={`Discard ${plural(totalChanges, "pending move")}`}
        busy={false}
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    )}
    </Theme>,
    document.body,
  );
}
