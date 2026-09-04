import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import AttachSetsDialog from "./AttachSetsDialog";
import { slotEntries, slotFacet, slotLabel } from "../../convex/platformSlots";
import type { BscFacet } from "../../convex/bscFacets";

/**
 * Per-row attached-sets panel (NEO-6 phase 1). Renders chip stacks for the
 * BSC and SL IDs attached to a variantType / insert / parallel row. Every
 * source is presented equally — see the note on the chip's <li> for why the
 * old "PRIMARY" badge was removed. Operator can:
 *   • Open the combined attach dialog to add more BSC/SL IDs.
 *   • Rename the label on any chip inline (Enter to save, Escape to cancel).
 *   • Remove any chip with the × button. Removing the slot the reconciler
 *     owns still takes one extra confirm — it is the one a later sync could
 *     re-add — but that is phrased as a consequence, not as a rank.
 *
 * Keyboard model:
 *   Tab     — cycles between chip controls and the Attach button.
 *   Enter   — confirms rename when editing a label.
 *   Escape  — cancels label edit; on the wrapping page, closes dialog.
 */
type Side = "bsc" | "sportlots";

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
  const detach = useMutation(api.selectorOptions.detachPlatformId);
  const rename = useMutation(api.selectorOptions.renamePlatformLabel);

  const [dialogOpen, setDialogOpen] = useState(false);

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

  return (
    <div className="border border-gray-700 rounded-lg bg-gray-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">
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
          title="BSC"
          chips={toChips(bscEntries, "bsc", primaryBscSlot)}
          onDetach={(slot, opts) =>
            detach({
              selectorOptionId,
              side: "bsc",
              slot,
              confirmPrimary: opts?.confirmPrimary,
            })
          }
          onRename={(slot, label) =>
            rename({ selectorOptionId, side: "bsc", slot, label })
          }
        />
        <SideColumn
          title="SportLots"
          chips={toChips(slEntries, "sportlots", primarySlSlot)}
          onDetach={(slot, opts) =>
            detach({
              selectorOptionId,
              side: "sportlots",
              slot,
              confirmPrimary: opts?.confirmPrimary,
            })
          }
          onRename={(slot, label) =>
            rename({ selectorOptionId, side: "sportlots", slot, label })
          }
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
  title,
  chips,
  onDetach,
  onRename,
}: {
  title: string;
  chips: SlotChip[];
  onDetach: (
    slot: string,
    opts?: { confirmPrimary?: boolean },
  ) => Promise<unknown>;
  onRename: (slot: string, label: string) => Promise<unknown>;
}) {
  return (
    <div>
      <header className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
        {title}
      </header>
      {chips.length === 0 ? (
        <div className="text-xs text-gray-500 italic">No sets attached.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {chips.map((chip) => (
            <Chip
              key={chip.slot}
              chip={chip}
              onDetach={onDetach}
              onRename={onRename}
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
  onDetach,
  onRename,
}: {
  chip: SlotChip;
  onDetach: (
    slot: string,
    opts?: { confirmPrimary?: boolean },
  ) => Promise<unknown>;
  onRename: (slot: string, label: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<ChipMode>("idle");
  const [draft, setDraft] = useState(chip.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const handleDetach = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onDetach(chip.slot, { confirmPrimary: chip.isPrimary });
      setMode("idle");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (mode === "confirming") {
    return (
      <li
        className="flex items-center gap-2 px-3 py-1.5 rounded border border-[#FF2EB3] bg-[#FF2EB3]/10"
        role="alert"
      >
        <span className="flex-1 min-w-0 truncate text-sm text-gray-100">
          Remove “{chip.label}”? A later sync of this row could re-add it.
        </span>
        <button
          type="button"
          onClick={handleDetach}
          disabled={busy}
          aria-label={`Confirm remove ${chip.label}`}
          className="text-xs font-semibold text-[#FF2EB3] hover:text-[#ff5cc0] focus:text-[#ff5cc0] focus:outline-none px-1"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setMode("idle")}
          disabled={busy}
          aria-label={`Cancel remove ${chip.label}`}
          className="text-xs text-gray-400 hover:text-gray-200 focus:text-gray-200 focus:outline-none px-1"
        >
          Cancel
        </button>
        {err && (
          <span className="text-[10px] text-[#FF2EB3]" role="alert">
            {err}
          </span>
        )}
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
      {chip.isPrimary ? (
        <button
          type="button"
          onClick={() => setMode("confirming")}
          disabled={busy}
          aria-label={`Remove ${chip.label}`}
          className="text-gray-400 hover:text-[#FF2E9A] focus:text-[#FF2E9A] focus:outline-none px-1"
        >
          ×
        </button>
      ) : (
        <button
          type="button"
          onClick={handleDetach}
          disabled={busy}
          aria-label={`Detach ${chip.label}`}
          className="text-gray-400 hover:text-[#FF2E9A] focus:text-[#FF2E9A] focus:outline-none px-1"
        >
          ×
        </button>
      )}
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </li>
  );
}
