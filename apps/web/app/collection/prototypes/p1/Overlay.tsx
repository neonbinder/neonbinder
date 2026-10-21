import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { inertBackground } from "@/lib/dom/inert-background";

/**
 * A modal layer for prototype 1: portalled to <body>, the rest of the page
 * made `inert` (so Tab cannot leave and a screen reader cannot wander), Tab
 * wrapped at both ends, Escape closes, and focus goes back to whatever opened
 * it. `drawer` slides in from the right like the admin CardDetailPanel;
 * `modal` is a centred box for small forms.
 *
 * On open, focus lands on the element marked `data-autofocus`, else the
 * labelling heading.
 */
export default function Overlay({
  labelledBy,
  onClose,
  variant = "drawer",
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  variant?: "drawer" | "modal";
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const release = inertBackground(root);
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      document.getElementById(labelledBy);
    target?.focus({ preventScroll: true });
    return () => {
      release();
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // Open once per mount; the heading id never changes while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-50 font-[Lexend,sans-serif]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={
          variant === "drawer"
            ? "absolute top-0 right-0 h-full w-full sm:w-[40rem] max-w-[95vw] bg-gray-800 text-slate-100 border-l border-gray-700 shadow-xl flex flex-col animate-slide-in-right"
            : "absolute left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-800 bg-gray-800 p-6 text-slate-100 shadow-xl"
        }
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
