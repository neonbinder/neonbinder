import React from "react";

export interface MenuItemProps {
  children: React.ReactNode;
  disabled?: boolean;
  selected?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  rightText?: string;
  variant?: "default" | "sectionTitle";
  onClick?: () => void;
  className?: string;
}

export const MenuItem: React.FC<MenuItemProps> = ({
  children,
  disabled = false,
  selected = false,
  leftIcon,
  rightIcon,
  rightText,
  variant = "default",
  onClick,
  className = "",
}) => {
  const baseClasses =
    "flex items-center gap-2 px-2 py-1.5 text-sm transition-colors";

  const variantClasses = {
    default: `cursor-pointer ${
      selected
        ? "bg-slate-50 text-slate-900"
        : disabled
          ? "text-slate-400 cursor-not-allowed opacity-50"
          : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
    }`,
    sectionTitle: "text-slate-500 font-semibold cursor-default px-8",
  };

  const handleClick = () => {
    if (!disabled && onClick) {
      onClick();
    }
  };

  return (
    <div
      className={`${baseClasses} ${variantClasses[variant]} ${
        variant === "default" && !leftIcon ? "pl-8" : ""
      } ${className}`}
      onClick={handleClick}
    >
      {leftIcon && <span className="w-4 h-4 shrink-0">{leftIcon}</span>}

      <span className="flex-1 font-medium">{children}</span>

      {rightText && (
        <span className="text-xs text-slate-400 font-medium">{rightText}</span>
      )}

      {rightIcon && <span className="w-4 h-4 shrink-0">{rightIcon}</span>}
    </div>
  );
};
