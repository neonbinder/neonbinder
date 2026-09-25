import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { userFacingMessage } from "@/lib/errors/user-facing-message";

/**
 * NEO-306 — the SportLots-only review: "Sort SportLots sets for {brand}".
 *
 * Sync Sets no longer decides what a SportLots-only name is. Each one is a
 * row here, and the operator files it as its own set (the default) or as a
 * variant of one of the brand's sets, under one of that set's variant types
 * (`convex/slSetReview.ts` has the why). Three columns, in the order the
 * question is asked: SportLots set | Variant of | Variant type.
 *
 * ## Variant of → Variant type
 *
 * - "Variant of" is a disclosure button opening a list of BUTTONS (never a
 *   `<select>`: the Maestro web driver reaches options only in the first
 *   native select on a page). "Its own set" first, then the set the server
 *   suggests (tagged "suggested", NEVER preselected — a name-derived guess is
 *   a hint, not a decision), then the brand's other sets. Default: its own set.
 * - Picking a set runs that set's Sync Variant Types, ONCE per set per
 *   opening of this dialog (`requestedRef`), forced: a set that already has a
 *   Base would otherwise never re-sync, and its Insert/Parallel types are what
 *   the next column lists. The write is additive and stays if the operator
 *   cancels (accepted, Jason 2026-09-25). Retry is the only second call.
 * - "Variant type" lists that set's types (Base excluded server-side: it is
 *   terminal in the builder), each tagged with its NB role. Required once a
 *   set is chosen; the row says so, and so does the Save button's
 *   description.
 *
 * ## The review is shared
 *
 * One doc per brand, not per admin. Another admin's save removes entries
 * under this dialog; rows simply drop out of the derived list (decisions are
 * keyed by SportLots id and read through the live entries, so a vanished id is
 * never sent). While THIS dialog saves, the rows render from the snapshot
 * taken when Save was pressed, because the save itself empties the doc chunk
 * by chunk before the action returns.
 *
 * ## Keyboard and focus
 *
 * Focus opens on the filter, Tab is trapped (skipping anything `inert`), and
 * Escape cancels — unless a picker list is open, where Escape closes the list
 * and puts focus back on its trigger. Arrow keys, Home and End move through a
 * list. Every button spells Enter out (`activateOnEnter`: maestro-web's
 * `pressKey` is synthetic). Busy states, sync results and bulk marks are said
 * in ONE polite live region. On close focus goes back to the pill that opened
 * the dialog, or to the column when a finished save took the pill away.
 *
 * No DOM `id` on any control: Maestro's resource-id is `id || aria-label`, so
 * an id would hide the label flows target. Ids live on non-interactive
 * targets only (the lists `aria-controls` names, the reason lines).
 */

type RowId = Id<"selectorOptions">;

type ReviewEntry = { slId: string; label: string; suggestedOfSetId?: RowId };
type OfSet = { _id: RowId; value: string };
type Review = {
  yearId: RowId;
  manufacturerId: RowId;
  brandValue: string;
  entries: ReviewEntry[];
  ofSets: OfSet[];
  ofSetsTruncated: boolean;
  moreNextSync: number;
  partial: boolean;
  classifiedAt: number;
};
type VariantTypeOption = { _id: RowId; value: string; role?: "insert" | "parallel" };
type TypeRole = "insert" | "parallel" | "none";

/** The operator's answer for one row. Empty = its own set. */
type Decision = { setId?: RowId; typeId?: RowId; typeRole?: TypeRole };
type LocalSync = "syncing" | "done" | "failed";

export type SlSetReviewResult = {
  sets: number;
  underType: { insert: number; parallel: number; none: number };
  skipped: number;
  skippedByReason: {
    notInReview: number;
    alreadyLinked: number;
    nameTaken: number;
    existsElsewhere: number;
    invalid: number;
  };
  knownBrandsAdded: number;
  remaining: number;
  incomplete: boolean;
};

/** The server's cap on one save (`MAX_REVIEW_DECISIONS`). */
export const MAX_REVIEW_DECISIONS = 200;

/** The bulk bar's picker key; never a SportLots id (slugs carry no spaces). */
const BULK = " bulk";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every string this dialog says. DRAFT copy (NEO-306), accepted for now;
 * Jason signs off on local Vite. Exported so tests and flows read one source.
 */
export const slReviewCopy = {
  title: (brand: string) => `Sort SportLots sets for ${brand}`,
  titleEmpty: "Sort SportLots sets",
  description: (brand: string) =>
    `SportLots lists these under ${brand}. Each is a set of its own unless it belongs to one.`,
  moreNextSync: (n: number) =>
    `${plural(n, "more SportLots set")} will show up after the next Sync Sets.`,
  partial: "A save stopped part-way. What it saved is saved; save again to finish.",
  empty: "Nothing left to sort here.",
  loading: "Loading the SportLots sets…",
  headerName: "SportLots set",
  headerOf: "Variant of",
  headerType: "Variant type",
  filter: "Find a SportLots set",
  selectAllShown: "Select all shown",
  selectRow: (name: string) => `Select ${name}`,
  ownSet: "Its own set",
  suggested: "suggested",
  pickType: "Pick a type",
  pickSet: "Pick a set",
  setPicker: (name: string) => `Variant of set for ${name}`,
  typePicker: (name: string) => `Variant type for ${name}`,
  setList: (name: string) => `Where ${name} goes`,
  typeList: (set: string) => `Types under ${set}`,
  roleTag: { insert: "inserts", parallel: "parallels" } as const,
  onlyLinkedSets:
    "Only sets with BSC variant types are listed; their types come from BSC.",
  setsTruncated: (n: number) => `Showing the first ${n} sets.`,
  syncing: (set: string) => `Syncing ${set}'s variant types…`,
  syncFailed: (set: string) => `Couldn't sync ${set}'s variant types.`,
  syncReady: (set: string) => `${set}'s variant types are in.`,
  retry: "Retry",
  retryLabel: (set: string) => `Retry syncing ${set}'s variant types`,
  noTypes: (set: string) => `${set} has no variant types to file under yet.`,
  needsType: "Pick a variant type.",
  rowsNeedType: (n: number) =>
    `${plural(n, "row")} ${n === 1 ? "needs" : "need"} a variant type.`,
  bulkLead: "Mark selected as variant of",
  bulkSetPicker: "Set for selected rows",
  bulkTypePicker: "Type for selected rows",
  bulkApply: (n: number) => `Apply to ${n} selected`,
  bulkOwn: "Mark selected as their own sets",
  bulkNeedsRows: "Select rows first.",
  bulkNeedsType: "Pick a set and a type first.",
  bulkMarked: (n: number, set: string, type: string) =>
    `Marked ${plural(n, "row")} as ${set} › ${type}.`,
  bulkMarkedOwn: (n: number) => `Marked ${plural(n, "row")} as their own sets.`,
  save: (n: number) => `Save ${plural(n, "SportLots set")}`,
  saving: "Saving…",
  cancel: "Cancel",
  close: "Close",
  saveFailed: "Couldn't save. Nothing was lost; save again.",
  left: (n: number) => `${n} left — save again.`,
  stillToSort: (n: number) => `${plural(n, "row")} still to sort.`,
  filterCount: (n: number) =>
    n === 0 ? "Nothing matches that." : plural(n, "match", "matches"),
} as const;

const SKIP_REASON_TEXT: Record<keyof SlSetReviewResult["skippedByReason"], (n: number) => string> = {
  alreadyLinked: (n) => `${n} already linked`,
  notInReview: (n) => `${n} already sorted`,
  nameTaken: (n) => `${n} already there by that name`,
  existsElsewhere: (n) => `${n} already a set under another brand`,
  invalid: (n) => `${n} with no usable name`,
};

/**
 * The save's outcome in one sentence — the toast when the review is done,
 * the dialog's status line when it is not. "Saved" answers "Save". A row
 * under a type with no NB role lands as an insert-level row whose card type
 * falls back to Insert (`deriveOwnLevelFeatures`), so it counts as an insert.
 */
export function slReviewSavedText(result: SlSetReviewResult): string {
  const inserts = result.underType.insert + result.underType.none;
  const parts: string[] = [];
  if (result.sets > 0) parts.push(plural(result.sets, "set"));
  if (result.underType.parallel > 0) parts.push(plural(result.underType.parallel, "parallel"));
  if (inserts > 0) parts.push(plural(inserts, "insert"));
  let text = parts.length > 0 ? `Saved ${parts.join(", ")}.` : "Nothing new saved.";
  if (result.skipped > 0) {
    const reasons = (Object.keys(SKIP_REASON_TEXT) as Array<keyof typeof SKIP_REASON_TEXT>)
      .filter((k) => result.skippedByReason[k] > 0)
      .map((k) => SKIP_REASON_TEXT[k](result.skippedByReason[k]));
    text += ` ${result.skipped} skipped${reasons.length > 0 ? `: ${reasons.join(", ")}` : ""}.`;
  }
  return text;
}

// ───────────────────────────────────────────────────────────────────────────
// One set's variant types, and where its sync stands
// ───────────────────────────────────────────────────────────────────────────

type TypesPhase = "none" | "syncing" | "failed" | "loading" | "ready";

/**
 * The picker's view of one set: this dialog's own sync call (`local`) and
 * the set's reactive sync-status row (a Variant Types column elsewhere may be
 * syncing the same set), then its types. Convex dedupes identical
 * subscriptions, so two hundred rows on one set cost two queries.
 */
function useSetTypes(setId: RowId | undefined, local: LocalSync | undefined) {
  const rawTypes: unknown = useQuery(
    api.slSetReview.getVariantTypesOfSet,
    setId ? { setId } : "skip",
  );
  const rawStatus: unknown = useQuery(
    api.selectorOptions.getSelectorSyncStatus,
    setId ? { level: "variantType", parentId: setId } : "skip",
  );
  const remote =
    typeof rawStatus === "object" && rawStatus !== null
      ? (rawStatus as { status?: unknown }).status
      : undefined;
  const types: VariantTypeOption[] = Array.isArray(rawTypes)
    ? (rawTypes as VariantTypeOption[])
    : [];
  let phase: TypesPhase;
  if (!setId) phase = "none";
  else if (local === "syncing" || remote === "syncing") phase = "syncing";
  // A failed sync over a set that already HAS types still lets the operator
  // pick one: those rows are real. The failure line and Retry stay.
  else if ((local === "failed" || remote === "error") && types.length === 0) phase = "failed";
  else if (!Array.isArray(rawTypes)) phase = "loading";
  else phase = "ready";
  const failed = phase === "failed" || (setId !== undefined && phase === "ready" && (local === "failed" || remote === "error"));
  return { phase, types, failed };
}

function roleOf(type: VariantTypeOption | undefined): TypeRole {
  return type?.role ?? "none";
}

// ───────────────────────────────────────────────────────────────────────────
// Pieces
// ───────────────────────────────────────────────────────────────────────────

type PickerOption = {
  key: string;
  label: string;
  tag?: string;
  current: boolean;
};

/** A picker's key in the DOM, for focus hand-offs (never an E2E handle). */
function pickerKey(rowKey: string, kind: "set" | "type"): string {
  return `${kind}:${rowKey}`;
}

/**
 * The disclosure button a picker opens from. Visible text = the choice;
 * `aria-label` = what it chooses, for which row.
 */
function PickerTrigger({
  label,
  text,
  muted,
  open,
  listId,
  pkey,
  disabled,
  inert,
  describedBy,
  onToggle,
}: {
  label: string;
  text: string;
  muted: boolean;
  open: boolean;
  listId: string;
  pkey: string;
  disabled?: boolean;
  inert?: boolean;
  describedBy?: string;
  onToggle: () => void;
}) {
  const activate = () => {
    if (!disabled) onToggle();
  };
  return (
    <button
      type="button"
      data-picker-trigger={pkey}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      inert={inert || undefined}
      onClick={activate}
      onKeyDown={(e) => activateOnEnter(e, activate, disabled)}
      className={`flex w-full min-h-8 items-center justify-between gap-2 rounded-md border px-2.5 py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
        open ? "border-[#00B7FF]" : "border-slate-500 hover:border-slate-300"
      } ${muted ? "text-slate-400" : "text-gray-100"}`}
    >
      <span className="min-w-0 truncate">{text}</span>
      <span aria-hidden="true" className="shrink-0 text-xs text-slate-400">
        {open ? "▴" : "▾"}
      </span>
    </button>
  );
}

/** The open list under a trigger: plain buttons, arrow keys between them. */
function PickerList({
  listId,
  pkey,
  label,
  options,
  onPick,
  onClose,
  footer,
}: {
  listId: string;
  pkey: string;
  label: string;
  options: PickerOption[];
  onPick: (key: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-pick]"),
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (at + 1) % buttons.length
            : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return (
    <div
      id={listId}
      data-picker-list={pkey}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="mt-1 rounded-md border border-slate-500 bg-slate-950 p-1"
    >
      <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            data-pick={option.key}
            aria-current={option.current || undefined}
            onClick={() => onPick(option.key)}
            onKeyDown={(e) => activateOnEnter(e, () => onPick(option.key))}
            // py-1.5 keeps each row at WCAG 2.5.8's 24px minimum.
            className={`flex items-baseline justify-between gap-2 rounded border px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] ${
              option.current
                ? "border-[#00D558] text-[#00D558]"
                : "border-transparent text-gray-200 hover:border-slate-500"
            }`}
          >
            <span className="flex min-w-0 items-baseline gap-1">
              {/* 1.4.1 — the current choice is not colour alone. */}
              {option.current && <span aria-hidden="true">✓</span>}
              <span className="break-words">{option.label}</span>
            </span>
            {option.tag && (
              <span className="shrink-0 text-xs text-slate-400">
                <span className="sr-only">, </span>
                {option.tag}
              </span>
            )}
          </button>
        ))}
      </div>
      {footer}
    </div>
  );
}

/** The tick box: a `role="checkbox"` button (ParallelGroupingModal's). */
function TickBox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean | "mixed";
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      onKeyDown={(e) => activateOnEnter(e, onToggle)}
      className="group/tick flex h-8 w-8 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
    >
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 items-center justify-center rounded-[4px] border text-[10px] leading-none ${
          checked
            ? "border-neon-blue bg-neon-blue text-gray-950"
            : "border-gray-400 bg-gray-900 group-hover/tick:border-neon-blue"
        }`}
      >
        {checked === "mixed" ? "–" : checked ? "✓" : ""}
      </span>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// One row
// ───────────────────────────────────────────────────────────────────────────

type RowProps = {
  entry: ReviewEntry;
  decision: Decision;
  ofSets: OfSet[];
  setName: (id: RowId) => string | undefined;
  suggestedSet?: OfSet;
  ofSetsTruncated: boolean;
  selected: boolean;
  openKind: "set" | "type" | null;
  localSync: (setId: RowId) => LocalSync | undefined;
  onToggleSelect: () => void;
  onTogglePicker: (kind: "set" | "type") => void;
  onClosePicker: () => void;
  onPickSet: (setId: RowId | null) => void;
  onPickType: (type: VariantTypeOption) => void;
  onRetry: (setId: RowId) => void;
};

function ReviewRow({
  entry,
  decision,
  ofSets,
  setName,
  suggestedSet,
  ofSetsTruncated,
  selected,
  openKind,
  localSync,
  onToggleSelect,
  onTogglePicker,
  onClosePicker,
  onPickSet,
  onPickType,
  onRetry,
}: RowProps) {
  const setListId = useId();
  const typeListId = useId();
  const reasonId = useId();
  const setId = decision.setId;
  const setLabel = setId ? (setName(setId) ?? "") : "";
  const { phase, types, failed } = useSetTypes(setId, setId ? localSync(setId) : undefined);
  const chosenType = decision.typeId
    ? types.find((t) => t._id === decision.typeId)
    : undefined;
  const name = entry.label;

  const setOptions: PickerOption[] = [
    { key: "", label: slReviewCopy.ownSet, current: !setId },
    ...(suggestedSet
      ? [
          {
            key: suggestedSet._id,
            label: suggestedSet.value,
            tag: slReviewCopy.suggested,
            current: setId === suggestedSet._id,
          },
        ]
      : []),
    ...ofSets
      .filter((s) => s._id !== suggestedSet?._id)
      .map((s) => ({ key: s._id, label: s.value, current: setId === s._id })),
  ];

  // What stands between this row and Save, said beside the type picker.
  let reason: ReactNode = null;
  if (setId) {
    if (phase === "syncing") {
      reason = <span className="text-slate-400">{slReviewCopy.syncing(setLabel)}</span>;
    } else if (failed) {
      reason = (
        <span className="flex flex-wrap items-center gap-2 text-[#FF2EB3]">
          {slReviewCopy.syncFailed(setLabel)}
          <button
            type="button"
            aria-label={slReviewCopy.retryLabel(setLabel)}
            onClick={() => onRetry(setId)}
            onKeyDown={(e) => activateOnEnter(e, () => onRetry(setId))}
            className="min-h-6 rounded border border-slate-500 px-2 text-xs text-gray-200 hover:border-[#00D558] hover:text-[#00D558] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
          >
            {slReviewCopy.retry}
          </button>
        </span>
      );
    } else if (phase === "ready" && types.length === 0) {
      reason = <span className="text-amber-300">{slReviewCopy.noTypes(setLabel)}</span>;
    } else if (!chosenType && phase === "ready") {
      reason = <span className="text-amber-300">{slReviewCopy.needsType}</span>;
    }
  }
  const typeBlocked = phase !== "ready" || types.length === 0;

  return (
    <div
      role="row"
      data-review-row={entry.slId}
      className={`grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 border-b border-slate-800 px-2 py-2 sm:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] ${
        selected ? "bg-neon-blue/5" : ""
      }`}
    >
      <div role="cell">
        <TickBox label={slReviewCopy.selectRow(name)} checked={selected} onToggle={onToggleSelect} />
      </div>
      <div role="cell" className="flex min-h-8 items-center text-sm text-gray-100">
        <span className="break-words">{name}</span>
      </div>
      <div role="cell" className="col-start-2 sm:col-start-auto">
        <span aria-hidden="true" className="mb-0.5 block text-[11px] text-slate-400 sm:hidden">
          {slReviewCopy.headerOf}
        </span>
        <PickerTrigger
          label={slReviewCopy.setPicker(name)}
          text={setId ? setLabel : slReviewCopy.ownSet}
          muted={!setId}
          open={openKind === "set"}
          listId={setListId}
          pkey={pickerKey(entry.slId, "set")}
          onToggle={() => onTogglePicker("set")}
        />
        {openKind === "set" && (
          <PickerList
            listId={setListId}
            pkey={pickerKey(entry.slId, "set")}
            label={slReviewCopy.setList(name)}
            options={setOptions}
            onPick={(key) => onPickSet(key === "" ? null : (key as RowId))}
            onClose={onClosePicker}
            footer={
              <p className="px-2 pb-1 pt-1.5 text-[11px] text-slate-400">
                {ofSetsTruncated
                  ? `${slReviewCopy.setsTruncated(ofSets.length)} `
                  : ""}
                {slReviewCopy.onlyLinkedSets}
              </p>
            }
          />
        )}
      </div>
      <div
        role="cell"
        className="col-start-2 sm:col-start-auto"
        aria-busy={phase === "syncing" || undefined}
      >
        {setId ? (
          <>
            <span aria-hidden="true" className="mb-0.5 block text-[11px] text-slate-400 sm:hidden">
              {slReviewCopy.headerType}
            </span>
            <PickerTrigger
              label={slReviewCopy.typePicker(name)}
              text={chosenType ? chosenType.value : slReviewCopy.pickType}
              muted={!chosenType}
              open={openKind === "type"}
              listId={typeListId}
              pkey={pickerKey(entry.slId, "type")}
              disabled={typeBlocked}
              inert={phase === "syncing"}
              describedBy={reason ? reasonId : undefined}
              onToggle={() => onTogglePicker("type")}
            />
            {openKind === "type" && !typeBlocked && (
              <PickerList
                listId={typeListId}
                pkey={pickerKey(entry.slId, "type")}
                label={slReviewCopy.typeList(setLabel)}
                options={types.map((t) => ({
                  key: t._id,
                  label: t.value,
                  ...(t.role ? { tag: slReviewCopy.roleTag[t.role] } : {}),
                  current: t._id === decision.typeId,
                }))}
                onPick={(key) => {
                  const type = types.find((t) => t._id === key);
                  if (type) onPickType(type);
                }}
                onClose={onClosePicker}
              />
            )}
            {reason && (
              <p id={reasonId} className="mt-1 text-xs">
                {reason}
              </p>
            )}
          </>
        ) : (
          <span aria-hidden="true" className="hidden min-h-8 items-center text-sm text-slate-600 sm:flex">
            —
          </span>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The bulk bar
// ───────────────────────────────────────────────────────────────────────────

function BulkBar({
  ofSets,
  setName,
  bulk,
  selectedCount,
  openKind,
  localSync,
  onTogglePicker,
  onClosePicker,
  onPickSet,
  onPickType,
  onRetry,
  onApply,
  onOwn,
}: {
  ofSets: OfSet[];
  setName: (id: RowId) => string | undefined;
  bulk: Decision;
  selectedCount: number;
  openKind: "set" | "type" | null;
  localSync: (setId: RowId) => LocalSync | undefined;
  onTogglePicker: (kind: "set" | "type") => void;
  onClosePicker: () => void;
  onPickSet: (setId: RowId) => void;
  onPickType: (type: VariantTypeOption) => void;
  onRetry: (setId: RowId) => void;
  onApply: (typeValue: string) => void;
  onOwn: () => void;
}) {
  const setListId = useId();
  const typeListId = useId();
  const applyReasonId = useId();
  const ownReasonId = useId();
  const statusId = useId();
  const setId = bulk.setId;
  const setLabel = setId ? (setName(setId) ?? "") : "";
  const { phase, types, failed } = useSetTypes(setId, setId ? localSync(setId) : undefined);
  const chosenType = bulk.typeId ? types.find((t) => t._id === bulk.typeId) : undefined;
  const typeBlocked = !setId || phase !== "ready" || types.length === 0;
  const applyBlocked = selectedCount === 0 || !chosenType;
  const applyReason =
    selectedCount === 0 ? slReviewCopy.bulkNeedsRows : !chosenType ? slReviewCopy.bulkNeedsType : null;

  const status: ReactNode = !setId ? null : phase === "syncing" ? (
    <span className="text-slate-400">{slReviewCopy.syncing(setLabel)}</span>
  ) : failed ? (
    <span className="flex flex-wrap items-center gap-2 text-[#FF2EB3]">
      {slReviewCopy.syncFailed(setLabel)}
      <button
        type="button"
        aria-label={slReviewCopy.retryLabel(setLabel)}
        onClick={() => onRetry(setId)}
        onKeyDown={(e) => activateOnEnter(e, () => onRetry(setId))}
        className="min-h-6 rounded border border-slate-500 px-2 text-xs text-gray-200 hover:border-[#00D558] hover:text-[#00D558] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
      >
        {slReviewCopy.retry}
      </button>
    </span>
  ) : phase === "ready" && types.length === 0 ? (
    <span className="text-amber-300">{slReviewCopy.noTypes(setLabel)}</span>
  ) : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 p-2">
      <div className="flex flex-wrap items-start gap-2">
        <span className="flex min-h-8 items-center text-xs text-slate-300">
          {slReviewCopy.bulkLead}
        </span>
        <div className="w-44" aria-busy={phase === "syncing" || undefined}>
          <PickerTrigger
            label={slReviewCopy.bulkSetPicker}
            text={setId ? setLabel : slReviewCopy.pickSet}
            muted={!setId}
            open={openKind === "set"}
            listId={setListId}
            pkey={pickerKey(BULK, "set")}
            onToggle={() => onTogglePicker("set")}
          />
          {openKind === "set" && (
            <PickerList
              listId={setListId}
              pkey={pickerKey(BULK, "set")}
              label={slReviewCopy.bulkSetPicker}
              options={ofSets.map((s) => ({ key: s._id, label: s.value, current: s._id === setId }))}
              onPick={(key) => onPickSet(key as RowId)}
              onClose={onClosePicker}
              footer={
                <p className="px-2 pb-1 pt-1.5 text-[11px] text-slate-400">
                  {slReviewCopy.onlyLinkedSets}
                </p>
              }
            />
          )}
        </div>
        <span aria-hidden="true" className="flex min-h-8 items-center text-slate-500">
          ›
        </span>
        <div className="w-40">
          <PickerTrigger
            label={slReviewCopy.bulkTypePicker}
            text={chosenType ? chosenType.value : slReviewCopy.pickType}
            muted={!chosenType}
            open={openKind === "type"}
            listId={typeListId}
            pkey={pickerKey(BULK, "type")}
            disabled={typeBlocked}
            inert={phase === "syncing"}
            describedBy={status ? statusId : undefined}
            onToggle={() => onTogglePicker("type")}
          />
          {openKind === "type" && !typeBlocked && (
            <PickerList
              listId={typeListId}
              pkey={pickerKey(BULK, "type")}
              label={slReviewCopy.typeList(setLabel)}
              options={types.map((t) => ({
                key: t._id,
                label: t.value,
                ...(t.role ? { tag: slReviewCopy.roleTag[t.role] } : {}),
                current: t._id === bulk.typeId,
              }))}
              onPick={(key) => {
                const type = types.find((t) => t._id === key);
                if (type) onPickType(type);
              }}
              onClose={onClosePicker}
            />
          )}
        </div>
        <NeonButton
          type="button"
          size="1"
          aria-disabled={applyBlocked || undefined}
          aria-describedby={applyReason ? applyReasonId : undefined}
          onClick={() => {
            if (!applyBlocked && chosenType) onApply(chosenType.value);
          }}
          onKeyDown={(e) =>
            activateOnEnter(e, () => chosenType && onApply(chosenType.value), applyBlocked)
          }
        >
          {slReviewCopy.bulkApply(selectedCount)}
        </NeonButton>
        <NeonButton
          type="button"
          size="1"
          secondary
          aria-disabled={selectedCount === 0 || undefined}
          aria-describedby={selectedCount === 0 ? ownReasonId : undefined}
          onClick={() => {
            if (selectedCount > 0) onOwn();
          }}
          onKeyDown={(e) => activateOnEnter(e, onOwn, selectedCount === 0)}
        >
          {slReviewCopy.bulkOwn}
        </NeonButton>
      </div>
      {(status || applyReason) && (
        <p className="flex flex-wrap gap-x-3 text-xs text-slate-400">
          {status && <span id={statusId}>{status}</span>}
          {applyReason && <span id={applyReasonId}>{applyReason}</span>}
        </p>
      )}
      {/* The own-sets button's reason is the same sentence as Apply's first
          one; kept as its own node so each button names what blocks IT. */}
      <span id={ownReasonId} className="sr-only">
        {slReviewCopy.bulkNeedsRows}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The dialog
// ───────────────────────────────────────────────────────────────────────────

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export default function SlSetReviewModal({
  manufacturerId,
  restoreFocusRef,
  fallbackFocusRef,
  onClose,
  onSaved,
}: {
  manufacturerId: RowId;
  /** The pill that opened this; focus goes back to it on close. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus goes when that pill is gone (a finished save removes it). */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Cancel / Escape / Close: writes nothing. */
  onClose: () => void;
  /** The review is done: the owner closes the dialog and toasts `text`. */
  onSaved: (text: string) => void;
}) {
  const rawReview: unknown = useQuery(api.slSetReview.getSlSetReview, { manufacturerId });
  const liveReview: Review | null | undefined =
    rawReview === undefined
      ? undefined
      : typeof rawReview === "object" && rawReview !== null && Array.isArray((rawReview as Review).entries)
        ? (rawReview as Review)
        : null;
  const ensureSync = useAction(api.selectorOptions.ensureSelectorOptions);
  const applyReview = useAction(api.slSetReview.applySlSetReview);

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [openPicker, setOpenPicker] = useState<{ row: string; kind: "set" | "type" } | null>(null);
  const [bulk, setBulk] = useState<Decision>({});
  const [syncs, setSyncs] = useState<Record<string, LocalSync>>({});
  const [busy, setBusy] = useState(false);
  const [saveSnapshot, setSaveSnapshot] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  /** Sets this opening of the dialog has already asked to sync. */
  const requestedRef = useRef<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The trigger to hand focus back to once its list has closed. */
  const refocusTriggerRef = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const saveReasonId = useId();
  const errorId = useId();

  // While THIS dialog saves, render the rows it is saving: the save empties
  // the doc chunk by chunk before the action returns.
  const review = busy && saveSnapshot ? saveSnapshot : liveReview;
  const entries = useMemo(() => review?.entries ?? [], [review]);
  const ofSets = useMemo(() => review?.ofSets ?? [], [review]);
  const ofSetById = useMemo(() => new Map(ofSets.map((s) => [s._id as string, s])), [ofSets]);
  const setName = (id: RowId) => ofSetById.get(id)?.value;

  /** A decision whose set has left the brand's list reads as its own set. */
  const decisionOf = (slId: string): Decision => {
    const d = decisions[slId];
    if (!d?.setId || !ofSetById.has(d.setId)) return {};
    return d;
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.label.toLowerCase().includes(q)) : entries;
  const selectedLive = entries.filter((e) => selected.has(e.slId));
  const allShownSelected = shown.length > 0 && shown.every((e) => selected.has(e.slId));
  const someShownSelected = shown.some((e) => selected.has(e.slId));

  const needingType = entries.filter((e) => {
    const d = decisionOf(e.slId);
    return d.setId !== undefined && d.typeId === undefined;
  }).length;
  const tally = entries.reduce(
    (acc, e) => {
      const d = decisionOf(e.slId);
      if (!d.setId) acc.sets++;
      else if (d.typeId) {
        if (d.typeRole === "parallel") acc.parallels++;
        else acc.inserts++;
      }
      return acc;
    },
    { sets: 0, parallels: 0, inserts: 0 },
  );
  const saveBlocked = needingType > 0 || entries.length === 0;

  // Focus: in on the filter, back out to the pill (or the column) on close.
  useEffect(() => {
    // Both captured at mount: the pill and the column both exist by then, and
    // the pill is the one that may be gone by close (a finished save).
    const opener =
      restoreFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    const fallback = fallbackFocusRef?.current ?? null;
    const dialog = dialogRef.current;
    const landing = dialog?.querySelector<HTMLElement>('input[type="search"]');
    (landing ?? dialog)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
    // Mount/unmount only: the opener is captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The review loads a round-trip after the dialog: land on the filter once
  // it exists, unless focus has already moved on.
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !hasEntries) return;
    if (document.activeElement !== dialog) return;
    dialog.querySelector<HTMLElement>('input[type="search"]')?.focus();
  }, [hasEntries]);

  // A row another admin's save removed may have held focus; the browser drops
  // it to <body>, outside the trap. Park it on the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.contains(document.activeElement)) dialog.focus();
  }, [entries.length]);

  // Busy disables every button, blurring the one just pressed: hold focus.
  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  // Picker focus: into the list when it opens (on the current choice), back
  // to its trigger when it closes by Escape or a pick.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (openPicker) {
      const key = pickerKey(openPicker.row, openPicker.kind);
      const list = Array.from(dialog.querySelectorAll<HTMLElement>("[data-picker-list]")).find(
        (el) => el.getAttribute("data-picker-list") === key,
      );
      const target =
        list?.querySelector<HTMLElement>('[aria-current="true"]') ??
        list?.querySelector<HTMLElement>("[data-pick]");
      target?.focus();
      return;
    }
    const pending = refocusTriggerRef.current;
    if (!pending) return;
    refocusTriggerRef.current = null;
    Array.from(dialog.querySelectorAll<HTMLElement>("[data-picker-trigger]"))
      .find((el) => el.getAttribute("data-picker-trigger") === pending)
      ?.focus();
  }, [openPicker]);

  const announce = (text: string) => setAnnouncement(text);

  const startSync = (setId: RowId) => {
    requestedRef.current.add(setId);
    const label = setName(setId) ?? "";
    setSyncs((prev) => ({ ...prev, [setId]: "syncing" }));
    announce(slReviewCopy.syncing(label));
    ensureSync({ level: "variantType", parentId: setId, force: true }).then(
      (result: unknown) => {
        const failed =
          typeof result === "object" &&
          result !== null &&
          (result as { reason?: unknown }).reason === "error";
        setSyncs((prev) => ({ ...prev, [setId]: failed ? "failed" : "done" }));
        announce(failed ? slReviewCopy.syncFailed(label) : slReviewCopy.syncReady(label));
      },
      () => {
        setSyncs((prev) => ({ ...prev, [setId]: "failed" }));
        announce(slReviewCopy.syncFailed(label));
      },
    );
  };

  /** Once per set per opening of the dialog; Retry is the only second call. */
  const syncOnce = (setId: RowId) => {
    if (requestedRef.current.has(setId)) return;
    startSync(setId);
  };

  const localSync = (setId: RowId) => syncs[setId];

  const closePicker = (refocus: boolean) => {
    if (refocus && openPicker) refocusTriggerRef.current = pickerKey(openPicker.row, openPicker.kind);
    setOpenPicker(null);
  };

  const togglePicker = (row: string, kind: "set" | "type") => {
    if (openPicker && openPicker.row === row && openPicker.kind === kind) {
      setOpenPicker(null);
      return;
    }
    setOpenPicker({ row, kind });
  };

  const pickRowSet = (slId: string, setId: RowId | null) => {
    setDecisions((prev) => {
      const current = prev[slId];
      if (setId && current?.setId === setId) return prev;
      return { ...prev, [slId]: setId ? { setId } : {} };
    });
    closePicker(true);
    if (setId) syncOnce(setId);
  };

  const pickRowType = (slId: string, type: VariantTypeOption) => {
    setDecisions((prev) => {
      const current = prev[slId];
      if (!current?.setId) return prev;
      return { ...prev, [slId]: { setId: current.setId, typeId: type._id, typeRole: roleOf(type) } };
    });
    closePicker(true);
  };

  const pickBulkSet = (setId: RowId) => {
    setBulk((prev) => (prev.setId === setId ? prev : { setId }));
    closePicker(true);
    syncOnce(setId);
  };

  const pickBulkType = (type: VariantTypeOption) => {
    setBulk((prev) =>
      prev.setId ? { setId: prev.setId, typeId: type._id, typeRole: roleOf(type) } : prev,
    );
    closePicker(true);
  };

  const applyBulk = (typeValue: string) => {
    const { setId, typeId, typeRole } = bulk;
    if (!setId || !typeId || selectedLive.length === 0) return;
    const ids = selectedLive.map((e) => e.slId);
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { setId, typeId, typeRole };
      return next;
    });
    setSelected(new Set());
    announce(slReviewCopy.bulkMarked(ids.length, setName(setId) ?? "", typeValue));
  };

  const markOwn = () => {
    const ids = selectedLive.map((e) => e.slId);
    if (ids.length === 0) return;
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = {};
      return next;
    });
    setSelected(new Set());
    announce(slReviewCopy.bulkMarkedOwn(ids.length));
  };

  const toggleRow = (slId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slId)) next.delete(slId);
      else next.add(slId);
      return next;
    });

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) for (const e of shown) next.delete(e.slId);
      else for (const e of shown) next.add(e.slId);
      return next;
    });

  const handleSave = async () => {
    if (busy || saveBlocked || !liveReview) return;
    const snapshot = liveReview;
    const payload = snapshot.entries.slice(0, MAX_REVIEW_DECISIONS).map((e) => {
      const d = decisionOf(e.slId);
      return d.setId && d.typeId ? { slId: e.slId, variantTypeId: d.typeId } : { slId: e.slId };
    });
    setSaveSnapshot(snapshot);
    setBusy(true);
    setError(null);
    setOutcome(null);
    setOpenPicker(null);
    announce(slReviewCopy.saving);
    try {
      const result = (await applyReview({
        manufacturerId,
        decisions: payload,
      })) as SlSetReviewResult;
      const text = slReviewSavedText(result);
      if (result.incomplete) {
        setOutcome(`${text} ${slReviewCopy.left(result.remaining)}`);
        announce(`${text} ${slReviewCopy.left(result.remaining)}`);
      } else if (result.remaining > 0) {
        setOutcome(`${text} ${slReviewCopy.stillToSort(result.remaining)}`);
        announce(`${text} ${slReviewCopy.stillToSort(result.remaining)}`);
      } else {
        onSaved(text);
      }
    } catch (e) {
      const message = userFacingMessage(e, slReviewCopy.saveFailed);
      setError(message);
    } finally {
      setBusy(false);
      setSaveSnapshot(null);
    }
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      // An open list closes first (focus may still be on its trigger); the
      // next Escape cancels the dialog.
      if (openPicker) closePicker(true);
      else if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.closest("[inert]") === null,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const brand = review?.brandValue;
  const tallyParts: string[] = [];
  if (tally.sets > 0) tallyParts.push(plural(tally.sets, "set"));
  if (tally.parallels > 0) tallyParts.push(plural(tally.parallels, "parallel"));
  if (tally.inserts > 0) tallyParts.push(plural(tally.inserts, "insert"));

  return createPortal(
    <Theme>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 outline-none sm:p-4"
      >
        <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
          <header className="flex flex-col gap-2 border-b border-slate-800 px-4 pb-3 pt-4">
            <h2 id={titleId} className="text-lg font-semibold text-gray-100">
              {brand ? slReviewCopy.title(brand) : slReviewCopy.titleEmpty}
            </h2>
            <p id={descriptionId} className="max-w-[70ch] text-sm text-slate-400">
              {brand ? slReviewCopy.description(brand) : slReviewCopy.empty}
            </p>
            {review && review.moreNextSync > 0 && (
              <p className="text-xs text-slate-400">{slReviewCopy.moreNextSync(review.moreNextSync)}</p>
            )}
            {review?.partial && !outcome && !busy && (
              <p className="text-xs text-amber-300">{slReviewCopy.partial}</p>
            )}
            {hasEntries && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    bare
                    type="search"
                    aria-label={slReviewCopy.filter}
                    placeholder={slReviewCopy.filter}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="w-full max-w-xs rounded-md px-2.5 py-1.5 text-sm"
                  />
                  {q && <span className="text-xs text-slate-400">{slReviewCopy.filterCount(shown.length)}</span>}
                </div>
                <BulkBar
                  ofSets={ofSets}
                  setName={setName}
                  bulk={bulk.setId && !ofSetById.has(bulk.setId) ? {} : bulk}
                  selectedCount={selectedLive.length}
                  openKind={openPicker?.row === BULK ? openPicker.kind : null}
                  localSync={localSync}
                  onTogglePicker={(kind) => togglePicker(BULK, kind)}
                  onClosePicker={() => closePicker(true)}
                  onPickSet={pickBulkSet}
                  onPickType={pickBulkType}
                  onRetry={startSync}
                  onApply={applyBulk}
                  onOwn={markOwn}
                />
              </>
            )}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {review === undefined ? (
              <p className="px-4 py-6 text-sm text-slate-400">{slReviewCopy.loading}</p>
            ) : !hasEntries ? (
              <p className="px-4 py-6 text-sm text-slate-400">{slReviewCopy.empty}</p>
            ) : (
              <div role="table" aria-labelledby={titleId}>
                <div role="rowgroup" className="sticky top-0 z-10 bg-slate-900">
                  <div
                    role="row"
                    className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 border-b border-slate-700 px-2 py-1 sm:grid-cols-[2rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
                  >
                    <div role="columnheader">
                      <TickBox
                        label={slReviewCopy.selectAllShown}
                        checked={allShownSelected ? true : someShownSelected ? "mixed" : false}
                        onToggle={toggleAllShown}
                      />
                    </div>
                    <div role="columnheader" className="text-xs font-medium text-slate-300">
                      {slReviewCopy.headerName}
                    </div>
                    <div role="columnheader" className="sr-only text-xs font-medium text-slate-300 sm:not-sr-only">
                      {slReviewCopy.headerOf}
                    </div>
                    <div role="columnheader" className="sr-only text-xs font-medium text-slate-300 sm:not-sr-only">
                      {slReviewCopy.headerType}
                    </div>
                  </div>
                </div>
                <div role="rowgroup">
                  {shown.map((entry) => {
                    const suggested = entry.suggestedOfSetId
                      ? ofSetById.get(entry.suggestedOfSetId)
                      : undefined;
                    return (
                      <ReviewRow
                        key={entry.slId}
                        entry={entry}
                        decision={decisionOf(entry.slId)}
                        ofSets={ofSets}
                        setName={setName}
                        suggestedSet={suggested}
                        ofSetsTruncated={review?.ofSetsTruncated ?? false}
                        selected={selected.has(entry.slId)}
                        openKind={openPicker?.row === entry.slId ? openPicker.kind : null}
                        localSync={localSync}
                        onToggleSelect={() => toggleRow(entry.slId)}
                        onTogglePicker={(kind) => togglePicker(entry.slId, kind)}
                        onClosePicker={() => closePicker(true)}
                        onPickSet={(setId) => pickRowSet(entry.slId, setId)}
                        onPickType={(type) => pickRowType(entry.slId, type)}
                        onRetry={startSync}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <footer className="flex flex-col gap-2 border-t border-slate-700 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5 text-sm">
              {hasEntries && tallyParts.length > 0 && (
                // The one loud line: what Save will do, in the words its
                // toast will use ("Saved …").
                <p className="font-semibold text-[#00D558] tabular-nums">
                  {`Saves as ${tallyParts.join(", ")}.`}
                </p>
              )}
              {needingType > 0 && (
                <p id={saveReasonId} className="text-xs text-amber-300">
                  {slReviewCopy.rowsNeedType(needingType)}
                </p>
              )}
              {outcome && <p className="text-xs text-amber-300">{outcome}</p>}
              {error && (
                <p id={errorId} role="alert" className="text-xs text-[#FF2EB3]">
                  {error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-3">
              {hasEntries && (
                <NeonButton
                  type="button"
                  disabled={busy}
                  aria-disabled={saveBlocked && !busy ? true : undefined}
                  aria-describedby={needingType > 0 ? saveReasonId : undefined}
                  onClick={() => {
                    if (!saveBlocked) void handleSave();
                  }}
                  onKeyDown={(e) => activateOnEnter(e, () => void handleSave(), saveBlocked || busy)}
                >
                  {busy ? slReviewCopy.saving : slReviewCopy.save(entries.length)}
                </NeonButton>
              )}
              <NeonButton
                type="button"
                secondary
                disabled={busy}
                onClick={onClose}
                onKeyDown={(e) => activateOnEnter(e, onClose, busy)}
              >
                {hasEntries ? slReviewCopy.cancel : slReviewCopy.close}
              </NeonButton>
            </div>
          </footer>
          {/* One polite region for every busy state and result. */}
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
