import { XMarkIcon } from "@heroicons/react/20/solid";
import { FOCUS } from "./ui";

/** What the last add/remove said, and how to take it back. */
export interface Notice {
  /** Bumps on every notice, so the same words twice still re-announce. */
  id: number;
  message: string;
  undo?: () => void;
}

export type Notify = (message: string, undo?: () => void) => void;

/**
 * The status line with its Undo. The `role="status"` element is ALWAYS
 * mounted (a live region inserted with text already in it says nothing), and
 * holds only the message; Undo sits beside it so it is never read twice.
 *
 * `floating` is the page toast (bottom centre, above the content); inline is
 * the line at the top of the detail drawer, next to the form that caused it.
 */
export default function NoticeLine({
  notice,
  onUndo,
  onDismiss,
  floating = false,
}: {
  notice: Notice | null;
  onUndo: () => void;
  onDismiss: () => void;
  floating?: boolean;
}) {
  const shell = floating
    ? `fixed bottom-4 left-1/2 z-40 -translate-x-1/2 w-[min(32rem,calc(100vw-2rem))] ${
        notice ? "" : "pointer-events-none"
      }`
    : "";
  return (
    <div className={shell}>
      <div
        className={
          notice
            ? "flex items-center gap-3 rounded-md border border-neon-blue/60 bg-sheet px-3 py-2 text-sm shadow-lg"
            : ""
        }
      >
        <p role="status" className={notice ? "flex-1 text-ink" : "sr-only"}>
          {notice?.message ?? ""}
        </p>
        {notice?.undo && (
          <button
            type="button"
            onClick={onUndo}
            className={`min-h-8 rounded px-2 py-1 text-sm font-semibold text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
          >
            Undo
          </button>
        )}
        {notice && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss message"
            className={`flex h-8 w-8 items-center justify-center rounded text-ink-3 hover:text-ink ${FOCUS}`}
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
