import { ReactNode, useEffect, useRef, useState } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import SelectorSyncReviewModal, {
  MAX_DECISIONS_PER_CALL,
  type SelectorSyncSuggestion,
} from "./SelectorSyncReviewModal";
import SyncDoneNotice from "./SyncDoneNotice";
import {
  buildUnlinkedNotices,
  levelLabelPlural,
  LEVEL_SINGULAR,
  unlinkNoticeText,
  UNLINKED_NAME_LIMIT_TOAST,
  type SyncSide,
  type UnlinkedEntry,
} from "./selector-sync-feedback";
import { checkCustomSelectorValue } from "../../convex/selectorSyncMatch";

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

/**
 * NEO-219 — one row this column's "+ Custom" value already exists as, under a
 * DIFFERENT parent. `path` is that row's ancestor chain (root-first), which is
 * what `onDrillToExisting` replays to move the whole cascade onto it.
 */
export type ElsewhereMatch = {
  _id: GenericId<"selectorOptions">;
  value: string;
  parentId?: GenericId<"selectorOptions">;
  path: Array<{
    _id: GenericId<"selectorOptions">;
    level: Level;
    value: string;
  }>;
};

/**
 * NEO-219 — the custom-entry form is three states, not one.
 *
 * It used to write on the first Enter with no validation and a duplicate check
 * scoped to this column only, so "2o24" became a Year and a set that already
 * existed under a sibling manufacturer became a second, unsyncable copy. Typing
 * now leads to a CONFIRM, and the confirm is where the operator finds out the
 * value lives somewhere else.
 */
type CustomStage =
  | { kind: "input" }
  /** `findSelectorOptionElsewhere` in flight. The input stays mounted. */
  | { kind: "checking" }
  | { kind: "confirm-create"; value: string }
  | { kind: "confirm-exists"; value: string; matches: ElsewhereMatch[] };

/**
 * The server's structured refusals for a custom create.
 *
 * Read from `data`, never `.message`: production redacts the message, and the
 * reason/matches are the only fields this UI can render meaningfully.
 * Structural rather than `instanceof ConvexError` for the same reason
 * `RenameEntityControl` is — a rethrown or mocked error still has to surface.
 */
function customRefusal(
  e: unknown,
):
  | { code: "CUSTOM_VALUE_INVALID"; reason: string }
  | { code: "CUSTOM_EXISTS_ELSEWHERE"; matches: ElsewhereMatch[] }
  | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, reason, matches } = data as {
    code?: unknown;
    reason?: unknown;
    matches?: unknown;
  };
  if (code === "CUSTOM_VALUE_INVALID") {
    return {
      code,
      reason:
        typeof reason === "string" && reason.length > 0
          ? reason
          : "That value isn't allowed here.",
    };
  }
  if (code === "CUSTOM_EXISTS_ELSEWHERE") {
    return {
      code,
      matches: Array.isArray(matches) ? (matches as ElsewhereMatch[]) : [],
    };
  }
  return null;
}

/**
 * How many ancestors to name in a confirm sentence.
 *
 * Two: the column is `min-w-[260px] max-w-[340px]`, and the two closest
 * ancestors ("2021 > Topps") are what actually disambiguate a set — the sport
 * is never the thing an operator confuses.
 */
const BREADCRUMB_DEPTH = 2;

function breadcrumbOf(
  chain: Array<{ value: string }> | undefined | null,
): string {
  if (!chain || chain.length === 0) return "";
  return chain
    .slice(-BREADCRUMB_DEPTH)
    .map((a) => a.value)
    .join(" \u203a ");
}

export type EntityColumnProps = {
  selector: ReactNode;
  renderForm: (onDone: () => void) => ReactNode;
  addButtonText: string;
  isVisible: boolean;
  level?: Level;
  parentId?: GenericId<"selectorOptions">;
  // Called when the user types a value into "+ Custom" that already exists at
  // this column (synced marketplace data OR a prior custom entry). Instead of
  // minting a duplicate, we drive the parent's level-select handler so the
  // cascade drills into the existing row — identical to searching for and
  // selecting it. A genuinely-new value still creates a custom entry.
  onSelectExisting?: (id: GenericId<"selectorOptions">) => void;
  // NEO-219: the typed value exists under a DIFFERENT parent and the operator
  // chose "Go to it". The path is root-first and ends at the matched row, so
  // the parent replays it through its own level-select handlers in order and
  // the cascade lands on the existing row instead of minting a second copy.
  onDrillToExisting?: (
    path: Array<{ _id: GenericId<"selectorOptions">; level: Level }>,
  ) => void;
  // Extra buttons rendered alongside Sync / + Custom in idle mode. Used by
  // the Variants column to expose the "Group Parallels" trigger without
  // forcing every column to learn about that domain.
  extraActions?: ReactNode;
  // NEO-47 sync redesign: when true, this column uses the backend-owned
  // ensureSelectorOptions + reactive selectorSyncStatus path (no FE sync
  // state-machine / onDone handoff). Aggregator levels only for now;
  // setName/insert/parallel keep the legacy renderForm path until Phases 2-3.
  useEnsureSync?: boolean;
  // Heading shown in the loading box while ensureSelectorOptions syncs. Must
  // match the legacy form heading the flows assert on (e.g. "Syncing Sport
  // Options"). Only used when useEnsureSync is true.
  syncingLabel?: string;
  // NEO-83: reports the pure-read loading state (getSelectorOptions still
  // undefined) up to the ResilientEntityColumn backstop, which re-subscribes a
  // stalled column. Left undefined when this column is used bare (e.g. in
  // tests) — the backstop is opt-in via the wrapper.
  onLoadingChange?: (loading: boolean) => void;
};

// Gap left between a newly-revealed column's edge and the scroll row's true
// visible boundary, so it doesn't land flush against the edge. Matches the
// gap-4/pl-4 16px spacing unit already used for this row in SetSelector.tsx.
const REVEAL_SCROLL_BUFFER_PX = 16;

// Scrolls `column`'s own [data-set-selector-scroll] ancestor just far enough
// that `column` clears the ancestor's visible right/left edge. No-op if no
// such ancestor exists (e.g. an isolated unit-test render).
function scrollColumnIntoView(column: HTMLElement) {
  const scrollContainer = column.closest<HTMLElement>(
    "[data-set-selector-scroll]",
  );
  if (!scrollContainer) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const columnRect = column.getBoundingClientRect();
  const overflowRight = columnRect.right - containerRect.right;
  if (overflowRight > 0) {
    // Instant, not smooth: Maestro reads layout bounds and taps immediately,
    // so an animated scroll lets it tap a column before it settles — the
    // e2e nav-tap that parked the prior NEO-63 attempt.
    scrollContainer.scrollLeft += overflowRight + REVEAL_SCROLL_BUFFER_PX;
  } else {
    const overflowLeft = containerRect.left - columnRect.left;
    if (overflowLeft > 0) {
      scrollContainer.scrollLeft -= overflowLeft + REVEAL_SCROLL_BUFFER_PX;
    }
  }
}

export default function EntityColumn({
  selector,
  renderForm,
  addButtonText,
  isVisible,
  level,
  parentId,
  onSelectExisting,
  onDrillToExisting,
  extraActions,
  useEnsureSync,
  syncingLabel,
  onLoadingChange,
}: EntityColumnProps) {
  const [mode, setMode] = useState<"idle" | "sync" | "custom">("idle");
  const [customValue, setCustomValue] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  // NEO-219: where the custom-entry form is in its type -> confirm -> write
  // sequence. See CustomStage.
  const [customStage, setCustomStage] = useState<CustomStage>({ kind: "input" });
  const [creating, setCreating] = useState(false);
  // Set once the user engages this column after its first sync — see the
  // freeze-on-interaction effect below. Frozen columns stop auto-syncing.
  const [hasInteracted, setHasInteracted] = useState(false);
  // True only while THIS session's own explicit "Sync <X>" click is in flight
  // (useEnsureSync path). Lets us still show the "Fetching from marketplaces…"
  // panel for the sync the operator personally requested, even though that same
  // click also flips hasInteracted true (which otherwise suppresses the panel —
  // see newPathContent). Reset the moment the reactive status leaves "syncing".
  const [selfRequestedSync, setSelfRequestedSync] = useState(false);
  // NEO-211 (plan C): the marketplace-renamed-this review dialog, and the
  // post-apply outcome line it leaves behind.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [applyingSuggestions, setApplyingSuggestions] = useState(false);
  const [suggestionOutcome, setSuggestionOutcome] = useState<string | null>(null);
  // NEO-211 (plan D): which "no longer listed" notice this session has already
  // read, keyed by the notice's CONTENT. Keyed rather than a bare boolean so a
  // later sync's fresh notice at the same (level, parentId) is never suppressed
  // by an old dismissal — content rather than a timestamp because
  // `getSelectorSyncStatus` does not expose the row's `updatedAt`, and the
  // set of unlinked ids is what actually distinguishes one report from another.
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);
  const [dismissingNotice, setDismissingNotice] = useState(false);
  // a11y: tracks the notice going visible→hidden, so focus can be parked when
  // the control that had it unmounts. See the effect below.
  const hadNoticeRef = useRef(false);
  // Reuses SetAttributesPanel's fixed-position toast verbatim rather than
  // inventing a second mechanism — the column may well have scrolled out of
  // view by the time a background sync lands its unlink report.
  const [toast, setToast] = useState<string | null>(null);

  // Unique per-instance class for the custom-entry input so Maestro web's
  // inputText resolves to THIS column's box. Maestro's createXPathFromElement
  // keys off className (not aria-label), so a raw shared Tailwind class makes
  // it type into the first matching input on the page (NEO-39). Same fix as the
  // mb-search-<col> class on the column search input in EntitySelector.
  const fieldClass = useFieldTestClass();

  const containerRef = useRef<HTMLDivElement | null>(null);
  // NEO-219: the confirm's primary button. Focused DIRECTLY in an effect (not
  // through requestAnimationFrame): the confirm is not portalled, so the node
  // exists by the time the effect runs, and the E2E drills press Enter twice in
  // immediate succession — a frame of delay is a dropped keystroke.
  const confirmPrimaryRef = useRef<HTMLButtonElement | null>(null);
  // An Enter that arrived while `findSelectorOptionElsewhere` was still in
  // flight. Replayed onto the CREATE confirm only, never onto the
  // exists-elsewhere offer: "create the thing I typed" is what the second Enter
  // meant, and drilling into somebody else's row is not.
  const pendingCreateEnterRef = useRef(false);
  // a11y: the pill the suggestions dialog was opened from, so focus comes back
  // to it on close rather than dropping to <body>.
  const suggestionsBtnRef = useRef<HTMLButtonElement | null>(null);
  // NEO-71-74 follow-up: always start false, regardless of this column's
  // isVisible prop at mount. Columns 6/7 (Variant / Variant of Variant) are
  // conditionally MOUNTED (not just conditionally rendered null like columns
  // 1-5) and remount already-visible — seeding this from `isVisible` made the
  // false->true reveal transition unobservable for them, so their scroll-into-
  // view never fired on any reveal. Starting false means every column's first
  // visible render is treated as a reveal that needs to scroll, which is a
  // harmless no-op for the always-mounted columns (they start hidden already).
  const wasVisibleRef = useRef(false);
  // True from the moment this column is revealed until its content has
  // genuinely settled (real items loaded, not mid-sync) — see the two
  // effects below. Scopes the settle re-check to only the column that was
  // JUST revealed, so it doesn't re-fire (and yank scroll position) for an
  // older, already-viewed column whose content happens to change later.
  const settleTargetRef = useRef(false);

  // Query the items at this column's level so we can auto-trigger sync
  // when the column opens empty. Skipped when no level is provided
  // (defensive — every caller in SetSelector.tsx supplies one).
  const items = useQuery(
    api.selectorOptions.getSelectorOptions,
    level ? { level, parentId } : "skip",
  );

  // NEO-219: the parent's own ancestry, so a confirm can say WHERE the row is
  // about to be created ("under 2021 › Topps"). Skipped at the root level,
  // which has no parent and therefore no breadcrumb.
  const parentChain = useQuery(
    api.selectorOptions.getAncestorChain,
    parentId ? { id: parentId } : "skip",
  );

  // One-shot reads (not a subscription): the cross-parent duplicate check runs
  // once per submit, on a value that does not exist yet, so there is nothing to
  // stay subscribed to.
  const convex = useConvex();

  // NEO-83: surface the pure-read loading state to the ResilientEntityColumn
  // backstop. `items === undefined` is exactly the "Loading <level>…" gate in
  // EntitySelector — both this column and its EntitySelector child subscribe to
  // the SAME (level, parentId) getSelectorOptions token, which Convex dedupes
  // into one reactive subscription, so this undefined mirrors the heading gate.
  // It is disjoint from the marketplace "Syncing…" state (which has
  // `items === []`, defined), so the backstop only ever fires on a genuine read
  // stall, never during an in-flight marketplace fetch. No-op for a level-less
  // column (query skipped → nothing to load).
  useEffect(() => {
    onLoadingChange?.(!!level && items === undefined);
  }, [onLoadingChange, level, items]);

  // NEO-47 new-path hooks (active only when useEnsureSync). Reactive sync status
  // (null = idle) drives loading/error; ensureSelectorOptions is the one backend
  // door that decides whether/how to populate.
  const syncStatus = useQuery(
    api.selectorOptions.getSelectorSyncStatus,
    useEnsureSync && level ? { level, parentId } : "skip",
  );
  const ensureOptions = useAction(
    api.selectorOptions.ensureSelectorOptions,
  );

  // NEO-211 (plan C): derived state, not a pipeline — this just compares the
  // marketplace label the store already recorded against our own value. Wired
  // for ALL seven levels: `idleButtons` below is shared by the useEnsureSync
  // path and the legacy renderForm path, so levels 6-7 get it too.
  const rawSuggestions = useQuery(
    api.selectorOptions.getSelectorSyncSuggestions,
    level ? { level, parentId } : "skip",
  );
  // Shape-guarded rather than trusted: this column subscribes to several
  // queries and a row without an `existingId` is not something this UI can act
  // on, so it is not something it should count in "N suggestions" either.
  const suggestions: SelectorSyncSuggestion[] | undefined = Array.isArray(
    rawSuggestions,
  )
    ? (rawSuggestions as SelectorSyncSuggestion[]).filter(
        (s) => s && typeof s.existingId === "string" && Array.isArray(s.suggestions),
      )
    : undefined;
  const applySuggestions = useMutation(
    api.selectorOptions.applySelectorSyncSuggestions,
  );
  const dismissNotice = useMutation(
    api.selectorOptions.dismissSelectorSyncNotice,
  );
  const ensuredRef = useRef<Set<string>>(new Set());

  // Track which (level, parentId) keys have already had auto-sync fired
  // so closing the form doesn't immediately retrigger it. A fresh
  // parentId (user picks a different parent) gets its own attempt.
  const autoSyncedRef = useRef<Set<string>>(new Set());

  // Has this column finished its first sync (data loaded, or a sync cycle
  // completed)? Freeze-on-interaction only engages after this, so a never-
  // synced column still gets its first sync even if the user scrolls it early.
  const hasSyncedRef = useRef(false);
  const prevModeRef = useRef<"idle" | "sync" | "custom">(mode);

  useEffect(() => {
    // NEO-71-74 follow-up: manual scroll math instead of native
    // scrollIntoView({inline:"center"}). "center" was chosen over the
    // original "end" by NEO-63 specifically to stop new columns landing
    // under the fixed right nav (mis-taps that navigated to /inventory) —
    // but "center" only centers the column, it doesn't guarantee the
    // column's own trailing edge actually clears the viewport, so it could
    // still render clipped (confirmed: reproduces at any viewport width
    // once enough columns accumulate, and unconditionally for columns 6/7
    // whose reveal effect never fired at all before the wasVisibleRef fix
    // above).
    //
    // The fixed nav is `position: fixed` (binder-tabs.tsx) — it contributes
    // zero width to layout. Its gutter is reserved entirely via
    // `binder-layout.tsx`'s `lg:pr-[170px]` padding on an ancestor several
    // levels above the scroll row, which (being padding on a border-box
    // element) already narrows the scroll row's own rendered box. So
    // measuring purely against the scroll row's own boundingClientRect is
    // automatically nav-safe — no separate nav-width constant needed.
    if (isVisible && !wasVisibleRef.current && containerRef.current) {
      scrollColumnIntoView(containerRef.current);
      // The column is content-driven width (min-w-[260px] max-w-[340px]),
      // and on first reveal its item list is frequently still loading (its
      // own "Loading <level>…" placeholder from EntitySelector, gated on
      // this same `items` query being undefined), so the call above can
      // measure a narrower box than the column settles into once real
      // content (e.g. long set names) arrives — leaving the now-wider
      // column clipped with no further scroll ever firing, since this
      // effect only re-runs on the next false->true transition. Flag this
      // reveal as pending a settle re-check; the effect below fires it once
      // the column's content actually stabilizes.
      settleTargetRef.current = true;
    }
    wasVisibleRef.current = isVisible;
  }, [isVisible]);

  // Fires the settle re-check exactly once per reveal, at the actual moment
  // this column's content stabilizes — not a guessed delay. `items` goes
  // undefined -> array the instant EntitySelector's "Loading <level>…"
  // placeholder (gated on that same undefined) is replaced by the real
  // list; `mode` leaving "sync" is this file's own existing signal (see the
  // hasSyncedRef effect below) that an in-flight marketplace fetch has
  // finished. Waiting on both means a cold column that loads empty and
  // triggers a sync still gets caught once the fetched results land, not
  // just the initial (still-empty) resolution.
  useEffect(() => {
    if (!settleTargetRef.current || !containerRef.current) return;
    if (items === undefined) return;
    if (mode === "sync") return;
    scrollColumnIntoView(containerRef.current);
    settleTargetRef.current = false;
  }, [items, mode]);

  // Latch "first sync done" for this column: either the items query has
  // returned data, or a sync cycle has completed (sync → idle). Freeze-on-
  // interaction only engages after this point ("freeze only after first sync").
  useEffect(() => {
    if (items && items.length > 0) hasSyncedRef.current = true;
    if (prevModeRef.current === "sync" && mode === "idle") {
      hasSyncedRef.current = true;
    }
    prevModeRef.current = mode;
  }, [items, mode]);

  // A different parent is a fresh, untouched context: re-allow auto-sync and
  // require a new first-sync before interaction can freeze the column again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-prop-change: a new parent is a fresh, unfrozen column
    setHasInteracted(false);
    setSelfRequestedSync(false);
    hasSyncedRef.current = false;
    // NEO-219: the custom-entry form is scoped to the parent it was opened
    // under. Leaving `mode`/`customValue`/`customError` alone meant a
    // half-typed value (and, worse, an open confirm naming the OLD parent)
    // survived a parent change and the next Enter wrote it under the new one.
    setMode((m) => (m === "custom" ? "idle" : m));
    setCustomValue("");
    setCustomError(null);
    setCustomStage({ kind: "input" });
    pendingCreateEnterRef.current = false;
  }, [parentId]);

  // Freeze-on-interaction (FE stability for concurrent users): once the user
  // engages a column that has ALREADY synced — selects a row, types in the
  // search box, or scrolls — stop auto-syncing it and drop out of any in-flight
  // auto-sync. A background re-sync (triggered by this or another user's writes
  // to the shared selectorOptions) can then no longer blank the column or
  // swallow the interaction. The reactive items query stays live, so
  // collaborative adds/updates still appear; only the marketplace re-fetch
  // stops. Columns the user hasn't touched keep syncing normally.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onInteract = () => {
      if (!hasSyncedRef.current) return; // only after the first sync
      setHasInteracted(true);
      setMode((m) => (m === "sync" ? "idle" : m));
    };
    // capture phase so we freeze before the row's own onClick runs.
    const opts = { capture: true, passive: true } as const;
    // pointerdown = select a row / press a button; keydown = type in search;
    // wheel + touchstart = scroll. We deliberately do NOT listen for the
    // generic `scroll` event, so the programmatic scrollIntoView that fires
    // when a column first appears can't falsely freeze an untouched column.
    el.addEventListener("pointerdown", onInteract, opts);
    el.addEventListener("keydown", onInteract, opts);
    el.addEventListener("wheel", onInteract, opts);
    el.addEventListener("touchstart", onInteract, opts);
    return () => {
      el.removeEventListener("pointerdown", onInteract, opts);
      el.removeEventListener("keydown", onInteract, opts);
      el.removeEventListener("wheel", onInteract, opts);
      el.removeEventListener("touchstart", onInteract, opts);
    };
  }, [isVisible]);

  // Clear the "I asked for this sync" latch as soon as the reactive status
  // leaves "syncing" (finished / errored / cleared). Without this, a later
  // BACKGROUND sync triggered by someone else would incorrectly re-show the
  // panel for this session just because it once clicked Sync. Deps on the raw
  // status string so it does NOT fire on the render where forceSync sets the
  // latch true (status hasn't flipped to "syncing" yet), avoiding a self-reset.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the self-requested-sync latch once the reactive status leaves 'syncing'
    if (syncStatus?.status !== "syncing") setSelfRequestedSync(false);
  }, [syncStatus?.status]);

  // NEO-211 (plan D): the "sync done, and here is what it detached" state.
  // `status: "done"` is only ever written when there is something to report —
  // a clean sync still deletes its status row — so this branch and the
  // `error` / `syncing` branches are mutually exclusive by construction.
  const doneUnlinked: UnlinkedEntry[] =
    syncStatus?.status === "done" && Array.isArray(syncStatus.unlinked)
      ? (syncStatus.unlinked as UnlinkedEntry[])
      : [];
  // A "done" row carries a partial-failure `message`, an `unlinked` list, or
  // both — the backend writes it whenever EITHER is non-empty (a clean sync
  // still deletes the row). All three shapes are one dismissable surface.
  const doneMessage =
    syncStatus?.status === "done" ? syncStatus.message : undefined;
  const noticeKey = `${doneMessage ?? ""}::${doneUnlinked
    .map((u) => `${u.side}:${u.id}`)
    .join("|")}`;
  const noticeVisible =
    (!!doneMessage || doneUnlinked.length > 0) &&
    noticeKey !== dismissedNoticeKey;
  // `unlinkedTotal` is one scalar across both sides, so it can only be
  // attributed when a single side is involved — which is the common case (one
  // marketplace dropped a batch). With both sides present we fall back to
  // counting what we were sent rather than inventing a split.
  const unlinkedTotals: Partial<Record<SyncSide, number>> | undefined = (() => {
    const total = syncStatus?.unlinkedTotal;
    if (typeof total !== "number" || doneUnlinked.length === 0) return undefined;
    const sides = new Set(doneUnlinked.map((u) => u.side));
    if (sides.size !== 1) return undefined;
    const [only] = [...sides];
    return { [only]: total } as Partial<Record<SyncSide, number>>;
  })();

  // Toast once, on the transition INTO "done" — not on every re-render of a
  // done row, or a re-subscribe would re-announce a sync from an hour ago.
  const prevSyncStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevSyncStatusRef.current;
    prevSyncStatusRef.current = syncStatus?.status;
    if (prev === "done" || syncStatus?.status !== "done") return;
    if (doneUnlinked.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- announces a completed background sync; there is no event to hang it off
    setToast(
      unlinkNoticeText(doneUnlinked, level, {
        maxNames: UNLINKED_NAME_LIMIT_TOAST,
      }),
    );
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the status transition only; doneUnlinked is derived from the same row
  }, [syncStatus?.status, level]);

  // a11y: clicking the notice's Dismiss unmounts the whole box — Dismiss
  // included — and nothing else takes focus, so the browser drops it to <body>
  // and a keyboard user restarts from the top of the document. Park it on the
  // column container instead, which is where they were.
  //
  // Same guarded shape the two forms use: keyed on the notice's own
  // visible→hidden transition, and only when focus ACTUALLY landed on <body>.
  // Without that second check this would steal focus from wherever the operator
  // legitimately moved next — a background sync can clear this notice at any
  // moment, with nobody having touched Dismiss at all.
  useEffect(() => {
    const hadNotice = hadNoticeRef.current;
    hadNoticeRef.current = noticeVisible;
    if (hadNotice && !noticeVisible && document.activeElement === document.body) {
      containerRef.current?.focus();
    }
  }, [noticeVisible]);

  // Auto-sync: when this column is visible, not frozen by interaction, in idle
  // mode, the items query has resolved to an empty list, and we haven't already
  // auto-synced this (level, parentId) — switch to sync mode. The form itself
  // auto-runs `fetchRawOptions`/`fetchAggregatedOptions` on mount, so this is
  // the only nudge needed.
  useEffect(() => {
    if (useEnsureSync) return; // new path handles populate via ensureSelectorOptions
    if (!isVisible) return;
    if (hasInteracted) return;
    if (mode !== "idle") return;
    if (!level) return;
    if (items === undefined) return;
    if (items.length > 0) return;
    const key = `${level}:${parentId ?? "root"}`;
    if (autoSyncedRef.current.has(key)) return;
    autoSyncedRef.current.add(key);
    setMode("sync");
  }, [isVisible, mode, level, parentId, items, hasInteracted, useEnsureSync]);

  // NEO-47 new path: on an empty column, ask the backend to populate (once per
  // key). The backend decides everything (already-populated / custom-subtree /
  // which marketplaces); we just read items + syncStatus reactively. No FE sync
  // mode, so there is no onDone handoff to drop — the stuck-sync race is gone.
  useEffect(() => {
    if (!useEnsureSync) return;
    if (!isVisible) return;
    if (!level) return;
    if (items === undefined) return;
    if (items.length > 0) return;
    const key = `${level}:${parentId ?? "root"}`;
    if (ensuredRef.current.has(key)) return;
    ensuredRef.current.add(key);
    void ensureOptions({ level, parentId });
  }, [useEnsureSync, isVisible, level, parentId, items, ensureOptions]);

  const addCustomOption = useMutation(
    api.selectorOptions.addCustomSelectorOption,
  );

  const handleFormDone = () => {
    setMode("idle");
  };

  // NEO-211 (plan D): dismiss clears the SERVER's notice, not just this
  // session's view. The status row is shared, so a purely local dismiss would
  // leave the notice waiting for this admin on every re-subscribe — and the
  // contract puts the clear on the server so it survives a reload. The local
  // stamp is optimism, so the box goes away on click instead of on round-trip.
  const handleDismissNotice = async () => {
    if (!level || dismissingNotice) return;
    setDismissedNoticeKey(noticeKey);
    setDismissingNotice(true);
    try {
      await dismissNotice({ level, parentId });
    } catch {
      // A failed dismiss is not worth an error box: the notice is informational
      // and the local stamp already hid it for this session. It will come back
      // on reload, which is the honest outcome of the write not landing.
    } finally {
      setDismissingNotice(false);
    }
  };

  // NEO-211 (plan C): the only path that turns a suggestion into a write.
  const handleApplySuggestions = async (decisions: Array<{
    existingId: GenericId<"selectorOptions">;
    baseVersion: number;
    side: "bsc" | "sportlots";
    action: "accept" | "decline";
  }>) => {
    if (!level) return;
    // The server caps a batch. Slicing and SAYING SO beats having the mutation
    // reject all 300 decisions because the operator was thorough.
    const truncated = decisions.length > MAX_DECISIONS_PER_CALL;
    const batch = truncated
      ? decisions.slice(0, MAX_DECISIONS_PER_CALL)
      : decisions;
    setApplyingSuggestions(true);
    try {
      const result = await applySuggestions({ level, parentId, decisions: batch });
      const parts: string[] = [];
      if (result?.applied) parts.push(`${result.applied} renamed`);
      if (result?.declined) parts.push(`${result.declined} declined`);
      // Every degraded outcome is named. A decision that silently did not take
      // is the one failure mode this whole feature exists to avoid.
      if (result?.stale) parts.push(`${result.stale} changed just now`);
      if (result?.clashed) parts.push(`${result.clashed} clashed with a sibling name`);
      if (result?.skipped) parts.push(`${result.skipped} skipped`);
      if (truncated) {
        parts.push(
          `${decisions.length - MAX_DECISIONS_PER_CALL} not sent — reopen to finish`,
        );
      }
      setSuggestionOutcome(
        parts.length > 0 ? parts.join(" · ") : "Nothing to apply.",
      );
      setShowSuggestions(false);
    } catch (error) {
      setSuggestionOutcome(
        error instanceof Error ? error.message : "Couldn't apply decisions.",
      );
    } finally {
      setApplyingSuggestions(false);
    }
  };

  /**
   * The single write path for a new custom row.
   *
   * `allowDuplicateElsewhere` is the explicit, operator-chosen escape hatch
   * from the cross-parent check — never a default, so a value that exists
   * somewhere else can only be duplicated deliberately.
   */
  const runCreate = async (value: string, allowDuplicateElsewhere: boolean) => {
    if (!level || creating) return;
    setCreating(true);
    setCustomError(null);
    try {
      await addCustomOption({
        level,
        value,
        parentId,
        ...(allowDuplicateElsewhere ? { allowDuplicateElsewhere: true } : {}),
      });
      setCustomValue("");
      setCustomStage({ kind: "input" });
      setMode("idle");
    } catch (error) {
      // The server re-runs both checks this form ran, so its refusal is the
      // authority — a stale bundle or a row created a second ago by somebody
      // else still cannot get the write through. Render the STRUCTURE
      // (`data.reason` / `data.matches`), never the raw text.
      const refusal = customRefusal(error);
      if (refusal?.code === "CUSTOM_EXISTS_ELSEWHERE") {
        setCustomStage({
          kind: "confirm-exists",
          value,
          matches: refusal.matches,
        });
        return;
      }
      if (refusal?.code === "CUSTOM_VALUE_INVALID") {
        setCustomValue(value);
        setCustomStage({ kind: "input" });
        setCustomError(refusal.reason);
        return;
      }
      setCustomValue(value);
      setCustomStage({ kind: "input" });
      setCustomError(
        error instanceof Error ? error.message : "Failed to add custom entry",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleCustomSubmit = async () => {
    if (!level) return;
    // An Enter that lands while the cross-parent lookup is in flight is the
    // operator (or the E2E driver) confirming ahead of the round-trip. Hold it
    // rather than dropping it; the confirm effect replays it.
    if (customStage.kind === "checking") {
      pendingCreateEnterRef.current = true;
      return;
    }
    if (customStage.kind !== "input") return;
    setCustomError(null);

    // Validate BEFORE anything else. "2o24" is not a year, and the row it
    // would create is one nothing can ever sync or reconcile.
    const checked = checkCustomSelectorValue(level, customValue);
    if (!checked.ok) {
      setCustomError(checked.reason);
      return;
    }
    const trimmed = checked.value;

    // "Custom" is only for values the marketplaces don't have. If the typed
    // value already exists at this column — whether it was synced from a
    // marketplace OR added as a prior custom entry — treat it exactly like
    // searching for and selecting it: drill into the existing row via the
    // parent's level-select handler. No duplicate, no error, and no confirm:
    // this is a navigation, not a write. (The server's addCustomSelectorOption
    // is idempotent and returns the existing _id on a match, but the FE drives
    // the actual selection so the cascade advances.)
    const normalized = trimmed.toLowerCase();
    const existing = (items ?? []).find(
      (o) => o.value.toLowerCase().trim() === normalized,
    );
    if (existing) {
      setCustomValue("");
      setCustomStage({ kind: "input" });
      setMode("idle");
      onSelectExisting?.(existing._id);
      return;
    }

    setCustomStage({ kind: "checking" });
    let matches: ElsewhereMatch[] = [];
    try {
      const result = await convex.query(
        api.selectorOptions.findSelectorOptionElsewhere,
        { level, value: trimmed, parentId },
      );
      matches = Array.isArray(result) ? (result as ElsewhereMatch[]) : [];
    } catch {
      // A failed lookup must not become a wall. Fall through to the plain
      // create confirm — the mutation runs the same check server-side and
      // refuses with CUSTOM_EXISTS_ELSEWHERE if there is something to find.
      matches = [];
    }
    setCustomStage(
      matches.length > 0
        ? { kind: "confirm-exists", value: trimmed, matches }
        : { kind: "confirm-create", value: trimmed },
    );
  };

  // NEO-219: move the whole cascade onto the row that already exists elsewhere.
  // `path` is root-first and ends at the matched row itself, so the parent can
  // replay it through its own level-select handlers in order.
  const handleDrillToMatch = (match: ElsewhereMatch) => {
    if (!level) return;
    const ancestors = (match.path ?? []).filter((p) => p._id !== match._id);
    setCustomValue("");
    setCustomStage({ kind: "input" });
    setMode("idle");
    onDrillToExisting?.([
      ...ancestors.map((p) => ({ _id: p._id, level: p.level })),
      { _id: match._id, level },
    ]);
  };

  const backToInput = () => {
    pendingCreateEnterRef.current = false;
    setCustomStage((stage) =>
      stage.kind === "confirm-create" || stage.kind === "confirm-exists"
        ? { kind: "input" }
        : stage,
    );
  };

  const closeCustomForm = () => {
    pendingCreateEnterRef.current = false;
    setCustomValue("");
    setCustomError(null);
    setCustomStage({ kind: "input" });
    setMode("idle");
  };

  // Focus the confirm's primary button the moment it mounts, and replay a
  // buffered Enter onto the CREATE confirm only.
  useEffect(() => {
    if (customStage.kind !== "confirm-create" && customStage.kind !== "confirm-exists") {
      return;
    }
    confirmPrimaryRef.current?.focus();
    if (customStage.kind === "confirm-create" && pendingCreateEnterRef.current) {
      pendingCreateEnterRef.current = false;
      // Replays the operator's own second Enter onto the confirm it was aimed
      // at. Not a state write from the effect body: `runCreate` is an async
      // mutation call, exactly what the button's own onClick runs.
      void runCreate(customStage.value, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stage transition; runCreate is recreated every render
  }, [customStage]);

  if (!isVisible) return null;

  // The noun this column creates, mid-sentence ("set", "sport", "sub-variant").
  const levelNounSingular = level ? LEVEL_SINGULAR[level].toLowerCase() : "entry";
  const parentBreadcrumb = breadcrumbOf(parentChain);
  const confirmValue =
    customStage.kind === "confirm-create" || customStage.kind === "confirm-exists"
      ? customStage.value
      : "";
  // Sentences are composed in JS, not assembled from JSX text nodes, so what
  // Maestro reads is exactly one string with exactly one set of spaces in it.
  const createSentence = parentBreadcrumb
    ? `Create ${levelNounSingular} '${confirmValue}' under ${parentBreadcrumb}?`
    : `Create ${levelNounSingular} '${confirmValue}'?`;
  const firstMatch =
    customStage.kind === "confirm-exists" ? customStage.matches[0] : undefined;
  const matchBreadcrumb = firstMatch
    ? breadcrumbOf((firstMatch.path ?? []).filter((a) => a._id !== firstMatch._id))
    : "";
  const existsSentence = matchBreadcrumb
    ? `'${confirmValue}' already exists under ${matchBreadcrumb}`
    : `'${confirmValue}' already exists elsewhere`;
  const otherMatchCount =
    customStage.kind === "confirm-exists" ? customStage.matches.length - 1 : 0;

  // Extracted so both the legacy mode-machine path and the new ensureSync path
  // render byte-identical custom-entry + idle-button UI (keeps NEO-39 field-class
  // + the "Add custom X" aria-label the drills target).
  //
  // NEO-219: the heading is deliberately CONSTANT across all three stages.
  // Eleven Maestro flows wait on "Add Custom Entry" to appear and on the same
  // string to disappear once the row is written, so it brackets the whole
  // interaction rather than just its first screen. (It is also the only place
  // in this column allowed to contain the bare word "Custom" —
  // `custom-entry-survives-resync.yaml` asserts `text: "Custom"` positioned
  // rightOf a row, and a second match here is a resolution hazard.)
  const customForm = (
    <div
      className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Escape steps BACK out of a confirm before it closes the form: the
        // operator who opened a confirm by mistake should not also lose what
        // they typed.
        e.stopPropagation();
        if (
          customStage.kind === "confirm-create" ||
          customStage.kind === "confirm-exists"
        ) {
          backToInput();
        } else {
          closeCustomForm();
        }
      }}
    >
      <h2 className="text-lg font-semibold mb-3">Add Custom Entry</h2>

      {(customStage.kind === "input" || customStage.kind === "checking") && (
        <>
          <Input
            bare
            type="text"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCustomSubmit();
            }}
            className={`${fieldClass("customvalue")} w-full p-2 mb-3`}
            placeholder="Enter custom value..."
            // The input stays MOUNTED while the cross-parent lookup runs so it
            // keeps focus: unmounting it drops focus to <body>, and the second
            // Enter of the keyboard flow lands on nothing.
            readOnly={customStage.kind === "checking"}
            autoFocus
          />
          {customStage.kind === "checking" && (
            <p className="text-xs text-gray-500 mb-3" role="status">
              Checking where this name is already used…
            </p>
          )}
          {customError && (
            <div className="p-2 mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
              {customError}
            </div>
          )}
          <div className="flex gap-2">
            <NeonButton
              onClick={handleCustomSubmit}
              disabled={customStage.kind === "checking"}
            >
              Add
            </NeonButton>
            <NeonButton cancel onClick={closeCustomForm}>
              Cancel
            </NeonButton>
          </div>
        </>
      )}

      {customStage.kind === "confirm-create" && (
        <>
          <p className="text-sm mb-3">{createSentence}</p>
          {customError && (
            <div className="p-2 mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
              {customError}
            </div>
          )}
          <div className="flex gap-2">
            {/* Create is the PRIMARY and holds focus (decision 3): this confirm
                is not destructive, and the keyboard flow it exists to serve is
                type → Enter → Enter. */}
            <NeonButton
              ref={confirmPrimaryRef}
              onClick={() => void runCreate(customStage.value, false)}
              disabled={creating}
            >
              Create
            </NeonButton>
            <NeonButton secondary onClick={backToInput} disabled={creating}>
              Back
            </NeonButton>
          </div>
        </>
      )}

      {customStage.kind === "confirm-exists" && firstMatch && (
        <>
          <p className="text-sm mb-1">{existsSentence}</p>
          {otherMatchCount > 0 && (
            <p className="text-xs text-gray-500 mb-2">
              {otherMatchCount === 1
                ? "1 other place also has it."
                : `${otherMatchCount} other places also have it.`}
            </p>
          )}
          <p className="text-xs text-gray-500 mb-3">
            Going to it keeps one row. Creating it here makes a second.
          </p>
          {customError && (
            <div className="p-2 mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
              {customError}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <NeonButton
              ref={confirmPrimaryRef}
              onClick={() => handleDrillToMatch(firstMatch)}
              disabled={creating}
            >
              Go to it
            </NeonButton>
            {/* Decision 5: kept, but secondary and explicit — duplicating a
                name across parents is sometimes right, and never a default. */}
            <NeonButton
              secondary
              onClick={() => void runCreate(customStage.value, true)}
              disabled={creating}
            >
              Create here anyway
            </NeonButton>
            <NeonButton cancel onClick={backToInput} disabled={creating}>
              Back
            </NeonButton>
          </div>
        </>
      )}
    </div>
  );

  // NEO-211 (plan C). Deliberately a PILL, not a NeonButton: a full-size
  // green/blue button next to Sync would read as a second primary action and
  // compete for the thumb in the mobile card-show workflow this column already
  // has to survive. Amber reuses CardAttentionBadge's already-contrast-checked
  // palette for the same reason it does — this is an unanswered question, not a
  // destructive or confirmed state, and green and pink are both spoken for.
  //
  // Rendered only when the query has RESOLVED to a non-empty list: no ghost
  // "0 suggestions" flash while loading, and no dialog that opens with nothing
  // in it (the `needsSyncReview` precedent). Visible text is the bare count so
  // Maestro can assert or tap on "1 suggestion" with no id lookup.
  const suggestionsPill =
    suggestions && suggestions.length > 0 ? (
      <button
        type="button"
        ref={suggestionsBtnRef}
        onClick={() => {
          setSuggestionOutcome(null);
          setShowSuggestions(true);
        }}
        aria-label={`${suggestions.length} naming suggestion${
          suggestions.length === 1 ? "" : "s"
        } from marketplaces — review`}
        className="text-xs px-2.5 py-1 rounded-full border border-amber-700 dark:border-amber-400/70 bg-amber-400/15 text-amber-800 dark:text-amber-300 focus:outline-none focus:ring-2 focus:ring-[#00B7FF]"
      >
        {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
      </button>
    ) : null;

  const idleButtons = (onSync: () => void) => (
    <div className="flex gap-2 items-center flex-wrap">
      <NeonButton onClick={onSync}>{addButtonText}</NeonButton>
      {/* After Sync, before "+ Custom", so `extraActions` ("Group Parallels")
          still sits last. */}
      {suggestionsPill}
      {level && (
        <NeonButton
          secondary
          onClick={() => {
            // Always open on a clean form: a stage left over from a previous
            // visit would put the operator straight into a confirm for a value
            // they no longer see.
            setCustomError(null);
            setCustomStage({ kind: "input" });
            pendingCreateEnterRef.current = false;
            setMode("custom");
          }}
          aria-label={`Add custom ${addButtonText.replace(/^Sync /, "")}`}
        >
          + Custom
        </NeonButton>
      )}
      {extraActions}
    </div>
  );

  // NEO-47 new path: loading/error derived from the reactive selectorSyncStatus
  // (no FE sync mode → no onDone handoff to drop). Sync button = forced re-sync
  // via the backend door; "+ Custom" still opens the custom form.
  const newPathContent = () => {
    // The custom-entry form is an explicit, in-progress user action: once the
    // operator has opened "+ Custom" and started typing, a BACKGROUND re-sync
    // (syncStatus flipping to "syncing" — e.g. a concurrent writer churning the
    // shared selectorOptions catalog, or an auto re-fetch) must NOT swap their
    // form out for the "Fetching from marketplaces…" panel: doing so unmounts
    // the <input> mid-edit, discarding whatever they'd typed. So the custom form
    // takes precedence over the syncing panel. (Previously the syncing check
    // came first; it silently destroyed a half-typed custom value for real
    // users, and surfaced as a "stale element reference" crash for the E2E
    // drill util creating a per-worker custom Sport under CI's 8-shard
    // concurrency, where these background re-syncs fire constantly.)
    if (mode === "custom") return customForm;
    // Same freeze-on-interaction philosophy the legacy path already applies to
    // auto-sync (see the effect above), extended to this rendering branch: the
    // selectorSyncStatus row for a no-parentId aggregator level (Sport) is a
    // SINGLE GLOBAL record shared by every concurrent session — so one admin (or
    // an E2E worker) running a real marketplace "Sync Sports" flips it to
    // "syncing" for EVERYONE. Once THIS session has already engaged an
    // already-populated column (scroll/pointerdown/keydown flips hasInteracted —
    // e.g. it's mid-interaction, about to click "+ Custom"), a concurrent/
    // background sync must NOT evict its idle buttons back to the panel and
    // swallow that interaction. selfRequestedSync carves out the one case we DO
    // still want the panel: the operator clicking "Sync <X>" themselves.
    // A never-touched column mid-INITIAL sync keeps the panel (hasInteracted is
    // still false — the interaction effect no-ops until the first sync lands).
    if (syncStatus?.status === "syncing" && (!hasInteracted || selfRequestedSync)) {
      return (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-4">
            {syncingLabel ?? `Syncing ${addButtonText.replace(/^Sync /, "")}`}
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            Fetching from marketplaces…
          </p>
        </div>
      );
    }
    const forceSync = () => {
      if (!level) return;
      // Mark this as a sync THIS session explicitly asked for, so the panel
      // above still shows even though the click also set hasInteracted true.
      setSelfRequestedSync(true);
      void ensureOptions({ level, parentId, force: true });
    };
    return (
      <>
        {syncStatus?.status === "error" && (
          <div className="p-3 mb-1 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
            {syncStatus.message || "Couldn't sync options."}
          </div>
        )}
        {/* NEO-211 (plans B + D). `message` is the partial-failure case: one
            side failed but the other stored, so the sync is "done" and NOT an
            error — yet the operator still has to know a marketplace was not
            reached, or they will read the column as complete. It is a fixed
            server-composed string, rendered verbatim and never rebuilt here.
            Either half can arrive without the other, so both share one box and
            one Dismiss. */}
        {noticeVisible && (
          <SyncDoneNotice
            message={doneMessage}
            notices={buildUnlinkedNotices(doneUnlinked, level, {
              totalsBySide: unlinkedTotals,
            })}
            dismissing={dismissingNotice}
            onDismiss={handleDismissNotice}
          />
        )}
        {idleButtons(forceSync)}
      </>
    );
  };

  return (
    <div
      ref={containerRef}
      // a11y: -1 keeps it out of the tab order while still being a valid
      // programmatic focus target for the park above.
      tabIndex={-1}
      className="min-w-[260px] max-w-[340px] flex-shrink-0 flex flex-col gap-4 focus:outline-none"
    >
      {selector}
      {useEnsureSync
        ? newPathContent()
        : mode === "sync"
          ? renderForm(handleFormDone)
          : mode === "custom"
            ? customForm
            : idleButtons(() => setMode("sync"))}

      {/* Non-blocking: the dialog has already closed, the rows are still live-
          queried, and a stale/clashed decision is something to look at again,
          not something to acknowledge. */}
      {suggestionOutcome && (
        <p className="text-xs text-gray-400" role="status">
          {suggestionOutcome}
        </p>
      )}

      {showSuggestions && suggestions && (
        <SelectorSyncReviewModal
          isOpen
          level={level}
          parentId={parentId}
          columnLabel={levelLabelPlural(level)}
          suggestions={suggestions}
          saving={applyingSuggestions}
          restoreFocusRef={suggestionsBtnRef}
          onClose={() => setShowSuggestions(false)}
          onConfirm={(result) => void handleApplySuggestions(result.decisions)}
        />
      )}

      {toast && (
        // SetAttributesPanel's pattern verbatim (NEO-47): fixed in the viewport,
        // because a background sync can land while this column is scrolled well
        // off-screen and an in-flow banner would announce to nobody.
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 border border-amber-400/60 rounded text-xs text-amber-300 shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
