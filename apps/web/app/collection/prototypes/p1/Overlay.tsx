import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { inertBackground } from "@/lib/dom/inert-background";

/**
 * Where focus can go when the opener is gone, nearest first, resolved while
 * the opener is still on the page: an ancestor marked `data-focus-home`, the
 * heading that labels an ancestor `section` or `article` (looked up by id at
 * close, so a redraw of the heading still counts), and last the page's `h1`.
 */
export function focusHomes(opener: Element | null): (() => HTMLElement | null)[] {
  const homes: (() => HTMLElement | null)[] = [];
  for (let el = opener?.parentElement ?? null; el; el = el.parentElement) {
    if (el.hasAttribute("data-focus-home")) {
      const home = el as HTMLElement;
      homes.push(() => home);
    }
    if ((el.tagName === "SECTION" || el.tagName === "ARTICLE") && el.hasAttribute("aria-labelledby")) {
      const id = el.getAttribute("aria-labelledby")?.split(/\s+/)[0];
      if (id) homes.push(() => document.getElementById(id));
    }
  }
  homes.push(() => document.querySelector<HTMLElement>("h1"));
  return homes;
}

/** Focus the first home still on the page, making it focusable (never a tab stop) if it was not. */
export function focusFirstHome(homes: readonly (() => HTMLElement | null)[]): HTMLElement | null {
  for (const resolve of homes) {
    const home = resolve();
    if (!home || !home.isConnected) continue;
    if (!home.hasAttribute("tabindex") && home.tabIndex < 0) home.tabIndex = -1;
    home.focus({ preventScroll: false });
    if (document.activeElement === home) return home;
  }
  return null;
}

/** Focus has nowhere to be: on the page's body, or on something no longer in it. */
function focusIsFree(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * A modal layer for prototype 1: portalled to <body> (inside its own nested
 * Radix `<Theme>`, so Radix tokens resolve), the rest of the page
 * made `inert` (so Tab cannot leave and a screen reader cannot wander), Tab
 * wrapped at both ends, Escape closes, and focus goes back to whatever opened
 * it. `drawer` slides in from the right like the admin CardDetailPanel;
 * `modal` is a centred box for small forms; `stage` is no box at all, a
 * full-screen column for one object on the dimmed page (the public binder's
 * top loader). The stage lets clicks through to the scrim, so whatever its
 * children leave empty still closes it; a child that should catch a click
 * says so (`pointer-events-auto`).
 *
 * On open, focus lands on the element marked `data-autofocus`, else the
 * labelling heading. The panel takes focus itself (never a tab stop), so a click
 * on something that can't hold focus leaves it in here, where Escape still works.
 *
 * On close, focus goes back to the opener. When the opener is gone (what was
 * done in here took it off the page: a held-back card priced, a need filled),
 * it goes to the nearest place that still stands around where the opener was
 * (`focusHomes`), so the keyboard never falls to the page's top. That waits a
 * frame and only steps in when focus is still nowhere, so a page that parks
 * focus itself after a close keeps doing so.
 */
export default function Overlay({
  labelledBy,
  onClose,
  variant = "drawer",
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  variant?: "drawer" | "modal" | "stage";
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const opener = document.activeElement as HTMLElement | null;
    // Resolved now: once the opener is gone, its ancestors cannot be read. No
    // opener (a link opened it on load, or a click that focuses nothing, as in
    // Safari): nowhere to go back to, so nothing is moved on close.
    const homes = opener && opener !== document.body ? focusHomes(opener) : [];
    const release = inertBackground(root);
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      document.getElementById(labelledBy);
    target?.focus({ preventScroll: true });
    return () => {
      release();
      if (opener && opener !== document.body && document.contains(opener)) {
        opener.focus({ preventScroll: true });
        return;
      }
      // The opener went while this was open: a frame on, once the page has
      // redrawn (and had its own say), the nearest home that still stands.
      if (homes.length > 0) {
        requestAnimationFrame(() => {
          if (focusIsFree()) focusFirstHome(homes);
        });
      }
    };
    // Open once per mount; the heading id never changes while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A layer opened from inside this one is portalled to <body>, but React
    // still bubbles its keys up here: they are that layer's, never this one's
    // (its Tab would otherwise be trapped back into this panel, now inert).
    if (!panelRef.current?.contains(e.target as Node)) return;
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
    const active = document.activeElement;
    const inside = !!active && panel.contains(active);
    // Focus can sit on something that is no tab stop (the heading, the panel):
    // the browser would then walk out of the dialog if no stop lies that way.
    const lies = (position: number) =>
      inside && focusables.some((el) => active.compareDocumentPosition(el) & position);
    if (e.shiftKey ? active === first || !lies(Node.DOCUMENT_POSITION_PRECEDING) : active === last || !lies(Node.DOCUMENT_POSITION_FOLLOWING)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  return createPortal(
    // The portal lands on <body>, outside the root <Theme> (src/main.tsx) and
    // so outside every Radix CSS variable: a NeonButton in here had no
    // padding, radius or size (NEO-359). A nested <Theme> with no props takes
    // the ambient appearance/accent/radius from context and puts the
    // `.radix-themes` scope back. Portalling INTO the Theme root instead would
    // break two things: `inertBackground` inerts <body>'s other children, so
    // the app behind would stay live, and that root is `position: relative;
    // z-index: 0`, a stacking context that would trap this layer under any
    // body-level portal. Same fix as components/SetSelector/BaseSetPicker.tsx.
    <Theme>
    <div ref={rootRef} className="fixed inset-0 z-50 font-[Lexend,sans-serif]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`outline-none ${
          variant === "stage"
            ? "pointer-events-none absolute inset-0 text-ink"
            : variant === "drawer"
            ? "absolute top-0 right-0 h-full w-full sm:w-[40rem] max-w-[95vw] bg-raised text-ink border-l border-rule-strong shadow-xl flex flex-col animate-slide-in-right"
            : "absolute left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-rule bg-raised p-6 text-ink shadow-xl"
        }`}
      >
        {children}
      </div>
    </div>
    </Theme>,
    document.body,
  );
}
