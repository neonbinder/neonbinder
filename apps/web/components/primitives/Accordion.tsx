import React, { useState } from "react";

export interface AccordionProps {
  items: AccordionItem[];
  type?: "single" | "multiple";
  collapsible?: boolean;
  className?: string;
}

export interface AccordionItem {
  id: string;
  trigger: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}

export const Accordion: React.FC<AccordionProps> = ({
  items,
  type = "single",
  collapsible = true,
  className = "",
}) => {
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    const newOpenItems = new Set(openItems);

    if (type === "single") {
      if (newOpenItems.has(id)) {
        if (collapsible) {
          newOpenItems.clear();
        }
      } else {
        newOpenItems.clear();
        newOpenItems.add(id);
      }
    } else {
      if (newOpenItems.has(id)) {
        newOpenItems.delete(id);
      } else {
        newOpenItems.add(id);
      }
    }

    setOpenItems(newOpenItems);
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {items.map((item) => {
        const isOpen = openItems.has(item.id);

        return (
          <div key={item.id} className="border-b border-slate-200">
            <button
              type="button"
              onClick={() => !item.disabled && toggleItem(item.id)}
              disabled={item.disabled}
              className={`flex w-full items-center justify-between py-4 text-left text-sm font-medium transition-colors hover:text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed ${
                isOpen ? "bg-slate-50" : ""
              }`}
            >
              <span className="text-slate-900">{item.trigger}</span>
              <svg
                className={`h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200 ${
                  isOpen ? "rotate-180" : ""
                }`}
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
              </svg>
            </button>

            {isOpen && (
              <div className="pb-4 pt-2">
                <div className="text-sm text-slate-700">{item.content}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
