import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { inertBackground } from "@/lib/dom/inert-background";
import { useVisibleNavItems } from "./binder-tabs";

/** Shared with the header toggle's `aria-controls`. */
export const MOBILE_NAV_ID = "mobile-nav";

interface MobileNavProps {
  onClose: () => void;
}

/**
 * The phone/tablet stand-in for the binder tabs (below `lg`).
 *
 * A modal dialog, because it behaves like one: it covers the page and the
 * header's menu toggle with it. Before this it was a bare fixed `<div>`, so
 * focus stayed on the toggle underneath the panel (SC 2.4.11), Escape did
 * nothing, and Tab walked straight past the links into the hidden page.
 *
 * ## The keyboard contract (same shape as `ConfirmDialog` / `NewTeamDialog`)
 * - **Focus opens on the current page's link** (or the first link), so Enter
 *   on open is harmless and arrow-free Tab order starts where you are.
 * - **Escape closes**, as does the backdrop and the Close button inside the
 *   panel. The header toggle cannot close it: the background is `inert` while
 *   the menu is open, which is what keeps `aria-modal` honest for a screen
 *   reader's browse cursor too.
 * - **Tab is trapped** inside the panel.
 * - On close, focus goes back to whatever opened the menu (the toggle).
 *
 * Portalled to `<body>` so `inertBackground` can make the app root inert
 * without taking the dialog with it.
 */
export default function MobileNav({ onClose }: MobileNavProps) {
  const location = useLocation();
  const initialPathname = useRef(location.pathname);
  const items = useVisibleNavItems();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Close on route change (skip initial mount)
  useEffect(() => {
    if (location.pathname !== initialPathname.current) {
      onClose();
    }
  }, [location.pathname, onClose]);

  useEffect(() => {
    // Captured FIRST: making the background inert blurs the toggle, and a
    // trigger read after that would be `<body>`.
    triggerRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const releaseBackground = panel ? inertBackground(panel) : () => {};
    const start =
      panel?.querySelector<HTMLElement>('nav a[aria-current="page"]') ??
      panel?.querySelector<HTMLElement>("nav a");
    start?.focus();
    return () => {
      // Released BEFORE focus goes back: focusing an inert element is a no-op.
      releaseBackground();
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>("button:not([disabled]), [href]"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="lg:hidden" onKeyDown={handleKeyDown}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-scrim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        id={MOBILE_NAV_ID}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-nav-title"
        className="fixed top-0 right-0 h-full w-64 max-w-[85vw] bg-raised-deep text-foreground border-l border-rule-strong z-50 flex flex-col animate-slide-in-right overscroll-contain"
      >
        <div className="p-4 border-b border-rule-strong flex items-center justify-between gap-2">
          <h2 id="mobile-nav-title" className="neon-header text-xl">
            Menu
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-hover focus-outline transition-colors"
          >
            <XMarkIcon className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              // `binder-row` (app/theme.css) colours the row and lights the
              // current one (aria-current) in its tab's hue.
              className={`binder-row ${item.hueClass} flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 focus-outline`}
            >
              <item.icon className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>,
    document.body,
  );
}
