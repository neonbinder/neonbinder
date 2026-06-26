import React from "react";

export interface MenuSectionTitleProps {
  children: React.ReactNode;
  withPaddingLeft?: boolean;
  className?: string;
}

export const MenuSectionTitle: React.FC<MenuSectionTitleProps> = ({
  children,
  withPaddingLeft = false,
  className = "",
}) => {
  return (
    <div
      className={`flex items-center py-1.5 px-2 text-sm font-semibold text-slate-500 ${
        withPaddingLeft ? "pl-8" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
};
