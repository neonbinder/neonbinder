import React, { useCallback, useMemo, useReducer, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { Input } from "../primitives/Input";
import type { Id } from "../../convex/_generated/dataModel";

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

export type ItemMetadata = {
  cardNumberPrefix?: string;
  isInsert?: boolean;
  isParallel?: boolean;
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
};

type ReconciliationState = {
  /** Sets that will be written on save. */
  ready: ReadySet[];
  /** Marketplace sets not yet assigned to any NB set. NOT saved. */
  pendingBsc: PlatformItem[];
  pendingSl: PlatformItem[];
  /** Monotonic source of ReadySet keys. Never rewound, so a key is never reused. */
  seq: number;
};

/**
 * NEO-137: a ranked SL candidate for a BSC row that ended up unmatched.
 * `alreadyMatched` means an auto-matched pair already claimed this SL set —
 * confirming it is what creates the M-NB-rows-to-1-marketplace-set mapping.
 */
export type SlCandidateGroup = {
  bsc: PlatformItem;
  candidates: Array<{
    sl: PlatformItem;
    confidence: number;
    alreadyMatched: boolean;
  }>;
};

type Side = "bsc" | "sl";

type ReconciliationAction =
  // Two pending items become a new set. The 1:1 case, which is 95%+ of real
  // reconciliation and stays a single drag.
  | { type: "PROMOTE_PAIR"; bsc: PlatformItem; sl: PlatformItem }
  // One item becomes a set on its own. Replaces "keep as platform-only":
  // a set with ids on one side only is ordinary, not special.
  | { type: "PROMOTE_SOLO"; side: Side; item: PlatformItem }
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

function reconciliationReducer(
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
          action.side === "bsc" ? [...state.pendingBsc, item] : state.pendingBsc,
        pendingSl:
          action.side === "sl" ? [...state.pendingSl, item] : state.pendingSl,
      };
    }
    case "DISBAND": {
      const target = state.ready.find((s) => s.key === action.key);
      if (!target) return state;
      return {
        ...state,
        ready: state.ready.filter((s) => s.key !== action.key),
        pendingBsc: [...state.pendingBsc, ...target.bsc],
        pendingSl: [...state.pendingSl, ...target.sl],
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

// ===== PROPS =====

type ReconciliationModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: ReconciledResult) => Promise<void>;
  level: string;
  // Optional override for the heading label. When provided, replaces the
  // default level-derived noun (e.g. caller passes "Inserts" to display
  // "Reconcile Inserts" instead of the generic "Reconcile Variants").
  levelLabel?: string;
  initialData: {
    autoMatched: MatchedPair[];
    unmatchedBsc: PlatformItem[];
    unmatchedSl: PlatformItem[];
    /** NEO-137 — ranked SL candidates per unmatched BSC row. Optional so
     *  callers that do not pass it behave exactly as before. */
    slCandidates?: SlCandidateGroup[];
  };
  showMetadata?: boolean;
  setName?: string;
  manufacturer?: string;
  // Additional SL-side starts-with prefixes used to narrow the unmatched SL
  // list (e.g., the Base variant's SL anchor name). Merged with the
  // set-name-derived defaults.
  extraSlPrefixes?: string[];
  usedSlPlatformValues?: string[];
  usedBscPlatformValues?: string[];
  // Previously-saved insert rows for this variantType. Used to seed the
  // modal's matched / keptBsc / keptSl sections so re-running a sync
  // preserves prior reconciliation work instead of starting fresh.
  existingRows?: Array<{
    /** The row's own `_id` — see `ReadySet.existingId`. Optional so callers
     *  that predate NEO-211 (and the tests that construct rows by hand) keep
     *  working; without it a title edit is still delete-and-insert. */
    existingId?: Id<"selectorOptions">;
    value: string;
    platformData: { bsc?: string | string[]; sportlots?: string | string[] };
    metadata?: ItemMetadata;
  }>;
};

// ===== DRAGGABLE ITEM =====

// Text input with an inline "×" clear button that appears once the user
// has typed. Clicking it (or pressing Enter on it via keyboard) clears the
// value and returns focus to the input. Used for both BSC and SL filters.
function FilterInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Unique per-instance class so Maestro inputText targets THIS filter rather
  // than the first filter input on screen (multiple FilterInputs share a
  // className; see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  const clear = () => {
    onChange("");
    inputRef.current?.focus();
  };
  return (
    <div className="relative mb-2">
      <Input
        bare
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`${fieldClass()} w-full pl-2.5 pr-7 py-1.5 text-xs`}
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={clear}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-[#00B7FF]"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

function DraggableItem({
  id,
  value,
  platform,
  isSelected,
  onClick,
}: {
  id: string;
  value: string;
  platform: "bsc" | "sl";
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const platformLabel = platform === "bsc" ? "BSC" : "SL";
  const platformColor =
    platform === "bsc"
      ? "bg-blue-900/40 text-blue-300 border-blue-700"
      : "bg-purple-900/40 text-purple-300 border-purple-700";

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`
        px-3 py-2 rounded-lg border cursor-grab active:cursor-grabbing
        text-sm font-medium transition-all select-none
        ${isSelected
          ? "ring-2 ring-[#00B7FF] bg-[#00B7FF]/10 border-[#00B7FF]"
          : "bg-gray-800 border-gray-600 hover:border-gray-400"
        }
      `}
    >
      <div className="flex items-start gap-2">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${platformColor} shrink-0 mt-0.5`}
        >
          {platformLabel}
        </span>
        <span className="text-gray-200 break-words">{value}</span>
      </div>
    </div>
  );
}

// ===== READY SET ROW =====

/**
 * One NeonBinder set: our editable title, plus every marketplace set mapped to
 * it. Also a drop target — dragging a pending item here attaches it, which is
 * how a set grows past the 1:1 case in either direction.
 */
function ReadySetRow({
  set,
  onRename,
  onDetach,
  onDisband,
  onAttachClick,
  attachHint,
  showMetadata,
  onUpdateMetadata,
}: {
  set: ReadySet;
  onRename: (title: string) => void;
  onDetach: (side: Side, platformValue: string) => void;
  onDisband: () => void;
  onAttachClick?: () => void;
  /** Label for the pending item that would be attached, when one is selected. */
  attachHint?: string;
  showMetadata?: boolean;
  onUpdateMetadata?: (metadata: ItemMetadata) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `ready-${set.key}` });

  // Title is edited against a LOCAL draft and committed on blur / Enter.
  //
  // Dispatching RENAME per keystroke would re-render the whole modal — every
  // Ready row, every Pending column — between characters, which is the
  // controlled-input keystroke-drop this codebase has been bitten by before.
  // It is not hypothetical here: a real reconcile can hold a dozen-plus sets.
  // `key` is stable and never reused, so seeding from props is safe.
  const [titleDraft, setTitleDraft] = useState(set.title);
  const commitTitle = () => {
    const next = titleDraft.trim();
    // An empty title would save a nameless set; snap back instead.
    if (!next) {
      setTitleDraft(set.title);
      return;
    }
    if (next !== set.title) onRename(next);
  };

  const confidenceColor =
    set.confidence >= 0.9
      ? "text-green-400"
      : set.confidence >= 0.75
        ? "text-yellow-400"
        : "text-orange-400";

  const chip = (side: Side, item: PlatformItem) => (
    <span
      key={`${side}-${item.platformValue}`}
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${
        side === "bsc"
          ? "bg-blue-900/40 text-blue-200 border-blue-700"
          : "bg-purple-900/40 text-purple-200 border-purple-700"
      }`}
    >
      <span className="opacity-70">{side === "bsc" ? "BSC" : "SL"}</span>
      <span className="break-words">{item.value}</span>
      <button
        type="button"
        onClick={() => onDetach(side, item.platformValue)}
        className="text-pink-400 hover:text-pink-300 px-0.5 rounded"
        title="Remove this mapping"
        aria-label={`Remove ${item.value} from ${set.title}`}
      >
        ✕
      </button>
    </span>
  );

  return (
    <div
      ref={setNodeRef}
      className={`border-l-4 border-[#00D558] rounded-r-lg p-3 mb-2 transition-colors ${
        isOver ? "bg-[#00B7FF]/10 ring-1 ring-[#00B7FF]" : "bg-gray-800/50"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* The title is OUR set name, so it is an input, not a label. */}
        <Input
          bare
          type="text"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTitleDraft(set.title);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label={`NeonBinder set name for ${set.title}`}
          className="flex-1 min-w-0 px-2 py-1 text-sm font-medium text-gray-100 bg-gray-900/60 border border-gray-700 rounded focus:border-[#00B7FF]"
        />
        {set.confidence > 0 && (
          <span className={`text-xs shrink-0 ${confidenceColor}`}>
            {Math.round(set.confidence * 100)}%
          </span>
        )}
        {showMetadata && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-gray-400 hover:text-gray-200 px-2"
            aria-label={`Toggle details for ${set.title}`}
          >
            {expanded ? "▲" : "▼"}
          </button>
        )}
        <button
          onClick={onDisband}
          className="text-xs text-pink-400 hover:text-pink-300 px-2 py-1 rounded hover:bg-pink-900/20 shrink-0"
          title="Remove this set (its mappings return to Pending)"
          aria-label={`Remove set ${set.title}`}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-2">
        {set.bsc.map((i) => chip("bsc", i))}
        {set.sl.map((i) => chip("sl", i))}
        {set.bsc.length === 0 && (
          <span className="text-[11px] text-gray-500 italic">no BSC mapping</span>
        )}
        {set.sl.length === 0 && (
          <span className="text-[11px] text-gray-500 italic">no SL mapping</span>
        )}
      </div>

      {onAttachClick && (
        <button
          type="button"
          onClick={onAttachClick}
          className="mt-2 text-[11px] font-semibold rounded px-2 py-1 bg-[#00B7FF] text-gray-900 hover:bg-[#33C6FF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B7FF]"
          aria-label={`Add ${attachHint} to ${set.title}`}
        >
          Add “{attachHint}” to this set
        </button>
      )}

      {showMetadata && expanded && onUpdateMetadata && (
        <MetadataEditor
          metadata={set.metadata || {}}
          onChange={onUpdateMetadata}
        />
      )}
    </div>
  );
}

// ===== METADATA EDITOR (inline) =====

function MetadataEditor({
  metadata,
  onChange,
}: {
  metadata: ItemMetadata;
  onChange: (metadata: ItemMetadata) => void;
}) {
  // Unique per-instance class so Maestro inputText targets THIS row's Prefix
  // input rather than the first one (MetadataEditor renders once per item;
  // see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  return (
    <div className="mt-2 pt-2 border-t border-gray-700 flex flex-wrap gap-3 items-center">
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={metadata.isInsert || false}
          onChange={(e) => onChange({ isInsert: e.target.checked })}
          className="rounded border-gray-600 bg-gray-700"
        />
        Insert
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={metadata.isParallel || false}
          onChange={(e) => onChange({ isParallel: e.target.checked })}
          className="rounded border-gray-600 bg-gray-700"
        />
        Parallel
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        Prefix:
        <Input
          bare
          type="text"
          value={metadata.cardNumberPrefix || ""}
          onChange={(e) => onChange({ cardNumberPrefix: e.target.value })}
          placeholder="e.g. DK-"
          className={`${fieldClass("prefix")} w-20 px-1.5 py-0.5 text-xs`}
        />
      </label>
    </div>
  );
}

// ===== MAIN COMPONENT =====

export default function ReconciliationModal({
  isOpen,
  onClose,
  onConfirm,
  level,
  levelLabel: levelLabelProp,
  initialData,
  showMetadata = false,
  setName = "",
  manufacturer = "",
  extraSlPrefixes = [],
  usedSlPlatformValues = [],
  usedBscPlatformValues = [],
  existingRows = [],
}: ReconciliationModalProps) {
  const usedSlSet = useMemo(
    () => new Set(usedSlPlatformValues),
    [usedSlPlatformValues],
  );
  const usedBscSet = useMemo(
    () => new Set(usedBscPlatformValues),
    [usedBscPlatformValues],
  );
  // Build the initial state once from a snapshot of initialData + existingRows.
  //
  // Previously-saved rows come back as Ready sets with ALL of their mappings
  // restored. The old code kept only the first id per side (`firstBsc`), which
  // silently dropped operator-attached extras every time the modal reopened —
  // invisible, because the row still looked plausible with one id.
  const initialState: ReconciliationState = useMemo(() => {
    const ready: ReadySet[] = [];
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
      if (bscIds.length === 0 && slIds.length === 0) continue;
      ready.push({
        key: `set-${seq++}`,
        existingId: row.existingId,
        title: row.value,
        bsc: bscIds.map(
          (id) => bscByPv.get(id) ?? { value: row.value, platformValue: id },
        ),
        sl: slIds.map(
          (id) => slByPv.get(id) ?? { value: row.value, platformValue: id },
        ),
        confidence: 0,
        metadata: row.metadata,
      });
      for (const id of bscIds) usedBsc.add(id);
      for (const id of slIds) usedSl.add(id);
    }

    // Auto-matches that do not collide with anything already restored. These
    // are suggestions the reconciler made; they arrive as Ready because 95%+
    // of them are right, and a wrong one is one ✕ away from Pending.
    for (const m of initialData.autoMatched) {
      if (usedBsc.has(m.bsc.platformValue) || usedSl.has(m.sl.platformValue)) {
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

    return {
      ready,
      pendingBsc: initialData.unmatchedBsc.filter(
        (it) => !usedBsc.has(it.platformValue),
      ),
      pendingSl: initialData.unmatchedSl.filter(
        (it) => !usedSl.has(it.platformValue),
      ),
      seq,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [state, dispatch] = useReducer(reconciliationReducer, initialState);

  // ONE selection at a time, either side. Clicking the opposite side pairs
  // them; clicking a Ready set attaches to it. Drag does the same things but
  // is not keyboard-operable, so the click path is the accessible one.
  const [selected, setSelected] = useState<{ side: Side; value: string } | null>(
    null,
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Default SL-side prefixes: full set name, set name with manufacturer
  // prefix stripped, plus any caller-supplied extras (typically the SL Base
  // anchor's name). De-duped and lowercased.
  // e.g. setName="Topps Chrome", mfg="Topps", extra=["Chrome"] → ["topps chrome", "chrome"]
  const defaultSlPrefixes = useMemo(() => {
    const setNorm = setName.trim().toLowerCase();
    const mfgNorm = manufacturer.trim().toLowerCase();
    const prefixes: string[] = [];
    const seen = new Set<string>();
    const push = (p: string) => {
      const v = p.trim().toLowerCase();
      if (v && !seen.has(v)) {
        seen.add(v);
        prefixes.push(v);
      }
    };
    if (setNorm) push(setNorm);
    if (mfgNorm && setNorm.startsWith(`${mfgNorm} `)) {
      push(setNorm.slice(mfgNorm.length + 1).trim());
    }
    for (const extra of extraSlPrefixes) push(extra);
    return prefixes;
  }, [setName, manufacturer, extraSlPrefixes]);

  const [slFilter, setSlFilter] = useState<string>("");
  const [showAllSl, setShowAllSl] = useState<boolean>(false);
  const [bscFilter, setBscFilter] = useState<string>("");
  const [readyFilter, setReadyFilter] = useState<string>("");
  // Reveal marketplace sets that some NB set already maps. NOT a sharing
  // concept — mapping never consumed anything, this just keeps the default
  // list short by hiding what is already accounted for.
  const [showMappedBsc, setShowMappedBsc] = useState<boolean>(false);
  const [showMappedSl, setShowMappedSl] = useState<boolean>(false);

  // The "Show all" toggle controls the SL prefix filter only. The typed
  // query is applied as a secondary contains-search on top of whatever
  // the prefix filter selects (mirroring how the BSC filter works).
  const activeSlPrefixes = useMemo(() => {
    if (showAllSl) return [];
    return defaultSlPrefixes;
  }, [showAllSl, defaultSlPrefixes]);

  const slQuery = useMemo(() => slFilter.trim().toLowerCase(), [slFilter]);
  const bscQuery = useMemo(() => bscFilter.trim().toLowerCase(), [bscFilter]);

  // Filter pending columns by platformValue only. The same display value can
  // legitimately appear across variantTypes ("Inception" exists as both a Base
  // and a Parallel) — only the underlying platform identifier identifies a set.
  //
  // NOTE what is deliberately NOT here: nothing is hidden because some other NB
  // set already maps to it. `usedSlPlatformValues` scopes this modal to its own
  // level; within it, a marketplace set may be mapped by any number of NB sets.
  const filteredPendingSl = useMemo(() => {
    return state.pendingSl.filter((item) => {
      if (usedSlSet.has(item.platformValue)) return false;
      const v = item.value.toLowerCase();
      if (
        activeSlPrefixes.length > 0 &&
        !activeSlPrefixes.some((p) => v.startsWith(p))
      ) {
        return false;
      }
      if (slQuery && !v.includes(slQuery)) return false;
      return true;
    });
  }, [state.pendingSl, activeSlPrefixes, slQuery, usedSlSet]);

  const filteredPendingBsc = useMemo(() => {
    return state.pendingBsc.filter((item) => {
      if (usedBscSet.has(item.platformValue)) return false;
      if (!bscQuery) return true;
      return item.value.toLowerCase().includes(bscQuery);
    });
  }, [state.pendingBsc, usedBscSet, bscQuery]);

  // A real reconcile can hold a dozen-plus Ready sets, which pushes Pending out
  // of reach — the dialog body is its own scroller, so there is no getting back
  // to it without a lot of wheel. Filtering by OUR title or by any mapped
  // marketplace name keeps both halves usable, and it is how an operator finds
  // the one set they came to fix.
  const readyQuery = useMemo(
    () => readyFilter.trim().toLowerCase(),
    [readyFilter],
  );
  const filteredReady = useMemo(() => {
    if (!readyQuery) return state.ready;
    return state.ready.filter(
      (set) =>
        set.title.toLowerCase().includes(readyQuery) ||
        set.bsc.some((i) => i.value.toLowerCase().includes(readyQuery)) ||
        set.sl.some((i) => i.value.toLowerCase().includes(readyQuery)),
    );
  }, [state.ready, readyQuery]);

  // One entry per marketplace id already mapped by some NB set, carrying the
  // titles that map it so the operator can see where it is in use.
  const mappedItems = useCallback(
    (side: Side): Array<{ item: PlatformItem; usedBy: string[] }> => {
      const byPv = new Map<string, { item: PlatformItem; usedBy: string[] }>();
      for (const set of state.ready) {
        for (const item of side === "bsc" ? set.bsc : set.sl) {
          const hit = byPv.get(item.platformValue);
          if (hit) hit.usedBy.push(set.title);
          else byPv.set(item.platformValue, { item, usedBy: [set.title] });
        }
      }
      return [...byPv.values()];
    },
    [state.ready],
  );

  // Resolve a dragged/clicked value to its item, whether it is still pending or
  // already mapped somewhere.
  const resolveItem = useCallback(
    (side: Side, value: string): PlatformItem | undefined => {
      const pending = (side === "bsc" ? state.pendingBsc : state.pendingSl).find(
        (i) => i.value === value,
      );
      if (pending) return pending;
      for (const set of state.ready) {
        const hit = (side === "bsc" ? set.bsc : set.sl).find(
          (i) => i.value === value,
        );
        if (hit) return hit;
      }
      return undefined;
    },
    [state.pendingBsc, state.pendingSl, state.ready],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // Values are sliced, not `replace`d — replace strips the first occurrence
      // anywhere in the string, which corrupts any value containing the prefix.
      const activeSide: Side | null = activeId.startsWith("bsc-")
        ? "bsc"
        : activeId.startsWith("sl-")
          ? "sl"
          : null;
      if (!activeSide) return;
      const activeValue = activeId.slice(activeSide.length + 1);

      const activeItem = resolveItem(activeSide, activeValue);
      if (!activeItem) return;

      // Dropped on a Ready set → join it.
      if (overId.startsWith("ready-")) {
        dispatch({
          type: "ATTACH",
          key: overId.slice("ready-".length),
          side: activeSide,
          item: activeItem,
        });
        return;
      }

      // Dropped on the opposite side's pending item → the two become a set.
      const overSide: Side | null = overId.startsWith("bsc-")
        ? "bsc"
        : overId.startsWith("sl-")
          ? "sl"
          : null;
      if (!overSide || overSide === activeSide) return;
      const overItem = resolveItem(overSide, overId.slice(overSide.length + 1));
      if (!overItem) return;

      dispatch({
        type: "PROMOTE_PAIR",
        bsc: activeSide === "bsc" ? activeItem : overItem,
        sl: activeSide === "sl" ? activeItem : overItem,
      });
    },
    [resolveItem],
  );

  // Click-to-link, the keyboard-reachable mirror of the drags above.
  const handlePendingClick = useCallback(
    (side: Side, value: string) => {
      if (selected && selected.side !== side) {
        const here = resolveItem(side, value);
        const there = resolveItem(selected.side, selected.value);
        if (here && there) {
          dispatch({
            type: "PROMOTE_PAIR",
            bsc: side === "bsc" ? here : there,
            sl: side === "sl" ? here : there,
          });
        }
        setSelected(null);
        return;
      }
      setSelected(
        selected && selected.side === side && selected.value === value
          ? null
          : { side, value },
      );
    },
    [selected, resolveItem],
  );

  const handleAttachClick = useCallback(
    (key: string) => {
      if (!selected) return;
      const item = resolveItem(selected.side, selected.value);
      if (item) dispatch({ type: "ATTACH", key, side: selected.side, item });
      setSelected(null);
    },
    [selected, resolveItem],
  );

  const handlePromoteSolo = useCallback(
    (side: Side, value: string) => {
      const item = resolveItem(side, value);
      if (item) dispatch({ type: "PROMOTE_SOLO", side, item });
      setSelected(null);
    },
    [resolveItem],
  );

  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    try {
      const items: ReconciledResult["items"] = state.ready.map((set) => {
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
        };
      });

      // Anything left in Pending is intentionally discarded — SL especially
      // returns siblings from other variantTypes that don't belong here.
      await onConfirm({ items });
    } finally {
      setConfirming(false);
    }
  }, [state, onConfirm]);

  // Find the dragged item for the overlay
  const activeDragItem = useMemo(() => {
    if (!activeDragId) return null;
    if (activeDragId.startsWith("bsc-")) {
      const value = activeDragId.replace("bsc-", "");
      return { value, platform: "bsc" as const };
    }
    if (activeDragId.startsWith("sl-")) {
      const value = activeDragId.replace("sl-", "");
      return { value, platform: "sl" as const };
    }
    return null;
  }, [activeDragId]);

  if (!isOpen) return null;

  const levelLabel =
    levelLabelProp ??
    (level === "insert"
      ? "Variants"
      : level === "parallel"
        ? "Variants of Variants"
        : level);

  const saveCount = state.ready.length;
  const pendingCount = state.pendingBsc.length + state.pendingSl.length;

  const renderPendingColumn = (side: Side) => {
    const isBsc = side === "bsc";
    const filtered = isBsc ? filteredPendingBsc : filteredPendingSl;
    const all = isBsc ? state.pendingBsc : state.pendingSl;
    const query = isBsc ? bscQuery : slQuery;
    // Already-mapped sets, revealed on request. Mapping never consumed them —
    // this toggle only keeps the default list to what still needs attention.
    const showMapped = isBsc ? showMappedBsc : showMappedSl;
    const mapped = showMapped
      ? mappedItems(side).filter(
          ({ item }) =>
            !query || item.value.toLowerCase().includes(query),
        )
      : [];

    return (
      <div>
        <div
          className={`text-xs font-medium uppercase tracking-wide mb-2 ${
            isBsc ? "text-blue-400" : "text-purple-400"
          }`}
        >
          {isBsc ? "BSC" : "SportLots"} ({filtered.length}
          {filtered.length !== all.length ? ` of ${all.length}` : ""})
        </div>
        <FilterInput
          value={isBsc ? bscFilter : slFilter}
          onChange={isBsc ? setBscFilter : setSlFilter}
          placeholder={isBsc ? "Filter BSC items..." : "Search SportLots items..."}
          ariaLabel={isBsc ? "Filter BSC items" : "Search SportLots items"}
        />
        {isBsc ? (
          // Spacer keeps the two lists' tops aligned; only SL has a prefix
          // filter worth toggling.
          <div className="mb-2 h-[18px]" aria-hidden="true" />
        ) : (
          <label className="flex items-center gap-2 mb-2 text-xs text-gray-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showAllSl}
              onChange={(e) => setShowAllSl(e.target.checked)}
              aria-label="Show all SportLots items"
              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 text-purple-500 focus:ring-1 focus:ring-purple-400"
            />
            Show all SportLots items
          </label>
        )}
        <label className="flex items-center gap-2 mb-2 text-xs text-gray-400 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={showMapped}
            onChange={(e) =>
              (isBsc ? setShowMappedBsc : setShowMappedSl)(e.target.checked)
            }
            aria-label={`Show ${isBsc ? "BSC" : "SportLots"} sets already mapped`}
            className={`h-3.5 w-3.5 rounded border-gray-600 bg-gray-800 focus:ring-1 ${
              isBsc
                ? "text-blue-500 focus:ring-blue-400"
                : "text-purple-500 focus:ring-purple-400"
            }`}
          />
          Show sets already mapped
        </label>
        <div className="space-y-1.5 min-h-[60px]">
          {filtered.map((item) => (
            <div key={`${side}-${item.value}`}>
              <DraggableItem
                id={`${side}-${item.value}`}
                value={item.value}
                platform={side}
                isSelected={
                  selected?.side === side && selected.value === item.value
                }
                onClick={() => handlePendingClick(side, item.value)}
              />
              <button
                type="button"
                onClick={() => handlePromoteSolo(side, item.value)}
                className="mt-1 text-[11px] text-gray-400 hover:text-[#00B7FF] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#00B7FF] rounded px-1"
                aria-label={`Make ${item.value} its own NeonBinder set`}
              >
                + Make its own set
              </button>
            </div>
          ))}
          {mapped.map(({ item, usedBy }) => (
            <div key={`mapped-${side}-${item.value}`}>
              <DraggableItem
                id={`${side}-${item.value}`}
                value={item.value}
                platform={side}
                isSelected={
                  selected?.side === side && selected.value === item.value
                }
                onClick={() => handlePendingClick(side, item.value)}
              />
              <p className="text-[11px] text-gray-500 mt-0.5 px-1 truncate">
                mapped to {usedBy.join(", ")}
              </p>
            </div>
          ))}
          {all.length === 0 && mapped.length === 0 && (
            <p className="text-xs text-gray-500 italic py-2">
              Nothing pending on {isBsc ? "BSC" : "SportLots"}
            </p>
          )}
          {all.length > 0 && filtered.length === 0 && (
            <p className="text-xs text-gray-500 italic py-2">
              {query
                ? `No ${isBsc ? "BSC" : "SL"} items contain "${query}"`
                : !isBsc && activeSlPrefixes.length > 0
                  ? `No SL items start with ${activeSlPrefixes
                      .map((p) => `"${p}"`)
                      .join(" or ")}`
                  : "Nothing to show"}
            </p>
          )}
        </div>
      </div>
    );
  };

  return createPortal(
    // NEO-71-74 QA fix: see BaseSetPicker.tsx for why this nested <Theme> is
    // needed — createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-6xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-white">
            Reconcile {levelLabel}
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            {saveCount} ready
            {pendingCount > 0 ? `, ${pendingCount} pending` : ""}
          </p>
        </div>

        {/* One DndContext over BOTH sections — a pending item is dragged onto a
            Ready set, so they cannot be in separate contexts. */}
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            {/* ── READY ─────────────────────────────────────────────── */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-1">
                Ready ({filteredReady.length}
                {filteredReady.length !== state.ready.length
                  ? ` of ${state.ready.length}`
                  : ""}
                )
              </h3>
              <p className="text-xs text-gray-500 mb-2">
                These become NeonBinder sets. The title is ours — edit it freely.
                Each set can map to any number of BSC and SportLots sets.
              </p>
              {state.ready.length > 0 && (
                <div className="mb-2">
                  <FilterInput
                    value={readyFilter}
                    onChange={setReadyFilter}
                    placeholder="Filter sets..."
                    ariaLabel="Filter NeonBinder sets"
                  />
                </div>
              )}
              {state.ready.length === 0 ? (
                <p className="text-xs text-gray-500 italic py-2">
                  No sets yet. Pair two items below, or make one its own set.
                </p>
              ) : filteredReady.length === 0 ? (
                <p className="text-xs text-gray-500 italic py-2">
                  No sets match "{readyQuery}"
                </p>
              ) : (
                filteredReady.map((set) => (
                  <ReadySetRow
                    key={set.key}
                    set={set}
                    showMetadata={showMetadata}
                    attachHint={selected?.value}
                    onAttachClick={
                      selected ? () => handleAttachClick(set.key) : undefined
                    }
                    onRename={(title) =>
                      dispatch({ type: "RENAME", key: set.key, title })
                    }
                    onDetach={(side, platformValue) =>
                      dispatch({ type: "DETACH", key: set.key, side, platformValue })
                    }
                    onDisband={() => dispatch({ type: "DISBAND", key: set.key })}
                    onUpdateMetadata={(metadata) =>
                      dispatch({ type: "UPDATE_METADATA", key: set.key, metadata })
                    }
                  />
                ))
              )}
            </div>

            {/* ── PENDING ───────────────────────────────────────────── */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-1">
                Pending ({pendingCount})
              </h3>
              <p className="text-xs text-gray-500 mb-2">
                Drag one onto the other to make a set, or onto a set above to add
                it there. Anything left here is not saved.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {renderPendingColumn("bsc")}
                {renderPendingColumn("sl")}
              </div>
            </div>
          </div>

          <DragOverlay>
            {activeDragItem && (
              <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                <span className="text-gray-200">{activeDragItem.value}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
          <NeonButton cancel onClick={onClose} disabled={confirming}>
            Cancel
          </NeonButton>
          <NeonButton
            onClick={handleConfirm}
            disabled={confirming || saveCount === 0}
          >
            {confirming ? "Saving..." : `Save ${saveCount} sets`}
          </NeonButton>
        </div>
      </div>
    </div>
    </Theme>,
    document.body,
  );
}