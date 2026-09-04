import { useEffect, useMemo, useState } from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { FeatureValueControl } from "./FeatureValueControl";
import RenameEntityControl from "./RenameEntityControl";
import BaseRoleControl from "./BaseRoleControl";

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
}: {
  selectorOptionId: Id<"selectorOptions">;
  /** Start collapsed (cards present) so the panel doesn't push them off-screen. */
  defaultCollapsed?: boolean;
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
   * Raise a transient confirmation.
   *
   * Shared by the feature rows below and by the header's base-role control
   * (NEO-239), which is why it is a helper rather than an inline setToast:
   * two callers raising a 6s toast had to agree on the 6s.
   */
  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 6000);
  };

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
    showToast(clearing ? `Cleared ${label}` : `Saved ${label}`);
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
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-gray-100">
              {headerTitle}
            </h3>
            {/* NEO-239: every level renames, variantType included. Base is an
                NB role flag and the BSC `variant` facet comes off the row's
                tagged slot, so no display value is load-bearing any more. */}
            <RenameEntityControl id={selectorOptionId} currentValue={row.value} />
            {/* NEO-239: which variant type is the set's base is IDENTITY, not
                an attribute, so it sits with the name rather than in the grid
                below — and stays reachable while the panel is collapsed, which
                is how an operator building a set by hand will meet it. Only
                variant types have the role; nothing else in the hierarchy can
                be a base set. */}
            {leafLevel === "variantType" && (
              <BaseRoleControl
                id={selectorOptionId}
                value={row.value}
                metadata={row.metadata}
                onResult={showToast}
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

      {toast && (
        // NEO-47: position the save confirmation FIXED in the viewport, not
        // in-flow above the grid. A save made while scrolled down to the
        // feature rows would otherwise render the toast off-screen above
        // the fold — invisible to the user (and the e2e assertion).
        //
        // NEO-239: outside the `expanded` branch, because the header now holds
        // a control ("Mark as base set") that is reachable while the panel is
        // collapsed. A confirmation that only renders in the expanded state
        // would leave that action looking like it did nothing.
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 border border-[#00D558]/60 rounded text-xs text-[#00D558] shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}

      {expanded && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Set attributes
            </span>
          </div>

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
