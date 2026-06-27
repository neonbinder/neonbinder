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
      className={`inline-flex items-center px-1 py-0.5 rounded bg-slate-50 text-sm font-bold text-slate-900 ${className}`}
    >
      {children}
    </code>
  );
};
