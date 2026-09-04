import { useEffect, useId, useMemo, useState } from "react";
import { TrashIcon } from "@heroicons/react/24/outline";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { slotIds, type SlotBearingRow } from "../../convex/platformSlots";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { FeatureValueControl } from "./FeatureValueControl";
import RenameEntityControl, { canRenameSelectorRow } from "./RenameEntityControl";
import {
  ALL_SIDES,
  joinLabels,
  LEVEL_SINGULAR,
  levelNoun,
  SIDE_LABEL,
  type SelectorLevel,
} from "./selector-sync-feedback";

/**
 * NEO-38 (PR B-2) — level-agnostic set ATTRIBUTES editor.
 *
 * Renamed/generalized from `SetFeaturesPanel`. Mounts at the deepest
 * selected node at ANY level (sport → parallel), not just setName, so
 * the panel never vanishes when a variant (e.g. "Base") is selected.
 *
 * Renders one row per applicable `EXPECTED_FEATURES` entry — persisted via
 * `setSelectorOptionFeature`, a single-row patch on THIS node only
 * (NEO-71-74: write-once feature snapshots). A row's `features` is already
 * the complete resolved value — computed once via copy-down at the node's
 * own creation — so this panel reads it directly, with no client-side
 * ancestor-chain merge.
 *
 * `releaseDate` / `block` / `totalCardCount` used to live in a separate
 * `setMetadata` object editable ONLY at the setName level (with every other
 * level showing a read-only "inherited from Set" display). That couldn't
 * represent a real case: a parallel/insert released LATER than its parent
 * set (e.g. a Panini Rewards-exclusive parallel with its own release date).
 * They're now plain features like everything else here — independently
 * editable at every set-side level, copied down at creation like the rest.
 *
 * Collapsible so it never pushes the card list off-screen. Collapsed shows
 * a single summary bar (breadcrumb + an "Edit attributes" toggle). Default
 * collapsed only when `defaultCollapsed` (cards present); expanded otherwise
 * so the setName-with-no-cards flow needs no extra tap.
 *
 * None of these fields are actually required — blank is a perfectly
 * acceptable, complete answer for most of them (not every card is
 * autographed, has a memorabilia relic, a known signer, etc). There is
 * deliberately no "missing"/required warning treatment anywhere in this
 * panel — every row renders identically whether filled in or blank.
 *
 * Save flow:
 *   1. User types a new value into a row.
 *   2. Blur / Enter triggers the mutation (patches this row only).
 *   3. Toast renders "Saved {label}".
 *
 * Clear flow (NEO-217): emptying a text row, or picking the "—" option in a
 * select, sends `value: ""`, which the server treats as "remove this key"
 * (never as a stored empty string). The toast then reads "Cleared {label}".
 * Blank is a complete answer for every field here, so being unable to get back
 * to blank was a hole, not a safeguard.
 */

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

/** Human-readable label per selectorOptions level (fixes QA #2). */
const LEVEL_LABEL: Record<Level, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

export default function SetAttributesPanel({
  selectorOptionId,
  defaultCollapsed,
  onDeleted,
}: {
  selectorOptionId: Id<"selectorOptions">;
  /** Start collapsed (cards present) so the panel doesn't push them off-screen. */
  defaultCollapsed?: boolean;
  /**
   * NEO-219 — the row this panel describes was just deleted, so the panel and
   * everything downstream of it is about to be pointing at nothing. The owner
   * (`SetSelector`) clears the selection from `level` down and parks focus on
   * the column, because only it knows where "stable" is; this panel cannot,
   * since it unmounts as part of the same update.
   */
  onDeleted?: (level: SelectorLevel) => void;
}) {
  const row = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: selectorOptionId,
  });
  const chain = useQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  const setSelectorOptionFeature = useMutation(
    api.selectorOptions.setSelectorOptionFeature,
  );

  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [toast, setToast] = useState<string | null>(null);

  // Re-evaluate the default whenever the source intent flips (cards
  // appear/disappear or the selected node changes). Without this, drilling
  // from a card-less set into a node with cards would keep the panel
  // expanded (pushing the list down) because state initializes once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-evaluates the collapse default when the source intent flips; useState only initialises once
    setExpanded(!defaultCollapsed);
  }, [defaultCollapsed, selectorOptionId]);

  // Derive the sport from the ancestor chain so we can drop features that
  // don't apply (e.g. "League" hidden for Pokemon).
  const ancestorSport = useMemo(() => {
    if (!chain) return undefined;
    return chain.find((c) => c.level === "sport")?.value;
  }, [chain]);

  const applicable = useMemo(() => {
    return EXPECTED_FEATURES.filter((f) => {
      if (f.hiddenAtLevels?.includes("set")) return false;
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true;
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport]);

  if (!row || !chain) return null;

  const leafLevel = row.level as Level;
  const features = row.features ?? {};

  // Toggle-pill features (checkbox + toggleOptions) render together in one
  // wrapping row instead of scattered through the 2-column grid at their
  // config-order position.
  const toggleFeatures = applicable.filter(
    (f) => f.inputType === "checkbox" || f.inputType === "toggleOptions",
  );
  const otherFeatures = applicable.filter(
    (f) => f.inputType !== "checkbox" && f.inputType !== "toggleOptions",
  );

  // Breadcrumb: "Attributes for {leaf} ({levelLabel}) — a › b › c".
  const breadcrumb = chain.map((c) => c.value).join(" › ");
  const headerTitle = `Attributes for ${row.value} (${LEVEL_LABEL[leafLevel]})`;

  /**
   * NEO-217 — an empty value CLEARS the attribute; it is not a no-op.
   *
   * This used to return early on `""`, which meant nothing set at this level
   * could ever be un-set: a League typed by mistake, or a Season that turned
   * out to belong to the parallel rather than the set, was permanent. The
   * server now removes the key entirely for `""` (never stores an empty
   * string — "attribute gone" has one spelling, absence), so the only thing
   * needed here is to stop swallowing the empty commit and to say which of
   * the two things happened.
   */
  const handleSaveFeature = async (
    key: string,
    label: string,
    value: string,
  ) => {
    const trimmed = value.trim();
    const clearing = trimmed.length === 0;
    // A clear of an already-absent key is the real no-op — `features[key]`
    // is undefined, and `"" === undefined` is false, so it needs saying.
    if (clearing ? features[key] === undefined : features[key] === trimmed) {
      return;
    }
    // Optimistic confirmation — the mutation is a single-row patch
    // (NEO-71-74), no propagation counts to report. "Saved {label}" is
    // unchanged (Maestro asserts it); "Cleared {label}" is the new string,
    // deliberately distinct so the toast never claims a value was stored.
    setToast(clearing ? `Cleared ${label}` : `Saved ${label}`);
    setTimeout(() => setToast(null), 6000);
    try {
      await setSelectorOptionFeature({ selectorOptionId, key, value: trimmed });
    } catch (e) {
      // NEVER a raw `.message`. Production redacts a plain Error to "Server
      // Error", and even a surviving message reaches the client wrapped in
      // "[CONVEX M(selectorOptions:setSelectorOptionFeature)] [Request ID: …]"
      // — so the old `Failed: ${e.message}` toast showed an operator either
      // nothing useful or a request id. Only a ConvexError's `data` is text a
      // backend deliberately chose for a person, and `userFacingMessage` is
      // the one place that rule lives.
      setToast(`Failed: ${userFacingMessage(e, `Could not save ${label}`)}`);
    }
  };

  return (
    <div
      className="border border-gray-700 rounded-lg bg-gray-900/60 p-4 space-y-3"
      role="region"
      aria-label="Set attributes panel"
    >
      {/* Breadcrumb header (fixes QA #2 — which level/column applies). */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* NEO-96: the rename pencil sits immediately after the title
              because the title IS the name it edits — that adjacency is the
              only thing making it discoverable. The panel scopes itself to the
              deepest current selection at ANY level, so this one control
              renames sports, years, manufacturers, sets and variants alike. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold text-gray-100">
              {headerTitle}
            </h3>
            {/* NEO-211 (plan F): a non-custom variantType's value drives Base
                detection and the BSC checklist fetch's `variant` facet, so it is
                not editable. Rendering a pencil that always errors would be a
                worse answer than not offering one. */}
            {canRenameSelectorRow(row) && (
              <RenameEntityControl id={selectorOptionId} currentValue={row.value} />
            )}
            {/* NEO-219: the one sanctioned delete, next to the pencil for the
                same reason the pencil is next to the title — the title IS the
                row it acts on. Gated by exactly the rename rule on the client
                (a non-custom variantType is structural, not a label) and again,
                independently, by the server's own emptiness + protection
                checks. */}
            {canRenameSelectorRow(row) && (
              <DeleteSelectorRowControl
                // Keyed on the row: this panel does NOT remount when the
                // selection moves, so without this a dialog opened for one row
                // — or a revealed reason belonging to it — would survive onto
                // the next one and ask its question about the wrong thing.
                key={selectorOptionId}
                id={selectorOptionId}
                row={row}
                level={leafLevel}
                onDeleted={onDeleted}
              />
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate" title={breadcrumb}>
            {breadcrumb}
          </p>
        </div>
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Hide attributes"
            className="shrink-0 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
          >
            Hide attributes ▴
          </button>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Edit attributes"
              className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
            >
              Edit attributes ▾
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Set attributes
            </span>
          </div>

          {toast && (
            // NEO-47: position the save confirmation FIXED in the viewport, not
            // in-flow above the grid. A save made while scrolled down to the
            // feature rows would otherwise render the toast off-screen above
            // the fold — invisible to the user (and the e2e assertion).
            <div
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 border border-[#00D558]/60 rounded text-xs text-[#00D558] shadow-lg"
              role="status"
              aria-live="polite"
            >
              {toast}
            </div>
          )}

          {toggleFeatures.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Set attribute toggles"
            >
              {toggleFeatures.map((feat) => (
                <SetFeatureRow
                  key={feat.key}
                  feat={feat}
                  value={features[feat.key]}
                  onSave={(v) => handleSaveFeature(feat.key, feat.label, v)}
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {otherFeatures.map((feat) => (
              <SetFeatureRow
                key={feat.key}
                feat={feat}
                value={features[feat.key]}
                onSave={(v) => handleSaveFeature(feat.key, feat.label, v)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Editable feature row. Maestro targets `Value for {label}` — DO NOT rename.
 */
function SetFeatureRow({
  feat,
  value,
  onSave,
}: {
  feat: ExpectedFeature;
  value: string | undefined;
  onSave: (value: string) => Promise<unknown>;
}) {
  const label = feat.label;
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  // "checkbox" features store "true"/"false" strings in the `features` map
  // (unlike "boolean", which is bound to a real schema column and isn't
  // meaningful at the set level). Unchecked/unset is itself a complete
  // answer, so this never shows the amber "missing" treatment. "toggleOptions"
  // renders the same bare-pill way (no label/box chrome) so it sits
  // indistinguishably in the shared toggle row.
  if (feat.inputType === "checkbox" || feat.inputType === "toggleOptions") {
    return (
      <div
        className="flex flex-row items-center"
        aria-label={`Set feature ${label}`}
      >
        <FeatureValueControl
          feat={feat}
          value={value ?? ""}
          onSave={onSave}
          ariaLabel={`Value for ${label}`}
          dataFeatKey={feat.key}
          className=""
        />
      </div>
    );
  }

  // "boolean" has no typed target at the set level (no set-level isRookie
  // column) and is filtered out via `hiddenAtLevels` before reaching here —
  // this is a defensive fallback, not an expected path.
  if (feat.inputType === "boolean") {
    console.warn(
      `SetFeatureRow: unexpected boolean-type feature "${feat.key}" at set level; rendering read-only.`,
    );
    return (
      <div
        className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Set feature ${label}`}
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span className="text-gray-300">{value ?? "—"}</span>
      </div>
    );
  }

  return (
    <label
      className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
      aria-label={`Set feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span
          title={feat.hint}
          className={
            feat.hint
              ? "cursor-help underline decoration-dotted decoration-gray-500"
              : undefined
          }
        >
          {label}
        </span>
      </span>
      <FeatureValueControl
        feat={feat}
        value={value ?? ""}
        onSave={onSave}
        // NEO-217: without this, `useReactiveField` treats an empty commit as
        // "revert" and writes the old value straight back into the input — the
        // operator deletes the text, tabs out, and watches it reappear. Routing
        // it to `onSave("")` is what makes a set attribute clearable.
        onEmptyCommit={() => onSave("")}
        ariaLabel={`Value for ${label}`}
        placeholder="—"
        dataFeatKey={feat.key}
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// NEO-219 — the one sanctioned delete
// ---------------------------------------------------------------------------

/**
 * "Sets are fixed, never deleted" holds, with ONE exception agreed 2026-09-03:
 * a row with nothing below it — no child rows, no cards anywhere in its
 * subtree, no cross-listings, and at sport level no players/teams/leagues —
 * may be removed. That is the whole rule, and it is checked SERVER-side; this
 * control only mirrors it so the operator is not offered an action that will
 * be refused.
 *
 * Two states, both stated in words rather than colour:
 *   • holdings exist → the button is `aria-disabled` and names what is below
 *     it ("Holds 3 sets and 220 cards — delete what is below it first").
 *     Clicking reveals that sentence visually, because "why is this greyed
 *     out?" is the question a disabled control always raises and a permanent
 *     line of it under every row in the Set Builder is noise. The sentence is
 *     in the DOM at all times as the button's `aria-describedby` target, so a
 *     screen reader hears the reason without the reveal.
 *   • nothing below it → a ConfirmDialog, Cancel-focused (decision 3), which
 *     additionally says the row may come back if it carries a marketplace id:
 *     an empty SYNCED row deleted today is re-inserted by the next Sync Sets,
 *     which is harmless but surprising if unannounced.
 *
 * A `SELECTOR_ROW_NOT_EMPTY` refusal is a real race, not a bug: the holdings
 * query and the click are separated by however long the operator read the
 * dialog. It renders the server's own `holds` inside the dialog rather than
 * closing, so the answer arrives where the question was asked.
 */

/** One thing standing in the way of a delete, as the server reports it. */
type SelectorHolding = {
  kind: string;
  count: number;
  /**
   * On `kind: "rows"`, the level of the children being counted — OMITTED when
   * they are mixed (a variantType holding both inserts and parallels). Absent
   * therefore means "no single right noun exists", not "look it up": deriving
   * one from the parent's level would confidently name the wrong thing in
   * exactly the case the server declined to name.
   */
  level?: SelectorLevel;
  examples?: string[];
};

type SelectorHoldings = {
  holds: SelectorHolding[];
  /** `refusesValueRename` on the server — a structural row, never deletable. */
  protected: boolean;
};

/**
 * Singular/plural nouns for every non-row holding kind that is a COUNT NOUN —
 * i.e. every kind whose remedy is the sentence's own "delete what is below it
 * first". `review` deliberately has no entry here; see `reviewClause`.
 */
const HOLD_NOUN: Record<string, readonly [string, string]> = {
  cards: ["card", "cards"],
  crossListings: ["cross-listing", "cross-listings"],
  "cross-listings": ["cross-listing", "cross-listings"],
  players: ["player", "players"],
  teams: ["team", "teams"],
  leagues: ["league", "leagues"],
};

function holdPhrase(hold: SelectorHolding): string {
  if (hold.kind === "rows") {
    // No level means the children are MIXED (inserts and parallels under one
    // variantType), so there is no single right noun. "3 rows" is the honest
    // answer; deriving one from the parent would name the wrong thing in
    // precisely the case the server declined to name.
    return hold.level
      ? `${hold.count} ${levelNoun(hold.level, hold.count)}`
      : `${hold.count} ${hold.count === 1 ? "row" : "rows"}`;
  }
  const noun = HOLD_NOUN[hold.kind];
  if (!noun) return `${hold.count} ${hold.kind}`;
  return `${hold.count} ${hold.count === 1 ? noun[0] : noun[1]}`;
}

/**
 * An in-flight checklist review on this row.
 *
 * NOT a `HOLD_NOUN` entry, because it is not the same kind of statement as the
 * others. "Holds 1 checklist review — delete what is below it first" would give
 * the operator the wrong instruction: a review is not a thing below the row
 * waiting to be deleted, it is work in progress on the row itself, and the way
 * out is to finish or cancel it. So it gets its own clause with its own remedy.
 */
function reviewClause(count: number): string {
  return count === 1
    ? "a checklist review is in progress here — finish or cancel it first"
    : `${count} checklist reviews are in progress here — finish or cancel them first`;
}

/**
 * "Holds 3 sets and 220 cards — delete what is below it first."
 *
 * Exported shape shared by the disabled reason and the server's refusal, so
 * the operator reads the same sentence whichever side produced it.
 *
 * Two clauses at most, because there are two different remedies: everything
 * countable below the row is deleted, and an in-flight review is finished or
 * cancelled. Both can be true at once, so both are said.
 */
export function selectorHoldsMessage(
  holds: readonly SelectorHolding[],
): string {
  const present = holds.filter((h) => h.count > 0);
  const countable = present.filter((h) => h.kind !== "review");
  const reviewCount = present
    .filter((h) => h.kind === "review")
    .reduce((total, h) => total + h.count, 0);

  const clauses: string[] = [];
  if (countable.length > 0) {
    clauses.push(
      `Holds ${joinLabels(countable.map(holdPhrase))} — delete what is below it first`,
    );
  }
  if (reviewCount > 0) {
    const clause = reviewClause(reviewCount);
    // Leading clause starts a sentence; a trailing one continues one.
    clauses.push(
      clauses.length === 0
        ? clause.charAt(0).toUpperCase() + clause.slice(1)
        : clause,
    );
  }
  return clauses.join("; ");
}

/**
 * The server's delete refusals, matched STRUCTURALLY rather than with
 * `instanceof ConvexError` — same reasoning as RenameEntityControl's
 * `refusalMessage`: a mocked or rethrown error in a test, or a version skew in
 * the convex client, must still surface the server's own answer.
 */
function deleteRefusalMessage(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, holds, message } = data as {
    code?: unknown;
    holds?: unknown;
    message?: unknown;
  };
  if (code === "SELECTOR_ROW_NOT_EMPTY") {
    const list = Array.isArray(holds) ? (holds as SelectorHolding[]) : [];
    return (
      selectorHoldsMessage(list) ||
      "Something is below it now — it can't be deleted."
    );
  }
  if (code === "SELECTOR_ROW_PROTECTED") {
    return typeof message === "string" && message.length > 0
      ? message
      : "This row can't be deleted.";
  }
  return null;
}

function DeleteSelectorRowControl({
  id,
  row,
  level,
  onDeleted,
}: {
  id: Id<"selectorOptions">;
  row: Pick<SlotBearingRow, "platformData"> & { value: string };
  level: SelectorLevel;
  onDeleted?: (level: SelectorLevel) => void;
}) {
  const holdings: SelectorHoldings | undefined = useQuery(
    api.selectorOptions.getSelectorOptionHoldings,
    { id },
  );
  const deleteSelectorOption = useMutation(
    api.selectorOptions.deleteSelectorOption,
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonRevealed, setReasonRevealed] = useState(false);
  const reasonId = useId();

  // A protected row is not "disabled", it is not a thing you may do at all —
  // same call the pencil makes. Rendering nothing beats rendering a control
  // that can only ever refuse.
  if (holdings?.protected) return null;

  const reason =
    holdings === undefined
      ? "Checking what is below it…"
      : selectorHoldsMessage(holdings.holds);
  const blocked = reason.length > 0;

  const linkedSides = ALL_SIDES.filter(
    (side) => slotIds(row, side).length > 0,
  ).map((side) => SIDE_LABEL[side]);

  const description =
    "Nothing is below it. This cannot be undone." +
    (linkedSides.length > 0
      ? ` It is linked to ${joinLabels(
          linkedSides,
        )}; the next sync may add it back.`
      : "");

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSelectorOption({ id });
      setOpen(false);
      onDeleted?.(level);
    } catch (e) {
      setError(
        deleteRefusalMessage(e) ??
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (blocked) {
            setReasonRevealed(true);
            return;
          }
          setError(null);
          setOpen(true);
        }}
        // aria-disabled, not `disabled`: the reason is the whole point of the
        // control in this state, and a natively disabled button cannot be
        // focused to hear it or clicked to reveal it.
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : undefined}
        aria-label={`Delete ${row.value}`}
        title={`Delete ${row.value}`}
        // p-1: a bare 16x16 icon is under WCAG 2.5.8's 24x24 minimum target.
        className="shrink-0 p-1 text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-500"
      >
        <TrashIcon className="w-4 h-4" />
      </button>
      {blocked && (
        <span
          id={reasonId}
          className={
            reasonRevealed
              ? "w-full text-[10px] text-gray-400"
              : "sr-only"
          }
        >
          {reason}
        </span>
      )}
      {open && (
        <ConfirmDialog
          title={`Delete ${LEVEL_SINGULAR[level]} "${row.value}"?`}
          description={description}
          confirmLabel="Yes, delete"
          busyLabel="Deleting…"
          busy={busy}
          error={error}
          onConfirm={() => void handleConfirm()}
          onCancel={() => {
            if (busy) return;
            setError(null);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
