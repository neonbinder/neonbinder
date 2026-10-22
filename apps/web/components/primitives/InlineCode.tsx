import React from "react";

export interface InlineCodeProps {
  children: React.ReactNode;
  className?: string;
}

export const InlineCode: React.FC<InlineCodeProps> = ({
  children,
  className = "",
}) => {
  return (
    <code
      className={`inline-flex items-center px-1 py-0.5 rounded bg-hover text-sm font-bold text-ink ${className}`}
    >
      {children}
    </code>
  );
};
