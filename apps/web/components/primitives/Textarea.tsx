import React from "react";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helperText?: string;
  variant?: "default" | "withButton";
  buttonText?: string;
  onButtonClick?: () => void;
  state?: "default" | "disabled";
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      helperText,
      variant = "default",
      buttonText = "Send message",
      onButtonClick,
      state = "default",
      className = "",
      ...props
    },
    ref,
  ) => {
    const textareaClasses = `flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm ring-offset-background placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none ${className}`;

    return (
      <div
        className={`flex flex-col gap-2 ${state === "disabled" ? "opacity-50" : ""}`}
      >
        {label && (
          <label className="text-sm font-medium text-slate-900 leading-none">
            {label}
          </label>
        )}

        <div className="relative">
          <textarea
            ref={ref}
            className={textareaClasses}
            disabled={state === "disabled"}
            {...props}
          />
        </div>

        {variant === "withButton" && (
          <button
            type="button"
            onClick={onButtonClick}
            className={`w-full px-4 py-2 rounded-md text-sm font-medium text-white transition-colors ${
              state === "disabled"
                ? "bg-emerald-400 text-black"
                : "bg-emerald-500 hover:bg-emerald-600"
            }`}
          >
            {buttonText}
          </button>
        )}

        {helperText && <p className="text-sm text-slate-500">{helperText}</p>}
      </div>
    );
  },
);

Textarea.displayName = "Textarea";
