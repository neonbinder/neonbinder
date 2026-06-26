import React from "react";

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ label, onCheckedChange, className = "", ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
      props.onChange?.(e);
    };

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <div className="relative">
          <input
            ref={ref}
            type="checkbox"
            className="sr-only"
            onChange={handleChange}
            {...props}
          />
          <div
            className={`w-11 h-6 rounded-full transition-colors ${
              props.checked ? "bg-slate-900" : "bg-slate-200"
            }`}
          >
            <div
              className={`w-5 h-5 bg-white rounded-full transition-transform transform ${
                props.checked ? "translate-x-5.5" : "translate-x-0.5"
              } translate-y-0.5`}
            />
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

Switch.displayName = "Switch";
