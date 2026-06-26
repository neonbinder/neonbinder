import { useReactiveField } from "./useReactiveField";
import type { ReactiveFieldApi, ReactiveFieldOptions } from "./useReactiveField";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

/**
 * NEO-39 — reactive-safe text input.
 *
 * Thin presentational wrapper over {@link useReactiveField}: renders an
 * uncontrolled `<input>` (`defaultValue` + `ref`, no React `value` binding)
 * whose value is mirrored from the external reactive `value` ONLY while idle,
 * and which commits the live value on blur / Enter. Drop-in for the
 * hand-rolled `value={draft}` + `useEffect(setDraft)` + commit-on-blur rows.
 *
 * The caller supplies the exact `aria-label`, `placeholder`, `className`,
 * etc. so the rendered DOM is byte-for-byte identical to the row it replaces
 * (Maestro E2E targets these inputs by aria-label — no flow may change).
 *
 * Busy + error UX is delegated back to the caller via `renderError` /
 * the `busy`-driven `disabled` so each row keeps its existing affordances.
 */
export type ReactiveTextFieldProps = ReactiveFieldOptions & {
  /** Required — Maestro targets the input by this. Preserve exactly. */
  "aria-label": string;
  placeholder?: string;
  className?: string;
  /** Caller-driven disable (independent of the internal busy flag). */
  disabled?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  type?: "text" | "url" | "email";
  autoFocus?: boolean;
  /** Extra data-* attribute pass-through (e.g. `data-feat-key`). */
  dataAttrs?: Record<string, string>;
  /** Render-prop for the error/busy chrome so each row keeps its own markup. */
  children?: (state: Pick<ReactiveFieldApi, "busy" | "error">) => React.ReactNode;
};

export default function ReactiveTextField({
  value,
  onSave,
  onEmptyCommit,
  compareBaseline,
  placeholder,
  className,
  disabled,
  inputMode,
  type = "text",
  autoFocus,
  dataAttrs,
  children,
  ...rest
}: ReactiveTextFieldProps) {
  const ariaLabel = rest["aria-label"];
  // Unique per-instance marker class so Maestro's inputText targets THIS field
  // and not the first input sharing the same className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  const { inputProps, busy, error } = useReactiveField({
    value,
    onSave,
    onEmptyCommit,
    compareBaseline,
  });

  return (
    <>
      <input
        {...inputProps}
        {...dataAttrs}
        type={type}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled || busy}
        inputMode={inputMode}
        autoFocus={autoFocus}
        className={`${fieldClass()} ${className ?? ""}`}
      />
      {children?.({ busy, error })}
    </>
  );
}
