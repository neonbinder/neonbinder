import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { useVisibleNavItems } from "./binder-tabs";

interface MobileNavProps {
  onClose: () => void;
}

export default function MobileNav({ onClose }: MobileNavProps) {
  const location = useLocation();
  const initialPathname = useRef(location.pathname);
  const items = useVisibleNavItems();

  // Close on route change (skip initial mount)
  useEffect(() => {
    if (location.pathname !== initialPathname.current) {
      onClose();
    }
  }, [location.pathname, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-64 bg-gray-900 border-l border-gray-700 z-50 lg:hidden flex flex-col animate-slide-in-right">
        <div className="p-4 border-b border-gray-700">
          <span className="neon-header text-xl">Menu</span>
        </div>
        <nav className="flex-1 p-4 flex flex-col gap-2">
          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              viewTransition
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200
                ${isActive
                  ? `${item.glowClass} ${item.activeColor} bg-gray-800`
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`
              }
            >
              <item.icon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </>
  );
}
