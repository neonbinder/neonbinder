import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { ICON_BTN } from "./ui";

/**
 * NEO-350 prototype 4 — the counter's modal: a fixed overlay with
 * `role="dialog"` + `aria-modal`, the same hand-rolled shape the app's
 * ConfirmDialog uses.
 *
 * Keyboard: focus opens on `initialFocus` (else the first control), Tab is
 * trapped, Escape closes, and focus goes back to the opener on close when
 * that element is still in the document.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({
  title,
  description,
  onClose,
  initialFocus,
  wide = false,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target =
      initialFocus?.current ??
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panelRef.current;
    target?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
    // Open-time only: the dialog mounts once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-lg border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl sm:rounded-lg ${
          wide ? "sm:max-w-3xl" : "sm:max-w-xl"
        } focus:outline-none`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-white">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-slate-400">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={() => onCloseRef.current()}
            className={ICON_BTN}
          >
            <XMarkIcon aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
