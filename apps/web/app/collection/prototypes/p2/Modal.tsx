import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { inertBackground } from "@/lib/dom/inert-background";

/**
 * The prototype's modal shell: portalled, everything behind it inert, Tab
 * trapped, Escape closes, and focus goes back to whatever opened it (or to
 * `fallbackFocus` when the opener has gone, e.g. a pocket that emptied).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  fallbackFocus?: () => HTMLElement | null;
}

export default function Modal({ labelledBy, onClose, children, className = "", fallbackFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const fallbackRef = useRef(fallbackFocus);
  useEffect(() => {
    onCloseRef.current = onClose;
    fallbackRef.current = fallbackFocus;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Capture the opener BEFORE inerting: inert blurs it.
    const opener = document.activeElement as HTMLElement | null;
    const release = inertBackground(dialog);
    const first =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog).focus();
    // Safety net: if a control inside unmounts while focused, focus falls to
    // <body> and the dialog's own Escape handler never hears the key.
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !dialog.contains(document.activeElement)) onCloseRef.current();
    };
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("keydown", onDocKey);
      release();
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
      else fallbackRef.current?.()?.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`max-h-[calc(100dvh-1rem)] w-full overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl focus:outline-none sm:max-h-[calc(100dvh-3rem)] sm:rounded-2xl ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
