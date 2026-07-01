import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { detectGroupings } from "./parallelDetection";
import NeonButton from "../modules/NeonButton";

type RowId = Id<"selectorOptions">;

type Placement =
  | { kind: "ungrouped" }
  | { kind: "child"; parentId: RowId };

type RowInfo = {
  _id: RowId;
  value: string;
  isCustom: boolean;
  originalKind: "insert" | "parallel";
  originalParentId: RowId | null;
  // True for inserts that had parallel children at modal open. Such rows
  // can't themselves be moved (would orphan their existing parallels and
  // would create a parallels-of-parallels structure the schema doesn't
  // support).
  originalHadParallels: boolean;
};

type State = {
  rows: Map<RowId, RowInfo>;
  placement: Map<RowId, Placement>;
  // Rows whose current placement was set by auto-detection. Cleared per row
  // when the user explicitly accepts (Accept All) or moves the row.
  suggested: Set<RowId>;
  selectedRowId: RowId | null;
  hasInitialized: boolean;
};

type Action =
  | {
      type: "INIT";
      rows: Map<RowId, RowInfo>;
      placement: Map<RowId, Placement>;
      suggested: Set<RowId>;
    }
  | { type: "RESET" }
  | { type: "PLACE"; rowId: RowId; placement: Placement }
  | { type: "SELECT"; rowId: RowId | null }
  | { type: "ACCEPT_ALL_SUGGESTIONS" };

const emptyState: State = {
  rows: new Map(),
  placement: new Map(),
  suggested: new Set(),
  selectedRowId: null,
  hasInitialized: false,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "INIT":
      return {
        rows: action.rows,
        placement: action.placement,
        suggested: action.suggested,
        selectedRowId: null,
        hasInitialized: true,
      };
    case "RESET":
      return emptyState;
    case "PLACE": {
      const next = new Map(state.placement);
      next.set(action.rowId, action.placement);
      const suggested = new Set(state.suggested);
      suggested.delete(action.rowId);
      return {
        ...state,
        placement: next,
        suggested,
        selectedRowId: null,
      };
    }
    case "SELECT":
      return { ...state, selectedRowId: action.rowId };
    case "ACCEPT_ALL_SUGGESTIONS":
      return { ...state, suggested: new Set() };
    default:
      return state;
  }
}

type Tree = FunctionReturnType<
  typeof api.selectorOptions.getInsertTreeByVariantType
>;

function buildInitialState(tree: Tree): {
  rows: Map<RowId, RowInfo>;
  placement: Map<RowId, Placement>;
  suggested: Set<RowId>;
} {
  const rows = new Map<RowId, RowInfo>();
  const placement = new Map<RowId, Placement>();
  const suggested = new Set<RowId>();

  for (const { insert, parallels } of tree) {
    rows.set(insert._id, {
      _id: insert._id,
      value: insert.value,
      isCustom: !!insert.isCustom,
      originalKind: "insert",
      originalParentId: null,
      originalHadParallels: parallels.length > 0,
    });
    placement.set(insert._id, { kind: "ungrouped" });
    for (const par of parallels) {
      rows.set(par._id, {
        _id: par._id,
        value: par.value,
        isCustom: !!par.isCustom,
        originalKind: "parallel",
        originalParentId: insert._id,
        originalHadParallels: false,
      });
      placement.set(par._id, { kind: "child", parentId: insert._id });
    }
  }

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
  const detection = detectGroupings(candidates, excludeAsChild);
  for (const [parentId, childIds] of detection.suggestions) {
    for (const childId of childIds) {
      placement.set(childId, { kind: "child", parentId });
      suggested.add(childId);
    }
  }

  return { rows, placement, suggested };
}

function computeDiff(state: State): {
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

// ===== DRAGGABLE ROW =====

function DraggableRow({
  info,
  isSuggested,
  isSelected,
  isMovable,
  onSelect,
  onReject,
}: {
  info: RowInfo;
  isSuggested: boolean;
  isSelected: boolean;
  isMovable: boolean;
  onSelect: () => void;
  onReject?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: info._id,
    disabled: !isMovable,
  });

  const baseClass = isSuggested
    ? "border-yellow-700 bg-yellow-900/20"
    : isSelected
      ? "ring-2 ring-[#00B7FF] bg-[#00B7FF]/10 border-[#00B7FF]"
      : "bg-gray-800 border-gray-600 hover:border-gray-400";

  // Outer div is the drag container only — no role="button" so the inner
  // <button> children remain visible in the accessibility tree (ARIA hides
  // nested widgets inside another widget). dnd-kit's listeners on the
  // outer div catch pointer events; tap-to-click on the inner buttons is
  // unaffected because PointerSensor's activationConstraint requires 5px
  // of movement to activate drag.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`rounded-lg border text-sm font-medium transition-all select-none flex items-stretch ${baseClass} ${
        isMovable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!isMovable}
        aria-pressed={isSelected}
        className={`flex-1 text-left px-3 py-2 flex items-center gap-2 ${
          isMovable ? "cursor-pointer" : "cursor-default"
        } disabled:opacity-100`}
      >
        <span className="text-gray-200 break-words flex-1">{info.value}</span>
        {info.isCustom && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-700">
            Custom
          </span>
        )}
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
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  isClickTarget?: boolean;
  onClick?: () => void;
  emptyText?: string;
  highlight?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
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
          <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div className="p-3 space-y-1.5 min-h-[48px]">
        {showEmpty ? (
          <p className="text-xs text-gray-500 italic py-1">
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
  const [state, dispatch] = useReducer(reducer, emptyState);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Initialize once when the tree first resolves. Subsequent updates from
  // other tabs are intentionally ignored — re-initializing would discard the
  // user's pending edits. The modal closes after a successful confirm so a
  // re-open will fetch fresh data.
  useEffect(() => {
    if (!isOpen) return;
    if (state.hasInitialized) return;
    if (!tree) return;
    const init = buildInitialState(tree);
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
      dispatch({ type: "RESET" });
    }
  }, [isOpen, state.hasInitialized]);

  // Scroll the body so the last parallel row (where the ✕ reject button lives)
  // is fully inside the visible scroll viewport, not in the overflow region
  // behind the footer. On a 1024×629 headless viewport the modal's body has
  // ~50–80px of overflow with realistic content, and the ✕ button's natural
  // y position falls under the footer's Save button — a CDP-driven tap at
  // the ✕'s reported bounds-center would then hit Save instead. Scrolling
  // the last reject row into view guarantees the ✕'s click target is the
  // topmost element at that point, in any viewport size.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen || !state.hasInitialized) return;
    // Wait one frame for the body to render its current row list before
    // measuring offsets.
    const id = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const rejects = body.querySelectorAll<HTMLElement>(
        'button[aria-label^="Remove "]',
      );
      if (rejects.length === 0) return;
      rejects[rejects.length - 1].scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen, state.hasInitialized, state.placement]);

  // Top-level inserts: rows whose current placement is "ungrouped" AND original kind was insert.
  // Demoted parallels show up here too (originalKind=parallel, currently ungrouped) — they'll
  // become inserts on Confirm.
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

  // The set of inserts that should render as parent cards: rows whose
  // current placement is ungrouped AND originalKind was "insert" (not a
  // demoted parallel waiting to become an insert on confirm).
  const parentInserts = useMemo(
    () => ungroupedRows.filter((r) => r.originalKind === "insert"),
    [ungroupedRows],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
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
      const info = state.rows.get(rowId);
      if (!info) return;
      const isFixedParent =
        info.originalKind === "insert" && info.originalHadParallels;
      if (isFixedParent) return;
      if (overId === "drop-ungrouped") {
        dispatch({
          type: "PLACE",
          rowId,
          placement: { kind: "ungrouped" },
        });
        return;
      }
      if (overId.startsWith("drop-insert-")) {
        const parentId = overId.replace("drop-insert-", "") as RowId;
        if (parentId === rowId) return;
        dispatch({
          type: "PLACE",
          rowId,
          placement: { kind: "child", parentId },
        });
      }
    },
    [state.rows],
  );

  const handleSelect = useCallback((rowId: RowId) => {
    dispatch({
      type: "SELECT",
      rowId: rowId,
    });
  }, []);

  const handleZoneClick = useCallback(
    (placement: Placement) => {
      if (!state.selectedRowId) return;
      dispatch({
        type: "PLACE",
        rowId: state.selectedRowId,
        placement,
      });
    },
    [state.selectedRowId],
  );

  const diff = useMemo(() => computeDiff(state), [state]);
  const totalChanges =
    diff.promotions.length + diff.demotions.length + diff.reparentings.length;

  const handleConfirm = useCallback(async () => {
    if (totalChanges === 0) {
      onClose();
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      await apply({
        variantTypeId,
        promotions: diff.promotions,
        demotions: diff.demotions,
        reparentings: diff.reparentings,
      });
      // Reset state so re-open rebuilds from fresh tree.
      dispatch({ type: "RESET" });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes");
    } finally {
      setConfirming(false);
    }
  }, [apply, diff, onClose, totalChanges, variantTypeId]);

  // Keyboard: Escape closes, Enter on Confirm fires (browsers handle Enter
  // on focused button natively).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isLoading = tree === undefined;
  const suggestionCount = state.suggested.size;
  const hasSuggestions = suggestionCount > 0;

  const activeDragValue = activeDragId
    ? state.rows.get(activeDragId as RowId)?.value
    : null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-white">
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

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <ModalSkeleton />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="space-y-4">
                {/* Top-level / Ungrouped pool */}
                <DropZone
                  id="drop-ungrouped"
                  title="Top-level inserts"
                  subtitle={
                    state.selectedRowId
                      ? "Click here to place the selected row at the top level"
                      : "Demoted parallels appear here. They become inserts on Save."
                  }
                  isClickTarget={!!state.selectedRowId}
                  onClick={() => handleZoneClick({ kind: "ungrouped" })}
                  emptyText="(no top-level inserts)"
                >
                  {ungroupedRows.map((info) => {
                    const isFixedParent =
                      info.originalKind === "insert" &&
                      info.originalHadParallels;
                    return (
                      <DraggableRow
                        key={info._id}
                        info={info}
                        isSuggested={state.suggested.has(info._id)}
                        isSelected={state.selectedRowId === info._id}
                        isMovable={!isFixedParent}
                        onSelect={() => handleSelect(info._id)}
                      />
                    );
                  })}
                </DropZone>

                {/* Per-insert "Parallels of X" cards */}
                {parentInserts.map((parent) => {
                  const children = childrenByParent.get(parent._id) ?? [];
                  const hasYellow = children.some((c) =>
                    state.suggested.has(c._id),
                  );
                  return (
                    <DropZone
                      key={parent._id}
                      id={`drop-insert-${parent._id}`}
                      title={`Parallels of "${parent.value}"`}
                      subtitle={
                        state.selectedRowId
                          ? "Click here to make the selected row a parallel"
                          : `${children.length} parallel${children.length === 1 ? "" : "s"}`
                      }
                      isClickTarget={!!state.selectedRowId}
                      onClick={() =>
                        handleZoneClick({
                          kind: "child",
                          parentId: parent._id,
                        })
                      }
                      emptyText="(no parallels — drop rows here to make them parallels)"
                      highlight={hasYellow}
                    >
                      {children.map((info) => (
                        <DraggableRow
                          key={info._id}
                          info={info}
                          isSuggested={state.suggested.has(info._id)}
                          isSelected={state.selectedRowId === info._id}
                          isMovable
                          onSelect={() => handleSelect(info._id)}
                          onReject={() =>
                            dispatch({
                              type: "PLACE",
                              rowId: info._id,
                              placement: { kind: "ungrouped" },
                            })
                          }
                        />
                      ))}
                    </DropZone>
                  );
                })}
              </div>

              <DragOverlay>
                {activeDragValue && (
                  <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                    <span className="text-gray-200">{activeDragValue}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-400">
            {error ? (
              <span className="text-red-300">{error}</span>
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
              <span className="text-gray-500">No changes yet</span>
            )}
          </div>
          <div className="flex gap-3">
            <NeonButton cancel onClick={onClose} disabled={confirming}>
              Cancel
            </NeonButton>
            <NeonButton
              onClick={handleConfirm}
              disabled={confirming || isLoading || totalChanges === 0}
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
    </div>,
    document.body,
  );
}
