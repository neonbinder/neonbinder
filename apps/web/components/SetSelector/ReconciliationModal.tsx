import React, { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  useDroppable,
  type Active,
  type Announcements,
  type DragStartEvent,
  type DragEndEvent,
  type Over,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
import { countReconciliationEdits } from "./reconciliation-edits";
import { Input } from "../primitives/Input";
import type { Id } from "../../convex/_generated/dataModel";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
import HeldElsewhereNote from "./HeldElsewhereNote";
import { heldIdSets, type HeldRow } from "./held-elsewhere";
import {
  duplicateNames,
  itemLabel,
  nameKey,
  itemLabelParts,
  sharedTitleLabels,
} from "./marketplace-item-label";
import {
  RENAME_TIP,
  TITLE_CLASH_ROW_LINE,
  readyTitleClashes,
  titleClashMessage,
  titleClashSignature,
  type ClashExistingRow,
} from "./ready-title-clashes";
import { MAX_SELECTOR_VALUE_LENGTH } from "../../convex/selectorSyncMatch";
import { useConvex } from "convex/react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import {
  LiveLine,
  RunGlyph,
  SleeveStrip,
  type RunLineKind,
} from "../modules/RunLedger";
import {
  checkKey,
  useBaseMatchProbe,
  type BaseMatchClient,
  type RowCheck,
} from "./base-match-probe";
import { BASE_MATCH_COPY, type BaseMatchSide } from "@/lib/cards/base-match";

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

/** Exported for its unit test; the component is the only production caller. */
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
  /**
   * Marketplace ids NB rows elsewhere in the set already hold. Hidden from
   * Pending and, since NEO-312, held out of the auto-match seeding exactly like
   * `heldElsewhere` (less any id this sync's own `existingRows` carry), but
   * not named in a note.
   */
  usedSlPlatformValues?: string[];
  usedBscPlatformValues?: string[];
  /**
   * NEO-300 — NB rows OUTSIDE this sync's own level that already hold some of
   * the fetched marketplace ids (for Sync Inserts: the parallels Group
   * Parallels moved under an insert). Their ids are neither seeded Ready from
   * an auto-match nor offered in Pending, and the header says how many were
   * left alone, with a disclosure naming them. Only rows the fetch actually
   * returned belong here — the caller filters with `heldRowsReturnedBy`.
   *
   * Like `used*PlatformValues`, this also stops the auto-match seeding: that
   * seeding is what re-created every grouped parallel as a top-level insert.
   * Unlike them, the held rows are named in the header.
   */
  heldElsewhere?: {
    rows: HeldRow[];
    summary: string;
    toggleLabel: string;
  };
  /**
   * NEO-305 — the same hold, for ids another SET in the brand already holds
   * (a SportLots-derived "Bowman Blue" whose Base carries the id Bowman's
   * Parallels sync fetches again). Held exactly like `heldElsewhere` — not
   * offered, not auto-matched — and named in a note of its own, so the
   * grouped-parallels note keeps its wording and its count.
   */
  heldInBrand?: {
    rows: HeldRow[];
    summary: string;
    toggleLabel: string;
  };
  // Previously-saved insert rows for this variantType. Used to seed the
  // modal's matched / keptBsc / keptSl sections so re-running a sync
  // preserves prior reconciliation work instead of starting fresh.
  /**
   * NEO-211: a failure from the caller's own save, shown IN the dialog.
   *
   * `onConfirm` rejecting used to be an unhandled promise rejection: this
   * component's `handleConfirm` has a `finally` that clears `confirming` but no
   * `catch`, so the dialog simply sat there after "Save 76 sets" with no error
   * and no explanation. The caller now catches and hands the reason back here,
   * where the operator can read it and press Save again — the dialog stays open
   * deliberately, because closing it would throw away the whole reconciliation
   * they just did.
   */
  saveError?: string | null;
  /**
   * NEO-325 — `fetchRawOptions`' `twinIds`: ids whose name another id on the
   * same side shares in the marketplace's FULL list. An item listed here
   * always wears its `(#id)`, even when its namesake is not in this dialog
   * (the Base's own SportLots set is dropped from the list by id).
   */
  twinIds?: { bsc: readonly string[]; sportlots: readonly string[] };
  /**
   * NEO-325 — one sentence for the header when twins are why this dialog
   * opened (a one-sided fetch the form would otherwise have stored).
   */
  twinNotice?: string;
  /**
   * NEO-325 — where the Ready sets will be saved, as the operator reads it
   * ("2024 Topps Chrome › Inserts"). A title that clashes with a set already
   * saved there names this rather than "here". Optional: without it the
   * sentence says "here".
   */
  parentPath?: string;
  /**
   * NEO-325 — open with the SportLots prefix filter OFF. For a dialog opened
   * in place of a one-sided store: that store would have written every
   * fetched SportLots set, so hiding the ones outside the set's prefix would
   * hide work the operator is now answering for.
   */
  showAllSlInitially?: boolean;
  /**
   * NEO-325 (Jason, 2026-10-09) — check every pending set against the saved
   * Base of this variant type. Passed only for the variant type whose NB role
   * is `parallel` (VariantForm); never for Inserts. Each pending set is
   * probed on its marketplace and judged by `lib/cards/base-match.ts`: one
   * whose card count and first card agree with the Base stays listed, one
   * that disagrees is set aside behind "Show N that don't match the Base",
   * with the reason on its row. Nothing is stored; the verdicts die with the
   * dialog. Without it, the dialog is exactly what it was.
   */
  baseCheck?: { variantTypeId: Id<"selectorOptions"> };
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

/** "1 set change" / "2 set changes". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ===== DRAGGABLE ITEM =====

// Text input with an inline "×" clear button that appears once the user
// has typed. Clicking it (or pressing Enter on it via keyboard) clears the
// value and returns focus to the input. Used for both BSC and SL filters.
function FilterInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  inputRef: externalRef,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** NEO-300: lets the column's "Keep all" put focus back here once the list
   *  it emptied (and the button with it) is gone. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const inputRef = externalRef ?? ownRef;
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
        // NEO-220 (D8): Escape clears the filter — the same thing the "×"
        // does, and the reflex every search box on the web has trained.
        // Stopped here so it never reaches the dialog root, where Escape now
        // means "throw this reconciliation away".
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (value.length > 0) clear();
        }}
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

/** Names that more than one distinct item carries, per side (NEO-325). */
type SideDups = { bsc: ReadonlySet<string>; sl: ReadonlySet<string> };

/**
 * dnd ids for marketplace items: `${side}-${platformValue}` for a Pending row,
 * and the same behind `mapped-` for a row in the "already mapped" reveal.
 *
 * The prefix is not decoration. DETACH and DISBAND return an item to Pending
 * even while another Ready set still maps it, so with the reveal on, the same
 * marketplace id can be a Pending row AND a mapped row at once — and dnd-kit
 * must never see one id registered twice. Both still resolve by platformValue.
 */
const MAPPED_DND_PREFIX = "mapped-";

/**
 * The side and marketplace id a dnd item id names, or `null` for anything
 * else (a Ready set's `ready-<key>`). Sliced, never `replace`d: replace strips
 * the first occurrence anywhere, which corrupts a BSC slug containing it.
 */
function parseItemDndId(
  id: string,
): { side: Side; platformValue: string } | null {
  const rest = id.startsWith(MAPPED_DND_PREFIX)
    ? id.slice(MAPPED_DND_PREFIX.length)
    : id;
  const side: Side | null = rest.startsWith("bsc-")
    ? "bsc"
    : rest.startsWith("sl-")
      ? "sl"
      : null;
  if (!side) return null;
  return { side, platformValue: rest.slice(side.length + 1) };
}

/**
 * What a screen reader hears on every drag handle (dnd-kit's
 * aria-describedby). It describes the drag this dialog really has: the
 * KeyboardSensor is registered and `keyboardAwareCollision` lands keyboard
 * drops (NEO-300), so Space/Enter, the arrows and Space/Enter again do pair
 * and attach. A click on the handle selects instead, but that is pointer-only:
 * Enter on the handle starts a keyboard drag, never a click.
 */
const DRAG_INSTRUCTIONS =
  "Press Space or Enter to pick up this set. Use the arrow keys to move it onto a set from the other marketplace, or onto a Ready set above, then press Space or Enter to drop it. Press Escape to put it back.";

/**
 * NEO-325 — the id suffix on a twin's name. Secondary to the name: normal
 * weight, a size down, in the side's own badge hue at 80% (still 4.5:1+ on
 * the row's gray-800), so "(#12345)" reads as belonging to the SL badge
 * beside it without competing with the name. Unique names get no suffix.
 */
const ID_SUFFIX: Record<Side, string> = {
  bsc: "text-[11px] font-normal tabular-nums text-blue-300/80",
  sl: "text-[11px] font-normal tabular-nums text-purple-300/80",
};

/**
 * An item's visible name, with the id suffix when the name is shared. The
 * suffix is real text, separated by a real space, so it is part of the
 * accessible name of whatever control wraps it (WCAG 2.5.3 label in name).
 */
function ItemName({
  item,
  side,
  dups,
  suffixClassName,
}: {
  item: PlatformItem;
  side: Side;
  dups: SideDups;
  suffixClassName?: string;
}) {
  const { name, suffix } = itemLabelParts(item, side, dups[side]);
  return (
    <>
      {name}
      {suffix && (
        <>
          {" "}
          <span className={suffixClassName ?? ID_SUFFIX[side]}>{suffix}</span>
        </>
      )}
    </>
  );
}

function DraggableItem({
  id,
  name,
  platform,
  isSelected,
  onClick,
  action,
  status,
}: {
  id: string;
  /** The row's visible name — `<ItemName>`, so a twin carries its id. */
  name: React.ReactNode;
  /**
   * NEO-325 — the row's Base check: a glyph before the badge, and the same
   * state in words for a screen reader after the name, both inside the
   * handle so they are part of what the row is called.
   */
  status?: { kind: RunLineKind; srText: string };
  platform: "bsc" | "sl";
  isSelected?: boolean;
  onClick?: () => void;
  /**
   * NEO-300 — a control that lives INSIDE the row, on its right edge (today:
   * "Make its own set"). It is a SIBLING of the drag handle, never a child:
   * dnd-kit gives the handle role="button", and a button nested in a button
   * vanishes from the accessibility tree and would start a drag on press.
   */
  action?: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

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

  // The row's whole box is the sortable node — so it is still the drop target
  // a pairing drag lands on, button area included — while only the handle
  // (badge + name) carries the drag listeners and the click-to-select.
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        group flex items-center rounded-lg border
        text-sm font-medium transition-colors select-none
        ${isSelected
          ? "ring-2 ring-[#00B7FF] bg-[#00B7FF]/10 border-[#00B7FF]"
          : "bg-gray-800 border-gray-600 hover:border-gray-400"
        }
      `}
    >
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        onClick={onClick}
        className="flex-1 min-w-0 self-stretch flex items-start gap-2 px-3 py-2 rounded-lg cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#00B7FF]"
      >
        {status && <RunGlyph kind={status.kind} tones={CHECK_GLYPH_TONE} />}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${platformColor} shrink-0 mt-0.5`}
        >
          {platformLabel}
        </span>
        <span className="text-gray-200 break-words min-w-0">{name}</span>
        {status && <span className="sr-only">{`, ${status.srText}`}</span>}
      </div>
      {action && <div className="shrink-0 py-1.5 pr-1.5">{action}</div>}
    </div>
  );
}

/**
 * NEO-300 — the per-row "Make its own set" button, and the column's
 * "Keep all". Same shape, two weights: Keep all is the batch action, so it
 * wears the Ready rail's green at rest; a row's button stays neutral until
 * hovered or focused, so a column of 141 rows is not 141 green blobs. Green,
 * either way, because pressing it sends the item up to Ready — whose rows
 * carry that same green rail.
 *
 * `min-h-[28px]`: WCAG 2.5.8 wants 24px; 28 keeps the row a single line.
 */
const OWN_SET_BUTTON =
  "inline-flex items-center min-h-[28px] px-2.5 rounded-md border text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B7FF]";
const OWN_SET_ROW_BUTTON = `${OWN_SET_BUTTON} border-gray-500 text-gray-300 hover:border-[#00D558] hover:text-[#00D558] hover:bg-[#00D558]/10 focus-visible:text-[#00D558]`;
const KEEP_ALL_BUTTON = `${OWN_SET_BUTTON} border-[#00D558]/70 text-[#00D558] hover:bg-[#00D558]/10 hover:border-[#00D558] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`;

// ===== BASE CHECK (NEO-325) =====

/**
 * The run ledger's glyphs and sleeves (modules/RunLedger), in tones for THIS
 * dialog, which is dark whatever the OS theme: the ledger's own defaults are
 * light/dark pairs for the blue build banner, and a `-700` glyph on this
 * dialog's gray-800 rows would vanish in a light OS. Every tone below clears
 * 3:1 against gray-800 (SC 1.4.11); the state is also said in words.
 */
const CHECK_GLYPH_TONE: Record<RunLineKind, string> = {
  waiting: "text-gray-400",
  building: "text-[#00C2FF] motion-safe:animate-spin",
  built: "text-[#00D558]",
  skipped: "text-gray-300",
  blocked: "text-amber-300",
  stopped: "text-gray-400",
  failed: "text-pink-300",
  unfinished: "text-amber-300",
};
const CHECK_SLEEVE_TONE: Record<RunLineKind, string> = {
  waiting: "border-gray-500 bg-transparent",
  building: "border-[#00C2FF] bg-[#00C2FF]/40 motion-safe:animate-pulse",
  built: "border-[#00D558] bg-[#00D558]",
  skipped: "border-gray-400 bg-gray-400/40",
  blocked: "border-amber-400 bg-amber-400",
  stopped: "border-gray-600 bg-gray-600/40",
  failed: "border-pink-400 bg-[#FF2E9A]",
  unfinished: "border-amber-400 bg-transparent",
};
/** The column's sleeve strip draws at most this many; the rest are "+N". */
const SLEEVE_CAP = 200;

/** A check, in the ledger's terms: waiting, spinning, check, no-entry, minus. */
function checkKind(check: RowCheck): RunLineKind {
  if (check.state === "queued") return "waiting";
  if (check.state === "checking") return "building";
  return check.verdict === "match"
    ? "built"
    : check.verdict === "mismatch"
      ? "blocked"
      : "skipped";
}

function checkSrText(check: RowCheck): string {
  if (check.state !== "done") return BASE_MATCH_COPY.srChecking;
  return check.verdict === "match"
    ? BASE_MATCH_COPY.srMatch
    : check.verdict === "mismatch"
      ? BASE_MATCH_COPY.srMismatch
      : BASE_MATCH_COPY.srUnverifiable;
}

const isMismatch = (check: RowCheck | undefined) =>
  check?.state === "done" && check.verdict === "mismatch";

const toProbeSide = (side: Side): BaseMatchSide =>
  side === "bsc" ? "bsc" : "sportlots";

// ===== READY SET ROW =====

/**
 * One NeonBinder set: our editable title, plus every marketplace set mapped to
 * it. Also a drop target — dragging a pending item here attaches it, which is
 * how a set grows past the 1:1 case in either direction.
 */
function ReadySetRow({
  set,
  label,
  onRename,
  onDetach,
  onDisband,
  onAttachClick,
  attachHint,
  showMetadata,
  onUpdateMetadata,
  dups,
  onDraftChange,
  clashMessageId,
}: {
  set: ReadySet;
  /**
   * NEO-325 — what this row's controls call the set: its title, plus its
   * mapped ids when another Ready set has the same title (two promoted SL
   * twins). See `sharedTitleLabels`. Never written back into `title`.
   */
  label: string;
  onRename: (title: string) => void;
  onDetach: (side: Side, platformValue: string) => void;
  onDisband: () => void;
  onAttachClick?: () => void;
  /** Label for the pending item that would be attached, when one is selected. */
  attachHint?: string;
  showMetadata?: boolean;
  onUpdateMetadata?: (metadata: ItemMetadata) => void;
  /** NEO-325 — so a mapped twin's chip names its id, as its Pending row did. */
  dups: SideDups;
  /**
   * NEO-325 — every edit of the title draft, and `null` once it is committed
   * or reverted, so the dialog can block Save on a title clash while the
   * operator is still typing (see `readyTitleClashes`).
   */
  onDraftChange?: (draft: string | null) => void;
  /**
   * NEO-325 — set while this row's title clashes with another set's: the id
   * of the sentence beside Save that says so. Marks the title field invalid,
   * puts a short line under it (so the clash is not told by colour alone),
   * and describes the field by that line first, then by the sentence.
   */
  clashMessageId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // The row's OWN line; the footer's sentence ids are never reused here.
  const clashLineId = useId();
  const { setNodeRef, isOver } = useDroppable({ id: `ready-${set.key}` });

  // Title is edited against a LOCAL draft and committed on blur / Enter.
  //
  // Dispatching RENAME per keystroke would re-render the whole modal — every
  // Ready row, every Pending column — between characters, which is the
  // controlled-input keystroke-drop this codebase has been bitten by before.
  // It is not hypothetical here: a real reconcile can hold a dozen-plus sets.
  // `key` is stable and never reused, so seeding from props is safe.
  const [titleDraft, setTitleDraft] = useState(set.title);
  // Enter and Escape act in place and leave focus in the field: blurring it
  // dropped focus to <body>, outside this aria-modal dialog. A later blur
  // (Tab, a click away) still commits, and finds nothing left to do.
  const commitTitle = () => {
    const next = titleDraft.trim();
    onDraftChange?.(null);
    // An empty title would save a nameless set; snap back instead.
    if (!next) {
      setTitleDraft(set.title);
      return;
    }
    if (next !== titleDraft) setTitleDraft(next);
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
      <span className="break-words">
        {/* The chip's own "BSC"/"SL" tag is already muted with opacity-70;
            the id suffix matches it rather than adding a third tone. */}
        <ItemName
          item={item}
          side={side}
          dups={dups}
          suffixClassName="opacity-70 font-normal tabular-nums"
        />
      </span>
      <button
        type="button"
        onClick={() => onDetach(side, item.platformValue)}
        className="text-pink-400 hover:text-pink-300 px-0.5 rounded"
        title="Remove this mapping"
        aria-label={`Remove ${itemLabel(item, side, dups[side])} from ${label}`}
      >
        ✕
      </button>
    </span>
  );

  return (
    <div
      ref={setNodeRef}
      // NEO-325: the green rail says "this saves". A title another set also
      // carries cannot save, so its rail turns the dialog's error pink until
      // the titles differ; the sentence beside Save says why.
      className={`border-l-4 ${
        clashMessageId ? "border-[#FF2EB3]" : "border-[#00D558]"
      } rounded-r-lg p-3 mb-2 transition-colors ${
        isOver ? "bg-[#00B7FF]/10 ring-1 ring-[#00B7FF]" : "bg-gray-800/50"
      }`}
    >
      <div className="flex items-center gap-3">
        {/* The title is OUR set name, so it is an input, not a label. */}
        <Input
          bare
          type="text"
          value={titleDraft}
          onChange={(e) => {
            setTitleDraft(e.target.value);
            onDraftChange?.(e.target.value);
          }}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // NEO-220 (D8): Escape here reverts the title and nothing else.
              // The dialog root now treats an un-stopped Escape as "discard the
              // whole reconciliation", so abandoning one rename would have
              // thrown away every set on the screen.
              e.stopPropagation();
              setTitleDraft(set.title);
              onDraftChange?.(null);
            }
          }}
          // A name over the store's ceiling is refused at Save; never let one
          // be typed.
          maxLength={MAX_SELECTOR_VALUE_LENGTH}
          // Shown only once the field is cleared to retype; the line below
          // carries the same tip while the title clashes.
          placeholder={clashMessageId ? RENAME_TIP : undefined}
          aria-label={`NeonBinder set name for ${label}`}
          aria-invalid={clashMessageId ? true : undefined}
          aria-describedby={
            clashMessageId ? `${clashLineId} ${clashMessageId}` : undefined
          }
          className={`flex-1 min-w-0 px-2 py-1 text-sm font-medium text-gray-100 bg-gray-900/60 border rounded focus:border-[#00B7FF] ${
            clashMessageId ? "border-[#FF2EB3]" : "border-gray-700"
          }`}
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
            aria-label={`Toggle details for ${label}`}
          >
            {expanded ? "▲" : "▼"}
          </button>
        )}
        <button
          onClick={onDisband}
          className="text-xs text-pink-400 hover:text-pink-300 px-2 py-1 rounded hover:bg-pink-900/20 shrink-0"
          title="Remove this set (its mappings return to Pending)"
          aria-label={`Remove set ${label}`}
        >
          ✕
        </button>
      </div>
      {clashMessageId && (
        <p id={clashLineId} className="mt-1 text-xs text-[#FF2EB3]">
          {TITLE_CLASH_ROW_LINE}{" "}
          {/* gray-400: a hint, quieter than the pink fact it follows. */}
          <span className="text-gray-400">{RENAME_TIP}</span>
        </p>
      )}

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
          // WCAG 2.5.3: the name begins with the visible words, then names
          // the set — every Ready row offers this button at once, so "this
          // set" alone would be the same name a dozen times.
          aria-label={`Add ${attachHint} to this set, ${label}`}
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
  // Unique per-instance class so Maestro inputText targets THIS row's prefix
  // input rather than the first one (MetadataEditor renders once per item;
  // see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  return (
    <div className="mt-2 pt-2 border-t border-gray-700 flex flex-wrap gap-3 items-center">
      {/* NEO-291: the Insert/Parallel checkboxes that sat before this field
          are gone — a row's kind comes from the hierarchy, never from a tick.
          The same words the Attributes panel uses for the same fact. */}
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        Card prefix
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

/**
 * NEO-325 — the Convex client is read only when the caller asked for the
 * Base check. The dialog's other callers (and their component tests, whose
 * hand-built `convex/react` mocks predate it) never touch `useConvex`.
 * `baseCheck` is fixed for a dialog's life (VariantForm decides it before
 * the dialog opens), so the two paths never swap under a mounted dialog.
 */
export default function ReconciliationModal(props: ReconciliationModalProps) {
  return props.baseCheck ? (
    <ReconciliationDialogWithClient {...props} />
  ) : (
    <ReconciliationDialog {...props} client={null} />
  );
}

function ReconciliationDialogWithClient(props: ReconciliationModalProps) {
  const client = useConvex();
  return <ReconciliationDialog {...props} client={client ?? null} />;
}

function ReconciliationDialog({
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
  saveError = null,
  heldElsewhere,
  heldInBrand,
  twinIds,
  twinNotice,
  parentPath,
  showAllSlInitially = false,
  baseCheck,
  client,
}: ReconciliationModalProps & { client: BaseMatchClient | null }) {
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
  //
  // NEO-325: the same pass records every saved row under the parent — the
  // ones seeded into Ready and the ones that were not — so Save can refuse a
  // title that would sit beside one of them (`readyTitleClashes`).
  const seed = useMemo(() => {
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
        // over the row's whole stored metadata (`isBase`, retired
        // `isInsert`/`isParallel`), which tsc accepts structurally but
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialState = seed.state;
  const savedSiblings = seed.savedSiblings;
  const [state, dispatch] = useReducer(reconciliationReducer, initialState);

  // ONE selection at a time, either side. Clicking the opposite side pairs
  // them; clicking a Ready set attaches to it. Drag does the same things but
  // is not keyboard-operable, so the click path is the accessible one.
  //
  // NEO-325: held by `platformValue`, never by name. SportLots lists distinct
  // sets under one name, and a name-keyed selection resolved every twin to
  // the first one — so "pair the 3rd Anime" linked the 1st Anime's id.
  const [selected, setSelected] = useState<{
    side: Side;
    platformValue: string;
  } | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /**
   * NEO-220 — is the "throw this session away?" confirm on screen?
   *
   * Separate from `confirming` ("the save is in flight") on purpose: they are
   * opposite questions, and one flag for both would make Escape during a save
   * offer to discard the work being saved.
   */
  const [discardOpen, setDiscardOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** What had focus before this opened, so it can go back there on close
   *  rather than falling to `<body>` (WCAG 2.4.3) — matches CardPairingModal. */
  const triggerRef = useRef<HTMLElement | null>(null);
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
  const [showAllSl, setShowAllSl] = useState<boolean>(showAllSlInitially);
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
  //
  // NEO-325 — in three steps, because the Base check needs two of them. The
  // SCOPE is what a column shows with its search box empty (other-level ids
  // and the SportLots prefix applied): that is what the check reaches. The
  // QUERIED list adds the search box: that is the check's priority. The
  // FILTERED list (below) then sets aside what does not match the Base.
  const scopedPendingSl = useMemo(() => {
    return state.pendingSl.filter((item) => {
      if (usedSlSet.has(item.platformValue)) return false;
      const v = item.value.toLowerCase();
      if (
        activeSlPrefixes.length > 0 &&
        !activeSlPrefixes.some((p) => v.startsWith(p))
      ) {
        return false;
      }
      return true;
    });
  }, [state.pendingSl, activeSlPrefixes, usedSlSet]);

  const queriedPendingSl = useMemo(() => {
    if (!slQuery) return scopedPendingSl;
    return scopedPendingSl.filter((item) =>
      item.value.toLowerCase().includes(slQuery),
    );
  }, [scopedPendingSl, slQuery]);

  const scopedPendingBsc = useMemo(() => {
    return state.pendingBsc.filter(
      (item) => !usedBscSet.has(item.platformValue),
    );
  }, [state.pendingBsc, usedBscSet]);

  const queriedPendingBsc = useMemo(() => {
    if (!bscQuery) return scopedPendingBsc;
    return scopedPendingBsc.filter((item) =>
      item.value.toLowerCase().includes(bscQuery),
    );
  }, [scopedPendingBsc, bscQuery]);

  // NEO-325 — the Base check (see `baseCheck`). It runs over the columns
  // BEFORE anything is set aside, so a set keeps its verdict whether or not
  // it is on screen; closing the dialog cancels it.
  const probeScope = useMemo(
    () => ({
      bsc: scopedPendingBsc.map((i) => i.platformValue),
      sportlots: scopedPendingSl.map((i) => i.platformValue),
    }),
    [scopedPendingBsc, scopedPendingSl],
  );
  const probeView = useMemo(
    () => ({
      bsc: queriedPendingBsc.map((i) => i.platformValue),
      sportlots: queriedPendingSl.map((i) => i.platformValue),
    }),
    [queriedPendingBsc, queriedPendingSl],
  );
  const probe = useBaseMatchProbe({
    client,
    variantTypeId: isOpen ? baseCheck?.variantTypeId : undefined,
    scope: probeScope,
    view: probeView,
  });
  const checksOn = probe.phase === "on";
  const probeChecks = probe.checks;
  const checkOf = useCallback(
    (side: Side, platformValue: string): RowCheck | undefined =>
      checksOn
        ? probeChecks.get(checkKey(toProbeSide(side), platformValue))
        : undefined,
    [checksOn, probeChecks],
  );
  // Set aside: a VIEW filter only. The rows stay in Pending (reducer state)
  // and behind each column's "Show N that don't match the Base".
  const [showMismatched, setShowMismatched] = useState<Record<Side, boolean>>({
    bsc: false,
    sl: false,
  });
  const mismatchedSl = useMemo(
    () =>
      checksOn
        ? queriedPendingSl.filter((i) => isMismatch(checkOf("sl", i.platformValue)))
        : [],
    [checksOn, queriedPendingSl, checkOf],
  );
  const mismatchedBsc = useMemo(
    () =>
      checksOn
        ? queriedPendingBsc.filter((i) => isMismatch(checkOf("bsc", i.platformValue)))
        : [],
    [checksOn, queriedPendingBsc, checkOf],
  );

  const filteredPendingSl = useMemo(() => {
    if (mismatchedSl.length === 0) return queriedPendingSl;
    const out = new Set(mismatchedSl.map((i) => i.platformValue));
    return queriedPendingSl.filter((i) => !out.has(i.platformValue));
  }, [queriedPendingSl, mismatchedSl]);

  const filteredPendingBsc = useMemo(() => {
    if (mismatchedBsc.length === 0) return queriedPendingBsc;
    const out = new Set(mismatchedBsc.map((i) => i.platformValue));
    return queriedPendingBsc.filter((i) => !out.has(i.platformValue));
  }, [queriedPendingBsc, mismatchedBsc]);

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

  // Resolve a dragged/clicked item by its marketplace id, whether it is still
  // pending or already mapped somewhere. NEO-325: by id ONLY — a name is not
  // an identity, and SportLots reuses names across distinct sets.
  const resolveItem = useCallback(
    (side: Side, platformValue: string): PlatformItem | undefined => {
      const pending = (side === "bsc" ? state.pendingBsc : state.pendingSl).find(
        (i) => i.platformValue === platformValue,
      );
      if (pending) return pending;
      for (const set of state.ready) {
        const hit = (side === "bsc" ? set.bsc : set.sl).find(
          (i) => i.platformValue === platformValue,
        );
        if (hit) return hit;
      }
      return undefined;
    },
    [state.pendingBsc, state.pendingSl, state.ready],
  );

  // NEO-325 (D2) — which names more than one distinct item on a side carries,
  // so only those rows show their id. Computed over the WHOLE side (Pending
  // plus every item mapped in Ready), never the filtered view: a suffix that
  // came and went as the operator typed would make the same row read
  // differently from one keystroke to the next.
  const dups = useMemo<SideDups>(() => {
    const allBsc = [...state.pendingBsc, ...state.ready.flatMap((set) => set.bsc)];
    const allSl = [...state.pendingSl, ...state.ready.flatMap((set) => set.sl)];
    // NEO-325 — plus every name the FETCH called a twin, judged on the
    // marketplace's whole list: a twin whose namesake never reached this
    // dialog still needs its id to be told from that namesake elsewhere.
    const withTwins = (
      items: PlatformItem[],
      ids: readonly string[] | undefined,
    ): Set<string> => {
      const out = duplicateNames(items);
      if (!ids || ids.length === 0) return out;
      const twin = new Set(ids);
      for (const item of items) {
        if (twin.has(item.platformValue)) out.add(nameKey(item.value));
      }
      return out;
    };
    return {
      bsc: withTwins(allBsc, twinIds?.bsc),
      sl: withTwins(allSl, twinIds?.sportlots),
    };
  }, [state.pendingBsc, state.pendingSl, state.ready, twinIds]);

  // NEO-325 — Ready rows' names for their own controls. Over EVERY Ready set,
  // never the filtered view, for the same reason as `dups` above.
  const readyLabels = useMemo(
    () => sharedTitleLabels(state.ready),
    [state.ready],
  );
  const readyLabelOf = useCallback(
    (set: ReadySet) => readyLabels.get(set.key) ?? set.title,
    [readyLabels],
  );

  // NEO-325 — Save is blocked while two sets would save under one title
  // (`readyTitleClashes`). A Ready row's title draft is NOT dispatched per
  // keystroke — a RENAME per letter would re-render every row and column of
  // the dialog — so the live drafts are kept in a ref, and `titleDraftView`,
  // the copy the render reads, is replaced only when a keystroke changes the
  // answer (starts or ends a clash, or changes what its sentence says) and on
  // every commit or revert. Save therefore re-enables the moment the titles
  // differ, at one render per change of answer rather than one per letter.
  const titleDraftsRef = useRef<Map<string, string>>(new Map());
  const shownDraftsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const [titleDraftView, setTitleDraftView] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const titleClashes = useMemo(
    () => readyTitleClashes(state.ready, titleDraftView, savedSiblings),
    [state.ready, titleDraftView, savedSiblings],
  );
  const handleTitleDraft = useCallback(
    (key: string, draft: string | null) => {
      const drafts = titleDraftsRef.current;
      if (draft === null) {
        // A blur after Enter or Escape already cleared this row's draft.
        if (!drafts.has(key)) return;
        drafts.delete(key);
      } else {
        drafts.set(key, draft);
      }
      const answerOf = (view: ReadonlyMap<string, string>) =>
        titleClashSignature(readyTitleClashes(state.ready, view, savedSiblings));
      if (draft !== null && answerOf(shownDraftsRef.current) === answerOf(drafts)) {
        return;
      }
      const next = new Map(drafts);
      shownDraftsRef.current = next;
      setTitleDraftView(next);
    },
    [state.ready, savedSiblings],
  );
  const clashBaseId = useId();
  const clashMessageIdOf = (index: number) => `${clashBaseId}-title-clash-${index}`;
  // Ready key → the id of the sentence that names its clash.
  const clashMessageIdByKey = useMemo(() => {
    const byKey = new Map<string, string>();
    titleClashes.forEach((clash, index) => {
      for (const key of clash.readyKeys) {
        byKey.set(key, `${clashBaseId}-title-clash-${index}`);
      }
    });
    return byKey;
  }, [titleClashes, clashBaseId]);
  const saveBlockedByTitles = titleClashes.length > 0;
  const clashMessageOf = useCallback(
    (clash: (typeof titleClashes)[number]) => titleClashMessage(clash, parentPath),
    [parentPath],
  );
  const twinNoticeId = useId();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  // What a screen reader hears during a drag. dnd-kit's defaults speak the raw
  // dnd id ("Picked up draggable item sl-11"); these speak the item the way
  // its row reads, id suffix and all for a twin, and the set it lands on.
  const announcements = useMemo<Announcements>(() => {
    const labelOf = (id: UniqueIdentifier): string | null => {
      const ref = parseItemDndId(String(id));
      if (!ref) return null;
      const item = resolveItem(ref.side, ref.platformValue);
      return item ? itemLabel(item, ref.side, dups[ref.side]) : null;
    };
    const readySetOf = (id: UniqueIdentifier): ReadySet | undefined => {
      const raw = String(id);
      if (!raw.startsWith("ready-")) return undefined;
      const key = raw.slice("ready-".length);
      return state.ready.find((s) => s.key === key);
    };
    // Mirrors handleDragEnd: what this drop does, said before it happens.
    const outcome = (
      active: Active,
      over: Over | null,
    ):
      | { kind: "attach"; set: ReadySet; already: boolean }
      | { kind: "pair"; other: string }
      | { kind: "none"; other: string | null } => {
      if (!over || over.id === active.id) return { kind: "none", other: null };
      const set = readySetOf(over.id);
      const ref = parseItemDndId(String(active.id));
      if (set && ref) {
        const mapped = ref.side === "bsc" ? set.bsc : set.sl;
        return {
          kind: "attach",
          set,
          already: mapped.some((i) => i.platformValue === ref.platformValue),
        };
      }
      const overRef = parseItemDndId(String(over.id));
      const other = labelOf(over.id);
      if (ref && overRef && other && overRef.side !== ref.side) {
        return { kind: "pair", other };
      }
      return { kind: "none", other };
    };
    return {
      onDragStart: ({ active }) => {
        const label = labelOf(active.id);
        return label ? `Picked up ${label}.` : undefined;
      },
      onDragOver: ({ active, over }) => {
        const label = labelOf(active.id);
        if (!label) return undefined;
        if (over && over.id === active.id) {
          return `${label} is back where it started.`;
        }
        const next = outcome(active, over);
        if (next.kind === "attach") {
          return next.already
            ? `${label} is over ${readyLabelOf(next.set)}, which already has it.`
            : `${label} is over ${readyLabelOf(next.set)}. Drop to add it to that set.`;
        }
        if (next.kind === "pair") {
          return `${label} is over ${next.other}. Drop to make them one set.`;
        }
        return next.other
          ? `${label} is over ${next.other}, from the same marketplace. Dropping here changes nothing.`
          : `${label} is not over anywhere it can be dropped.`;
      },
      onDragEnd: ({ active, over }) => {
        const label = labelOf(active.id);
        if (!label) return undefined;
        const next = outcome(active, over);
        if (next.kind === "attach") {
          return next.already
            ? `${readyLabelOf(next.set)} already has ${label}. Nothing changed.`
            : `Dropped ${label} on ${readyLabelOf(next.set)}.`;
        }
        if (next.kind === "pair") {
          return `Dropped ${label} on ${next.other}. They are now one set.`;
        }
        return `Dropped ${label}. Nothing changed.`;
      },
      onDragCancel: ({ active }) => {
        const label = labelOf(active.id);
        return label ? `Put ${label} back. Nothing changed.` : undefined;
      },
    };
  }, [resolveItem, dups, state.ready, readyLabelOf]);

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

      const activeRef = parseItemDndId(activeId);
      if (!activeRef) return;
      const activeSide = activeRef.side;
      const activeItem = resolveItem(activeSide, activeRef.platformValue);
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
      const overRef = parseItemDndId(overId);
      if (!overRef || overRef.side === activeSide) return;
      const overItem = resolveItem(overRef.side, overRef.platformValue);
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
    (side: Side, platformValue: string) => {
      if (selected && selected.side !== side) {
        const here = resolveItem(side, platformValue);
        const there = resolveItem(selected.side, selected.platformValue);
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
        selected &&
          selected.side === side &&
          selected.platformValue === platformValue
          ? null
          : { side, platformValue },
      );
    },
    [selected, resolveItem],
  );

  const handleAttachClick = useCallback(
    (key: string) => {
      if (!selected) return;
      const item = resolveItem(selected.side, selected.platformValue);
      if (item) dispatch({ type: "ATTACH", key, side: selected.side, item });
      setSelected(null);
    },
    [selected, resolveItem],
  );

  const bscFilterRef = useRef<HTMLInputElement | null>(null);
  const slFilterRef = useRef<HTMLInputElement | null>(null);

  /**
   * NEO-300 — keep focus in the column after its row (or all its rows) leave.
   *
   * The pressed button unmounts with its row, which drops focus to <body> —
   * a keyboard operator working down a column would be thrown out of it on
   * every press. Next row's button (the one that slid into the pressed one's
   * place), else the last one, else the column's filter.
   */
  const refocusColumn = useCallback((side: Side, index: number) => {
    requestAnimationFrame(() => {
      const buttons = dialogRef.current?.querySelectorAll<HTMLElement>(
        `button[data-own-set="${side}"]`,
      );
      const next =
        buttons && buttons.length > 0
          ? buttons[Math.min(index, buttons.length - 1)]
          : (side === "bsc" ? bscFilterRef : slFilterRef).current;
      next?.focus();
    });
  }, []);

  /**
   * NEO-325 (a11y, WCAG 2.4.3) — a verdict that sets a row aside takes the
   * row out of its column under the operator. If focus was on it (its handle
   * or its "Make its own set"), the browser drops it to <body>, outside this
   * aria-modal dialog. Park it on that column's "Show N that don't match the
   * Base", which just appeared or grew and says where the row went. Only when
   * focus really was dropped; anywhere else, the operator put it there.
   */
  const mismatchCountsRef = useRef<Record<Side, number>>({ bsc: 0, sl: 0 });
  useEffect(() => {
    const prev = mismatchCountsRef.current;
    const grew: Side | null =
      mismatchedSl.length > prev.sl
        ? "sl"
        : mismatchedBsc.length > prev.bsc
          ? "bsc"
          : null;
    mismatchCountsRef.current = {
      bsc: mismatchedBsc.length,
      sl: mismatchedSl.length,
    };
    if (!grew || !isOpen) return;
    if (document.activeElement !== document.body) return;
    dialogRef.current
      ?.querySelector<HTMLElement>(`button[data-base-toggle="${grew}"]`)
      ?.focus();
  }, [mismatchedBsc.length, mismatchedSl.length, isOpen]);

  const mismatchGroupBaseId = useId();

  const handlePromoteSolo = useCallback(
    (side: Side, platformValue: string, index: number) => {
      const item = resolveItem(side, platformValue);
      if (item) dispatch({ type: "PROMOTE_SOLO", side, item });
      setSelected(null);
      refocusColumn(side, index);
    },
    [resolveItem, refocusColumn],
  );

  const handleConfirm = useCallback(async () => {
    // NEO-325: Save is aria-disabled (not removed from the tab order) while
    // titles clash, so a press still arrives here. It must not save; it
    // takes the operator to the first title that needs a new name instead
    // (a press that did nothing at all read as a broken button).
    if (saveBlockedByTitles) {
      dialogRef.current
        ?.querySelector<HTMLElement>('input[aria-invalid="true"]')
        ?.focus();
      return;
    }
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
          // NEO-325: a set the operator made its own is matched by identity
          // only, so a SportLots twin saved after its namesake is stored as
          // its own row rather than withheld against the namesake by name.
          ...(set.ownSet ? { identityOnly: true as const } : {}),
        };
      });

      // Anything left in Pending is intentionally discarded — SL especially
      // returns siblings from other variantTypes that don't belong here.
      await onConfirm({ items });
    } finally {
      setConfirming(false);
    }
  }, [state, onConfirm, saveBlockedByTitles]);

  /**
   * NEO-220 — how much of this session a dismissal would throw away.
   *
   * A diff against the seeded state, not a counter: the modal opens with a
   * screenful of Ready sets restored from `existingRows`, so "the list is not
   * empty" says nothing about whether the operator has done anything.
   * `countReconciliationEdits` is pure and separately tested.
   */
  const pendingEdits = useMemo(
    () => countReconciliationEdits(initialState, state),
    [initialState, state],
  );

  /**
   * The single door out. Backdrop click, footer Cancel and root Escape all come
   * through here, so the "was anything lost?" question is asked once rather
   * than three times — and cannot be forgotten on the next path someone adds.
   *
   * The backdrop is the reason this dialog needed the guard most: a reconcile
   * of a real set is twenty minutes of dragging, and one stray click outside
   * the panel ended it silently.
   */
  const requestClose = useCallback(() => {
    if (confirming) return;
    if (pendingEdits === 0) {
      onClose();
      return;
    }
    setDiscardOpen(true);
  }, [confirming, onClose, pendingEdits]);

  /**
   * a11y: `aria-modal="true"` is a promise that focus starts inside and stays
   * inside. It starts here, on the container, so the first Tab lands on the
   * dialog's own first control rather than wherever the operator had been on
   * the page behind.
   *
   * Trigger is captured and restored on close (mirrors CardPairingModal's own
   * effect) — without it, closing this dialog (Cancel, Confirm, or the
   * discard confirm) drops focus to `<body>` instead of back to whatever
   * button opened it (WCAG 2.4.3).
   */
  useEffect(() => {
    if (!isOpen) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [isOpen]);

  // Find the dragged item for the overlay. Resolved by id, like the drop, so
  // the overlay names the item that will actually land.
  const activeDragItem = useMemo(() => {
    if (!activeDragId) return null;
    const ref = parseItemDndId(activeDragId);
    if (!ref) return null;
    const item = resolveItem(ref.side, ref.platformValue);
    return item ? { item, side: ref.side } : null;
  }, [activeDragId, resolveItem]);

  // The item a Ready row's "Add … to this set" would attach, for its label.
  const selectedItem = selected
    ? resolveItem(selected.side, selected.platformValue)
    : undefined;
  const attachHint =
    selected && selectedItem
      ? itemLabel(selectedItem, selected.side, dups[selected.side])
      : undefined;

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
    const sideName = isBsc ? "BSC" : "SportLots";
    const probeSide = toProbeSide(side);
    const narrowed = filtered.length !== all.length;
    // NEO-325 — the Base check's view of this column. `scoped` is what the
    // check reaches (the counter and the sleeves); `mismatched` is what the
    // search box shows of the sets set aside.
    const scoped = isBsc ? scopedPendingBsc : scopedPendingSl;
    const mismatched = isBsc ? mismatchedBsc : mismatchedSl;
    const revealMismatched = checksOn && mismatched.length > 0 && showMismatched[side];
    // NEO-300 — Keep all acts on exactly the rows that carry a "Make its own
    // set" button: `filtered`, i.e. after the search box, the SportLots
    // prefix filter ("Show all" off) and the other-level exclusion. The
    // "already mapped" reveal is not included — those already back a set,
    // and none of them offers "Make its own set" either.
    //
    // NEO-325 — and, while the Base check runs, never a row that does not
    // match the Base (revealed or not) or one still being checked: Keep all
    // promotes only what has been checked. A set-aside row is promoted only
    // by its own "Make its own set".
    const keepable = checksOn
      ? filtered.filter((i) => checkOf(side, i.platformValue)?.state === "done")
      : filtered;
    const stillChecking = filtered.length - keepable.length;
    const keepNarrowed = keepable.length !== all.length;
    //
    // Labels: the accessible name BEGINS with the visible words (WCAG 2.5.3
    // label in name), then says what they reach. The two columns' names share
    // no substring either way, and neither matches CardPairingModal's
    // "Keep all BSC-only cards".
    const keepAllName = `Keep all: ${keepable.length} ${sideName} ${
      keepable.length === 1 ? "set" : "sets"
    }`;
    const keepAll = () => {
      if (keepable.length === 0) return;
      dispatch({ type: "PROMOTE_SOLO_MANY", side, items: keepable });
      setSelected(null);
      // The list this emptied took the focused button with it.
      requestAnimationFrame(() =>
        (isBsc ? bscFilterRef : slFilterRef).current?.focus(),
      );
    };
    // Already-mapped sets, revealed on request. Mapping never consumed them —
    // this toggle only keeps the default list to what still needs attention.
    const showMapped = isBsc ? showMappedBsc : showMappedSl;
    const mapped = showMapped
      ? mappedItems(side).filter(
          ({ item }) =>
            !query || item.value.toLowerCase().includes(query),
        )
      : [];

    // The column's Base-check counter, over everything the check reaches.
    let settled = 0;
    let matched = 0;
    let notMatched = 0;
    let unverifiable = 0;
    if (checksOn) {
      for (const item of scoped) {
        const check = checkOf(side, item.platformValue);
        if (check?.state !== "done") continue;
        settled++;
        if (check.verdict === "match") matched++;
        else if (check.verdict === "mismatch") notMatched++;
        else unverifiable++;
      }
    }
    const checkTotal = scoped.length;
    const checkHeader =
      settled < checkTotal
        ? BASE_MATCH_COPY.checkingHeader(settled, checkTotal)
        : BASE_MATCH_COPY.checkedHeader(matched, notMatched, unverifiable);
    // Said in tenths, then once at the end: a 579-row column is not read
    // aloud row by row. Worded apart from the counter (side name, full stop)
    // so the page never carries the counter's text twice.
    const tenth = checkTotal > 0 ? Math.floor((settled * 10) / checkTotal) : 0;
    const checkPulse =
      checkTotal === 0
        ? ""
        : settled === checkTotal
          ? BASE_MATCH_COPY.pulseDone(probeSide, checkHeader)
          : tenth > 0
            ? BASE_MATCH_COPY.pulse(probeSide, tenth * 10)
            : "";
    const toggleVisible = showMismatched[side]
      ? BASE_MATCH_COPY.hideMismatched(mismatched.length)
      : BASE_MATCH_COPY.showMismatched(mismatched.length);
    const mismatchGroupId = `${mismatchGroupBaseId}-${side}`;

    /** A row's check, for its glyph and words; undefined with the check off. */
    const statusOf = (item: PlatformItem) => {
      const check = checkOf(side, item.platformValue);
      return check ? { kind: checkKind(check), srText: checkSrText(check) } : undefined;
    };

    /**
     * One pending row. With the check on, every row is wrapped (so a verdict
     * landing never swaps the row's element type and remounts it under
     * focus), and a row set aside or not checkable carries its reason under it.
     */
    const pendingRow = (item: PlatformItem, buttonIndex: number) => {
      const row = (
        // NEO-325: keyed and dnd-identified by marketplace id. Keyed by
        // name, two same-named SportLots sets shared a React key, and
        // filtering the column left a stale twin on screen.
        <DraggableItem
          key={`${side}-${item.platformValue}`}
          id={`${side}-${item.platformValue}`}
          name={<ItemName item={item} side={side} dups={dups} />}
          platform={side}
          isSelected={
            selected?.side === side &&
            selected.platformValue === item.platformValue
          }
          onClick={() => handlePendingClick(side, item.platformValue)}
          status={statusOf(item)}
          action={
            <button
              type="button"
              data-own-set={side}
              onClick={() =>
                handlePromoteSolo(side, item.platformValue, buttonIndex)
              }
              className={OWN_SET_ROW_BUTTON}
              // WCAG 2.5.3: the name begins with the visible text, then
              // names the row — with its id when the name is shared, so
              // twins are distinct to a screen reader too.
              // bowman-insert-grouping-builds-parallels.yaml taps this by
              // id (Maestro id: is a full-string regex match), so a
              // unique name must stay exactly `Make its own set: <name>`.
              aria-label={`Make its own set: ${itemLabel(item, side, dups[side])}`}
            >
              Make its own set
            </button>
          }
        />
      );
      if (!checksOn) return row;
      const check = checkOf(side, item.platformValue);
      const reason =
        check?.state === "done" && check.verdict !== "match" ? check : undefined;
      return (
        <div key={`${side}-${item.platformValue}`}>
          {row}
          {reason && (
            // amber-300: the dialog's "a person should look at this" tone
            // (the twin notice); gray-400 for "couldn't check", a fact
            // rather than a finding. Both clear 4.5:1 on gray-900.
            <p
              className={`text-[11px] mt-0.5 px-1 ${
                reason.verdict === "mismatch" ? "text-amber-300" : "text-gray-400"
              }`}
            >
              {reason.reason}
            </p>
          )}
        </div>
      );
    };
    // "Make its own set" buttons are found again by DOM order after a
    // promote (`refocusColumn`), so the index counts the revealed rows, which
    // render first.
    const revealedCount = revealMismatched ? mismatched.length : 0;

    return (
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div
            className={`text-xs font-medium uppercase tracking-wide ${
              isBsc ? "text-blue-400" : "text-purple-400"
            }`}
          >
            {sideName} ({filtered.length}
            {narrowed ? ` of ${all.length}` : ""})
          </div>
          <button
            type="button"
            onClick={keepAll}
            disabled={keepable.length === 0}
            aria-label={keepAllName}
            title={`${
              keepNarrowed
                ? `Make each of the ${keepable.length} listed ${sideName} sets its own NeonBinder set`
                : `Make every pending ${sideName} set its own NeonBinder set`
            }${
              checksOn
                ? BASE_MATCH_COPY.keepAllLeftOut(stillChecking, mismatched.length)
                : ""
            }`}
            className={KEEP_ALL_BUTTON}
          >
            {/* Filtered, the number says the button reaches only what is
                listed — never the rows the search is hiding. */}
            {keepNarrowed && keepable.length > 0
              ? `Keep all ${keepable.length}`
              : "Keep all"}
          </button>
        </div>
        {checksOn && checkTotal > 0 && (
          // NEO-325 — the column's Base check, in the run ledger's shape: a
          // counter, a sleeve per set filling as each one settles, and one
          // polite line that says it in tenths. The sleeves are decorative
          // (aria-hidden); the counter and the rows say it all in words.
          <div className="mb-2">
            <p className="text-[11px] text-gray-400 tabular-nums">
              {checkHeader}
            </p>
            <SleeveStrip
              items={scoped.slice(0, SLEEVE_CAP).map((item) => {
                const check = checkOf(side, item.platformValue);
                const label = itemLabel(item, side, dups[side]);
                return {
                  key: item.platformValue,
                  kind: check ? checkKind(check) : "waiting",
                  title:
                    check?.state === "done"
                      ? `${label} — ${check.reason}`
                      : `${label} — ${BASE_MATCH_COPY.srChecking}`,
                };
              })}
              tones={CHECK_SLEEVE_TONE}
              more={Math.max(0, scoped.length - SLEEVE_CAP)}
              moreClassName="text-[10px] leading-[14px] text-gray-400 tabular-nums"
            />
            <LiveLine text={checkPulse} />
          </div>
        )}
        <FilterInput
          value={isBsc ? bscFilter : slFilter}
          onChange={isBsc ? setBscFilter : setSlFilter}
          placeholder={isBsc ? "Filter BSC items..." : "Search SportLots items..."}
          ariaLabel={isBsc ? "Filter BSC items" : "Search SportLots items"}
          inputRef={isBsc ? bscFilterRef : slFilterRef}
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
        {checksOn && mismatched.length > 0 && (
          // NEO-325 — the sets the Base check set aside, never silently gone.
          // A disclosure: its text says how many and its state is
          // `aria-expanded`. Enter is handled here because the E2E driver's
          // `pressKey` has no default action.
          <button
            type="button"
            data-base-toggle={side}
            aria-expanded={showMismatched[side]}
            aria-controls={showMismatched[side] ? mismatchGroupId : undefined}
            aria-label={BASE_MATCH_COPY.toggleName(toggleVisible, probeSide)}
            onClick={() =>
              setShowMismatched((prev) => ({ ...prev, [side]: !prev[side] }))
            }
            onKeyDown={(event) =>
              activateOnEnter(event, () =>
                setShowMismatched((prev) => ({ ...prev, [side]: !prev[side] })),
              )
            }
            className="group mb-2 inline-flex items-center gap-1 min-h-[24px] rounded-sm text-xs font-medium text-amber-300 hover:text-amber-200 underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B7FF]"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={`h-3.5 w-3.5 shrink-0 motion-safe:transition-transform ${
                showMismatched[side] ? "rotate-90" : ""
              }`}
            />
            {toggleVisible}
          </button>
        )}
        <div className="space-y-1.5 min-h-[60px]">
          {revealMismatched && (
            // Set apart from the rows that matched by an amber rule, the
            // reason's own tone, so the eye reads them as one group.
            <div
              id={mismatchGroupId}
              className="space-y-1.5 border-l-2 border-amber-400/70 pl-2 pb-1"
            >
              {mismatched.map((item, index) => pendingRow(item, index))}
            </div>
          )}
          {filtered.map((item, index) => pendingRow(item, revealedCount + index))}
          {mapped.map(({ item, usedBy }) => (
            <div key={`mapped-${side}-${item.platformValue}`}>
              <DraggableItem
                // Its own dnd id: the same marketplace id can be a Pending
                // row above at the same time (see MAPPED_DND_PREFIX).
                id={`${MAPPED_DND_PREFIX}${side}-${item.platformValue}`}
                name={<ItemName item={item} side={side} dups={dups} />}
                platform={side}
                isSelected={
                  selected?.side === side &&
                  selected.platformValue === item.platformValue
                }
                onClick={() => handlePendingClick(side, item.platformValue)}
              />
              {/* gray-400: gray-500 on the gray-900 panel is 3.67:1. */}
              <p className="text-[11px] text-gray-400 mt-0.5 px-1 truncate">
                mapped to {usedBy.join(", ")}
              </p>
            </div>
          ))}
          {all.length === 0 && mapped.length === 0 && (
            <p className="text-xs text-gray-500 italic py-2">
              Nothing pending on {isBsc ? "BSC" : "SportLots"}
            </p>
          )}
          {all.length > 0 && filtered.length === 0 && mismatched.length === 0 && (
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
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 outline-none"
      // NEO-220: this dialog announced itself to nothing. Every other modal in
      // this directory carries the role/aria-modal/labelledby trio and owns its
      // keyboard contract; this one had no role, no name and no keydown
      // handler, so assistive tech read it as an anonymous div and Escape did
      // nothing at all.
      role="dialog"
      aria-modal="true"
      aria-labelledby="reconciliation-heading"
      // NEO-325 — the twin sentence is why this dialog opened in place of a
      // save; it is read with the heading, not announced.
      aria-describedby={twinNotice ? twinNoticeId : undefined}
      tabIndex={-1}
      ref={dialogRef}
      onClick={requestClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // The discard confirm owns Escape while it is open. It is a sibling
          // in this portal rather than a descendant, so its own keypresses
          // never reach here; this covers focus left behind it.
          if (discardOpen) return;
          // D8: inside a text field Escape already means something smaller —
          // clear the filter, revert the title — and those handlers stop
          // propagation. Anything arriving here from a field is a field with
          // no local meaning for the key.
          if (isEditableTarget(e.target)) return;
          // Escape during a drag cancels the DRAG (dnd-kit's own document
          // listener). One keypress must not also end the session.
          if (activeDragId) return;
          e.preventDefault();
          requestClose();
          return;
        }
        if (e.key !== "Tab") return;
        // Keep Tab inside the dialog — aria-modal="true" promises this.
        const root = dialogRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl max-w-6xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700">
          <h2
            id="reconciliation-heading"
            className="text-xl font-semibold text-white"
          >
            Reconcile {levelLabel}
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            {saveCount} ready
            {pendingCount > 0 ? `, ${pendingCount} pending` : ""}
          </p>
          {twinNotice && (
            // NEO-325 — why this opened instead of saving on its own. Amber,
            // the builder's "a person should look at this" tone; not live:
            // it is on screen when the dialog opens, read with its heading.
            <p id={twinNoticeId} className="text-sm text-amber-300 mt-1 max-w-[80ch]">
              {twinNotice}
            </p>
          )}
          {heldElsewhere && heldElsewhere.rows.length > 0 && (
            <div className="mt-1">
              <HeldElsewhereNote
                rows={heldElsewhere.rows}
                summary={heldElsewhere.summary}
                toggleLabel={heldElsewhere.toggleLabel}
              />
            </div>
          )}
          {heldInBrand && heldInBrand.rows.length > 0 && (
            <div className="mt-1">
              <HeldElsewhereNote
                rows={heldInBrand.rows}
                summary={heldInBrand.summary}
                toggleLabel={heldInBrand.toggleLabel}
              />
            </div>
          )}
        </div>

        {/* One DndContext over BOTH sections — a pending item is dragged onto a
            Ready set, so they cannot be in separate contexts. */}
        <DndContext
          sensors={sensors}
          // NEO-300 — not bare `pointerWithin`: a keyboard drag has no
          // pointer, and that dropped every keyboard drag on nothing.
          collisionDetection={keyboardAwareCollision}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: DRAG_INSTRUCTIONS },
          }}
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
                    label={readyLabelOf(set)}
                    showMetadata={showMetadata}
                    dups={dups}
                    attachHint={attachHint}
                    onAttachClick={
                      attachHint !== undefined
                        ? () => handleAttachClick(set.key)
                        : undefined
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
                    onDraftChange={(draft) => handleTitleDraft(set.key, draft)}
                    clashMessageId={clashMessageIdByKey.get(set.key)}
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
                <span className="text-gray-200">
                  <ItemName
                    item={activeDragItem.item}
                    side={activeDragItem.side}
                    dups={dups}
                  />
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-700 flex justify-end items-center gap-3 flex-wrap">
          {saveError && (
            // role="alert": the operator pressed Save and is watching the
            // button, not this spot, so this has to interrupt.
            <span
              role="alert"
              className="mr-auto text-sm text-[#FF2EB3] max-w-md"
            >
              {saveError}
            </span>
          )}
          {/* NEO-325 — why Save is unavailable, said beside it. Always
              mounted so the region exists before a clash fills it (polite:
              it appears as the operator types). Empty, it takes no room. */}
          <div
            role="status"
            className="max-w-md text-right text-sm text-[#FF2EB3] space-y-1"
          >
            {titleClashes.map((clash, index) => (
              <p key={clash.key} id={clashMessageIdOf(index)}>
                {clashMessageOf(clash)}
              </p>
            ))}
          </div>
          <NeonButton cancel onClick={requestClose} disabled={confirming}>
            Cancel
          </NeonButton>
          <NeonButton
            onClick={handleConfirm}
            disabled={confirming || saveCount === 0}
            // aria-disabled, not disabled: a disabled button leaves the tab
            // order, and the reason it is unavailable would be unreachable
            // from it (the CardPairingModal Confirm precedent).
            aria-disabled={saveBlockedByTitles || undefined}
            // Maestro web cannot read disabled / aria-disabled /
            // aria-describedby, so the reason rides on `title` too: with no
            // aria-label on this button, maestro-web takes it as the
            // button's id, and it is a hover tooltip. Only while blocked;
            // the visible text stays `Save N sets` either way.
            title={
              saveBlockedByTitles
                ? titleClashes.map(clashMessageOf).join(" ")
                : undefined
            }
            aria-describedby={
              saveBlockedByTitles
                ? titleClashes.map((_, index) => clashMessageIdOf(index)).join(" ")
                : undefined
            }
          >
            {confirming ? "Saving..." : `Save ${saveCount} sets`}
          </NeonButton>
        </div>
      </div>
    </div>
    {/* NEO-220 — a SIBLING of the overlay, not a child of it. This overlay
        closes on backdrop click; a confirm nested inside it would hand its own
        backdrop click straight to the thing it is protecting. */}
    {discardOpen && (
      <ConfirmDialog
        title={`Discard ${plural(pendingEdits, "set change")}?`}
        description="Closing throws away the sets you built here. Nothing has been saved yet."
        confirmLabel={`Discard ${plural(pendingEdits, "set change")}`}
        // Nothing is written on this path, so there is no in-flight window.
        busyLabel={`Discard ${plural(pendingEdits, "set change")}`}
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