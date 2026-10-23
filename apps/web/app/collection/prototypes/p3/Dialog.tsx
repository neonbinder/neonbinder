import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { inertBackground } from "@/lib/dom/inert-background";

/**
 * NEO-350 prototype 3 — a modal shell: a right-hand drawer on wide screens,
 * a bottom sheet on phones (`drawer`), or a centred panel (`center`).
 *
 * Portalled to <body>; everything else goes `inert` while it is open; Tab
 * wraps inside; Escape closes; focus returns to whatever opened it (captured
 * before the background goes inert, restored after it is released).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface P3DialogProps {
  title: string;
  /** Visible line under the title. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  shape?: "drawer" | "center";
}

export default function P3Dialog({
  title,
  subtitle,
  onClose,
  children,
  shape = "drawer",
}: P3DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const release = panel.current ? inertBackground(panel.current) : () => {};
    heading.current?.focus();
    return () => {
      release();
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const frame =
    shape === "drawer"
      ? "inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(560px,100vw)] sm:rounded-none sm:rounded-l-2xl sm:border-l"
      : "inset-x-0 top-[8vh] mx-auto max-h-[84vh] w-[min(640px,calc(100vw-2rem))] rounded-2xl border";

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-shape={shape}
        onKeyDown={onKeyDown}
        className={`p3-slide absolute flex flex-col overflow-hidden border-t border-rule-strong bg-sheet text-ink shadow-[0_0_24px_rgba(0,194,255,0.18)] shadow-offset ${frame}`}
      >
        <div className="flex items-start gap-3 border-b border-rule px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2
              ref={heading}
              tabIndex={-1}
              className="text-lg font-bold text-ink focus:outline-none"
            >
              {title}
            </h2>
            {subtitle && <p className="text-sm text-ink-3">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="grid size-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink focus-outline sm:size-9"
          >
            <XMarkIcon aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
