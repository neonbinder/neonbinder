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
 * ## What the primitive owns, and what the caller owns
 * The primitive owns **visual identity** — surface, border, radius, focus ring,
 * disabled treatment. In `bare` mode the caller owns **geometry** (width,
 * padding, font size), because it is dropping into markup that already has a
 * layout. This split is not stylistic: Tailwind resolves conflicting utilities
 * by stylesheet order, not by the order they appear in a `className` string, so
 * a caller's `w-28`/`p-1.5` cannot reliably override a baked-in `w-full`/`px-3
 * py-2`. Geometry has to be *absent* rather than overridden. Non-bare mode is
 * standalone, so it does supply `w-full` and a size.
 *
 * ## Modes
 * - **bare** — renders the lone `<input>` with no wrapper/label/helper chrome
 *   and no geometry classes. Use this when dropping into existing markup: keep
 *   the layout classes that were already on the element and delete only the
 *   colour ones, so the DOM stays what it was and no `.maestro` flow changes.
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
}

/**
 * Visual identity. The text colour is hardcoded rather than `text-foreground`
 * on purpose: `--foreground` flips to #171717 under a light-mode OS (see
 * globals.css), and this surface is always `bg-slate-900`, so the themed token
 * would render near-black text on a near-black field for anyone whose system is
 * not in dark mode. A hardcoded surface needs a hardcoded foreground.
 */
const BASE_INPUT =
  "border border-slate-700 rounded-md bg-slate-900 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#00C2FF] disabled:cursor-not-allowed disabled:opacity-50";

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
      className = "",
      ...props
    },
    ref,
  ) => {
    const fieldClass = useFieldTestClass();

    /**
     * NEO-212 (a11y) — the helper/error line is ASSOCIATED with the field, not
     * merely printed under it.
     *
     * A `<p>` below an input is a visual convention; nothing in the
     * accessibility tree connects the two, so a screen-reader user who tabs
     * into a field with "That name is already taken" beneath it hears only the
     * label. `aria-describedby` makes the message part of what is announced on
     * focus (WCAG 2.2 SC 1.3.1 / 3.3.2), and `aria-invalid` marks the field
     * itself as errored (SC 3.3.1) so it is reachable by an "errors" rotor.
     *
     * The id goes on the `<p>`, never on the `<input>` — Maestro derives
     * `resource-id` from `node.id || node.ariaLabel`, so an id on the field
     * would clobber every `tapOn id: "<aria-label>"` selector in the suite (see
     * the header note). `useId` is stable across renders and unique per
     * instance, which is all the association needs.
     *
     * Bare mode renders no message at all, so it gets neither attribute: its
     * contract is "the lone <input>, markup unchanged".
     */
    const messageId = React.useId();
    const hasMessage = !bare && Boolean(error || helperText);
    const describedBy =
      [props["aria-describedby"], hasMessage ? messageId : null]
        .filter(Boolean)
        .join(" ") || undefined;
    // Emitted only when there IS an error: `aria-invalid="false"` is the ARIA
    // default, so spelling it out on every input in the app would be pure
    // markup noise with no behavioural difference.
    const ariaInvalid = !bare && error ? true : props["aria-invalid"];

    const inputClasses = [
      fieldClass(fieldKey),
      BASE_INPUT,
      // Geometry only in standalone mode — see the header note.
      bare ? "" : `w-full ${SIZE_CLASSES[inputSize]}`,
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
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid}
      />
    ) : (
      <input
        {...props}
        ref={ref}
        className={inputClasses}
        disabled={props.disabled || state === "disabled"}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid}
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
            id={messageId}
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
