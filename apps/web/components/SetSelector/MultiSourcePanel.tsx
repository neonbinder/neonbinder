import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import AttachSetsDialog from "./AttachSetsDialog";
import { slotEntries, slotFacet, slotLabel } from "../../convex/platformSlots";
import type { BscFacet } from "../../convex/bscFacets";
import { SIDE_LABEL, type SyncSide } from "./selector-sync-feedback";

/**
 * Per-row attached-sets panel (NEO-6 phase 1). Renders chip stacks for the
 * BSC and SL IDs attached to a variantType / insert / parallel row. Every
 * source is presented equally — see the note on the chip's <li> for why the
 * old "PRIMARY" badge was removed. Operator can:
 *   • Open the combined attach dialog to add more BSC/SL IDs.
 *   • Rename the label on any chip inline (Enter to save, Escape to cancel).
 *   • Remove any chip with the × button, which always asks first.
 *
 * ── EVERY DETACH ASKS, AND SAYS WHAT IT COSTS (NEO-219, part 1) ─────────────
 * There used to be two × buttons with two different contracts: the primary
 * chip's opened a confirm ("a later sync could re-add it"), the non-primary
 * chip's (labelled `Detach …`) detached on the first click. That asymmetry was
 * exactly backwards about what is at stake. `platformSlotSeq` is deliberately
 * never rewound (`convex/platformSlots.ts` detachSlot), so a detached slot key
 * is retired for good: every card whose `platformData.<side>.src` names it
 * becomes an orphaned ref, and re-attaching allocates a FRESH key that heals
 * none of them. The "primary" flag, by contrast, only records which slot the
 * reconciler refreshes — the cheap half. So the confirm now guards both, and
 * what it states is the number of CARDS the slot sourced, from
 * `getSlotCardCounts`, because that is the number the operator cannot get back.
 *
 * The count is also sent back as `acknowledgedCards`: if it moved between the
 * query and the click the server refuses with `DETACH_COUNT_CHANGED` and the
 * confirm stays open showing the new number, rather than silently detaching
 * against a figure the operator never saw.
 *
 * Keyboard model:
 *   Tab     — cycles between chip controls and the Attach button.
 *   Enter   — confirms rename when editing a label. In the detach confirm
 *             there is NO row-level Enter handler: Enter only ever fires the
 *             button that actually has focus, and focus opens on Cancel.
 *   Escape  — cancels label edit; closes the detach confirm and returns focus
 *             to the × that opened it; on the wrapping page, closes dialog.
 */
type Side = SyncSide;

/**
 * `getSlotCardCounts` — cards currently sourced from each slot, per side.
 * Annotated rather than inferred so this file states the shape it depends on.
 */
type SlotCardCounts = {
  bsc: Record<string, number>;
  sportlots: Record<string, number>;
  total: number;
};

/**
 * NEO-137: a chip is one SLOT, not one marketplace id. The same marketplace
 * set can legitimately occupy more than one slot, and detach/rename now key on
 * the slot because an id is no longer a unique handle on this row.
 */
type SlotChip = {
  slot: string;
  id: string;
  label: string;
  isPrimary: boolean;
  /**
   * NEO-189 — which BSC facet this slot's id filters on, when it has one.
   *
   * Shown because it changes what the row SOURCES, not as decoration: a slug
   * tagged `setName` pulls the whole set at this row's variant, a slug tagged
   * `variantName` pulls one named variant, and the two are indistinguishable
   * from the label. Absent on every slot attached before NEO-189 and on every
   * slot the reconciler writes — those are the untagged ones the fetch handles
   * by NB level, so "no tag" is a real, visible state rather than a gap.
   *
   * NEO-239 added a third: `variant`, the BSC axis a variantType row filters on
   * (what used to be re-derived from the row's DISPLAY VALUE, which is why
   * those rows could not be renamed). An untagged variantType row makes the BSC
   * side unresolvable and is skipped, so whether this tag is present is now the
   * difference between a row that fetches and one that does not — the operator
   * has to be able to see it.
   */
  facet?: BscFacet;
};

/** Detach options carried from the chip's confirm to the mutation. */
type DetachOptions = {
  confirmPrimary?: boolean;
  /** The count the operator was shown; the server refuses a stale one. */
  acknowledgedCards?: number;
};

/**
 * The server's `DETACH_COUNT_CHANGED` refusal, matched STRUCTURALLY rather
 * than with `instanceof ConvexError` — same reasoning as
 * RenameEntityControl.refusalMessage: a mocked or rethrown error in a test, or
 * a version skew in the convex client, must still surface the fresh count.
 * Returns the server's new count, or null when this is some other failure.
 */
function detachCountChanged(e: unknown): number | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, cards } = data as { code?: unknown; cards?: unknown };
  if (code !== "DETACH_COUNT_CHANGED") return null;
  return typeof cards === "number" ? cards : null;
}

/**
 * The confirm sentence. Exported for the unit tests and for anyone writing a
 * Maestro assertion against it — the card clause is the part flows match on.
 *
 * `count === undefined` is the pre-resolution state, not "zero": saying "No
 * cards" before the query lands would be a wrong answer rather than a pending
 * one, and it is the one answer that would make an operator click Confirm.
 */
export function detachConfirmSentence(
  side: Side,
  label: string,
  count: number | undefined,
  isPrimary: boolean,
): string {
  const sideLabel = SIDE_LABEL[side];
  const cards =
    count === undefined
      ? "Counting the cards fetched from it…"
      : count === 0
        ? "No cards were fetched from it."
        : count === 1
          ? `1 card was fetched from it; its ${sideLabel} link will be dropped.`
          : `${count} cards were fetched from it; their ${sideLabel} link will be dropped.`;
  // The primary chip is the one the reconciler owns, so it carries the extra
  // consequence — stated as a consequence, never as a rank.
  const resync = isPrimary ? " A later sync of this row could re-add it." : "";
  return `Detach ${sideLabel} "${label}"? ${cards}${resync}`;
}

export default function MultiSourcePanel({
  selectorOptionId,
}: {
  selectorOptionId: Id<"selectorOptions">;
}) {
  const row = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: selectorOptionId,
  });
  const chain = useQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  // One count query for the whole panel, not one per chip: the server tallies
  // `cardChecklist.by_selector_option` once and buckets by slot, so N chips
  // cost one read rather than N.
  const slotCounts: SlotCardCounts | undefined = useQuery(
    api.selectorOptions.getSlotCardCounts,
    { selectorOptionId },
  );
  const detach = useMutation(api.selectorOptions.detachPlatformId);
  const rename = useMutation(api.selectorOptions.renamePlatformLabel);

  const [dialogOpen, setDialogOpen] = useState(false);
  // A confirmed detach unmounts the chip that held focus. Nothing else takes
  // it, so the browser drops focus to <body> and a keyboard operator restarts
  // from the top of the document — the same park EntityColumn does for its
  // dismissable notice, aimed at the heading of the surface they were in.
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Memoize the derived props handed to AttachSetsDialog so they keep a stable
  // reference identity across re-renders driven by *unrelated* reactive
  // updates. AttachSetsDialog's candidate-load effect keys off these; a fresh
  // object/Set every render re-fired that effect and wiped the dialog's search
  // box mid-interaction (NEO-85 dropped-tap class). These hooks must precede
  // the early returns below so hook order stays unconditional (Rules of Hooks),
  // hence the `row?.`/guarded bodies for the not-yet-loaded case.
  const bscEntries = useMemo(
    () => (row ? slotEntries(row, "bsc") : []),
    [row],
  );
  const slEntries = useMemo(
    () => (row ? slotEntries(row, "sportlots") : []),
    [row],
  );
  const parentFilters = useMemo<Record<string, string>>(() => {
    const filters: Record<string, string> = {};
    if (!row || !chain) return filters;
    for (const ancestor of chain) {
      if (ancestor._id !== row._id) {
        filters[ancestor.level] = ancestor.value;
      }
    }
    return filters;
  }, [chain, row]);
  const alreadyAttached = useMemo(
    () => ({
      bsc: new Set(bscEntries.map((e) => e.id)),
      sportlots: new Set(slEntries.map((e) => e.id)),
    }),
    [bscEntries, slEntries],
  );

  if (!row || !chain) return null;
  if (
    row.level !== "variantType" &&
    row.level !== "insert" &&
    row.level !== "parallel"
  ) {
    return null;
  }

  // Falls back to the lowest-numbered slot, matching primarySlot() on the
  // backend, so the UI marks the same chip the reconciler treats as primary.
  const primaryBscSlot = row.primaryPlatformId?.bsc ?? bscEntries[0]?.slot;
  const primarySlSlot =
    row.primaryPlatformId?.sportlots ?? slEntries[0]?.slot;

  // `undefined` until the query resolves — a slot missing from a RESOLVED map
  // really is zero.
  const countFor = (side: Side, slot: string): number | undefined =>
    slotCounts ? (slotCounts[side]?.[slot] ?? 0) : undefined;

  const toChips = (
    entries: Array<{ slot: string; id: string }>,
    side: Side,
    primary: string | undefined,
  ): SlotChip[] =>
    entries.map((e) => ({
      slot: e.slot,
      id: e.id,
      label: slotLabel(row, side, e.slot),
      isPrimary: e.slot === primary,
      ...(slotFacet(row, side, e.slot)
        ? { facet: slotFacet(row, side, e.slot) }
        : {}),
    }));

  // NEO-239: no row is hidden here. A set either carries marketplace ids or
  // it does not, and both behave the same — an id can be attached to ANY row,
  // including one entered by hand and one whose ids were all detached
  // (NEO-71-74). The panel IS the affordance for attaching the first id, so
  // hiding it on the rows that have none was exactly backwards.

  const parkFocusOnHeading = () => headingRef.current?.focus();

  return (
    <div className="border border-gray-700 rounded-lg bg-gray-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3
            ref={headingRef}
            // a11y: -1 keeps the heading out of the tab order while still
            // being a valid programmatic focus target for the park above.
            tabIndex={-1}
            className="text-sm font-semibold text-gray-100 focus:outline-none"
          >
            Multi-source sets
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Cards fetched for this variant come from every attached BSC and
            SportLots set. Users can filter the checklist by source.
          </p>
        </div>
        <NeonButton
          secondary
          size="2"
          onClick={() => setDialogOpen(true)}
          aria-label="Attach more source sets"
        >
          Attach more…
        </NeonButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SideColumn
          side="bsc"
          chips={toChips(bscEntries, "bsc", primaryBscSlot)}
          countFor={(slot) => countFor("bsc", slot)}
          onDetach={(slot, opts) =>
            detach({
              selectorOptionId,
              side: "bsc",
              slot,
              confirmPrimary: opts?.confirmPrimary,
              acknowledgedCards: opts?.acknowledgedCards,
            })
          }
          onRename={(slot, label) =>
            rename({ selectorOptionId, side: "bsc", slot, label })
          }
          onDetached={parkFocusOnHeading}
        />
        <SideColumn
          side="sportlots"
          chips={toChips(slEntries, "sportlots", primarySlSlot)}
          countFor={(slot) => countFor("sportlots", slot)}
          onDetach={(slot, opts) =>
            detach({
              selectorOptionId,
              side: "sportlots",
              slot,
              confirmPrimary: opts?.confirmPrimary,
              acknowledgedCards: opts?.acknowledgedCards,
            })
          }
          onRename={(slot, label) =>
            rename({ selectorOptionId, side: "sportlots", slot, label })
          }
          onDetached={parkFocusOnHeading}
        />
      </div>

      {/* NEO-196: the dialog no longer takes `level` / `parentId`. Scoping the
          candidate pool to the row's own level under its own parent is what
          made a sibling set unreachable; the pools are now resolved
          server-side from `selectorOptionId`. `parentFilters` stays, but only
          as display text for the pane headings and the BSC breadcrumb. */}
      <AttachSetsDialog
        isOpen={dialogOpen}
        parentFilters={parentFilters}
        selectorOptionId={selectorOptionId}
        alreadyAttached={alreadyAttached}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

/**
 * What each BSC facet is CALLED in this panel.
 *
 * `variant` is BSC's own axis of Base / Insert / Parallel, which is NB's
 * variantType column, so it is named for the NB level the operator is looking
 * at rather than for BSC's word — the two "variant" facets would otherwise be
 * one indistinguishable label, and they source completely different things.
 */
const FACET_NOUN: Record<BscFacet, string> = {
  setName: "set",
  variantName: "variant",
  variant: "variant type",
};

function SideColumn({
  side,
  chips,
  countFor,
  onDetach,
  onRename,
  onDetached,
}: {
  side: Side;
  chips: SlotChip[];
  countFor: (slot: string) => number | undefined;
  onDetach: (slot: string, opts?: DetachOptions) => Promise<unknown>;
  onRename: (slot: string, label: string) => Promise<unknown>;
  onDetached: () => void;
}) {
  return (
    <div>
      <header className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
        {SIDE_LABEL[side]}
      </header>
      {chips.length === 0 ? (
        <div className="text-xs text-gray-500 italic">No sets attached.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {chips.map((chip) => (
            <Chip
              key={chip.slot}
              chip={chip}
              side={side}
              cardCount={countFor(chip.slot)}
              onDetach={onDetach}
              onRename={onRename}
              onDetached={onDetached}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

type ChipMode = "idle" | "editing" | "confirming";

function Chip({
  chip,
  side,
  cardCount,
  onDetach,
  onRename,
  onDetached,
}: {
  chip: SlotChip;
  side: Side;
  /** `undefined` while `getSlotCardCounts` is still in flight. */
  cardCount: number | undefined;
  onDetach: (slot: string, opts?: DetachOptions) => Promise<unknown>;
  onRename: (slot: string, label: string) => Promise<unknown>;
  onDetached: () => void;
}) {
  const [mode, setMode] = useState<ChipMode>("idle");
  const [draft, setDraft] = useState(chip.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The server's fresh count after a DETACH_COUNT_CHANGED refusal. It wins
  // over the (now known-stale) subscription value until the confirm closes.
  const [recount, setRecount] = useState<number | null>(null);

  const removeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Only a CANCELLED confirm returns focus to the ×. A confirmed one unmounts
  // this chip, and the panel parks focus on its heading instead.
  const returnFocusRef = useRef(false);
  const sentenceId = useId();

  const shownCount = recount ?? cardCount;
  const counting = shownCount === undefined;

  useEffect(() => {
    if (mode === "confirming") {
      // Focus opens on CANCEL, not Confirm — same contract as ConfirmDialog:
      // the reflexive first keystroke on a surface that just appeared must do
      // the safe thing (WCAG 3.3.4, Error Prevention).
      cancelRef.current?.focus();
      return;
    }
    if (mode === "idle" && returnFocusRef.current) {
      returnFocusRef.current = false;
      removeRef.current?.focus();
    }
  }, [mode]);

  const commitRename = async () => {
    if (busy) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === chip.label) {
      setMode("idle");
      setDraft(chip.label);
      return;
    }
    setBusy(true);
    try {
      await onRename(chip.slot, trimmed);
      setMode("idle");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closeConfirm = () => {
    if (busy) return;
    returnFocusRef.current = true;
    setRecount(null);
    setErr(null);
    setMode("idle");
  };

  const handleDetach = async () => {
    // aria-disabled, not `disabled`: a natively disabled button blurs to
    // <body> the moment it is disabled, ending the modality of this little
    // surface mid-round-trip. aria-disabled is enforced HERE, by this guard,
    // rather than by the browser.
    if (busy || counting) return;
    setBusy(true);
    setErr(null);
    try {
      await onDetach(chip.slot, {
        confirmPrimary: chip.isPrimary,
        acknowledgedCards: shownCount,
      });
      setRecount(null);
      setMode("idle");
      setBusy(false);
      onDetached();
    } catch (e) {
      const fresh = detachCountChanged(e);
      if (fresh !== null) {
        // Stay in the confirm with the number the server just proved is
        // current. Nothing was written.
        setRecount(fresh);
        setErr(
          `The card count changed while this was open; it now reads ${fresh}. Confirm again to detach.`,
        );
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  };

  if (mode === "confirming") {
    return (
      <li className="px-3 py-1.5 rounded border border-[#FF2EB3] bg-[#FF2EB3]/10">
        {/* role="group" + aria-labelledby: the sentence IS the name of this
            little decision surface, so focus landing on Cancel announces what
            is being decided. Not role="alert" — an alert fires once on mount
            and says nothing when the operator tabs back into it. */}
        <div
          role="group"
          aria-labelledby={sentenceId}
          className="flex flex-wrap items-center gap-2"
          onKeyDown={(e) => {
            // Escape only. Enter is deliberately NOT handled here: it must
            // fire the button that actually has focus (Cancel, on open) and
            // nothing else.
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeConfirm();
            }
          }}
        >
          <span
            id={sentenceId}
            className="flex-1 min-w-[12rem] text-sm text-gray-100"
          >
            {detachConfirmSentence(side, chip.label, shownCount, chip.isPrimary)}
          </span>
          <button
            type="button"
            onClick={handleDetach}
            aria-disabled={busy || counting || undefined}
            // The accessible name always STARTS with the visible label (WCAG
            // 2.5.3), so the pending/busy state is announced rather than
            // hidden behind a fixed label.
            aria-label={
              counting
                ? `Counting cards for ${chip.label}`
                : busy
                  ? `Detaching ${chip.label}`
                  : `Confirm detach ${chip.label}`
            }
            // py-1: text-xs's 1rem line-height + 0.25rem top/bottom padding
            // clears WCAG 2.5.8's 24px target-size minimum; px-1 alone left
            // this ~16px tall.
            className="text-xs font-semibold text-[#FF2EB3] hover:text-[#ff5cc0] focus:text-[#ff5cc0] focus:outline-none px-1 py-1 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            {counting ? "Counting cards…" : busy ? "Detaching…" : "Confirm"}
          </button>
          <button
            type="button"
            ref={cancelRef}
            onClick={closeConfirm}
            aria-disabled={busy || undefined}
            aria-label={`Cancel detach ${chip.label}`}
            className="text-xs text-gray-400 hover:text-gray-200 focus:text-gray-200 focus:outline-none px-1 py-1 aria-disabled:opacity-50"
          >
            Cancel
          </button>
          {err && (
            <span
              className="w-full text-[10px] text-[#FF2EB3]"
              role="alert"
            >
              {err}
            </span>
          )}
        </div>
      </li>
    );
  }

  return (
    // No "PRIMARY" badge, deliberately.
    //
    // `primaryPlatformId` is bookkeeping — it records which slot the RECONCILER
    // owns and refreshes, so operator-attached extras survive a re-sync. It says
    // nothing about the cards. Rendering it as "PRIMARY" invited the reading it
    // does not have: that this source is where the cards were released and the
    // others are secondary. For a set like 1996 Score DCAP, split across two BSC
    // sets, every source is equally primary and the badge was just wrong.
    //
    // The provenance concept the badge appeared to express is real but rarer
    // than 1-in-100 sets (2021 Score's last 20 cards were released in
    // Chronicles — primary there, secondary in Score). When it is modelled it
    // gets its own SECONDARY tag on the sources that carry it; silence means
    // primary, which is the overwhelming default.
    // items-start, and the name/slug wrap as a pair: the NAME is what the
    // operator reads, so it gets the full width and the slug drops to a second
    // line when they will not both fit. Previously both were `truncate`
    // siblings on one row, which clipped the name ("Dugout Collection Artist's
    // Proof…") while the slug — the part nobody reads — survived intact.
    <li className="flex items-start gap-2 px-3 py-1.5 rounded border border-gray-700 bg-gray-800">
      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
      {mode === "editing" ? (
        <Input
          bare
          type="text"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setMode("idle");
              setDraft(chip.label);
            }
          }}
          onBlur={commitRename}
          aria-label={`Edit label for ${chip.id}`}
          className="w-full min-w-0 px-2 py-0.5 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(chip.label);
            setMode("editing");
          }}
          aria-label={`Rename label for ${chip.id}`}
          className="min-w-0 text-left break-words text-sm text-gray-100 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
        >
          {chip.label}
        </button>
      )}
      <span className="text-[10px] text-gray-500 break-all" aria-hidden>
        {chip.id}
      </span>
      {chip.facet && (
        // Not a control — a read-only note on what this slot filters on. Grey,
        // so it cannot be mistaken for the green select/commit affordance.
        <span
          // gray-400, not gray-500: 10px uppercase at gray-500 is 3.0:1 here,
          // well under 4.5:1, and this tag is what separates a slot that
          // sources a whole set from one that sources a single variant.
          className="text-[10px] uppercase tracking-wide text-gray-400 shrink-0"
          aria-label={`${chip.label} is attached as a BSC ${FACET_NOUN[chip.facet]}`}
        >
          {FACET_NOUN[chip.facet]}
        </span>
      )}
      </div>
      {/* ONE × for every chip, primary or not — see the file header. */}
      <button
        type="button"
        ref={removeRef}
        onClick={() => setMode("confirming")}
        disabled={busy}
        aria-label={`Remove ${chip.label}`}
        // min-w-6/min-h-6 (24px): the bare "×" glyph plus px-1 alone rendered
        // an ~18x19px hit area, under WCAG 2.5.8's 24x24 target-size minimum.
        className="inline-flex items-center justify-center min-w-6 min-h-6 text-gray-400 hover:text-[#FF2E9A] focus:text-[#FF2E9A] focus:outline-none"
      >
        ×
      </button>
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </li>
  );
}
