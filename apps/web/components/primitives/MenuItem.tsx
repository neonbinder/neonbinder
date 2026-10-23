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
        ? "bg-hover text-ink"
        : disabled
          ? "text-ink-3 cursor-not-allowed opacity-50"
          : "text-ink-3 hover:bg-hover hover:text-ink"
    }`,
    sectionTitle: "text-ink-3 font-semibold cursor-default px-8",
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
        <span className="text-xs text-ink-3 font-medium">{rightText}</span>
      )}

      {rightIcon && <span className="w-4 h-4 shrink-0">{rightIcon}</span>}
    </div>
  );
};
