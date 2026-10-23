import React, { useState } from "react";

export interface CollapsibleProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export const Collapsible: React.FC<CollapsibleProps> = ({
  trigger,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className = "",
}) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;

  const toggleOpen = () => {
    const newOpen = !isOpen;
    if (open === undefined) {
      setInternalOpen(newOpen);
    }
    onOpenChange?.(newOpen);
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between px-4">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-ink">{trigger}</h3>
        </div>
        <button
          type="button"
          onClick={toggleOpen}
          className="p-2 rounded-md text-ink-2 hover:bg-hover transition-colors focus-outline"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        </button>
      </div>

      {isOpen && <div className="space-y-2">{children}</div>}
    </div>
  );
};
