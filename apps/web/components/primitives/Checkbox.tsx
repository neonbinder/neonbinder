import React from "react";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
  variant?: "default" | "withText";
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    { label, description, variant = "default", className = "", ...props },
    ref,
  ) => {
    return (
      <div className={`flex items-start gap-3 ${className}`}>
        <div className="relative flex items-center">
          <input
            ref={ref}
            type="checkbox"
            className="h-3.5 w-3.5 rounded border border-gray-300 bg-white checked:bg-slate-900 checked:border-slate-900 focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
            {...props}
          />
          {props.checked && (
            <svg
              className="absolute inset-0 h-3.5 w-3.5 text-white pointer-events-none"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </div>

        {(label || description) && (
          <div className="flex flex-col gap-1.5">
            {label && (
              <label className="text-sm font-medium text-slate-900 leading-none">
                {label}
              </label>
            )}
            {variant === "withText" && description && (
              <p className="text-sm text-slate-500 leading-5">{description}</p>
            )}
          </div>
        )}
      </div>
    );
  },
);

Checkbox.displayName = "Checkbox";
