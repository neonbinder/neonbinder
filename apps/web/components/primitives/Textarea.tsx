import React from "react";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

/**
 * NEO-44 — the app's shared multi-line text field. The `<textarea>` counterpart
 * to {@link ./Input}: same dark-neon styling, same auto-applied
 * {@link useFieldTestClass} marker class for Maestro `inputText` targeting, and
 * the same hard rule — **never emits an `id` of its own**, because Maestro reads
 * `resource-id = node.id || node.ariaLabel`, so an invented id would clobber the
 * aria-label our flows select on.
 *
 * `bare` renders the lone `<textarea>` with no wrapper chrome, which is how
 * existing markup migrates without any DOM or selector change.
 *
 * There is no `reactive` mode here (unlike `Input`): `useReactiveField` is typed
 * to `HTMLInputElement`, and no reactive row in the app is currently multi-line.
 * Widen the hook first if that changes.
 */
export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helperText?: string;
  error?: string;
  variant?: "default" | "withButton";
  buttonText?: string;
  onButtonClick?: () => void;
  state?: "default" | "disabled";
  /** Render only the `<textarea>` — no wrapper, label, helper or button. */
  bare?: boolean;
  /** Optional marker-class suffix; uniqueness is already guaranteed without it. */
  fieldKey?: string;
}

/** Visual identity only — geometry is the caller's in `bare` mode (see Input). */
const BASE_TEXTAREA =
  "resize-none rounded-md border border-slate-700 bg-slate-900 text-foreground placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#00C2FF] disabled:cursor-not-allowed disabled:opacity-50";

const TEXTAREA_GEOMETRY = "flex min-h-[80px] w-full px-3 py-2 text-sm";

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      helperText,
      error,
      variant = "default",
      buttonText = "Send message",
      onButtonClick,
      state = "default",
      bare = false,
      fieldKey,
      className = "",
      ...props
    },
    ref,
  ) => {
    const fieldClass = useFieldTestClass();
    const textareaClasses = [
      fieldClass(fieldKey),
      BASE_TEXTAREA,
      bare ? "" : TEXTAREA_GEOMETRY,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const control = (
      <textarea
        {...props}
        ref={ref}
        className={textareaClasses}
        disabled={props.disabled || state === "disabled"}
      />
    );

    if (bare) return control;

    // Associate the label without inventing an `id`: `htmlFor` when the caller
    // supplied one, otherwise wrap for implicit association.
    const labelled = !label ? (
      control
    ) : props.id ? (
      <>
        <label
          htmlFor={props.id}
          className="text-sm font-medium leading-none text-slate-300"
        >
          {label}
        </label>
        {control}
      </>
    ) : (
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium leading-none text-slate-300">
          {label}
        </span>
        {control}
      </label>
    );

    return (
      <div
        className={`flex flex-col gap-2 ${state === "disabled" ? "opacity-50" : ""}`}
      >
        {labelled}

        {variant === "withButton" && (
          <button
            type="button"
            onClick={onButtonClick}
            className={`w-full rounded-md px-4 py-2 text-sm font-medium text-black transition-colors ${
              state === "disabled"
                ? "bg-[#00D558]/40"
                : "bg-[#00D558] hover:bg-[#00D558]/90"
            }`}
          >
            {buttonText}
          </button>
        )}

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

Textarea.displayName = "Textarea";
