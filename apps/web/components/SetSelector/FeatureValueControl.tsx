import { useId, useState } from "react";
import { useReactiveField } from "../forms/useReactiveField";
import type { ExpectedFeature } from "../../convex/features/expectedFeatures";
import { Input } from "../primitives/Input";

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
  ariaDescribedBy,
}: {
  feat: ExpectedFeature;
  /** Resolved value to display/edit — caller has already merged own vs. inherited. */
  value: string;
  /** Text-only: no-op baseline for useReactiveField. Defaults to `value`. */
  compareBaseline?: string;
  onSave: (value: string) => Promise<unknown>;
  /**
   * Text-only: handler for an empty commit. Both hosts pass
   * `() => onSave("")` (NEO-217 — the server removes the key). Omitting it
   * makes an emptied field snap back to its previous value, which is what a
   * row that genuinely cannot be blank should do.
   */
  onEmptyCommit?: () => Promise<unknown>;
  ariaLabel: string;
  placeholder?: string;
  className: string;
  dataFeatKey?: string;
  /** Checkbox-only: rendered inside the toggle pill itself. Ignored by other input types. */
  label?: string;
  /**
   * NEO-291 (a11y) — text/select only: the id of the host row's hint, so the
   * control announces it on focus. A `title` on the label is hover-only and
   * unreliable for AT; the host renders the hint visually hidden and points
   * here. Combined with the control's own error id while an error is up, so
   * neither description hides the other.
   */
  ariaDescribedBy?: string;
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
        ariaDescribedBy={ariaDescribedBy}
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
      ariaDescribedBy={ariaDescribedBy}
    />
  );
}

/**
 * The `aria-describedby` for a control: the host's hint id plus this
 * control's own error id while an error is showing. Empty → undefined, so an
 * undescribed control emits no attribute.
 */
function describedBy(
  hintId: string | undefined,
  errorId: string,
  error: string | null,
): string | undefined {
  return [hintId, error ? errorId : null].filter(Boolean).join(" ") || undefined;
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
  ariaDescribedBy,
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
  ariaDescribedBy?: string;
}) {
  const { inputProps, busy, error } = useReactiveField({
    value,
    compareBaseline,
    onSave: (trimmed) => onSave(trimmed),
    onEmptyCommit,
  });
  // On the error span, never on the input: an id on the field would replace
  // its aria-label as Maestro's resource-id (see useFieldTestClass).
  const errorId = useId();

  return (
    <>
      <Input
        bare
        {...inputProps}
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        data-feat-key={dataFeatKey}
        disabled={busy}
        aria-label={ariaLabel}
        aria-describedby={describedBy(ariaDescribedBy, errorId, error)}
        placeholder={placeholder ?? "—"}
        className={className}
      />
      {error && (
        <span id={errorId} className="text-[10px] text-[#FF2EB3]" role="alert">
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
  ariaDescribedBy,
}: {
  options: ReadonlyArray<string>;
  value: string;
  onSave: (value: string) => Promise<unknown>;
  ariaLabel: string;
  className: string;
  dataFeatKey?: string;
  ariaDescribedBy?: string;
}) {
  const errorId = useId();
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

  // The `next === selected` guard stays: re-picking what is already selected
  // fires no mutation, including re-picking "—" on an already-empty row.
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
        aria-describedby={describedBy(ariaDescribedBy, errorId, error)}
        onChange={(e) => void handleChange(e.target.value)}
        className={className}
      >
        {/* NEO-217: SELECTABLE, not disabled.

            It was disabled, which made it a pure placeholder and meant a
            League or Era could be set but never un-set — the one value in the
            list an operator could not get back to was "none of these", which
            is a legitimate answer for every feature in this control. Picking
            it now routes through the same `onSave` with `""`, which the server
            reads as "remove this key" (never as a stored empty string).

            a11y (audit fix, NEO-216/217): the label was a bare "—" (em dash),
            matching the "—" placeholder the text rows use for blank — but a
            placeholder is decorative ghost text a screen reader never reads,
            while THIS text is the option's actual accessible name (`<option>`
            support for overriding it with `aria-label` is inconsistent across
            browser/AT pairs, so the visible text has to carry the meaning on
            its own). A lone dash announces as "hyphen" or nothing at all,
            with nothing distinguishing it from a rendering glitch — "No
            value" says what picking it does, same as every real option
            beside it says what picking THAT does, and it's still not an
            instruction like "— Select —" was. */}
        <option value="">No value</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {error && (
        <span id={errorId} className="text-[10px] text-[#FF2EB3]" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
