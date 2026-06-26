import React, { createContext, useContext, useState } from "react";

interface MenubarContextType {
  activeItem: string | null;
  setActiveItem: (value: string | null) => void;
}

const MenubarContext = createContext<MenubarContextType | undefined>(undefined);

const useMenubarContext = () => {
  const context = useContext(MenubarContext);
  if (!context) {
    throw new Error(
      "Menubar components must be used within a Menubar provider",
    );
  }
  return context;
};

export interface MenubarProps {
  children: React.ReactNode;
  className?: string;
}

export const Menubar: React.FC<MenubarProps> = ({
  children,
  className = "",
}) => {
  const [activeItem, setActiveItem] = useState<string | null>(null);

  return (
    <MenubarContext.Provider value={{ activeItem, setActiveItem }}>
      <div
        className={`inline-flex items-start p-1.5 rounded-md border border-slate-300 bg-white ${className}`}
      >
        {children}
      </div>
    </MenubarContext.Provider>
  );
};

export interface MenubarItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export const MenubarItem: React.FC<MenubarItemProps> = ({
  value,
  children,
  className = "",
}) => {
  const { activeItem, setActiveItem } = useMenubarContext();
  const isActive = activeItem === value;

  return (
    <button
      type="button"
      onClick={() => setActiveItem(value)}
      className={`flex items-center px-3 py-1.5 text-sm font-medium transition-colors ${
        isActive ? "bg-slate-50 rounded" : "hover:bg-slate-50 rounded"
      } ${className}`}
    >
      {children}
    </button>
  );
};
