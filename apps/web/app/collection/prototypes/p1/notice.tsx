import { useEffect, useEffectEvent, useRef } from "react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { FOCUS } from "./ui";

/** What the last add/remove said, and how to take it back. */
export interface Notice {
  /**
   * Bumps on every notice, so the same words twice still re-announce: the
   * line's live region speaks on a new id, never on a re-render of the same
   * one (`useLiveWords`).
   */
  id: number;
  /** What the line shows. */
  message: string;
  /**
   * What the live region says when it is not `message`: a refusal merged in
   * front of a newer write's words says only itself, and "Still saving."
   * is said with the words on the line left as they are.
   */
  announce?: string;
  /** A refusal: never replaced by an aside (`useStatusLine`'s `inform`). */
  kind?: "refusal";
  /**
   * On a refusal merged in front of a newer write's live Undo: that write's
   * own words, which the Undo still belongs to. A later refusal replaces the
   * one in front of them rather than stacking.
   */
  undoWords?: string;
  undo?: () => void;
  /** The undo is running: Undo stays put but does nothing until it lands. */
  undoing?: boolean;
}

export type Notify = (message: string, undo?: () => void) => void;

/**
 * The line's live region speaks once per notice id. A live region only
 * speaks when its text changes, so the same words twice ("Nothing to undo."
 * after "Nothing to undo.", one refusal after the same refusal) would go
 * unsaid: on every new id it is cleared, then given the words a frame later.
 * The same notice drawn again says nothing, and the notice already up when
 * the line mounts (the card drawer opening over it) is not news either. A
 * line taken down empties it, so no stale words are left to find.
 */
function useLiveWords(notice: Notice | null) {
  const region = useRef<HTMLParagraphElement>(null);
  const id = notice?.id ?? null;
  const spokeFor = useRef(id);
  const words = useEffectEvent(() => (notice ? (notice.announce ?? notice.message) : ""));
  useEffect(() => {
    const el = region.current;
    if (!el || id === spokeFor.current) return;
    spokeFor.current = id;
    el.textContent = "";
    if (id === null) return;
    const said = words();
    const frame = requestAnimationFrame(() => {
      el.textContent = said;
    });
    return () => cancelAnimationFrame(frame);
  }, [id]);
  return region;
}

/**
 * The status line with its Undo. Its live region (`role="status"`) is a
 * visually hidden sibling, ALWAYS mounted (a live region inserted with text
 * already in it says nothing), that speaks once per notice (`useLiveWords`).
 * The words shown are not a live region of their own, so nothing is said
 * twice, and Undo sits outside both, so it is never read as part of them.
 *
 * `floating` is the page toast (bottom centre, above the content); inline is
 * the line at the top of the detail drawer, next to the form that caused it.
 *
 * The wrapper carries `data-notice-hold`: the collection page holds its
 * timer while the pointer or the keyboard is on the line, so Undo is never
 * snatched away mid-reach. While an undo runs (`undoing`), Undo stays where
 * it is, `aria-disabled`, and a second press does nothing; once it lands the
 * button goes, and the keyboard moves on to Dismiss rather than falling to
 * the page.
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
  const dismissRef = useRef<HTMLButtonElement>(null);
  const live = useLiveWords(notice);
  return (
    <div className={shell} data-notice-hold="">
      <p ref={live} role="status" className="sr-only" />
      <div
        className={
          notice
            ? "flex items-center gap-3 rounded-md border border-neon-blue/60 bg-sheet px-3 py-2 text-sm shadow-lg"
            : ""
        }
      >
        {notice && <p className="flex-1 text-ink">{notice.message}</p>}
        {notice?.undo && (
          <button
            type="button"
            ref={(el) => () => {
              // Unmounting while focused (Undo was pressed, or a new write took
              // it): keep the keyboard on the line. Focus moves to Dismiss and
              // the words stay, so nothing is lost from under the keyboard.
              if (el && document.activeElement === el) requestAnimationFrame(() => dismissRef.current?.focus());
            }}
            aria-disabled={notice.undoing || undefined}
            onClick={notice.undoing ? undefined : onUndo}
            className={`min-h-8 rounded px-2 py-1 text-sm font-semibold text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
          >
            Undo
          </button>
        )}
        {notice && (
          <button
            type="button"
            ref={dismissRef}
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
