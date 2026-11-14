import { createContext, useContext, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
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
   * What the live region says when it is not `message`: on a line that
   * joins a refusal and a write's words, only the part that is new (the
   * other part was said when it first came up), and "Still saving." is said
   * with the words on the line left as they are.
   */
  announce?: string;
  /** A refusal: never replaced by an aside (`useStatusLine`'s `inform`). */
  kind?: "refusal";
  /**
   * The refusal on a `kind: "refusal"` line: its words (the part in front of
   * `undoFor`, always ending a sentence), the notice that first said them,
   * and when. Only one ever goes in front: a later refusal replaces it.
   */
  refusal?: { words: string; id: number; at: number };
  /**
   * On a refusal line that carries a write's live Undo: that write's words
   * (behind the refusal) and the notice that first said them. The Undo
   * belongs to that write, never to the refusal in front of it.
   */
  undoFor?: { words: string; id: number };
  undo?: () => void;
  /** The undo is running: Undo stays put but does nothing until it lands. */
  undoing?: boolean;
}

export type Notify = (message: string, undo?: () => void) => void;

/**
 * Which notices of one status line have been said, shared by every line that
 * draws them (the page toast, the desk, the card drawer, the pack tray), so a
 * notice said by one is never said again by another that draws it later (the
 * desk's line coming back as the drawer closes). Ids are only ever handed out
 * in order: one at or below `floor` counts as said.
 */
export interface SpokenNotices {
  heard: Set<number>;
  floor: number;
}

/** A fresh record for a status line (`useStatusLine` holds one). */
export function spokenNotices(): SpokenNotices {
  return { heard: new Set(), floor: 0 };
}

/**
 * The status line's shared record. Without one (a prototype page), each line
 * keeps its own and counts the notice up when it mounted as said.
 */
export const NoticeSpokenContext = createContext<SpokenNotices | null>(null);

/**
 * The line's live region speaks once per notice id. A live region only
 * speaks when its text changes, so the same words twice ("Nothing to undo."
 * after "Nothing to undo.", one refusal after the same refusal) would go
 * unsaid: on every new id it is cleared, then given the words a frame later.
 * The same notice drawn again says nothing, nor does one another line of the
 * same status line already said (`SpokenNotices`): a line drawn over such a
 * notice holds its words without saying them. A line taken down empties it,
 * so no stale words are left to find.
 *
 * Nothing drawn is dropped unsaid: a notice that comes up before the last
 * one's frame has run joins it ("A B"), each said once. A line that joins
 * two notices' words (a refusal and a write's) says only the new part, unless
 * the notice that first said the other part was never said (both landed in
 * one render): then it says the whole line.
 */
function useLiveWords(notice: Notice | null) {
  const region = useRef<HTMLParagraphElement>(null);
  const id = notice?.id ?? null;
  const shared = useContext(NoticeSpokenContext);
  const [own] = useState(() => ({ heard: new Set<number>(), floor: id ?? 0 }));
  const spoken = shared ?? own;
  // `undefined`: this region has looked at nothing yet (just drawn).
  const spokeFor = useRef<number | null | undefined>(undefined);
  const pending = useRef<{ frame: number; ids: number[]; words: string[] } | null>(null);
  const words = useEffectEvent(() => {
    if (!notice) return "";
    const said = (earlier: number) => earlier <= spoken.floor || spoken.heard.has(earlier);
    const unheard = [notice.refusal?.id, notice.undoFor?.id].some(
      (earlier) => earlier !== undefined && earlier !== notice.id && !said(earlier),
    );
    return unheard ? notice.message : (notice.announce ?? notice.message);
  });
  // Layout effects: they run in the same task as the region is drawn, so a
  // region drawn holding words already said is seen as drawn with them.
  useLayoutEffect(() => {
    const el = region.current;
    if (!el || id === spokeFor.current) return;
    const drawn = spokeFor.current === undefined;
    spokeFor.current = id;
    if (id === null) {
      if (pending.current) cancelAnimationFrame(pending.current.frame);
      pending.current = null;
      el.textContent = "";
      return;
    }
    if (id <= spoken.floor || spoken.heard.has(id)) {
      // Said already, by this line or another. A line just drawn holds the
      // words quietly (a region drawn with its text says nothing), so what
      // it shows can still be found in it; one already up stays as it is.
      if (drawn) el.textContent = words();
      return;
    }
    const said = words();
    spoken.heard.add(id);
    // The frame has not run yet: these words go with the ones waiting.
    if (pending.current) {
      pending.current.ids.push(id);
      pending.current.words.push(said);
      return;
    }
    el.textContent = "";
    const next = { frame: 0, ids: [id], words: [said] };
    next.frame = requestAnimationFrame(() => {
      pending.current = null;
      el.textContent = next.words.join(" ");
    });
    pending.current = next;
  }, [id, spoken]);
  useLayoutEffect(
    () => () => {
      // Taken away before its frame ran (the drawer closing, the desk
      // changing): the words were never said, so the line drawn next says
      // them. Look again if this one is drawn again (StrictMode's rehearsal).
      const waiting = pending.current;
      if (waiting) {
        cancelAnimationFrame(waiting.frame);
        for (const unsaid of waiting.ids) spoken.heard.delete(unsaid);
      }
      pending.current = null;
      spokeFor.current = undefined;
    },
    [spoken],
  );
  return region;
}

/**
 * A status line's live region: visually hidden, ALWAYS mounted (a live
 * region inserted with text already in it says nothing), speaking once per
 * notice (`useLiveWords`). The words shown beside it are never a live region
 * of their own, so nothing is said twice.
 */
export function NoticeLiveRegion({ notice }: { notice: Notice | null }) {
  const live = useLiveWords(notice);
  return <p ref={live} role="status" className="sr-only" />;
}

/**
 * The words a line shows. A refusal in front of a write's words is set apart
 * in the negative ink, so the Undo beside them reads as that write's.
 */
export function NoticeWords({ notice }: { notice: Notice }) {
  const { refusal, undoFor } = notice;
  if (!refusal || !undoFor) return <>{notice.message}</>;
  return (
    <>
      <span className="text-neon-pink-text">{refusal.words}</span> {undoFor.words}
    </>
  );
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
  return (
    <div className={shell} data-notice-hold="">
      <NoticeLiveRegion notice={notice} />
      <div
        className={
          notice
            ? "flex items-center gap-3 rounded-md border border-neon-blue/60 bg-sheet px-3 py-2 text-sm shadow-lg"
            : ""
        }
      >
        {notice && (
          <p className="flex-1 text-ink">
            <NoticeWords notice={notice} />
          </p>
        )}
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
