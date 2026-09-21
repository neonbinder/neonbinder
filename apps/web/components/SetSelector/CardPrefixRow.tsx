import { useId } from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import type { ExpectedFeature } from "../../convex/features/expectedFeatures";
import { FeatureValueControl } from "./FeatureValueControl";

/**
 * NEO-291 — the card-number prefix, as a row in the Attributes panel.
 *
 * It used to live in a separate "Metadata" box under the Variants column,
 * beside two disabled Insert/Parallel checkboxes and behind its own Save
 * button. The box is gone: which of insert/parallel a row IS is a fact of
 * where it sits in the hierarchy, and the prefix is a per-row fact like every
 * other cell in the attributes grid, so it is edited the way they are — type,
 * blur or Enter, toast.
 *
 * Same chrome as `SetFeatureRow`'s text branch on purpose: the whole point of
 * the move is that this row is not special. It is not an `EXPECTED_FEATURES`
 * entry because it is not stored in the `features` map — it is
 * `metadata.cardNumberPrefix`, read by the checklist sync to take the prefix
 * off marketplace card numbers — so a synthetic `ExpectedFeature` carries the
 * label and hint into `FeatureValueControl`, and the save goes through its
 * own mutation rather than `setSelectorOptionFeature`.
 *
 * Hydration is `FeatureValueControl` → `useReactiveField`: `value` mirrors
 * the row while the field is idle and is dropped while it is focused or
 * saving, which is the NEO-111 "never resync over an unsaved edit" guarantee
 * the old box carried by hand. Nothing here re-implements it.
 *
 * Maestro targets the input as `Value for Card prefix` — DO NOT rename. The
 * wrapper is `Set feature Card prefix`, the same shape as every other row.
 */

export const CARD_PREFIX_FEATURE: ExpectedFeature = {
  key: "cardNumberPrefix",
  label: "Card prefix",
  inputType: "text",
  hint: "Diamond Kings come as DK-1, DK-2… — this is the part that comes off the number.",
};

export default function CardPrefixRow({
  value,
  onSave,
}: {
  /** The row's stored `metadata.cardNumberPrefix`; `undefined` when absent. */
  value: string | undefined;
  /** `""` clears. Trimming and validation are the server's. */
  onSave: (value: string) => Promise<unknown>;
}) {
  const label = CARD_PREFIX_FEATURE.label;
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  // Same as `SetFeatureRow`: the hint is in the DOM, visually hidden, as the
  // input's `aria-describedby` target — `title` alone is hover-only.
  const hintId = useId();

  return (
    <label
      className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
      aria-label={`Set feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span
          title={CARD_PREFIX_FEATURE.hint}
          className="cursor-help underline decoration-dotted decoration-gray-500"
        >
          {label}
        </span>
      </span>
      <span id={hintId} className="sr-only">
        {CARD_PREFIX_FEATURE.hint}
      </span>
      <FeatureValueControl
        feat={CARD_PREFIX_FEATURE}
        value={value ?? ""}
        onSave={onSave}
        // Same as the feature rows (NEO-217): without this an emptied field
        // snaps back to the stored prefix on blur. Routing it to `onSave("")`
        // is what makes the prefix clearable.
        onEmptyCommit={() => onSave("")}
        ariaLabel={`Value for ${label}`}
        ariaDescribedBy={hintId}
        placeholder="e.g. DK-"
        dataFeatKey={CARD_PREFIX_FEATURE.key}
        className={`${fieldClass("prefix")} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}
