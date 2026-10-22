import React from "react";

export interface TableItemProps {
  children: React.ReactNode;
  type?: "head" | "item";
  selected?: boolean;
  className?: string;
}

export const TableItem: React.FC<TableItemProps> = ({
  children,
  type = "item",
  selected = false,
  className = "",
}) => {
  const baseClasses = "px-4 py-3 text-base";

  const typeClasses = {
    head: "font-bold text-ink",
    item: `font-normal text-ink ${
      selected ? "bg-hover" : "hover:bg-hover"
    }`,
  };

  const Tag = type === "head" ? "th" : "td";

  return (
    <Tag className={`${baseClasses} ${typeClasses[type]} ${className}`}>
      {children}
    </Tag>
  );
};
