import React, { useCallback, useMemo, useReducer, useState } from "react";
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

type MatchedPairWithMetadata = MatchedPair & { metadata?: ItemMetadata };

type ReconciliationState = {
  matched: MatchedPairWithMetadata[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
  // User-marked "save as platform-only" items. Default Confirm only writes
  // matched + kept; remaining unmatched items are discarded so SL noise
  // (variants of other variantTypes that came back from dealsets.tpl) is
  // dropped without manual cleanup.
  keptBsc: PlatformItem[];
  keptSl: PlatformItem[];
};

type ReconciliationAction =
  | { type: "LINK"; bscValue: string; slValue: string }
  | { type: "UNLINK"; index: number }
  | { type: "UPDATE_METADATA"; index: number; metadata: ItemMetadata }
  | { type: "KEEP_BSC"; value: string }
  | { type: "KEEP_SL"; value: string }
  | { type: "UNKEEP_BSC"; value: string }
  | { type: "UNKEEP_SL"; value: string };

export type ReconciledResult = {
  items: Array<{
    value: string;
    platformData: {
      bsc?: string;
      sportlots?: string;
    };
    metadata?: ItemMetadata;
  }>;
};

function reconciliationReducer(
  state: ReconciliationState,
  action: ReconciliationAction,
): ReconciliationState {
  switch (action.type) {
    case "LINK": {
      const bscIndex = state.unmatchedBsc.findIndex(
        (item) => item.value === action.bscValue,
      );
      const slIndex = state.unmatchedSl.findIndex(
        (item) => item.value === action.slValue,
      );
      if (bscIndex === -1 || slIndex === -1) return state;

      const bscItem = state.unmatchedBsc[bscIndex];
      const slItem = state.unmatchedSl[slIndex];

      return {
        ...state,
        matched: [
          ...state.matched,
          {
            displayName: bscItem.value,
            bsc: bscItem,
            sl: slItem,
            confidence: 0,
          },
        ],
        unmatchedBsc: state.unmatchedBsc.filter((_, i) => i !== bscIndex),
        unmatchedSl: state.unmatchedSl.filter((_, i) => i !== slIndex),
      };
    }
    case "UNLINK": {
      const pair = state.matched[action.index];
      if (!pair) return state;
      return {
        ...state,
        matched: state.matched.filter((_, i) => i !== action.index),
        unmatchedBsc: [...state.unmatchedBsc, pair.bsc],
        unmatchedSl: [...state.unmatchedSl, pair.sl],
      };
    }
    case "UPDATE_METADATA": {
      const newMatched = [...state.matched];
      if (newMatched[action.index]) {
        newMatched[action.index] = {
          ...newMatched[action.index],
          metadata: {
            ...(newMatched[action.index].metadata || {}),
            ...action.metadata,
          },
        };
      }
      return { ...state, matched: newMatched };
    }
    case "KEEP_BSC": {
      const idx = state.unmatchedBsc.findIndex((it) => it.value === action.value);
      if (idx === -1) return state;
      const item = state.unmatchedBsc[idx];
      return {
        ...state,
        unmatchedBsc: state.unmatchedBsc.filter((_, i) => i !== idx),
        keptBsc: [...state.keptBsc, item],
      };
    }
    case "KEEP_SL": {
      const idx = state.unmatchedSl.findIndex((it) => it.value === action.value);
      if (idx === -1) return state;
      const item = state.unmatchedSl[idx];
      return {
        ...state,
        unmatchedSl: state.unmatchedSl.filter((_, i) => i !== idx),
        keptSl: [...state.keptSl, item],
      };
    }
    case "UNKEEP_BSC": {
      const idx = state.keptBsc.findIndex((it) => it.value === action.value);
      if (idx === -1) return state;
      const item = state.keptBsc[idx];
      return {
        ...state,
        keptBsc: state.keptBsc.filter((_, i) => i !== idx),
        unmatchedBsc: [...state.unmatchedBsc, item],
      };
    }
    case "UNKEEP_SL": {
      const idx = state.keptSl.findIndex((it) => it.value === action.value);
      if (idx === -1) return state;
      const item = state.keptSl[idx];
      return {
        ...state,
        keptSl: state.keptSl.filter((_, i) => i !== idx),
        unmatchedSl: [...state.unmatchedSl, item],
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
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`${fieldClass()} w-full pl-2.5 pr-7 py-1.5 text-xs bg-gray-800 border border-gray-600 rounded-md text-gray-200 placeholder-gray-500`}
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

// ===== KEPT ITEM (platform-only, draggable for unkeep via X) =====

function KeptItemRow({
  value,
  platform,
  onUnkeep,
}: {
  value: string;
  platform: "bsc" | "sl";
  onUnkeep: () => void;
}) {
  const platformLabel = platform === "bsc" ? "BSC" : "SL";
  const platformColor =
    platform === "bsc"
      ? "bg-blue-900/40 text-blue-300 border-blue-700"
      : "bg-purple-900/40 text-purple-300 border-purple-700";

  return (
    <div className="px-3 py-2 rounded-lg border border-amber-700 bg-amber-900/10 text-sm font-medium flex items-center gap-2">
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded border ${platformColor} shrink-0`}
      >
        {platformLabel}
      </span>
      <span className="text-gray-200 break-words flex-1">{value}</span>
      <button
        onClick={onUnkeep}
        className="text-xs text-pink-400 hover:text-pink-300 px-2 py-0.5 rounded hover:bg-pink-900/20"
        title="Send back to unmatched"
        aria-label={`Remove ${value} from save list`}
      >
        ✕
      </button>
    </div>
  );
}

// ===== KEEP SHELF (drop target for "save as platform-only") =====

function KeepShelf({ children, isEmpty }: { children: React.ReactNode; isEmpty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "keep-shelf" });
  return (
    <div
      ref={setNodeRef}
      className={`mt-4 rounded-lg border-2 border-dashed transition-colors p-3 ${
        isOver
          ? "border-amber-400 bg-amber-900/10"
          : isEmpty
            ? "border-gray-700 bg-gray-900/30"
            : "border-amber-700/60 bg-amber-900/5"
      }`}
    >
      <div className="text-xs text-amber-400 font-medium uppercase tracking-wide mb-2">
        Keep as platform-only (drop unmatched items here)
      </div>
      {isEmpty ? (
        <p className="text-xs text-gray-500 italic py-2">
          By default, only matched pairs are saved. Drag items from the
          BSC or SL columns above to keep them as platform-only entries.
        </p>
      ) : (
        <div className="space-y-1.5">{children}</div>
      )}
    </div>
  );
}

// ===== MATCHED ROW =====

function MatchedRow({
  pair,
  index,
  onUnlink,
  showMetadata,
  onUpdateMetadata,
}: {
  pair: MatchedPairWithMetadata;
  index: number;
  onUnlink: () => void;
  showMetadata?: boolean;
  onUpdateMetadata?: (metadata: ItemMetadata) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const confidenceColor =
    pair.confidence >= 0.9
      ? "text-green-400"
      : pair.confidence >= 0.75
        ? "text-yellow-400"
        : "text-orange-400";

  return (
    <div className="border-l-4 border-[#00D558] bg-gray-800/50 rounded-r-lg p-3 mb-2">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 text-sm">
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-900/40 text-blue-300 border-blue-700 shrink-0 mt-0.5">
              BSC
            </span>
            <span className="text-gray-200 break-words">{pair.bsc.value}</span>
          </div>
          <div className="flex items-start gap-2 text-sm mt-1">
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-purple-900/40 text-purple-300 border-purple-700 shrink-0 mt-0.5">
              SL
            </span>
            <span className="text-gray-400 break-words">{pair.sl.value}</span>
          </div>
        </div>
        {pair.confidence > 0 && (
          <span className={`text-xs ${confidenceColor}`}>
            {Math.round(pair.confidence * 100)}%
          </span>
        )}
        {showMetadata && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-gray-400 hover:text-gray-200 px-2"
          >
            {expanded ? "▲" : "▼"}
          </button>
        )}
        <button
          onClick={onUnlink}
          className="text-xs text-pink-400 hover:text-pink-300 px-2 py-1 rounded hover:bg-pink-900/20"
          title="Unlink"
        >
          ✕
        </button>
      </div>

      {showMetadata && expanded && onUpdateMetadata && (
        <MetadataEditor
          metadata={pair.metadata || {}}
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
        <input
          type="text"
          value={metadata.cardNumberPrefix || ""}
          onChange={(e) => onChange({ cardNumberPrefix: e.target.value })}
          placeholder="e.g. DK-"
          className={`${fieldClass("prefix")} w-20 px-1.5 py-0.5 text-xs bg-gray-700 border border-gray-600 rounded text-gray-200`}
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
  // Saved rows are bucketed into matched (both platforms set), keptBsc (only
  // bsc), or keptSl (only sportlots). Their platformValues are then removed
  // from the fresh auto-match and unmatched lists so re-running doesn't
  // duplicate work.
  const initialState: ReconciliationState = useMemo(() => {
    const matched: MatchedPairWithMetadata[] = [];
    const keptBsc: PlatformItem[] = [];
    const keptSl: PlatformItem[] = [];
    const usedBsc = new Set<string>();
    const usedSl = new Set<string>();

    // Build platform-value → fresh PlatformItem lookup so matched rows can
    // surface the up-to-date display value when available.
    const bscByPv = new Map<string, PlatformItem>();
    for (const item of initialData.unmatchedBsc) bscByPv.set(item.platformValue, item);
    for (const m of initialData.autoMatched) bscByPv.set(m.bsc.platformValue, m.bsc);
    const slByPv = new Map<string, PlatformItem>();
    for (const item of initialData.unmatchedSl) slByPv.set(item.platformValue, item);
    for (const m of initialData.autoMatched) slByPv.set(m.sl.platformValue, m.sl);

    const firstBsc = (bsc: string | string[] | undefined): string | undefined => {
      if (typeof bsc === "string") return bsc;
      if (Array.isArray(bsc) && bsc.length > 0) return bsc[0];
      return undefined;
    };

    for (const row of existingRows) {
      const bscPv = firstBsc(row.platformData.bsc);
      // SL now widened to string|string[] — use the same first-value heuristic.
      const slPv = firstBsc(row.platformData.sportlots);
      if (bscPv && slPv) {
        const bscItem = bscByPv.get(bscPv) ?? { value: row.value, platformValue: bscPv };
        const slItem = slByPv.get(slPv) ?? { value: row.value, platformValue: slPv };
        matched.push({
          displayName: row.value,
          bsc: bscItem,
          sl: slItem,
          confidence: 1,
          metadata: row.metadata,
        });
        usedBsc.add(bscPv);
        usedSl.add(slPv);
      } else if (bscPv) {
        keptBsc.push(bscByPv.get(bscPv) ?? { value: row.value, platformValue: bscPv });
        usedBsc.add(bscPv);
      } else if (slPv) {
        keptSl.push(slByPv.get(slPv) ?? { value: row.value, platformValue: slPv });
        usedSl.add(slPv);
      }
    }

    // Append fresh auto-matches that don't conflict with anything we already
    // restored from existing rows.
    for (const m of initialData.autoMatched) {
      if (usedBsc.has(m.bsc.platformValue) || usedSl.has(m.sl.platformValue)) continue;
      matched.push({ ...m });
      usedBsc.add(m.bsc.platformValue);
      usedSl.add(m.sl.platformValue);
    }

    return {
      matched,
      unmatchedBsc: initialData.unmatchedBsc.filter(
        (it) => !usedBsc.has(it.platformValue),
      ),
      unmatchedSl: initialData.unmatchedSl.filter(
        (it) => !usedSl.has(it.platformValue),
      ),
      keptBsc,
      keptSl,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [state, dispatch] = useReducer(reconciliationReducer, initialState);

  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [matchedCollapsed, setMatchedCollapsed] = useState(true);
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

  // The "Show all" toggle controls the SL prefix filter only. The typed
  // query is applied as a secondary contains-search on top of whatever
  // the prefix filter selects (mirroring how the BSC filter works).
  const activeSlPrefixes = useMemo(() => {
    if (showAllSl) return [];
    return defaultSlPrefixes;
  }, [showAllSl, defaultSlPrefixes]);

  const slQuery = useMemo(() => slFilter.trim().toLowerCase(), [slFilter]);
  const bscQuery = useMemo(() => bscFilter.trim().toLowerCase(), [bscFilter]);

  // Filter unmatched columns by platformValue only. The same display value
  // can legitimately appear across variantTypes ("Inception" exists as both
  // a Base and a Parallel) — only the underlying platform identifier is a
  // true "already claimed" signal. usedValueSet would otherwise hide items
  // the user just unlinked, leaving them no way to re-pair manually.
  const filteredUnmatchedSl = useMemo(() => {
    return state.unmatchedSl.filter((item) => {
      if (usedSlSet.has(item.platformValue)) return false;
      const v = item.value.toLowerCase();
      // Prefix filter (skipped when "Show all" is checked).
      if (
        activeSlPrefixes.length > 0 &&
        !activeSlPrefixes.some((p) => v.startsWith(p))
      ) {
        return false;
      }
      // Substring search within the prefix-filtered list.
      if (slQuery && !v.includes(slQuery)) return false;
      return true;
    });
  }, [state.unmatchedSl, activeSlPrefixes, slQuery, usedSlSet]);

  const filteredUnmatchedBsc = useMemo(() => {
    return state.unmatchedBsc.filter((item) => {
      if (usedBscSet.has(item.platformValue)) return false;
      if (!bscQuery) return true;
      return item.value.toLowerCase().includes(bscQuery);
    });
  }, [state.unmatchedBsc, usedBscSet, bscQuery]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // Build ID maps for DnD
  const bscIds = useMemo(
    () => state.unmatchedBsc.map((item) => `bsc-${item.value}`),
    [state.unmatchedBsc],
  );
  const slIds = useMemo(
    () => state.unmatchedSl.map((item) => `sl-${item.value}`),
    [state.unmatchedSl],
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

      const isActiveBsc = activeId.startsWith("bsc-");
      const isOverSl = overId.startsWith("sl-");
      const isActiveSl = activeId.startsWith("sl-");
      const isOverBsc = overId.startsWith("bsc-");

      const isOverKeepShelf =
        overId === "keep-shelf" || overId.startsWith("kept-");

      if (isActiveBsc && isOverSl) {
        dispatch({
          type: "LINK",
          bscValue: activeId.replace("bsc-", ""),
          slValue: overId.replace("sl-", ""),
        });
      } else if (isActiveSl && isOverBsc) {
        dispatch({
          type: "LINK",
          bscValue: overId.replace("bsc-", ""),
          slValue: activeId.replace("sl-", ""),
        });
      } else if (isActiveBsc && isOverKeepShelf) {
        dispatch({ type: "KEEP_BSC", value: activeId.replace("bsc-", "") });
      } else if (isActiveSl && isOverKeepShelf) {
        dispatch({ type: "KEEP_SL", value: activeId.replace("sl-", "") });
      }
    },
    [],
  );

  // Click-to-link: click BSC item then click SL item
  const handleBscClick = useCallback(
    (value: string) => {
      if (selectedBsc === value) {
        setSelectedBsc(null);
      } else {
        setSelectedBsc(value);
      }
    },
    [selectedBsc],
  );

  const handleSlClick = useCallback(
    (value: string) => {
      if (selectedBsc) {
        dispatch({ type: "LINK", bscValue: selectedBsc, slValue: value });
        setSelectedBsc(null);
      }
    },
    [selectedBsc],
  );

  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    try {
      const items: ReconciledResult["items"] = [];

      // Matched pairs: both platforms
      for (const pair of state.matched) {
        items.push({
          value: pair.displayName,
          platformData: {
            bsc: pair.bsc.platformValue,
            sportlots: pair.sl.platformValue,
          },
          metadata: pair.metadata,
        });
      }

      // Kept BSC-only: user explicitly opted to save
      for (const item of state.keptBsc) {
        items.push({
          value: item.value,
          platformData: { bsc: item.platformValue },
        });
      }

      // Kept SL-only: user explicitly opted to save
      for (const item of state.keptSl) {
        items.push({
          value: item.value,
          platformData: { sportlots: item.platformValue },
        });
      }

      // Anything still in state.unmatchedBsc / state.unmatchedSl is intentionally
      // discarded — SL especially returns siblings from other variantTypes that
      // don't belong to this set.

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

  const keptCount = state.keptBsc.length + state.keptSl.length;
  const saveCount = state.matched.length + keptCount;
  const totalItems =
    state.matched.length +
    state.unmatchedBsc.length +
    state.unmatchedSl.length +
    keptCount;

  return (
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
            {state.matched.length} matched
            {keptCount > 0 ? `, ${keptCount} kept` : ""},{" "}
            {state.unmatchedBsc.length} BSC-only,{" "}
            {state.unmatchedSl.length} SL-only ({totalItems} total)
          </p>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Auto-matched section (collapsible) */}
          {state.matched.length > 0 && (
            <div>
              <button
                onClick={() => setMatchedCollapsed(!matchedCollapsed)}
                className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2 hover:text-gray-100 transition-colors"
              >
                <span className="text-xs">{matchedCollapsed ? "▶" : "▼"}</span>
                <span>Matched ({state.matched.length})</span>
                {matchedCollapsed && (
                  <span className="text-xs text-gray-500">— click to review</span>
                )}
              </button>
              {!matchedCollapsed && state.matched.map((pair, index) => (
                <MatchedRow
                  key={`${pair.bsc.value}-${pair.sl.value}`}
                  pair={pair}
                  index={index}
                  onUnlink={() => dispatch({ type: "UNLINK", index })}
                  showMetadata={showMetadata}
                  onUpdateMetadata={(metadata) =>
                    dispatch({ type: "UPDATE_METADATA", index, metadata })
                  }
                />
              ))}
            </div>
          )}

          {/* Unmatched + Keep shelf section with shared DnD */}
          {(state.unmatchedBsc.length > 0 ||
            state.unmatchedSl.length > 0 ||
            keptCount > 0) && (
            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">
                  Unmatched — drag to link, or drag down to "keep as platform-only"
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  {/* BSC column */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs text-blue-400 font-medium uppercase tracking-wide">
                        BSC ({filteredUnmatchedBsc.length}
                        {filteredUnmatchedBsc.length !== state.unmatchedBsc.length
                          ? ` of ${state.unmatchedBsc.length}`
                          : ""}
                        )
                      </div>
                    </div>
                    <FilterInput
                      value={bscFilter}
                      onChange={setBscFilter}
                      placeholder="Filter BSC items..."
                      ariaLabel="Filter BSC items"
                    />
                    {/* Spacer matches the SL column's "Show all" checkbox row
                        so both list tops line up. */}
                    <div className="mb-2 h-[18px]" aria-hidden="true" />
                    <div className="space-y-1.5 min-h-[60px]">
                      {filteredUnmatchedBsc.map((item) => (
                        <DraggableItem
                          key={`bsc-${item.value}`}
                          id={`bsc-${item.value}`}
                          value={item.value}
                          platform="bsc"
                          isSelected={selectedBsc === item.value}
                          onClick={() => handleBscClick(item.value)}
                        />
                      ))}
                      {state.unmatchedBsc.length === 0 && (
                        <p className="text-xs text-gray-500 italic py-2">
                          All BSC items matched
                        </p>
                      )}
                      {state.unmatchedBsc.length > 0 &&
                        filteredUnmatchedBsc.length === 0 &&
                        bscQuery && (
                          <p className="text-xs text-gray-500 italic py-2">
                            No BSC items contain "{bscQuery}"
                          </p>
                        )}
                    </div>
                  </div>

                  {/* SL column */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs text-purple-400 font-medium uppercase tracking-wide">
                        SportLots ({filteredUnmatchedSl.length}
                        {filteredUnmatchedSl.length !== state.unmatchedSl.length
                          ? ` of ${state.unmatchedSl.length}`
                          : ""}
                        )
                      </div>
                    </div>
                    <FilterInput
                      value={slFilter}
                      onChange={setSlFilter}
                      placeholder="Search SportLots items..."
                      ariaLabel="Search SportLots items"
                    />
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
                    <div className="space-y-1.5 min-h-[60px]">
                      {filteredUnmatchedSl.map((item) => (
                        <DraggableItem
                          key={`sl-${item.value}`}
                          id={`sl-${item.value}`}
                          value={item.value}
                          platform="sl"
                          onClick={
                            selectedBsc
                              ? () => handleSlClick(item.value)
                              : undefined
                          }
                        />
                      ))}
                      {state.unmatchedSl.length === 0 && (
                        <p className="text-xs text-gray-500 italic py-2">
                          All SL items matched
                        </p>
                      )}
                      {state.unmatchedSl.length > 0 &&
                        filteredUnmatchedSl.length === 0 &&
                        (slQuery ? (
                          <p className="text-xs text-gray-500 italic py-2">
                            No SL items contain "{slQuery}"
                            {activeSlPrefixes.length > 0
                              ? " in the filtered list"
                              : ""}
                          </p>
                        ) : (
                          activeSlPrefixes.length > 0 && (
                            <p className="text-xs text-gray-500 italic py-2">
                              No SL items start with{" "}
                              {activeSlPrefixes.map((p, i) => (
                                <span key={p}>
                                  {i > 0 ? " or " : ""}
                                  "{p}"
                                </span>
                              ))}
                            </p>
                          )
                        ))}
                    </div>
                  </div>
                </div>

                <KeepShelf isEmpty={keptCount === 0}>
                  {state.keptBsc.map((item) => (
                    <KeptItemRow
                      key={`kept-bsc-${item.value}`}
                      value={item.value}
                      platform="bsc"
                      onUnkeep={() =>
                        dispatch({ type: "UNKEEP_BSC", value: item.value })
                      }
                    />
                  ))}
                  {state.keptSl.map((item) => (
                    <KeptItemRow
                      key={`kept-sl-${item.value}`}
                      value={item.value}
                      platform="sl"
                      onUnkeep={() =>
                        dispatch({ type: "UNKEEP_SL", value: item.value })
                      }
                    />
                  ))}
                </KeepShelf>
              </div>

              <DragOverlay>
                {activeDragItem && (
                  <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                    <span className="text-gray-200">
                      {activeDragItem.value}
                    </span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
          <NeonButton cancel onClick={onClose} disabled={confirming}>
            Cancel
          </NeonButton>
          <NeonButton onClick={handleConfirm} disabled={confirming || saveCount === 0}>
            {confirming
              ? "Saving..."
              : keptCount > 0
                ? `Save ${state.matched.length} matched + ${keptCount} kept`
                : `Save ${state.matched.length} matched`}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
