import React, { createContext, useContext, useState } from "react";

interface NavigationMenuContextType {
  activeItem: string | null;
  setActiveItem: (value: string | null) => void;
}

const NavigationMenuContext = createContext<
  NavigationMenuContextType | undefined
>(undefined);

const useNavigationMenuContext = () => {
  const context = useContext(NavigationMenuContext);
  if (!context) {
    throw new Error(
      "NavigationMenu components must be used within a NavigationMenu provider",
    );
  }
  return context;
};

export interface NavigationMenuProps {
  children: React.ReactNode;
  className?: string;
}

export const NavigationMenu: React.FC<NavigationMenuProps> = ({
  children,
  className = "",
}) => {
  const [activeItem, setActiveItem] = useState<string | null>(null);

  return (
    <NavigationMenuContext.Provider value={{ activeItem, setActiveItem }}>
      <nav className={`inline-flex items-start ${className}`}>{children}</nav>
    </NavigationMenuContext.Provider>
  );
};

export interface NavigationMenuItemProps {
  value: string;
  type?: "default" | "dropdown" | "link";
  children: React.ReactNode;
  className?: string;
}

export const NavigationMenuItem: React.FC<NavigationMenuItemProps> = ({
  value,
  type = "default",
  children,
  className = "",
}) => {
  const { activeItem, setActiveItem } = useNavigationMenuContext();
  const isActive = activeItem === value;

  const handleClick = () => {
    if (type === "dropdown") {
      setActiveItem(isActive ? null : value);
    } else {
      setActiveItem(value);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        className={`flex items-center gap-1 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
          isActive
            ? "bg-slate-50 text-slate-900 rounded-md"
            : "text-slate-900 hover:text-slate-600"
        } ${className}`}
      >
        <span>{children}</span>
        {type === "dropdown" && (
          <svg
            className={`h-3 w-3 transition-transform duration-200 ${
              isActive ? "rotate-180" : ""
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
        )}
      </button>
    </div>
  );
};

export interface NavigationMenuContentProps {
  value: string;
  type?: "withPicture" | "twoColumns";
  children: React.ReactNode;
  className?: string;
}

export const NavigationMenuContent: React.FC<NavigationMenuContentProps> = ({
  value,
  type = "twoColumns",
  children,
  className = "",
}) => {
  const { activeItem } = useNavigationMenuContext();

  if (activeItem !== value) {
    return null;
  }

  return (
    <div
      className={`absolute top-full left-0 mt-2 w-auto min-w-[400px] p-4 bg-white border border-slate-200 rounded-md shadow-lg z-50 ${
        type === "withPicture" ? "flex gap-3" : "grid grid-cols-2 gap-3"
      } ${className}`}
    >
      {children}
    </div>
  );
};

export interface NavigationMenuContentItemProps {
  title: string;
  description: string;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

export const NavigationMenuContentItem: React.FC<
  NavigationMenuContentItemProps
> = ({ title, description, selected = false, onClick, className = "" }) => {
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-md cursor-pointer transition-colors ${
        selected ? "bg-slate-50" : "hover:bg-slate-50"
      } ${className}`}
    >
      <div className="text-sm font-medium text-slate-900 mb-1">{title}</div>
      <div className="text-sm text-slate-500 leading-5">{description}</div>
    </div>
  );
};
