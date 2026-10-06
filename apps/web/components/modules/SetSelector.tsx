/* eslint-disable react-hooks/refs --
 * NEO-111: all 21 reports in this file trace to ONE deliberate construct —
 * `stableVariantTypeFlagsRef` (~L99-136), a render-phase cache that holds the
 * last known-good variant-type flags while `selectedVariantType` is briefly
 * `undefined` (its useQuery in flight). The other 20 reports are just the rule
 * following those three derived values to their consumers.
 *
 * It is load-bearing, not sloppiness: without it a mid-flight `undefined`
 * re-evaluates `isBaseVariantTypeSelected`, which unmounts <CardChecklist> and
 * takes an in-progress Add Card form with it — the NEO-36 failure this cache was
 * added to prevent. The comment above the ref spells that out.
 *
 * Do NOT "fix" this by reaching for useMemo. The requirement is "remember the
 * last DEFINED value across an undefined", which is inherently stateful, and a
 * memo cannot see its own previous result: the moment `selectedVariantType`
 * flips to undefined a memo keyed on it recomputes to false and you are back to
 * the unmount. Moving the write into an effect is worse still — the flags would
 * lag a render, so the frame where the query resolves renders the stale value
 * and you introduce a flicker that does not exist today.
 *
 * The one alternative that preserves the semantics is useState plus the
 * documented adjust-state-during-render pattern, because state does carry the
 * previous value. It costs an extra render pass per change and would trip
 * react-hooks/set-state-in-render, so it mostly trades this disable for another
 * one. This construct is fit for its purpose; the rule is flagging a category,
 * not a demonstrated defect. (The mutation is idempotent in its inputs, so
 * StrictMode's double render and a discarded-and-retried concurrent render both
 * land on the same result. The real theoretical hazard is interleaved
 * concurrent lanes carrying different selectedVariantTypeId values, which
 * nothing in this app currently creates.)
 *
 * The lever that would actually retire this cache is not the ref — it is the
 * coupling that makes a transient undefined collapse an id which controls
 * MOUNTING, when the only real harm is that an in-progress draft dies with the
 * unmount. Written up in NEO-112, deliberately low priority: this screen has
 * months of clean production history with no reported bugs here, so that is a
 * record to reach for IF a symptom shows up, not scheduled work.
 *
 * To exercise this screen locally, sign in THROUGH the seeding page —
 * /testing/sign-in?redirect=/testing/seed-credentials?redirect=/set-selector
 * — the same chain .maestro/flows/profile/worker-bootstrap.yaml uses. Going
 * straight to /set-selector only ever lands on the credential gate.
 */
import type { GenericId } from "convex/values";
import {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { slotEntries, slotIds, slotLabel } from "../../convex/platformSlots";
import type { Id } from "../../convex/_generated/dataModel";
import type { SourceChips } from "../SetSelector/ChecklistSourceFilter";
import { isBaseRole } from "../SetSelector/baseRole";
import { variantTypeRole } from "../../convex/variantRole";
import { bscSourceView } from "../../convex/bscFacets";
import { isEditableTarget } from "../../lib/dom/is-editable-target";

import SportSelector from "../SetSelector/SportSelector";
import YearSelector from "../SetSelector/YearSelector";
import ManufacturerSelector from "../SetSelector/ManufacturerSelector";
import {
  isAllBrandsView,
  type ManufacturerSelection,
} from "../SetSelector/all-brands-view";
import { useDrillUrlState } from "../SetSelector/useDrillUrlState";
import SetSelectorComponent from "../SetSelector/SetSelector";
import SetVariantSelector from "../SetSelector/SetVariantSelector";
import VariantSelector from "../SetSelector/VariantSelector";
import ParallelSelector from "../SetSelector/ParallelSelector";

import { SportForm } from "../SetSelector/SportForm";
import YearForm from "../SetSelector/YearForm";
import ManufacturerForm from "../SetSelector/ManufacturerForm";
import SetForm from "../SetSelector/SetForm";
import SetVariantForm from "../SetSelector/SetVariantForm";
import VariantForm from "../SetSelector/VariantForm";
import ParallelForm from "../SetSelector/ParallelForm";

// NEO-83: ResilientEntityColumn wraps EntityColumn with a stalled-read backstop
// (auto re-subscribe + Retry) so a column never hangs forever on "Loading…".
import ResilientEntityColumn from "../SetSelector/ResilientEntityColumn";
import CardChecklist from "../SetSelector/CardChecklist";
import ParallelBuildPanel, {
  buildButtonLabel,
  useHostedParallelBuildRun,
  type ParallelBuildRole,
} from "../SetSelector/ParallelBuildPanel";
import BaseMappingForm from "../SetSelector/BaseMappingForm";
import BaseParallelsBuildSection, {
  BASE_PARALLELS_REASON_ID,
  useBaseParallelsPlan,
} from "../SetSelector/BaseParallelsBuildSection";
import ParallelGroupingModal from "../SetSelector/ParallelGroupingModal";
import MultiSourcePanel from "../SetSelector/MultiSourcePanel";
import SetAttributesPanel from "../SetSelector/SetAttributesPanel";
import type { SelectorLevel } from "../SetSelector/selector-sync-feedback";
import NeonButton from "./NeonButton";

/**
 * The empty dismissal set (see `dismissedVariantTypeIds`).
 *
 * Shared rather than freshly allocated so clearing an already-empty set is
 * identity-equal to the current state and React bails out of the re-render —
 * every level change calls `clearFrom`, and most of them have nothing to clear.
 */
const NO_BASE_MAPPING_DISMISSALS: ReadonlySet<GenericId<"selectorOptions">> =
  new Set();

/**
 * NEO-224 copy, signed off by Jason.
 *
 * `TRUNCATED_LINK_NOTICE` is the visible one-liner after a link named rows
 * that are not there. `RESOLVING_LINK_LABEL` is heard, not seen: the page's
 * status line and the placeholder card's name while a link is checked.
 */
const TRUNCATED_LINK_NOTICE =
  "That link's trail went cold partway, so we opened it as far as it goes.";
const RESOLVING_LINK_LABEL = "Rewinding the tape to your set…";

/**
 * True when the cascade may move focus: nothing else holds it (`<body>`), or
 * the operator is already inside the column row and not typing into one of
 * its fields. Never while a dialog is up — a modal owns focus even in the
 * frame before it has taken it.
 */
function cascadeOwnsFocus(row: HTMLElement): boolean {
  if (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], dialog[open]',
    )
  ) {
    return false;
  }
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return row.contains(active) && !isTypingInRowField(active);
}

/**
 * NEO-224 — true when `el` is a field the operator types into that is NOT a
 * column's own search box: the "+ Custom" entry input, or any other text
 * input, textarea, select or contenteditable in the column row.
 *
 * Both cascade effects stand down there. The D3 rule waits on the DOM across
 * renders, so its target can land while the operator is mid-word in the
 * custom entry; moving focus then would drop the rest of the typing on
 * "Fetch from Marketplaces", and the Enter that was meant to add the entry
 * would start a marketplace fetch instead.
 *
 * A column's `role="combobox"` is the exception, and the cascade's own
 * contract: every combobox in the row IS a column's search box (see
 * `focusAdjacentColumn` in EntitySelector), and focus in one is exactly what
 * hands on to the next column after a pick.
 */
function isTypingInRowField(el: Element): boolean {
  if (el.getAttribute("role") === "combobox") return false;
  return isEditableTarget(el) || el.tagName === "SELECT";
}

/**
 * A column's collapsed card: the `aria-expanded="false"` button that stands
 * in for a column's list once it has a selection ("Sports: Baseball —
 * change"). Escape and Collapse put focus there on purpose, so the cascade
 * focus effect leaves it alone.
 */
function isCollapsedCard(row: HTMLElement, el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    row.contains(el) &&
    el.tagName === "BUTTON" &&
    el.getAttribute("aria-expanded") === "false"
  );
}

/**
 * True when no part of `el` is inside the viewport. A zero-size box (never
 * laid out) is not "outside": there is nothing to scroll to.
 */
function isWhollyOutsideViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  );
}

type TerminalFocusTarget =
  | { kind: "fetch" }
  | { kind: "attributes" }
  /** A leaf parallel's empty checklist: "Build from <insert>". */
  | { kind: "build"; label: string };

/**
 * The D3 landing spots, found by the accessible names their owners give
 * them. Keep in step with CardChecklist's empty-state fetch button
 * (`aria-label="Sync card checklist"`, visible "Fetch from Marketplaces"),
 * ParallelBuildButton (no aria-label, so its visible text IS its name:
 * `buildButtonLabel`, imported rather than spelled, so the two cannot drift)
 * and SetAttributesPanel's toggle ("Edit attributes" / "Hide attributes"
 * inside the "Set attributes panel" region). With no cards there is exactly
 * one "Sync card checklist" button on the page, and exactly one "Build from
 * …": the header's copies render only once the checklist has cards.
 */
function findTerminalFocusTarget(
  page: HTMLElement,
  row: HTMLElement,
  target: TerminalFocusTarget,
): HTMLElement | null {
  if (target.kind === "fetch") {
    const button = page.querySelector<HTMLButtonElement>(
      'button[aria-label="Sync card checklist"]',
    );
    return button && !button.disabled ? button : null;
  }
  if (target.kind === "build") {
    // Matched on the accessible name, and never inside the column row: a row
    // is an option, not this button, whatever it happens to be called.
    const button = Array.from(
      page.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (el) =>
        !row.contains(el) &&
        !el.disabled &&
        (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() ===
          target.label,
    );
    return button ?? null;
  }
  return page.querySelector<HTMLElement>(
    '[role="region"][aria-label="Set attributes panel"] button[aria-label="Edit attributes"], ' +
      '[role="region"][aria-label="Set attributes panel"] button[aria-label="Hide attributes"]',
  );
}

export default function SetSelector() {
  // NEO-224: the drill lives in the URL (`?sport=…&year=…&brand=…&set=…
  // &type=…&insert=…&parallel=…`), so a reload, a shared link and Back all
  // land on the same spot. The hook owns the trusted-id gate in front of the
  // column queries and every write; this component reads the selection and
  // calls the hook's handlers. Expanded/collapsed state, the base-mapping
  // dismissal and the dialogs stay local below.
  const drill = useDrillUrlState();
  const {
    select: drillSelect,
    selectSetUnder: drillSelectSetUnder,
    drillTo,
    clearFrom: drillClearFrom,
    moveSet: drillMoveSet,
  } = drill;
  const {
    // Level 1: Sport
    sportId: selectedSportId,
    // Level 2: Year
    yearId: selectedYearId,
    // Level 3: Manufacturer (SL only) — a row, or the All Brands VIEW
    // (NEO-237, D17): the pinned entry at the top of the column that lists
    // every set in the year. The view is a client sentinel, never a row id,
    // so anything below that needs a ROW reads `selectedManufacturerRowId`.
    manufacturer: selectedManufacturerId,
    // Level 4: Set (BSC only)
    setId: selectedSetId,
    // Level 5: Variant Type (BSC only)
    variantTypeId: selectedVariantTypeId,
    // Level 6: Variant (reconciled BSC + SL)
    insertId: selectedVariantId,
    // Level 7: Variant of Variant (NB only)
    parallelId: selectedVariantOfVariantId,
  } = drill.selection;
  const inAllBrandsView = isAllBrandsView(selectedManufacturerId);
  const selectedManufacturerRowId: GenericId<"selectorOptions"> | null =
    inAllBrandsView ? null : selectedManufacturerId;

  const [sportExpanded, setSportExpanded] = useState(false);
  const [yearExpanded, setYearExpanded] = useState(false);
  const [manufacturerExpanded, setManufacturerExpanded] = useState(false);
  const [setExpanded, setSetExpanded] = useState(false);
  const [variantTypeExpanded, setVariantTypeExpanded] = useState(false);
  const [variantExpanded, setVariantExpanded] = useState(false);
  const [variantOfVariantExpanded, setVariantOfVariantExpanded] =
    useState(false);

  /**
   * Base variantTypes whose mapping panel the operator has CLOSED (NEO-255).
   *
   * `baseHasMapping` counts the SportLots slot only, so on a Base that carries
   * a BSC id and no SportLots one it is false forever. Close used to clear
   * `baseMappingOpen` alone, which that row was never gated on — the panel
   * re-rendered instantly and the button read as broken. The dismissal is what
   * makes Close honest. It is per-row and deliberately NOT persisted: it says
   * "not right now", not "never", and it is cleared whenever the variant-type
   * selection changes so re-selecting Base prompts again.
   */
  const [dismissedVariantTypeIds, setDismissedVariantTypeIds] = useState<
    ReadonlySet<GenericId<"selectorOptions">>
  >(NO_BASE_MAPPING_DISMISSALS);

  // A change at the variant-type level or above re-arms the Base auto-prompt
  // (the dismissal is about the row the operator was looking at). Local state,
  // so it rides alongside a handler's one URL write rather than inside it —
  // in a transition, because the router commits that write in one: React
  // gives every transition started in the same event the same lane, so the
  // reset lands in the navigation's commit instead of rendering a frame of
  // the OLD selection ahead of it (NEO-224).
  const resetBaseMappingDismissals = useCallback(
    () =>
      startTransition(() =>
        setDismissedVariantTypeIds(NO_BASE_MAPPING_DISMISSALS),
      ),
    [],
  );

  // Base is a terminal variantType: when selected, the cascade stops
  // there and the CardChecklist attaches to the variantType row itself
  // (no Variant / Variant-of-Variant columns). Read the row for its NB base
  // role (NEO-239: `metadata.isBase`, never the display value) and to drive
  // the auto-mapping prompt.
  const selectedVariantType = useQuery(
    api.selectorOptions.getSelectorOptionById,
    selectedVariantTypeId ? { id: selectedVariantTypeId } : "skip",
  );
  // Stabilize the derived booleans across transient `useQuery` undefined
  // returns. Convex reactive queries can briefly return undefined during
  // refetches triggered by mutations on the watched row — including
  // cross-worker mutations in parallel test runs, or any background
  // re-write by a different tab in real-user traffic. Without this cache,
  // isBaseVariantTypeSelected and baseHasMapping flip to false during the
  // refetch window, which collapses cardChecklistId below to null and
  // unmounts <CardChecklist> — taking the in-progress Add Card form with
  // it (resets showAddForm + typed input). The cache invalidates only on
  // selectedVariantTypeId change, so real user navigation still
  // re-evaluates correctly.
  const stableVariantTypeFlagsRef = useRef<{
    forId: GenericId<"selectorOptions"> | null;
    isBase: boolean;
    /** NEO-321: the row's NB role is `parallel` — the base set's parallels live under it. */
    isParallelType: boolean;
    hasMapping: boolean;
    value: string;
  }>({
    forId: null,
    isBase: false,
    isParallelType: false,
    hasMapping: false,
    value: "",
  });
  if (stableVariantTypeFlagsRef.current.forId !== selectedVariantTypeId) {
    stableVariantTypeFlagsRef.current = {
      forId: selectedVariantTypeId,
      isBase: false,
      isParallelType: false,
      hasMapping: false,
      value: "",
    };
  }
  if (selectedVariantType !== undefined) {
    stableVariantTypeFlagsRef.current.isBase = isBaseRole(
      selectedVariantType?.metadata,
    );
    // NEO-321: read through the one role rule (`metadata.variantRole`),
    // never the row's name — a variant type an operator called "Parallel" is
    // just a row called "Parallel".
    stableVariantTypeFlagsRef.current.isParallelType =
      variantTypeRole(selectedVariantType) === "parallel";
    // Auto-prompt is gated on the SportLots mapping specifically. The BSC
    // slug on the row is auto-populated by "Sync Variant Types" (BSC's
    // variant facet returns "Base" with a slug), so testing it would
    // suppress the auto-prompt on every freshly-synced Base. Only the
    // SportLots value is exclusively written by BaseSetPicker, so its
    // presence is the reliable "user has mapped this Base" signal.
    //
    // NEO-137: count SLOTS, never truthiness. `platformData.sportlots` used to
    // be a string, where `!!` was a correct emptiness test. It is a Record now,
    // and `!!{}` is ALWAYS true — so a row carrying an empty-but-present
    // sportlots map (every side that has been attached and then fully detached,
    // since only `pruneEmptySides` removes the key) would report itself mapped.
    // The user would get the "Re-map Base" button instead of the auto-opening
    // picker, with no way to reach the picker except that button — the mapping
    // silently looks done when nothing is attached. Same class as the
    // typeof-string / Array.isArray narrowings this ticket replaced elsewhere:
    // type-legal against a Record, and wrong.
    stableVariantTypeFlagsRef.current.hasMapping = selectedVariantType
      ? slotIds(selectedVariantType, "sportlots").length > 0
      : false;
    stableVariantTypeFlagsRef.current.value = selectedVariantType?.value ?? "";
  }
  const isBaseVariantTypeSelected = stableVariantTypeFlagsRef.current.isBase;
  const isParallelTypeSelected =
    stableVariantTypeFlagsRef.current.isParallelType;
  const baseHasMapping = stableVariantTypeFlagsRef.current.hasMapping;
  // Pluralized variantType label ("Insert" → "Inserts") used as the column
  // header and Sync button text on the Variants column. Falls back to the
  // generic "Variants" while the variantType row is still loading or when
  // no variantType is selected.
  const variantTypeLabel = stableVariantTypeFlagsRef.current.value;
  const variantsColumnLabel = variantTypeLabel
    ? variantTypeLabel.endsWith("s")
      ? variantTypeLabel
      : `${variantTypeLabel}s`
    : "Variants";
  /**
   * NEO-260 (a11y) — the cascade opening a new column has to be SAID.
   *
   * Choosing a sport reveals the Years column and scrolls it into view, and
   * that is the whole feedback: a sighted operator sees a card slide in, a
   * screen-reader user gets nothing at all. (Since NEO-224 focus also moves
   * into the new column's search box — see the cascade focus effect below —
   * but a focus change says where you are, not that a column appeared.)
   *
   * The announcement is DERIVED, never stored. `role="status"` announces on a
   * content CHANGE, and this string changes only when the deepest revealed
   * column changes — so a re-render for any other reason writes the identical
   * text, React skips the DOM write, and nothing is announced. That is the
   * whole anti-chatter mechanism; no effect, no timer, no dedupe state.
   *
   * Only the DEEPEST column is named. Selecting one row can reveal at most one
   * column, and naming the whole open chain on every step would read the
   * cascade back to the user from the top each time.
   *
   * The labels are the column headings verbatim, because that is what the
   * operator will hear when they arrow into it.
   */
  const revealedColumns: string[] = ["Sports"];
  if (selectedSportId) revealedColumns.push("Years");
  if (selectedYearId) revealedColumns.push("Manufacturers");
  // NEO-237: the All Brands VIEW opens the Sets column too — it is a
  // selection in the Manufacturers column even though it is not a row — so
  // it is announced like any other reveal.
  if (selectedManufacturerId) revealedColumns.push("Sets");
  if (selectedSetId) revealedColumns.push("Variant Types");
  if (!isBaseVariantTypeSelected && selectedVariantTypeId)
    revealedColumns.push(variantsColumnLabel);
  if (!isBaseVariantTypeSelected && selectedVariantId)
    revealedColumns.push("Parallels");
  const deepestColumn = revealedColumns[revealedColumns.length - 1];

  /**
   * NEO-224 — the deepest column that is OPEN: on screen and showing its list
   * (no selection yet, or re-expanded by the operator) rather than its
   * collapsed card. Keyed by level and parent, so a new parent is a new
   * column even at the same level. `null` when every column on screen has
   * collapsed onto its selection — the terminal case (Base, or a parallel).
   *
   * Mirrors the `isVisible` gates the columns below are rendered with.
   */
  const cascadeColumns: ReadonlyArray<{
    level: SelectorLevel;
    parentId: string | null;
    visible: boolean;
    selected: boolean;
    expanded: boolean;
  }> = [
    {
      level: "sport",
      parentId: null,
      visible: true,
      selected: !!selectedSportId,
      expanded: sportExpanded,
    },
    {
      level: "year",
      parentId: selectedSportId,
      visible: !!selectedSportId,
      selected: !!selectedYearId,
      expanded: yearExpanded,
    },
    {
      level: "manufacturer",
      parentId: selectedYearId,
      visible: !!selectedYearId,
      selected: !!selectedManufacturerId,
      expanded: manufacturerExpanded,
    },
    {
      level: "setName",
      parentId: inAllBrandsView ? selectedYearId : selectedManufacturerRowId,
      visible: !!selectedManufacturerId,
      selected: !!selectedSetId,
      expanded: setExpanded,
    },
    {
      level: "variantType",
      parentId: selectedSetId,
      visible: !!selectedSetId,
      selected: !!selectedVariantTypeId,
      expanded: variantTypeExpanded,
    },
    {
      level: "insert",
      parentId: selectedVariantTypeId,
      visible: !isBaseVariantTypeSelected && !!selectedVariantTypeId,
      selected: !!selectedVariantId,
      expanded: variantExpanded,
    },
    {
      level: "parallel",
      parentId: selectedVariantId,
      visible: !isBaseVariantTypeSelected && !!selectedVariantId,
      selected: !!selectedVariantOfVariantId,
      expanded: variantOfVariantExpanded,
    },
  ];
  const deepestOpenColumn = [...cascadeColumns]
    .reverse()
    .find((column) => column.visible && (!column.selected || column.expanded));
  const openColumnKey = drill.resolving
    ? null
    : deepestOpenColumn
      ? `${deepestOpenColumn.level}:${deepestOpenColumn.parentId ?? ""}`
      : null;
  /**
   * The selection itself, as one string. The terminal focus rule below fires
   * on a SELECTION that leaves no column open, and this is what tells a
   * selection apart from a collapse: collapsing a chip changes which columns
   * are open but never the selection.
   */
  const selectionKey = [
    selectedSportId,
    selectedYearId,
    selectedManufacturerId,
    selectedSetId,
    selectedVariantTypeId,
    selectedVariantId,
    selectedVariantOfVariantId,
  ].join("/");

  // Manual trigger; the form also auto-opens on first selection when no
  // platformData exists yet.
  const [baseMappingOpen, setBaseMappingOpen] = useState(false);
  const baseMappingDismissed = selectedVariantTypeId
    ? dismissedVariantTypeIds.has(selectedVariantTypeId)
    : false;
  /**
   * `remap` is a claim that a mapping EXISTS and is about to be re-pointed, so
   * it follows the row, not the button that opened the dialog. A Base the
   * operator dismissed and then re-opened is still a first-time mapping —
   * keying this off `baseMappingOpen` (as it did before NEO-255) would show it
   * the "N cards are linked" impact copy for a mapping it does not have.
   */
  const baseMappingMode: "initial" | "remap" = baseHasMapping
    ? "remap"
    : "initial";
  /**
   * The panel and the button below are mutually exclusive, and exactly one of
   * them is always on screen for a selected Base: an unmapped row auto-prompts
   * until it is dismissed, and every other state offers the way back in.
   */
  const baseMappingFormOpen =
    (!baseHasMapping && !baseMappingDismissed) || baseMappingOpen;
  // Only a DISMISSAL (Close on the recovery panel) stops the auto-prompt. A
  // confirmed mapping closes the form too, but the row's own slot is what
  // ends the prompt there — `baseHasMapping` flips as the write lands — and
  // marking it dismissed as well would race that flip: the seed's "Re-map
  // Base" anchor read "Map Base Set" for a beat and scrolled past it (PR #242
  // run 4).
  const handleBaseMappingClose = (reason: "mapped" | "dismissed") => {
    baseMappingClosedForRef.current = selectedVariantTypeId;
    setBaseMappingOpen(false);
    if (reason === "dismissed" && selectedVariantTypeId && !baseHasMapping) {
      setDismissedVariantTypeIds((prev) => {
        if (prev.has(selectedVariantTypeId)) return prev;
        const next = new Set(prev);
        next.add(selectedVariantTypeId);
        return next;
      });
    }
  };
  // WCAG 2.4.3 focus park. Close lives INSIDE BaseMappingForm, and pressing it
  // runs `handleBaseMappingClose` synchronously — so React unmounts the form
  // (the clicked button with it) and mounts the sibling button in its place in
  // the same render pass, dropping keyboard/AT focus to <body> with nothing
  // said about where the operator now is. The button that replaced the panel is
  // the only control in that slot, so it is the unambiguous landing spot.
  //
  // The same shape as VariantForm/ParallelForm/SyncDoneNotice: a ref tracks the
  // PREVIOUS value so this fires on the true→false transition only, and the
  // `activeElement === body` guard means a park never yanks focus away from an
  // operator who is already holding it somewhere else (a confirm that resolves
  // while they have moved on, or a dialog that restored focus itself).
  //
  // NEO-224: `baseMappingFormOpen` is DERIVED, so it also flips true→false with
  // nothing closed at all: while a newly picked Base row is still loading it
  // reads as unmapped (the flags ref resets on the id change), and the moment
  // a MAPPED row answers the value drops to false. Focus is on <body> then too
  // (the Variant Types search box just unmounted), so reacting to the flip
  // alone parked focus on "Re-map Base" on every mapped Base, the D3 terminal
  // rule saw focus outside the row and stood down, and the operator's next
  // Enter opened the re-map picker. So the park fires only after a real close:
  // every close path (Close, Cancel's recovery panel, a confirmed pick) goes
  // through `handleBaseMappingClose`, which records the row it closed. A
  // confirmed first-time mapping keeps the form up until the row's slot lands,
  // so the record waits for that flip; it is spent on the first flip either
  // way, and a record for a different row (the operator moved on) parks
  // nothing.
  const baseMappingButtonRef = useRef<HTMLButtonElement | null>(null);
  const baseMappingClosedForRef = useRef<GenericId<"selectorOptions"> | null>(
    null,
  );
  const wasBaseMappingFormOpen = useRef(baseMappingFormOpen);
  useEffect(() => {
    const wasOpen = wasBaseMappingFormOpen.current;
    wasBaseMappingFormOpen.current = baseMappingFormOpen;
    if (!wasOpen || baseMappingFormOpen) return;
    const closedFor = baseMappingClosedForRef.current;
    baseMappingClosedForRef.current = null;
    if (closedFor === null || closedFor !== selectedVariantTypeId) return;
    if (document.activeElement !== document.body) return;
    baseMappingButtonRef.current?.focus();
  }, [baseMappingFormOpen, selectedVariantTypeId]);
  // Parallel-grouping modal trigger for the Variants column.
  const [groupingOpen, setGroupingOpen] = useState(false);

  // NEO-224: each pick is ONE push to the URL — the level and everything it
  // clears below it in a single write, so Back undoes exactly that pick.
  // Re-picking the row that is already selected is a no-op in the hook: it
  // closes the list and leaves the drill below it alone.
  const handleSportSelect = (id: GenericId<"selectorOptions">) => {
    drillSelect("sport", id);
    if (id !== selectedSportId) resetBaseMappingDismissals();
  };
  const handleYearSelect = (id: GenericId<"selectorOptions">) => {
    drillSelect("year", id);
    if (id !== selectedYearId) resetBaseMappingDismissals();
  };
  const handleManufacturerSelect = (id: ManufacturerSelection) => {
    drillSelect("manufacturer", id);
    if (id !== selectedManufacturerId) resetBaseMappingDismissals();
  };
  /**
   * NEO-237 (D17): a set picked in the All Brands view BACK-FILLS the
   * Manufacturers column from the set's own parent, so the cascade below it
   * (variant types, the attributes panel's breadcrumb, every fetch that reads
   * the manufacturer ancestor) sees the row the set actually lives under. The
   * view was a lens for finding the set; once found, the set's brand is the
   * selection. Both writes land in one render, so the operator sees the
   * collapsed Manufacturers card change to the brand at the moment the set
   * is chosen.
   *
   * NEO-224: brand and set are one URL write, so the address bar never holds
   * `brand=all` with a set under it.
   */
  const handleSetSelect = (
    id: GenericId<"selectorOptions">,
    parentId?: GenericId<"selectorOptions">,
  ) => {
    if (inAllBrandsView && parentId) drillSelectSetUnder(parentId, id);
    else drillSelect("setName", id);
    if (id !== selectedSetId) resetBaseMappingDismissals();
  };
  // Stable across re-renders (NEO-85): fed as onSelect into the memoized Variant
  // Types column via SetVariantSelector, so a bare parent re-render doesn't churn
  // the list under Maestro's coordinate taps.
  const handleVariantTypeSelect = useCallback(
    (id: GenericId<"selectorOptions">) => {
      drillSelect("variantType", id);
      // Selecting a variant type re-arms the auto-open prompt (NEO-255):
      // closing the panel is a decision about the row the operator was
      // looking at, and tapping a row — including tapping Base again — asks
      // the question afresh. Local state only: re-picking the selected row
      // makes no URL write and clears nothing below it (NEO-224).
      resetBaseMappingDismissals();
    },
    [drillSelect, resetBaseMappingDismissals],
  );
  const handleVariantSelect = (id: GenericId<"selectorOptions">) => {
    drillSelect("insert", id);
  };
  const handleVariantOfVariantSelect = (id: GenericId<"selectorOptions">) => {
    drillSelect("parallel", id);
  };

  // NEO-219: the column row is the focus parking spot after a row the operator
  // was standing on disappears (a sanctioned delete unmounts the panel that
  // held focus, and the browser would otherwise drop it to <body>, restarting a
  // keyboard user at the top of the document).
  const columnRowRef = useRef<HTMLDivElement | null>(null);

  // NEO-219: the row the attributes panel was editing has been deleted
  // server-side. Drop the selection from that level down so nothing downstream
  // is still querying a row that no longer exists.
  //
  // NEO-224: a `replace`, not a push — the row is gone, so Back must not walk
  // the operator onto it again.
  const handleRowDeleted = (level: SelectorLevel) => {
    drillClearFrom(level);
    resetBaseMappingDismissals();
    columnRowRef.current?.focus();
  };

  /**
   * NEO-294: the set the attributes panel was describing now lives under a
   * DIFFERENT brand. The Sets column is scoped to `selectedManufacturerRowId`
   * — the brand the set just left — so without this the row vanishes out of
   * an open column while everything below it (variant types, the checklist,
   * the panel itself) carries on working, because those key on the set's id
   * and a re-parent does not change it. A toast saying "Moved to Choice" and
   * a column that quietly no longer lists the set is the operator being told
   * two different things.
   *
   * So the column FOLLOWS the set rather than losing it: re-point the
   * Manufacturers column at the destination and the Sets column re-queries
   * under it with the moved row still selected. This is the same move
   * `handleSetSelect` already makes when a set is picked in the All Brands
   * view — the selection follows the set to its real parent — and it is the
   * one that keeps the evidence on screen: the brand card changes to the
   * destination and the set is sitting under it.
   *
   * Deliberately NOT `handleManufacturerSelect`, which `clearFrom(4)`s the
   * set and everything below it. Nothing was deleted here; there is nothing
   * to clear. Focus is left alone for the same reason — the control that did
   * this survives the move and has already parked focus on itself.
   *
   * NEO-224: a `replace` — the operator did not navigate, the set moved.
   */
  const handleSetMoved = (brandId: GenericId<"selectorOptions">) => {
    drillMoveSet(brandId);
  };

  /**
   * NEO-219: drill the whole cascade onto a row that lives under a DIFFERENT
   * parent, offered when the custom-entry form finds the typed value elsewhere.
   *
   * The steps are replayed in order the way the level handlers would be —
   * each sets its level and clears everything below it — but folded into ONE
   * URL push (NEO-224), so the operator sees the final selection rather than
   * a cascade animating through intermediate states, and Back undoes the
   * whole jump.
   */
  const handleDrillToExisting = (
    path: Array<{ _id: GenericId<"selectorOptions">; level: SelectorLevel }>,
  ) => {
    drillTo(path, "push");
    resetBaseMappingDismissals();
  };

  /**
   * NEO-305: the row the attributes panel was describing changed shape — a
   * set became a parallel of another set ("Make parallel of…", and the set is
   * gone), or a parallel's SportLots set became a set of its own ("Promote to
   * set"). The panel hands over where the result now lives, set first, and
   * the cascade DRILLS there: the operator sees the row they made, under the
   * set it now belongs to, rather than a column that silently lost one. Same
   * move as the custom form's "go to existing". The control that did it
   * unmounts with the old selection, so focus parks on the column row, as it
   * does after a delete.
   *
   * NEO-224: a `replace` — the row the URL named changed shape under it.
   */
  const handleRowReshaped = (
    path: Array<{ _id: GenericId<"selectorOptions">; level: SelectorLevel }>,
  ) => {
    drillTo(path, "replace");
    resetBaseMappingDismissals();
    columnRowRef.current?.focus();
  };

  // CardChecklist attaches to the deepest selected node — for Base
  // variantTypes that's the variantType row itself (Base is terminal).
  const cardChecklistId =
    selectedVariantOfVariantId ||
    selectedVariantId ||
    (isBaseVariantTypeSelected ? selectedVariantTypeId : null);

  // NEO-38/NEO-71-74: the deepest currently-selected node at ANY level
  // (sport → parallel). Drives SetAttributesPanel so the attributes editor
  // follows the selection all the way down and never vanishes when a
  // variant (e.g. "Base") is active.
  //
  // History: this used to start at setName-or-deeper only. The original
  // NEO-38 regression was specifically about the panel being EXPANDED at
  // sport/year/manufacturer during drill-down, which pushed the selector
  // columns down and hid the next column's target ("2026 not visible").
  // The panel always renders collapsed by default (`defaultCollapsed`
  // below) regardless of level, and expansion only ever happens via an
  // explicit "Edit attributes" tap — never automatically during a drill —
  // so extending to shallower levels does not reintroduce that failure
  // mode. Verified against the exact regression scenario (util-drill-to-
  // custom.yaml / custom-entry-survives-resync.yaml) before shipping this.
  //
  // NEO-237: the All Brands VIEW is not a row, so with the view open and
  // nothing picked beneath it the deepest ROW is the year.
  const deepestSelectedId =
    selectedVariantOfVariantId ||
    selectedVariantId ||
    selectedVariantTypeId ||
    selectedSetId ||
    selectedManufacturerRowId ||
    selectedYearId ||
    selectedSportId ||
    null;

  // NEO-6: read the cardChecklist row here (once) and derive the source-
  // set chip data + per-card label maps. Previously this lived inside
  // CardChecklist, but the two useMemos sat below an `if (!cards) return`
  // early return — a Rules-of-Hooks violation that crashed the page with
  // React error #310 after the variantType chip was tapped. Lifting them
  // to the parent puts these hooks alongside the other unconditional
  // top-level hooks. Convex deduplicates same-arg queries, so the Base
  // case (cardChecklistId === selectedVariantTypeId) does not refetch.
  const cardChecklistRow = useQuery(
    api.selectorOptions.getSelectorOptionById,
    cardChecklistId ? { id: cardChecklistId } : "skip",
  );
  // NEO-239: the BSC half of the source filter is the same list of SOURCES the
  // attach panel shows, so the chain the fetch buckets on is read here too.
  // Convex dedupes it against MultiSourcePanel's identical query whenever both
  // are mounted.
  const cardChecklistChain = useQuery(
    api.selectorOptions.getAncestorChain,
    cardChecklistId ? { id: cardChecklistId } : "skip",
  );
  const sourceChips: SourceChips = useMemo(() => {
    if (!cardChecklistRow) return {};
    const out: SourceChips = {};
    for (const side of ["bsc", "sportlots"] as const) {
      // NEO-137: chips are keyed by SLOT, matching what cards store in
      // platformData.<side>.src. Keying them by marketplace id would not
      // survive a row holding the same set in two slots, and would not match
      // what the per-card filter compares against.
      //
      // NEO-239: on the BSC side the list is the row's SOURCES, not its slots.
      // A `variant` slug scopes the query — no card is ever attributed to it —
      // so a chip for it filtered the checklist down to nothing, and on a Base
      // row it was the chip that looked most like the obvious one to press.
      // SportLots has one unit of attachment and no facets, so it keeps the
      // plain slot walk.
      const entries =
        side === "bsc"
          ? bscSourceView(
              cardChecklistRow,
              cardChecklistChain ?? [cardChecklistRow],
            ).sources.map((s) => ({ slot: s.slot, id: s.id }))
          : slotEntries(cardChecklistRow, side);
      if (entries.length <= 1) continue;
      const primarySlotKey =
        cardChecklistRow.primaryPlatformId?.[side] ?? entries[0].slot;
      out[side] = {
        primaryId: primarySlotKey,
        chips: entries.map((e) => ({
          id: e.slot,
          label: slotLabel(cardChecklistRow, side, e.slot),
        })),
      };
    }
    return out;
  }, [cardChecklistRow, cardChecklistChain]);
  // Slot -> display label, for the per-card source badge. Falls back to the
  // marketplace id via slotLabel when a slot carries no label.
  const sourceLabelMaps = useMemo(() => {
    const build = (side: "bsc" | "sportlots"): Record<string, string> => {
      if (!cardChecklistRow) return {};
      const out: Record<string, string> = {};
      for (const { slot } of slotEntries(cardChecklistRow, side)) {
        out[slot] = slotLabel(cardChecklistRow, side, slot);
      }
      return out;
    };
    return { bsc: build("bsc"), sportlots: build("sportlots") };
  }, [cardChecklistRow]);

  /**
   * NEO-312 — which half of a source → parallel pair the open checklist is.
   *
   * Read off the cascade's own selections and NB roles, never off a name or a
   * marketplace value: a checklist on the Variants column's row is an insert,
   * and one on the column below it is a parallel of that insert. The insert's
   * name is the parallel button's label ("Build from Anime"), taken from the
   * chain this component already reads for the checklist row — the insert is
   * that row's parent, so it is in the chain by construction, and matched by
   * id. Until the chain loads it is undefined and the button waits.
   *
   * NEO-321 (D3) — a row on the Variants column under a variant type whose
   * role is `parallel` is a parallel of the BASE set, not an insert: its Sync
   * slot builds from Base ("Build from Base") instead of fetching, and its
   * save builds nothing beneath it. Base's id and name are the server's
   * answer (`source` on the same list the Base-parallels section shows), so
   * the label and the build can never disagree about which row is Base.
   */
  /**
   * NEO-312 (hobby A10) — the runner that builds an insert's parallels after
   * its checklist is saved, hosted HERE rather than in the checklist. The
   * operator keeps working while a run goes — into a parallel it just built,
   * up to another variant type, across to a sibling insert — and several of
   * those moves unmount the checklist outright. The set builder outlives all
   * of them, so the run does too; the checklist is handed the runner, and
   * whenever no checklist is open this component shows the panel itself.
   */
  const parallelRun = useHostedParallelBuildRun();

  /**
   * NEO-321 — the base set's parallels and their source (Base), listed from
   * the selected Parallel variant type. Live only while that type is
   * selected; shared by the section and a base parallel's own button.
   */
  const baseParallelsPlan = useBaseParallelsPlan(
    isParallelTypeSelected ? selectedVariantTypeId : null,
  );
  const baseSource = baseParallelsPlan?.source ?? undefined;

  const parallelBuild: ParallelBuildRole | undefined = useMemo(() => {
    if (isBaseVariantTypeSelected || !selectedVariantId) return undefined;
    if (selectedVariantOfVariantId) {
      return {
        role: "parallel",
        sourceId: selectedVariantId,
        sourceValue: cardChecklistChain?.find(
          (c) => c._id === selectedVariantId,
        )?.value,
      };
    }
    if (isParallelTypeSelected) {
      return {
        role: "parallel",
        sourceId: baseSource?.id,
        sourceValue: baseSource?.value,
        // Loaded and still no Base: the section above says why, and the
        // row's stand-in button points at that sentence.
        ...(baseParallelsPlan && !baseSource
          ? { unavailableReasonId: BASE_PARALLELS_REASON_ID }
          : {}),
      };
    }
    return { role: "insert" };
  }, [
    isBaseVariantTypeSelected,
    isParallelTypeSelected,
    selectedVariantId,
    selectedVariantOfVariantId,
    cardChecklistChain,
    baseSource,
    baseParallelsPlan,
  ]);

  /**
   * NEO-321 — the run on screen is the one the Base-parallels section
   * started, and that section is showing: it draws the ledger, so neither the
   * checklist nor the stand-in below draws a second (one panel per page keeps
   * its heading and line ids unique).
   */
  const baseSectionShowsRun =
    isParallelTypeSelected &&
    !!selectedVariantTypeId &&
    parallelRun.run?.startedFrom === selectedVariantTypeId;

  /**
   * NEO-224 — where focus goes after the cascade moves, decided HERE rather
   * than in each column: a column cannot see that a pick in it opened the
   * next one.
   *
   * After every selection change, restore (deep link, reload) and popstate,
   * the deepest open column's search box takes focus, so a keyboard operator
   * types the next pick straight away: type, Enter, type, Enter, down to the
   * set. Keyed on that column, so a re-render that opens nothing new moves
   * nothing.
   *
   * Only ever moves focus the cascade already owns — `<body>` (the row the
   * operator picked just unmounted) or somewhere inside the column row — and
   * never off a column's collapsed card, which is where Escape and Collapse
   * deliberately put it. Never out of a dialog or the checklist. Every column
   * renders exactly one `role="combobox"` (EntitySelector's contract), even
   * while loading, so the last one in the row is the deepest open column's.
   * `preventScroll` because EntityColumn owns the row's horizontal scroll and
   * reveals each new column itself.
   */
  /**
   * NEO-224 — the truncation notice, attached to where focus lands. The page
   * status line says it too, but that announcement lands in the same moment
   * focus moves into the deepest combobox, and a screen reader is free to let
   * the focus announcement swallow it. As the box's description it is read
   * with the box itself.
   *
   * Written on the DOM rather than passed down: the combobox is three
   * components below this one, and only the cascade knows which column is the
   * deepest (the same reason the focus effect below lives here). EntitySelector
   * never passes `aria-describedby` to its box, so React never touches the
   * attribute and cannot overwrite it. Declared BEFORE the focus effect so the
   * description is in place when focus arrives. Removed with the notice.
   */
  const truncatedNoticeId = useId();
  const truncatedOnLoad = drill.truncatedOnLoad;
  useEffect(() => {
    if (!truncatedOnLoad || openColumnKey === null) return;
    const boxes =
      columnRowRef.current?.querySelectorAll<HTMLElement>('[role="combobox"]');
    const box = boxes?.[boxes.length - 1];
    if (!box) return;
    box.setAttribute("aria-describedby", truncatedNoticeId);
    return () => {
      if (box.getAttribute("aria-describedby") === truncatedNoticeId) {
        box.removeAttribute("aria-describedby");
      }
    };
  }, [truncatedOnLoad, openColumnKey, truncatedNoticeId]);

  useEffect(() => {
    if (openColumnKey === null) return;
    const row = columnRowRef.current;
    if (!row || !cascadeOwnsFocus(row)) return;
    if (isCollapsedCard(row, document.activeElement)) return;
    const boxes = row.querySelectorAll<HTMLElement>('[role="combobox"]');
    boxes[boxes.length - 1]?.focus({ preventScroll: true });
  }, [openColumnKey]);

  /**
   * NEO-224 (Jason, D3) — a selection that leaves NO column open (Base, or a
   * parallel) has nothing left to type into, so focus goes to what comes
   * next: the checklist's "Fetch from Marketplaces" button while the
   * checklist has no cards yet, otherwise the attributes panel's toggle.
   *
   * The card count comes from the same subscription CardChecklist holds
   * (identical reference and args, deduped by the Convex client), so it costs
   * no second read. A leaf parallel's empty checklist carries "Build from
   * <insert>" in that slot instead of a fetch, and that button is what comes
   * next there (Jason, 2026-10-04). While the insert's name is still loading
   * the button is a "Loading…" stand-in, so the rule waits for the name; a
   * parallel with no source to build from falls back to the attributes panel.
   *
   * When the selection was made from the keyboard (Enter in a column; see
   * `keyboardCommitRef`) and the target sits wholly outside the viewport, it
   * is scrolled into view as well: a keyboard operator has no other way to
   * see where they landed. A pointer pick keeps `preventScroll`.
   *
   * Fires once per selection: a collapse that happens to leave nothing open
   * is not a selection, and cards arriving after a fetch are not a new
   * arrival. The target can land a few commits after the selection (the
   * checklist and the panel load their own rows), so it waits on the DOM for
   * it — and stands down the moment focus is somewhere the cascade does not
   * own, or a dialog (the Base mapping picker auto-opens on an unmapped Base)
   * is up.
   */
  const terminalChecklistId =
    !drill.resolving && openColumnKey === null ? cardChecklistId : null;
  const terminalCards = useQuery(
    api.selectorOptions.getCardChecklist,
    terminalChecklistId ? { selectorOptionId: terminalChecklistId } : "skip",
  );
  const buildSourceValue =
    parallelBuild?.role === "parallel" ? parallelBuild.sourceValue : undefined;
  // The source's name comes from the ancestor chain (an insert's parallel)
  // or the Base-parallels plan; until the chain has answered, the slot holds
  // the "Loading…" stand-in and there is no button to land on yet.
  const buildSourcePending =
    parallelBuild?.role === "parallel" &&
    !buildSourceValue &&
    !parallelBuild.unavailableReasonId &&
    cardChecklistChain === undefined;
  const terminalTargetKey: string | null =
    terminalChecklistId === null || terminalCards === undefined
      ? null
      : terminalCards.length > 0
        ? "attributes"
        : parallelBuild?.role !== "parallel"
          ? "fetch"
          : buildSourceValue
            ? `build:${buildButtonLabel(buildSourceValue, false)}`
            : buildSourcePending
              ? null
              : "attributes";
  // Rebuilt from the string so the effect below keys on a value, not on an
  // object that is new every render.
  const terminalTarget = useMemo<TerminalFocusTarget | null>(() => {
    if (terminalTargetKey === null) return null;
    if (terminalTargetKey.startsWith("build:")) {
      return { kind: "build", label: terminalTargetKey.slice("build:".length) };
    }
    return { kind: terminalTargetKey as "fetch" | "attributes" };
  }, [terminalTargetKey]);
  /**
   * True when the operator's last commit in the column row was Enter, false
   * once they press a pointer anywhere on the page. Read once per terminal
   * selection by the D3 rule above.
   */
  const keyboardCommitRef = useRef(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const terminalHandledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (terminalChecklistId === null) {
      // Leaving terminal by a new selection re-arms the rule; leaving it by
      // re-expanding a chip (same selection) does not, so collapsing that
      // chip again never fires it.
      if (terminalHandledForRef.current !== selectionKey) {
        terminalHandledForRef.current = null;
      }
      return;
    }
    if (terminalTarget === null) return;
    if (terminalHandledForRef.current === selectionKey) return;
    const page = pageRef.current;
    const row = columnRowRef.current;
    if (!page || !row) return;
    const handledFor = selectionKey;
    const fromKeyboard = keyboardCommitRef.current;
    // True once there is nothing left to do: focused, or stood down.
    const attempt = (): boolean => {
      if (!cascadeOwnsFocus(row)) return true;
      if (isCollapsedCard(row, document.activeElement)) return true;
      const target = findTerminalFocusTarget(page, row, terminalTarget);
      if (!target) return false;
      target.focus({ preventScroll: true });
      if (document.activeElement !== target) return false;
      if (fromKeyboard && isWhollyOutsideViewport(target)) {
        target.scrollIntoView({ block: "nearest" });
      }
      return true;
    };
    if (attempt()) {
      terminalHandledForRef.current = handledFor;
      return;
    }
    const observer = new MutationObserver(() => {
      if (!attempt()) return;
      terminalHandledForRef.current = handledFor;
      observer.disconnect();
    });
    observer.observe(page, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    return () => observer.disconnect();
  }, [terminalChecklistId, terminalTarget, selectionKey]);

  // Feeds `keyboardCommitRef`: Enter in a column's search box (or on one of
  // its options) is a keyboard commit; any pointer press on the page is not.
  const noteKeyboardCommit = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    const role = (event.target as HTMLElement).getAttribute?.("role");
    if (role === "combobox" || role === "option") {
      keyboardCommitRef.current = true;
    }
  };
  const notePointer = () => {
    keyboardCommitRef.current = false;
  };

  // NO SCROLL HEADROOM HERE, deliberately — the shell owns it now (NEO-260).
  //
  // This container used to be the one place in the app that had a bottom-pad
  // question: the collapsed SetAttributesPanel's "Edit attributes" control
  // parked at y=518 on the 625px headless document, 143px below the driver's
  // centre band, so every step that centred it burned the full give-up path.
  // That was never a set-builder problem — every page in the app bottomed out
  // with its primary action jammed against the fold. It is fixed once, for all
  // of them, by the 208px spacer in src/layouts/binder-layout.tsx, which this
  // page renders inside: 518 - 208 = 310, mid-band.
  //
  // So do NOT add padding-bottom back here. A second helping stacks on the
  // shell's and lifts targets ABOVE the band, which fails exactly as hard as
  // being below it. (NEO-255's pb-[50vh] — 313px, exactly one driver swipe —
  // is the other way to get this wrong; read the note in binder-layout.tsx.)
  return (
    <div
      ref={pageRef}
      onPointerDownCapture={notePointer}
      className="max-w-full mx-auto p-6 flex flex-col gap-6"
    >
      {/* `sr-only` is position:absolute, so this is NOT a flex item and costs
          the layout nothing — which matters here: every pixel above the
          cascade pushes fold-sensitive controls down on the 1024x629 headless
          viewport (NEO-47, NEO-155). The text is a full sentence Maestro's
          FULL-STRING text matching can never confuse with a bare column
          heading. While a deep link is still being checked it says so
          (`RESOLVING_LINK_LABEL`): nothing has opened yet, and the cascade is
          a single placeholder card.

          NEO-224: when the link this page was opened with had to be cut back,
          the same region says so first. It is the page's ONE always-mounted
          polite region, so the sentence is announced the moment the restore
          lands rather than depending on a region that mounts with it. */}
      <p className="sr-only" role="status">
        {drill.resolving
          ? RESOLVING_LINK_LABEL
          : `${drill.truncatedOnLoad ? `${TRUNCATED_LINK_NOTICE} ` : ""}${deepestColumn} column opened`}
      </p>
      {/* NEO-224 — the visible half of that notice: the link named rows that
          are not there (deleted, or not under the parent it said), so the
          drill was cut back to the part that is. One line, only when it
          happened, until the next pick. Not a live region itself — the
          status line above already speaks it — but the deepest combobox is
          described by it (`truncatedNoticeId`), so it is read with the box
          focus lands on. */}
      {drill.truncatedOnLoad && (
        <p
          id={truncatedNoticeId}
          className="text-sm text-amber-800 dark:text-amber-300"
        >
          {TRUNCATED_LINK_NOTICE}
        </p>
      )}
      {/* pb-4 prevents the horizontal scrollbar from overlapping each
          EntityColumn's action-button row (Sync X / + Custom). Without it,
          Maestro web taps at the action-button y-coordinate hit the
          scrollbar instead of the button — see PR #31 diagnosis.

          pl-4 keeps the leftmost column's "Sync <X>" button clear of the
          viewport's left edge. This page sits in a vw-based full-bleed wrapper
          that leaves the first column only ~6px of edge clearance; under a
          CLASSIC scrollbar (Linux/Windows, incl. CI headless Chrome) the
          full-bleed math over-pulls ~8px left, rendering "Sync Sports" at
          x=-2 (~98% visible). Maestro's scrollUntilVisible(visibility:100%)
          then can't tap it. Mac overlay scrollbars (0px) hide this locally —
          custom-entry-survives-resync 8/8 CI failure, NEO root-cause. */}
      <div
        ref={columnRowRef}
        // a11y: -1 keeps the row out of the tab order while leaving it a valid
        // programmatic focus target for `handleRowDeleted`'s focus park.
        tabIndex={-1}
        data-set-selector-scroll
        onKeyDownCapture={noteKeyboardCommit}
        className="flex flex-row gap-4 overflow-x-auto pb-4 pl-4 focus:outline-none"
      >
        {drill.resolving ? (
          // NEO-224 — a deep link is being checked. One column-shaped card,
          // the same treatment EntitySelector gives a column whose rows are
          // loading (one static bar, no pulse — NEO-85/NEO-167), so the
          // restore goes placeholder → restored columns with no flash of
          // Sports in between. No heading: flows read a column heading as
          // "that column is open", and none is yet.
          //
          // A named, busy group. The page status line above is what SPEAKS
          // the wait; a nested live region here would be a second one saying
          // the same thing, so the bar is decorative.
          <div
            role="group"
            aria-label={RESOLVING_LINK_LABEL}
            aria-busy="true"
            className="min-w-[260px] max-w-[340px] flex-shrink-0 bg-white dark:bg-gray-800 p-6 rounded-lg shadow"
          >
            <div
              aria-hidden="true"
              className="h-[50px] rounded-md border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700"
            />
          </div>
        ) : (
          <>
            {/* 1. Sport (SL & BSC) */}
            <ResilientEntityColumn
              selector={
                <SportSelector
                  selectedSportId={selectedSportId}
                  onSportSelect={handleSportSelect}
                  expanded={sportExpanded}
                  setExpanded={setSportExpanded}
                />
              }
              renderForm={(onDone) => <SportForm onDone={onDone} />}
              addButtonText="Sync Sports"
              isVisible={true}
              level="sport"
              onSelectExisting={handleSportSelect}
              onDrillToExisting={handleDrillToExisting}
              useEnsureSync
              syncingLabel="Syncing Sport Options"
            />

            {/* 2. Year (SL & BSC) */}
            <ResilientEntityColumn
              selector={
                <YearSelector
                  sportId={selectedSportId!}
                  selectedYearId={selectedYearId}
                  onYearSelect={handleYearSelect}
                  expanded={yearExpanded}
                  setExpanded={setYearExpanded}
                />
              }
              renderForm={(onDone) => (
                <YearForm sportId={selectedSportId!} onDone={onDone} />
              )}
              addButtonText="Sync Years"
              isVisible={!!selectedSportId}
              level="year"
              parentId={selectedSportId || undefined}
              onSelectExisting={handleYearSelect}
              onDrillToExisting={handleDrillToExisting}
              useEnsureSync
              syncingLabel="Syncing Year Options"
            />

            {/* 3. Manufacturer (SL only) */}
            <ResilientEntityColumn
              selector={
                <ManufacturerSelector
                  yearId={selectedYearId!}
                  selectedManufacturerId={selectedManufacturerId}
                  onManufacturerSelect={handleManufacturerSelect}
                  expanded={manufacturerExpanded}
                  setExpanded={setManufacturerExpanded}
                />
              }
              renderForm={(onDone) => (
                <ManufacturerForm yearId={selectedYearId!} onDone={onDone} />
              )}
              addButtonText="Sync Manufacturers"
              isVisible={!!selectedYearId}
              level="manufacturer"
              parentId={selectedYearId || undefined}
              onSelectExisting={handleManufacturerSelect}
              onDrillToExisting={handleDrillToExisting}
              useEnsureSync
              syncingLabel="Syncing Manufacturer Options"
            />

            {/* 4. Set (BSC only) — or, under the All Brands VIEW, every set in
                the year with its brand alongside (NEO-237, D14c/D17). In the view
                the column's parent is the YEAR: `ensureSelectorOptions` and the
                sync status row key on it, "+ Custom" is replaced by a line
                saying to pick a brand first (a view has no one parent to create
                under), and picking a set back-fills the Manufacturers column
                from the set's own parent. */}
            <ResilientEntityColumn
              selector={
                <SetSelectorComponent
                  manufacturerId={selectedManufacturerRowId}
                  yearId={selectedYearId!}
                  selectedSetId={selectedSetId}
                  onSetSelect={handleSetSelect}
                  expanded={setExpanded}
                  setExpanded={setSetExpanded}
                />
              }
              // Legacy path only; this column is on `useEnsureSync`, so the form
              // is never rendered and the view never reaches it.
              renderForm={(onDone) => (
                <SetForm
                  manufacturerId={selectedManufacturerRowId!}
                  onDone={onDone}
                />
              )}
              addButtonText="Sync Sets"
              isVisible={!!selectedManufacturerId}
              level="setName"
              parentId={
                inAllBrandsView
                  ? selectedYearId || undefined
                  : selectedManufacturerRowId || undefined
              }
              onSelectExisting={handleSetSelect}
              onDrillToExisting={handleDrillToExisting}
              useEnsureSync
              syncingLabel="Syncing Sets"
              hideCustom={
                inAllBrandsView ? { reason: "Pick a brand to add a set" } : undefined
              }
            />

            {/* 5. Variant Type (BSC only: Base, Insert, Parallel, Promo) */}
            <ResilientEntityColumn
              selector={
                <SetVariantSelector
                  setId={selectedSetId!}
                  selectedVariantTypeId={selectedVariantTypeId}
                  onVariantTypeSelect={handleVariantTypeSelect}
                  expanded={variantTypeExpanded}
                  setExpanded={setVariantTypeExpanded}
                />
              }
              renderForm={(onDone) => (
                <SetVariantForm setId={selectedSetId!} onDone={onDone} />
              )}
              addButtonText="Sync Variant Types"
              isVisible={!!selectedSetId}
              level="variantType"
              parentId={selectedSetId || undefined}
              onSelectExisting={handleVariantTypeSelect}
              onDrillToExisting={handleDrillToExisting}
              useEnsureSync
              syncingLabel="Syncing Variant Types"
            />

            {/* 6. Variant (reconciled BSC variantName + SL set list) — hidden
                when Base is selected (Base is terminal). */}
            {!isBaseVariantTypeSelected && (
              <ResilientEntityColumn
                selector={
                  // NEO-291: the "Metadata" box that used to sit under this
                  // column is gone. Insert/Parallel were hierarchy facts shown
                  // as disabled checkboxes, and the card prefix now lives in the
                  // Attributes panel beside every other per-row fact.
                  <VariantSelector
                    variantTypeId={selectedVariantTypeId!}
                    selectedVariantId={selectedVariantId}
                    onVariantSelect={handleVariantSelect}
                    expanded={variantExpanded}
                    setExpanded={setVariantExpanded}
                    title={variantsColumnLabel}
                  />
                }
                renderForm={(onDone) => (
                  <VariantForm
                    variantTypeId={selectedVariantTypeId!}
                    onDone={onDone}
                  />
                )}
                addButtonText={`Sync ${variantsColumnLabel}`}
                isVisible={!!selectedVariantTypeId}
                level="insert"
                parentId={selectedVariantTypeId || undefined}
                onSelectExisting={handleVariantSelect}
                onDrillToExisting={handleDrillToExisting}
                extraActions={
                  selectedVariantTypeId ? (
                    <NeonButton secondary onClick={() => setGroupingOpen(true)}>
                      Group Parallels
                    </NeonButton>
                  ) : undefined
                }
              />
            )}

            {/* 7. Variant of Variant (NB only — translates to variant on BSC/SL) */}
            {!isBaseVariantTypeSelected && selectedVariantId && (
              <ResilientEntityColumn
                selector={
                  <ParallelSelector
                    insertId={selectedVariantId!}
                    selectedParallelId={selectedVariantOfVariantId}
                    onParallelSelect={handleVariantOfVariantSelect}
                    expanded={variantOfVariantExpanded}
                    setExpanded={setVariantOfVariantExpanded}
                  />
                }
                renderForm={(onDone) => (
                  <ParallelForm insertId={selectedVariantId!} onDone={onDone} />
                )}
                addButtonText="Sync Sub-Variants"
                isVisible={true}
                level="parallel"
                parentId={selectedVariantId || undefined}
                onSelectExisting={handleVariantOfVariantSelect}
                onDrillToExisting={handleDrillToExisting}
              />
            )}
          </>
        )}
      </div>

      {/* Base mapping: auto-prompts BaseSetPicker the first time a Base
          variantType without platformData is selected, and hands back a
          button — "Map Base Set" while it is still unmapped, "Re-map Base"
          once it is — whenever the panel is not showing. */}
      {selectedVariantTypeId && isBaseVariantTypeSelected && (
        <>
          {baseMappingFormOpen && (
            <BaseMappingForm
              key={`${selectedVariantTypeId}-${baseMappingMode}`}
              variantTypeId={selectedVariantTypeId}
              autoOpen={true}
              // NEO-219: a RE-MAP is an existing mapping that already holds
              // cards being re-pointed — so the dialog states the impact and
              // the write is version-guarded. The `key` above gives the two
              // modes separate instances.
              mode={baseMappingMode}
              onClose={handleBaseMappingClose}
            />
          )}
          {!baseMappingFormOpen && (
            <div>
              {/* Unmapped is the state that still needs an answer, so its
                  button is the primary one; a re-map is optional and stays
                  the quieter secondary. */}
              <NeonButton
                ref={baseMappingButtonRef}
                secondary={baseHasMapping}
                onClick={() => setBaseMappingOpen(true)}
              >
                {baseHasMapping ? "Re-map Base" : "Map Base Set"}
              </NeonButton>
            </div>
          )}
        </>
      )}

      {/* NEO-321: the base set's parallels, built from Base in one go — only
          when the operator presses the button (D2). Shown for the variant
          type whose NB role is `parallel`, and kept while one of its rows is
          open, in the same variant-type slot Base's mapping button uses. */}
      {selectedVariantTypeId && isParallelTypeSelected && (
        <BaseParallelsBuildSection
          // A confirm or an error on one variant type says nothing about the next.
          key={selectedVariantTypeId}
          variantTypeId={selectedVariantTypeId}
          plan={baseParallelsPlan}
          runner={parallelRun}
          showsRun={baseSectionShowsRun}
        />
      )}

      {/* NEO-6: multi-source attach panel for the active variant row.
          Renders for variantType (when Base/terminal), insert, and
          parallel rows once they have a reconciliation primary mapped. */}
      {cardChecklistId && (
        <MultiSourcePanel selectorOptionId={cardChecklistId} />
      )}

      {/* NEO-38/NEO-71-74: set ATTRIBUTES editor. Mounts at the DEEPEST
          selected node at ANY level (sport → parallel) so it follows the
          selection down and never vanishes when a variant (e.g. "Base") is
          active — including at sport/year/manufacturer, where operators need
          to see the write-once auto-populated features (league/era/etc.)
          as they drill, not just at setName+. ALWAYS starts COLLAPSED (a
          slim summary bar): the original NEO-38 regression was specifically
          about the panel being EXPANDED during drill-down, which pushed the
          selector columns down and hid the year list (broke the cascade's
          Football → 2026 pre-warm). Expansion only ever happens via an
          explicit "Edit attributes" tap, never automatically during a
          drill, so the collapsed bar rendering at every level does not
          reintroduce that failure mode. */}
      {deepestSelectedId && (
        <SetAttributesPanel
          selectorOptionId={deepestSelectedId as Id<"selectorOptions">}
          defaultCollapsed={true}
          onDeleted={handleRowDeleted}
          onMoved={handleSetMoved}
          onReshaped={handleRowReshaped}
        />
      )}

      {/* Cards — full width below the selector row. `cardChecklistId`
          stays stable across transient query refetches because the
          `isBaseVariantTypeSelected` it depends on is cached via
          `stableVariantTypeFlagsRef` above. */}
      {cardChecklistId && (
        <CardChecklist
          variantId={cardChecklistId}
          sourceChips={sourceChips}
          sourceLabelMaps={sourceLabelMaps}
          // NEO-306: "Fill N missing teams" lives in the checklist header now
          // and fills the whole SET, so it needs the set's id — which only
          // this cascade holds.
          setId={selectedSetId ?? undefined}
          // NEO-312: an insert builds its parallels after a save; a parallel
          // builds from its insert instead of syncing.
          parallelBuild={parallelBuild}
          parallelRun={parallelRun}
          parallelPanelElsewhere={baseSectionShowsRun}
        />
      )}

      {/* NEO-312 — no checklist is open to show the run (the operator moved
          above the insert level mid-run, or came back after leaving), so the
          panel stands in the checklist's place: Stop stays in reach and the
          result stays readable. */}
      {!cardChecklistId && parallelRun.run && !baseSectionShowsRun && (
        <ParallelBuildPanel run={parallelRun.run} onStop={parallelRun.stop} />
      )}

      {/* Parallel-grouping modal — mounted at the page root so it overlays
          on top of the selector row regardless of horizontal scroll. */}
      {selectedVariantTypeId && !isBaseVariantTypeSelected && (
        <ParallelGroupingModal
          isOpen={groupingOpen}
          onClose={() => setGroupingOpen(false)}
          variantTypeId={selectedVariantTypeId}
        />
      )}
    </div>
  );
}
