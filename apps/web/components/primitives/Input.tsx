import React from "react";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  helperText?: string;
  error?: string;
  inputSize?: "default" | "small";
  variant?: "default" | "withButton";
  buttonText?: string;
  onButtonClick?: () => void;
  state?: "default" | "focused" | "completed" | "disabled";
  labelPosition?: "top" | "left";
}

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
      className = "",
      ...props
    },
    ref,
  ) => {
    const inputSizeClasses = {
      default: "px-3 py-2 text-base",
      small: "px-3 py-2 text-sm",
    };

    const inputClasses = `flex w-full rounded-md border border-slate-300 bg-white ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${inputSizeClasses[inputSize]} ${className}`;

    const containerClasses =
      labelPosition === "left"
        ? "flex items-center gap-4"
        : "flex flex-col gap-1.5";
    const labelClasses =
      labelPosition === "left"
        ? "min-w-[84px] text-sm font-medium text-slate-900"
        : "text-sm font-medium text-slate-900";

    const inputElement = (
      <div className={variant === "withButton" ? "flex gap-2" : ""}>
        {state === "focused" && (
          <div className="flex p-0.5 rounded-lg border-2 border-slate-400 bg-white">
            <input
              ref={ref}
              className={`${inputClasses} border-0 focus-visible:ring-0`}
              {...props}
            />
          </div>
        )}
        {state !== "focused" && (
          <input
            ref={ref}
            className={inputClasses}
            disabled={state === "disabled"}
            {...props}
          />
        )}
        {variant === "withButton" && (
          <button
            type="button"
            onClick={onButtonClick}
            className={`px-4 py-2 rounded-md text-sm font-medium text-white transition-colors ${
              state === "completed"
                ? "bg-green-400"
                : state === "disabled"
                  ? "bg-green-300"
                  : "bg-neon-green hover:bg-neon-green/90"
            }`}
          >
            {buttonText}
          </button>
        )}
      </div>
    );

    return (
      <div
        className={`${containerClasses} ${state === "disabled" ? "opacity-50" : ""}`}
      >
        {label && <label className={labelClasses}>{label}</label>}
        {labelPosition === "top" && inputElement}
        {labelPosition === "left" && (
          <div className="flex-1">{inputElement}</div>
        )}
        {(helperText || error) && (
          <p className={`text-sm ${error ? "text-red-600" : "text-slate-500"}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
