import React from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import {
  useReactiveField,
  type ReactiveFieldOptions,
} from "../forms/useReactiveField";

/**
 * NEO-44 — the app's shared text input.
 *
 * Every raw `<input>` re-solved the same problems independently: the
 * dark-neon styling and (for reactive rows) the controlled-input race. This
 * primitive bakes both in so a new field is correct by default and no
 * per-field work is needed.
 *
 * ## The auto marker class (legacy)
 * Every input rendered here gets a document-unique marker class from
 * {@link useFieldTestClass}. It was added for the retired Maestro web driver,
 * whose `inputText` re-found the focused field by an XPath built from
 * `id` → `class` → position and typed into the first of several identical
 * inputs. The Playwright suite locates fields by role and accessible name and
 * does not read the class.
 *
 * ## This component NEVER emits an `id` of its own
 * An `id` appears only when the caller passes one (`PublicProfileEditor`
 * passes one per field so its visible `<label>`s can use `htmlFor` — label
 * wiring, NOT a test handle: E2E specs locate fields by their accessible name,
 * never by a DOM id). The rule began with Maestro, which used a field's `id`
 * in place of its aria-label as the selector handle. Label association therefore
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
 *   colour ones, so the DOM stays what it was and no E2E locator changes.
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
   * Which surface the field sits on — it owns the colours for that surface.
   *
   * - **dark** (default) — the always-dark field: `bg-slate-900` whatever the
   *   theme. For dialogs, walkers and pages that are dark in both themes.
   * - **panel** — a field on the set builder's bi-themed card surface
   *   (`bg-white dark:bg-gray-800`: the checklist card, the card drawer). A
   *   dark-only field reads as a hole punched in that card under a light
   *   theme, so this follows the card: white in light, a recessed
   *   `gray-900` well in dark. NEO-343, first used by the checklist search.
   *
   * A caller cannot get this by passing colour classes: Tailwind resolves
   * conflicting utilities by stylesheet order, so a caller's `bg-white` does
   * not reliably beat the baked-in `bg-slate-900` (see the header note).
   */
  surface?: "dark" | "panel";
  /**
   * Disambiguates multiple fields inside one component instance when it helps
   * debugging (`mb-field-r7-cardtitle`). Purely cosmetic — uniqueness is already
   * guaranteed per instance without it.
   */
  fieldKey?: string;
}

/**
 * Visual identity. The text colour is hardcoded rather than `text-foreground`
 * on purpose: the default surface is always `bg-slate-900`, and a hardcoded
 * surface needs a hardcoded foreground. (`--foreground` used to flip to #171717 under a
 * light-mode OS; since NEO-341 globals.css pins it dark, but the field should
 * not depend on the page token either way.)
 */
const BASE_INPUT =
  "border rounded-md focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The colours, per {@link InputProps.surface}. Contrast (WCAG 2.2 AA) of the
 * `panel` pairs, measured against the field's own fill and the card around it:
 *
 * | | light (on white) | dark (field gray-900, card gray-800) |
 * |---|---|---|
 * | text | gray-900, 17.7:1 | gray-100, 16.1:1 |
 * | placeholder | gray-500, 4.8:1 | gray-400, 7.0:1 |
 * | border (1.4.11) | gray-500, 4.8:1 | gray-500, 3.7:1 / 3.0:1 |
 * | focus ring | sky-700, 5.9:1 | #00C2FF, 8.6:1 / 7.1:1 |
 *
 * The neon ring is kept in dark; on white it measures 2.0:1, so light uses
 * sky-700 (the same swap CardDetailPanel's Regenerate link makes).
 */
const SURFACE_CLASSES: Record<NonNullable<InputProps["surface"]>, string> = {
  dark: "border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-400 focus:ring-[#00C2FF]",
  panel:
    "border-gray-500 bg-white text-gray-900 placeholder:text-gray-500 focus:ring-sky-700 " +
    "dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400 dark:focus:ring-[#00C2FF]",
};

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
      surface = "dark",
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
     * The id goes on the `<p>`, never on the `<input>`, which keeps the
     * "never emits an id of its own" rule in the header note. `useId` is
     * stable across renders and unique per instance, which is all the
     * association needs.
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
      SURFACE_CLASSES[surface],
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
            className={`text-sm ${error ? "text-[#FF2E9A]" : "text-slate-400"}`}
          >
            {error || helperText}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
