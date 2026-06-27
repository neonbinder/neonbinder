import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EXPECTED_FEATURES } from "../../convex/features/expectedFeatures";
import { useReactiveField } from "../forms/useReactiveField";

/**
 * NEO-24 — per-card feature override editor.
 *
 * Renders one row per `EXPECTED_FEATURES` entry with the card's
 * current value pre-filled. Save calls `setCardFeature` per row on
 * blur; "Revert to inherited" clears the per-card override so the
 * card falls back to whatever the ancestor chain effectively
 * provides.
 *
 * Missing-feature highlight (amber) fires when the key has no value
 * on either the card or any ancestor — that's a marketplace-listing
 * blocker the admin should fix before pushing the card to eBay/etc.
 *
 * Collapsed by default to keep the inline edit form tight; expanded
 * via the "Show features" button. Mobile: rows stack vertically.
 */
export default function CardFeaturesEditor({
  cardChecklistId,
  selectorOptionId,
  cardFeatures,
  ancestorSport,
}: {
  cardChecklistId: Id<"cardChecklist">;
  /** Variant the card lives under — feeds the ancestor-chain query. */
  selectorOptionId: Id<"selectorOptions">;
  /** The card's own features map (per-card override layer). */
  cardFeatures: Record<string, string> | undefined;
  /** Sport from the ancestor chain — drives `applicableSports` filtering. */
  ancestorSport?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const setCardFeature = useMutation(api.selectorOptions.setCardFeature);
  const updateCard = useMutation(api.selectorOptions.updateCard);

  // Ancestor chain → effective inherited value per key. Deeper
  // ancestors override shallower (mirrors `commitCardChecklist`).
  const chain = useQuery(
    api.selectorOptions.getAncestorChain,
    expanded ? { id: selectorOptionId } : "skip",
  );

  const inheritedByKey = useMemo(() => {
    const map: Record<string, string> = {};
    if (!chain) return map;
    for (const row of chain) {
      if (!row.features) continue;
      for (const [k, v] of Object.entries(row.features)) {
        map[k] = v;
      }
    }
    return map;
  }, [chain]);

  const applicable = useMemo(() => {
    return EXPECTED_FEATURES.filter((f) => {
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true; // Show all when sport unknown
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Show features editor"
        className="text-xs text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
      >
        Show features ▾
      </button>
    );
  }

  return (
    <div
      className="border border-gray-700 rounded p-2 space-y-1.5"
      aria-label="Card features editor"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Features
        </span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Hide features editor"
          className="text-xs text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
        >
          Hide ▴
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {applicable.map((feat) => (
          <CardFeatureRow
            key={feat.key}
            featKey={feat.key}
            label={feat.label}
            cardValue={cardFeatures?.[feat.key]}
            inheritedValue={inheritedByKey[feat.key]}
            onSave={async (value) => {
              await setCardFeature({
                cardChecklistId,
                key: feat.key,
                value,
              });
            }}
            onRevert={async () => {
              // No granular "clear key" mutation in v0; the cheapest
              // way to drop a key is a full-replacement features
              // patch via updateCard with the key removed. Existing
              // overrides on other keys are preserved.
              const next: Record<string, string> = { ...(cardFeatures ?? {}) };
              delete next[feat.key];
              await updateCard({
                id: cardChecklistId,
                features: next,
              });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function CardFeatureRow({
  featKey,
  label,
  cardValue,
  inheritedValue,
  onSave,
  onRevert,
}: {
  featKey: string;
  label: string;
  cardValue: string | undefined;
  inheritedValue: string | undefined;
  onSave: (value: string) => Promise<unknown>;
  onRevert: () => Promise<unknown>;
}) {
  // Effective displayed value = override if any, else inherited. The wrapper
  // mirrors this into the (uncontrolled) input whenever the field is idle.
  const displayed = cardValue ?? inheritedValue ?? "";

  // NEO-39: uncontrolled, focus-guarded field. Commit reads the live value;
  // empty input reverts the per-card override; the no-op baseline is the
  // card's own value (not the displayed inherited fallback), preserving the
  // original `trimmed === (cardValue ?? "")` check.
  const { inputProps, busy, error: err } = useReactiveField({
    value: displayed,
    compareBaseline: cardValue ?? "",
    onSave: (trimmed) => onSave(trimmed),
    onEmptyCommit: () => onRevert(),
  });

  const hasOverride =
    cardValue !== undefined && cardValue !== "" && cardValue !== inheritedValue;

  const isMissing =
    (cardValue === undefined || cardValue === "") &&
    (inheritedValue === undefined || inheritedValue === "");

  return (
    <label
      className={`flex flex-col gap-0.5 p-1.5 rounded border text-xs ${
        isMissing
          ? "border-amber-500/60 bg-amber-500/5"
          : "border-gray-700 bg-gray-900/30"
      }`}
      aria-label={`Feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>
          {isMissing && (
            <span
              className="text-amber-500 mr-1"
              aria-label="Missing required feature"
              title="Missing required feature"
            >
              ⚠
            </span>
          )}
          {label}
        </span>
        {hasOverride && (
          <button
            type="button"
            onClick={onRevert}
            disabled={busy}
            aria-label={`Revert ${label} to inherited`}
            className="text-[10px] text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
          >
            Revert
          </button>
        )}
      </span>
      <input
        {...inputProps}
        type="text"
        disabled={busy}
        aria-label={`Value for ${label}`}
        placeholder={inheritedValue ?? "—"}
        className="w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none"
      />
      {!hasOverride && inheritedValue !== undefined && inheritedValue !== "" && (
        <span className="text-[10px] text-gray-500" aria-label={`Inherited value: ${inheritedValue}`}>
          Inherited: {inheritedValue}
        </span>
      )}
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </label>
  );
}

/** Feature key used by callers — exported for SetFeaturesPanel reuse. */
export { CardFeatureRow };
