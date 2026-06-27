import React from "react";

export interface ScrollListItemProps {
  children: React.ReactNode;
  withDivider?: boolean;
  className?: string;
}

export const ScrollListItem: React.FC<ScrollListItemProps> = ({
  children,
  withDivider = true,
  className = "",
}) => {
  return (
    <div className={`inline-flex flex-col items-start ${className}`}>
      <div className="flex py-2 flex-col items-start gap-2.5 self-stretch">
        <div className="self-stretch text-slate-900 text-sm font-normal leading-5">
          {children}
        </div>
      </div>
      {withDivider && <div className="w-full h-px bg-slate-200" />}
    </div>
  );
};
