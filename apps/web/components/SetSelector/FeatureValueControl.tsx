import { useState } from "react";
import { useReactiveField } from "../forms/useReactiveField";
import type { ExpectedFeature } from "../../convex/features/expectedFeatures";

/**
 * NEO-71–74 — shared value editor for the "text"/"select" `ExpectedFeature`
 * input types, used by both `CardFeatureRow` (CardFeaturesEditor.tsx) and
 * `SetFeatureRow` (SetAttributesPanel.tsx). Those two rows diverge too much
 * on surrounding chrome (revert button + compareBaseline on the card row;
 * inherited-level label + `fieldClass()`/`data-feat-key` on the set row) to
 * fully unify, but the value editor itself has an identical contract, so it's
 * extracted here to avoid a second copy of the select-vs-text branch.
 *
 * "boolean"/"select"-adjacent "boolean" and "derived" input types are NOT
 * routed through this control — their value type isn't a string (boolean, or
 * a read-only display), so forcing them into this string-in/string-out
 * contract would need an awkward discriminated union. Callers branch on
 * those two cases inline before reaching for this component.
 */
export function FeatureValueControl({
  feat,
  value,
  compareBaseline,
  onSave,
  onEmptyCommit,
  ariaLabel,
  placeholder,
  className,
  dataFeatKey,
  label,
}: {
  feat: ExpectedFeature;
  /** Resolved value to display/edit — caller has already merged own vs. inherited. */
  value: string;
  /** Text-only: no-op baseline for useReactiveField. Defaults to `value`. */
  compareBaseline?: string;
  onSave: (value: string) => Promise<unknown>;
  /** Text-only: handler for an empty commit (e.g. "revert to inherited"). */
  onEmptyCommit?: () => Promise<unknown>;
  ariaLabel: string;
  placeholder?: string;
  className: string;
  dataFeatKey?: string;
  /** Checkbox-only: rendered inside the toggle pill itself. Ignored by other input types. */
  label?: string;
}) {
  if (feat.inputType === "select") {
    return (
      <SelectValueControl
        options={feat.options ?? []}
        value={value}
        onSave={onSave}
        ariaLabel={ariaLabel}
        className={className}
        dataFeatKey={dataFeatKey}
      />
    );
  }

  if (feat.inputType === "checkbox") {
    return (
      <CheckboxValueControl
        value={value}
        onSave={onSave}
        ariaLabel={ariaLabel}
        dataFeatKey={dataFeatKey}
        label={label ?? feat.label}
      />
    );
  }

  if (feat.inputType === "toggleOptions") {
    return (
      <ToggleOptionsValueControl
        options={feat.options ?? []}
        toggleLabels={feat.toggleLabels}
        value={value}
        onSave={onSave}
        ariaLabel={ariaLabel}
        dataFeatKey={dataFeatKey}
      />
    );
  }

  return (
    <TextValueControl
      value={value}
      compareBaseline={compareBaseline}
      onSave={onSave}
      onEmptyCommit={onEmptyCommit}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      className={className}
      dataFeatKey={dataFeatKey}
      numeric={feat.numeric}
    />
  );
}

function TextValueControl({
  value,
  compareBaseline,
  onSave,
  onEmptyCommit,
  ariaLabel,
  placeholder,
  className,
  dataFeatKey,
  numeric,
}: {
  value: string;
  compareBaseline?: string;
  onSave: (value: string) => Promise<unknown>;
  onEmptyCommit?: () => Promise<unknown>;
  ariaLabel: string;
  placeholder?: string;
  className: string;
  dataFeatKey?: string;
  numeric?: boolean;
}) {
  const { inputProps, busy, error } = useReactiveField({
    value,
    compareBaseline,
    onSave: (trimmed) => onSave(trimmed),
    onEmptyCommit,
  });

  return (
    <>
      <input
        {...inputProps}
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        data-feat-key={dataFeatKey}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder={placeholder ?? "—"}
        className={className}
      />
      {error && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Toggle-pill for "checkbox"-type features. Stores/reads the strings
 * "true"/"false" in the `features` map — NOT a typed schema column (that's
 * what "boolean"/`boundColumn` is for). Unset/missing renders un-toggled,
 * matching the "defaults to unchecked" contract; there's no third "unset"
 * visual state, since unchecked already IS a complete, valid answer here.
 *
 * Styled to match the RC/AU/RELIC attribute toggles in CardDetailPanel.tsx
 * (same colors/shape) — brought here so isReprint/isRelic/isProspect get the
 * same compact, scannable toggle look in both SetAttributesPanel and
 * CardFeaturesEditor, instead of a plain checkbox input next to a separate
 * label. The label renders INSIDE the pill now, so callers no longer need
 * a sibling `<span>{label}</span>` alongside this control.
 */
function CheckboxValueControl({
  value,
  onSave,
  ariaLabel,
  dataFeatKey,
  label,
}: {
  value: string;
  onSave: (value: string) => Promise<unknown>;
  ariaLabel: string;
  dataFeatKey?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = value === "true";

  const handleChange = async (next: boolean) => {
    setBusy(true);
    try {
      await onSave(next ? "true" : "false");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-feat-key={dataFeatKey}
        disabled={busy}
        onClick={() => void handleChange(!checked)}
        aria-label={ariaLabel}
        aria-pressed={checked}
        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
          checked
            ? "bg-[#00D558] text-black border-[#00D558] font-semibold"
            : "bg-transparent text-gray-500 border-gray-300 dark:border-gray-600 hover:border-[#00D558] hover:text-[#00D558]"
        }`}
      >
        {label}
      </button>
      {error && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Mutually-exclusive toggle-pill group for "toggleOptions"-type features
 * (Autographed's On Card/Sticker, Short Print's SP/SSP). `options[0]` is the
 * implicit "off" value (e.g. "None") and never gets its own pill — clicking
 * the currently-active pill again reverts to it. Same pill styling as
 * `CheckboxValueControl` so a toggleOptions feature sits visually
 * indistinguishable from a checkbox one in a shared toggle row.
 */
function ToggleOptionsValueControl({
  options,
  toggleLabels,
  value,
  onSave,
  ariaLabel,
  dataFeatKey,
}: {
  options: ReadonlyArray<string>;
  toggleLabels?: ReadonlyArray<string>;
  value: string;
  onSave: (value: string) => Promise<unknown>;
  ariaLabel: string;
  dataFeatKey?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offValue = options[0] ?? "";

  const handleChange = async (option: string, active: boolean) => {
    setBusy(true);
    try {
      await onSave(active ? offValue : option);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-1">
        {options.slice(1).map((opt, i) => {
          const active = value === opt;
          const pillLabel = toggleLabels?.[i + 1] ?? opt;
          return (
            <button
              key={opt}
              type="button"
              data-feat-key={dataFeatKey ? `${dataFeatKey}-${opt}` : undefined}
              disabled={busy}
              onClick={() => void handleChange(opt, active)}
              aria-label={`${ariaLabel}: ${pillLabel}`}
              aria-pressed={active}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                active
                  ? "bg-[#00D558] text-black border-[#00D558] font-semibold"
                  : "bg-transparent text-gray-500 border-gray-300 dark:border-gray-600 hover:border-[#00D558] hover:text-[#00D558]"
              }`}
            >
              {pillLabel}
            </button>
          );
        })}
      </div>
      {error && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function SelectValueControl({
  options,
  value,
  onSave,
  ariaLabel,
  className,
  dataFeatKey,
}: {
  options: ReadonlyArray<string>;
  value: string;
  onSave: (value: string) => Promise<unknown>;
  ariaLabel: string;
  className: string;
  dataFeatKey?: string;
}) {
  // No focus-guard/uncontrolled dance needed here: a <select> only commits on
  // an explicit user pick (onChange), never merely on focus/blur, so there's
  // no risk of a reactive re-render racing an in-flight keystroke the way
  // useReactiveField guards against for text inputs.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against a stale/off-list value (data drift) rendering as a
  // React "value didn't match any option" warning — fall back to the empty
  // placeholder option instead of silently coercing to the first option.
  const selected = options.includes(value) ? value : "";

  const handleChange = async (next: string) => {
    if (next === selected) return;
    setBusy(true);
    try {
      await onSave(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <select
        value={selected}
        data-feat-key={dataFeatKey}
        disabled={busy}
        aria-label={ariaLabel}
        onChange={(e) => void handleChange(e.target.value)}
        className={className}
      >
        <option value="" disabled>
          — Select —
        </option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {error && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
