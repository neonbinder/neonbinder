import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { FeatureValueControl } from "./FeatureValueControl";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

/**
 * NEO-24 — per-card feature override editor.
 *
 * Renders one row per `EXPECTED_FEATURES` entry with the card's current
 * value pre-filled. `cardFeatures` (the card's own `features` map) is
 * already the complete resolved snapshot (NEO-71-74: write-once feature
 * snapshots — computed once via copy-down from the selectorOption node at
 * card-creation time, see `commitCardChecklist`/`addCustomCard`), so this
 * component reads it directly with no client-side ancestor-chain merge.
 * Save calls `setCardFeature` per row on blur.
 *
 * None of these fields are actually required — blank is a perfectly
 * acceptable, complete answer for most of them (not every card is
 * autographed, has a memorabilia relic, a known signer, etc). There is
 * deliberately no "missing"/required warning treatment anywhere here —
 * every row renders identically whether filled in or blank.
 *
 * Collapsed by default to keep the inline edit form tight; expanded
 * via the "Show features" button. Mobile: rows stack vertically.
 */
export default function CardFeaturesEditor({
  cardChecklistId,
  cardFeatures,
  ancestorSport,
  cardIsRookie,
}: {
  cardChecklistId: Id<"cardChecklist">;
  /** The card's own features map — already the complete resolved snapshot. */
  cardFeatures: Record<string, string> | undefined;
  /** Sport from the ancestor chain — drives `applicableSports` filtering. */
  ancestorSport?: string;
  /** The card's real typed Rookie column — backs the "boolean" input type (NEO-71). */
  cardIsRookie?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const setCardFeature = useMutation(api.selectorOptions.setCardFeature);
  const updateCard = useMutation(api.selectorOptions.updateCard);

  const applicable = useMemo(() => {
    return EXPECTED_FEATURES.filter((f) => {
      if (f.hiddenAtLevels?.includes("card")) return false;
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
            feat={feat}
            cardValue={cardFeatures?.[feat.key]}
            cardIsRookie={cardIsRookie}
            onSave={async (value) => {
              await setCardFeature({
                cardChecklistId,
                key: feat.key,
                value,
              });
            }}
            onSaveBoolean={async (v) => {
              await updateCard({ id: cardChecklistId, isRookie: v });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function CardFeatureRow({
  feat,
  cardValue,
  cardIsRookie,
  onSave,
  onSaveBoolean,
}: {
  feat: ExpectedFeature;
  cardValue: string | undefined;
  cardIsRookie: boolean | undefined;
  onSave: (value: string) => Promise<unknown>;
  onSaveBoolean: (value: boolean) => Promise<unknown>;
}) {
  const label = feat.label;
  const [boolBusy, setBoolBusy] = useState(false);
  const [boolError, setBoolError] = useState<string | null>(null);
  // Unique per-field marker class so Maestro's inputText targets THIS field's
  // input rather than the FIRST card-feature input sharing the className (see
  // useFieldTestClass). Mirrors SetFeatureRow — without it, typing into any
  // text feature (e.g. Signed By) lands in the first text input (Card Type).
  const fieldClass = useFieldTestClass();

  if (feat.inputType === "checkbox") {
    return (
      <label
        className="flex flex-row items-center gap-2 p-1.5 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Feature ${label}`}
      >
        <FeatureValueControl
          feat={feat}
          value={cardValue ?? ""}
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

  if (feat.inputType === "boolean") {
    const handleToggle = async (checked: boolean) => {
      setBoolBusy(true);
      try {
        await onSaveBoolean(checked);
        setBoolError(null);
      } catch (e) {
        setBoolError(e instanceof Error ? e.message : String(e));
      } finally {
        setBoolBusy(false);
      }
    };
    return (
      <label
        className="flex flex-row items-center gap-2 p-1.5 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Feature ${label}`}
      >
        <input
          type="checkbox"
          checked={cardIsRookie === true}
          disabled={boolBusy}
          onChange={(e) => void handleToggle(e.target.checked)}
          aria-label={`Value for ${label}`}
          className="accent-[#00D558]"
        />
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        {boolError && (
          <span className="text-[10px] text-[#FF2EB3]" role="alert">
            {boolError}
          </span>
        )}
      </label>
    );
  }

  if (feat.inputType === "derived") {
    const resolved = cardValue ?? "—";
    return (
      <div
        className="flex flex-col gap-0.5 p-1.5 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Feature ${label}`}
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

  const displayed = cardValue ?? "";

  return (
    <label
      className="flex flex-col gap-0.5 p-1.5 rounded border text-xs border-gray-700 bg-gray-900/30"
      aria-label={`Feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>{label}</span>
      </span>
      <FeatureValueControl
        feat={feat}
        value={displayed}
        compareBaseline={cardValue ?? ""}
        onSave={onSave}
        ariaLabel={`Value for ${label}`}
        placeholder="—"
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}

/** Feature key used by callers — exported for SetFeaturesPanel reuse. */
export { CardFeatureRow };
