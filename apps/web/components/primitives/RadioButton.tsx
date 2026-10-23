import React from "react";

export interface RadioButtonProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const RadioButton = React.forwardRef<HTMLInputElement, RadioButtonProps>(
  ({ label, className = "", ...props }, ref) => {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="relative">
          <input ref={ref} type="radio" className="peer sr-only" {...props} />
          {/* The input is visually hidden, so the ring draws its focus: the
              same outline as `focus-outline`, keyed off the input. */}
          <div
            className={`w-4 h-4 rounded-full border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
              props.checked
                ? "border-selection bg-field"
                : "border-control bg-field"
            }`}
          >
            {props.checked && (
              <div className="w-2 h-2 bg-selection rounded-full absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2" />
            )}
          </div>
        </div>

        {label && (
          <label className="text-sm font-medium text-ink leading-none">
            {label}
          </label>
        )}
      </div>
    );
  },
);

RadioButton.displayName = "RadioButton";
