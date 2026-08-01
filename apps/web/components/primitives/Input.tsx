import React from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import {
  useReactiveField,
  type ReactiveFieldOptions,
} from "../forms/useReactiveField";

/**
 * NEO-44 — the app's shared text input.
 *
 * Every raw `<input>` re-solved the same three problems independently: the
 * dark-neon styling, Maestro `inputText` targeting, and (for reactive rows) the
 * controlled-input race. This primitive bakes all three in so a new field is
 * correct by default and no per-field work is needed.
 *
 * ## Maestro targeting (the reason for the auto class)
 * maestro-web's `inputText` reads `document.activeElement`, re-finds it via
 * `createXPathFromElement` (unique `id` → `class` → positional), then sends
 * keys. Inputs sharing an identical Tailwind `className` produce a non-unique
 * XPath, so Selenium types into the FIRST match rather than the field the test
 * tapped. Every input rendered here gets a document-unique marker class from
 * {@link useFieldTestClass}, which makes that XPath resolve exactly.
 *
 * ## This component NEVER emits an `id` of its own
 * Maestro builds `resource-id = node.id || node.ariaLabel || …`, so an
 * auto-generated `id` would clobber the aria-label and break every
 * `tapOn id: "<aria-label>"` selector in `.maestro/flows/`. Uniqueness comes
 * from a **class**; an `id` appears only when the caller passes one (several
 * profile flows target `pub-*` ids deliberately). Label association therefore
 * uses `htmlFor` when the caller supplies an `id`, and a wrapping `<label>`
 * (implicit association) when it does not — accessible either way, without
 * inventing an id.
 *
 * ## Modes
 * - **bare** — renders the lone `<input>` with no wrapper/label/helper chrome.
 *   Use this when dropping into existing markup that already has its own label
 *   and layout: the DOM stays byte-for-byte what it was, so no `.maestro` flow
 *   needs editing.
 * - **reactive** — pass {@link ReactiveFieldOptions} and the field becomes
 *   uncontrolled with the NEO-39 focus-guard (external reactive pushes are
 *   dropped while focused/saving; commit reads the live DOM). Supersedes the
 *   old `components/forms/ReactiveTextField.tsx`.
 * - **plain** — an ordinary controlled/uncontrolled input; all native props
 *   pass straight through.
 */

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "size"
>;

export interface InputProps extends NativeInputProps {
  label?: string;
  helperText?: string;
  error?: string;
  inputSize?: "default" | "small";
  variant?: "default" | "withButton";
  buttonText?: string;
  onButtonClick?: () => void;
  state?: "default" | "focused" | "completed" | "disabled";
  labelPosition?: "top" | "left";
  /**
   * Render only the `<input>` — no wrapper div, label, helper text or button.
   * The migration path for existing markup: layout and selectors are untouched.
   */
  bare?: boolean;
  /**
   * Opt into the NEO-39 reactive-safe uncontrolled behaviour. When present the
   * field ignores `value`/`defaultValue` and is driven by
   * {@link useReactiveField} instead (commit on blur / Enter).
   */
  reactive?: ReactiveFieldOptions;
  /**
   * Disambiguates multiple fields inside one component instance when it helps
   * debugging (`mb-field-r7-cardtitle`). Purely cosmetic — uniqueness is already
   * guaranteed per instance without it.
   */
  fieldKey?: string;
  /**
   * Fields are `w-full` by default, which is what almost every form row wants.
   * Set false for the narrow ones (a hex swatch, a print-run box): Tailwind
   * resolves conflicting width utilities by stylesheet order, not by the order
   * they appear in `className`, so a caller's `w-28` cannot reliably beat a
   * baked-in `w-full` — it has to be omitted rather than overridden.
   */
  fullWidth?: boolean;
}

const BASE_INPUT =
  "border border-slate-700 rounded-md bg-slate-900 text-foreground placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#00C2FF] disabled:cursor-not-allowed disabled:opacity-50";

const SIZE_CLASSES: Record<NonNullable<InputProps["inputSize"]>, string> = {
  default: "px-3 py-2 text-base",
  small: "px-3 py-2 text-sm",
};

const LABEL_CLASS = "block text-sm font-medium mb-1 text-slate-300";
const LABEL_LEFT_CLASS = "min-w-[84px] text-sm font-medium text-slate-300";

/**
 * Reactive variant, split into its own component so `useReactiveField` is called
 * unconditionally (a hook may not run behind an `if`). Rendered by {@link Input}
 * whenever `reactive` is supplied.
 */
const ReactiveInput = React.forwardRef<
  HTMLInputElement,
  { reactive: ReactiveFieldOptions; className: string } & NativeInputProps
>(({ reactive, className, disabled, ...props }, forwardedRef) => {
  const { inputProps, busy } = useReactiveField(reactive);
  const { ref: hookRef, ...restInputProps } = inputProps;

  return (
    <input
      {...props}
      {...restInputProps}
      ref={(el) => {
        hookRef(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      }}
      disabled={disabled || busy}
      className={className}
    />
  );
});
ReactiveInput.displayName = "ReactiveInput";

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      helperText,
      error,
      inputSize = "default",
      variant = "default",
      buttonText = "Subscribe",
      onButtonClick,
      state = "default",
      labelPosition = "top",
      bare = false,
      reactive,
      fieldKey,
      fullWidth = true,
      className = "",
      ...props
    },
    ref,
  ) => {
    const fieldClass = useFieldTestClass();
    const inputClasses = [
      fieldClass(fieldKey),
      fullWidth ? "w-full" : "",
      BASE_INPUT,
      SIZE_CLASSES[inputSize],
      state === "focused" ? "ring-2 ring-[#00C2FF]" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const control = reactive ? (
      <ReactiveInput
        {...props}
        ref={ref}
        reactive={reactive}
        className={inputClasses}
        disabled={props.disabled || state === "disabled"}
      />
    ) : (
      <input
        {...props}
        ref={ref}
        className={inputClasses}
        disabled={props.disabled || state === "disabled"}
      />
    );

    // Bare: the caller owns all surrounding markup. Nothing but the input.
    if (bare) return control;

    const inputElement =
      variant === "withButton" ? (
        <div className="flex gap-2">
          {control}
          <button
            type="button"
            onClick={onButtonClick}
            className={`shrink-0 px-4 py-2 rounded-md text-sm font-medium text-black transition-colors ${
              state === "completed"
                ? "bg-[#00D558]/70"
                : state === "disabled"
                  ? "bg-[#00D558]/40"
                  : "bg-[#00D558] hover:bg-[#00D558]/90"
            }`}
          >
            {buttonText}
          </button>
        </div>
      ) : (
        control
      );

    const containerClasses =
      labelPosition === "left"
        ? "flex items-center gap-4"
        : "flex flex-col gap-1.5";

    // Label association without inventing an `id` (see the header note): use
    // `htmlFor` when the caller gave us one, otherwise wrap so the association
    // is implicit.
    const labelled = !label ? (
      inputElement
    ) : props.id ? (
      <>
        <label
          htmlFor={props.id}
          className={labelPosition === "left" ? LABEL_LEFT_CLASS : LABEL_CLASS}
        >
          {label}
        </label>
        {labelPosition === "left" ? (
          <div className="flex-1">{inputElement}</div>
        ) : (
          inputElement
        )}
      </>
    ) : (
      <label
        className={
          labelPosition === "left"
            ? "flex flex-1 items-center gap-4"
            : "block flex-1"
        }
      >
        <span
          className={labelPosition === "left" ? LABEL_LEFT_CLASS : LABEL_CLASS}
        >
          {label}
        </span>
        {inputElement}
      </label>
    );

    return (
      <div
        className={`${containerClasses} ${state === "disabled" ? "opacity-50" : ""}`}
      >
        {labelled}
        {(helperText || error) && (
          <p
            className={`text-sm ${error ? "text-[#FF2EB3]" : "text-slate-400"}`}
          >
            {error || helperText}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
