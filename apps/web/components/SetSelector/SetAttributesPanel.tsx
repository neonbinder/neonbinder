import { useEffect, useMemo, useState } from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { FeatureValueControl } from "./FeatureValueControl";

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
      if (
        f.applicableAtLevels &&
        !f.applicableAtLevels.includes(row?.level as Level)
      ) {
        return false;
      }
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true;
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport, row?.level]);

  if (!row || !chain) return null;

  const leafLevel = row.level as Level;
  const features = row.features ?? {};

  // Breadcrumb: "Attributes for {leaf} ({levelLabel}) — a › b › c".
  const breadcrumb = chain.map((c) => c.value).join(" › ");
  const headerTitle = `Attributes for ${row.value} (${LEVEL_LABEL[leafLevel]})`;

  const handleSaveFeature = async (
    key: string,
    label: string,
    value: string,
  ) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (features[key] === trimmed) return; // no-op
    // Optimistic "Saved {label}" confirmation — the mutation is a single-row
    // patch (NEO-71-74), no propagation counts to report.
    setToast(`Saved ${label}`);
    setTimeout(() => setToast(null), 6000);
    try {
      await setSelectorOptionFeature({ selectorOptionId, key, value: trimmed });
    } catch (e) {
      setToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
          <h3 className="text-sm font-semibold text-gray-100">
            {headerTitle}
          </h3>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {applicable.map((feat) => (
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
  // answer, so this never shows the amber "missing" treatment.
  if (feat.inputType === "checkbox") {
    return (
      <label
        className="flex flex-row items-center gap-2 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
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
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
      </label>
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

  if (feat.inputType === "derived") {
    const resolved = value ?? "—";
    return (
      <div
        className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Set feature ${label}`}
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span aria-label={`Value for ${label}`} className="text-gray-300">
          {resolved}
        </span>
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
        ariaLabel={`Value for ${label}`}
        placeholder="—"
        dataFeatKey={feat.key}
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}
