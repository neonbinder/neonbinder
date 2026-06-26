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
          <input ref={ref} type="radio" className="sr-only" {...props} />
          <div
            className={`w-4 h-4 rounded-full border transition-colors ${
              props.checked
                ? "border-slate-200 bg-white"
                : "border-slate-200 bg-white"
            }`}
          >
            {props.checked && (
              <div className="w-2 h-2 bg-black rounded-full absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2" />
            )}
          </div>
        </div>

        {label && (
          <label className="text-sm font-medium text-slate-900 leading-none">
            {label}
          </label>
        )}
      </div>
    );
  },
);

RadioButton.displayName = "RadioButton";
