import { useEffect, useRef, useState } from "react";
import type { Notice } from "../prototypes/p1/notice";
import { writeErrorMessage } from "./data/store";
import type { Undo } from "./data/types";
import type { PageApi } from "./pageApi";

/**
 * NEO-358 / NEO-464 — the one status line with its Undo, as a page holds it:
 * what the last write said, the timer that takes it down, and the Undo that
 * takes the write back. The collection page (`./FinalCollectionPage`) holds
 * one for its tabs and its card drawer; the dashboard's card panel holds one
 * of its own (`app/dashboard/screen/CardPanelHost`).
 *
 * The line waits while the pointer rests on it or the keyboard is in it, so
 * Undo can always be reached in time (WCAG 2.2.1); it counts again after.
 */

/**
 * Runs a notice's undo. A store's undo is a write of its own: the demo's
 * lands in this same click, a server's when it answers. `onDone` runs once it
 * has landed (never before: a line the undo puts back is only the server's
 * once it answers), `onError` when it was refused.
 */
function runUndo(undo: () => unknown, onDone: () => void, onError: (error: unknown) => void) {
  let pending: unknown;
  try {
    pending = undo();
  } catch (error) {
    onError(error);
    return;
  }
  if (pending instanceof Promise) pending.then(onDone, onError);
  else onDone();
}

/** What Ctrl/⌘+Z says when the status line has no Undo to give. */
export const NOTHING_TO_UNDO = "Nothing to undo.";

/** What an undo that the server refused says on the status line. */
function undoFailed(error: unknown): string {
  return `That undo didn't go through. ${writeErrorMessage(error)}`;
}

export const NOTICE_MS = 10_000;

/** The status line a page holds, and the page API's half that speaks on it. */
export interface StatusLine extends Pick<PageApi, "notify" | "inform" | "undoLast" | "run"> {
  notice: Notice | null;
  /** The line's Undo button. */
  undo: () => void;
  /** The line's dismiss button: takes it down now. */
  dismiss: () => void;
}

export function useStatusLine(): StatusLine {
  const [notice, setNotice] = useState<Notice | null>(null);
  const held = useNoticeHold();
  // No manual memo here: the React Compiler memoizes these handlers itself.
  const notify = (message: string, undo?: () => void) => {
    setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, message, undo }));
  };
  useEffect(() => {
    // A running undo keeps its line up: "Undone." (or why not) replaces it.
    if (!notice || held || notice.undoing) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, held]);
  // One undo at a time: a second press while the first is running does nothing.
  const undoing = useRef(false);
  const undo = () => {
    if (!notice?.undo || undoing.current) return;
    const run = notice.undo;
    undoing.current = true;
    const ran = notice.id;
    // Undo stays on the line, inert, until the write lands; "Undone." waits
    // for it, so whatever it put back is already the server's when the
    // collector reaches for it.
    setNotice((prev) => (prev && prev.id === ran ? { ...prev, undoing: true } : prev));
    runUndo(
      run,
      () => {
        undoing.current = false;
        notify("Undone.");
      },
      (error) => {
        undoing.current = false;
        notify(undoFailed(error));
      },
    );
  };
  /** Ctrl/⌘+Z from quick entry: the line's Undo, or a word that there is none. */
  // An aside keeps a live Undo on the line: it is skipped rather than replace
  // it (an undo running counts too: its "Undone." is on the way).
  const inform = (message: string) => {
    setNotice((prev) => (prev?.undo ? prev : { id: (prev?.id ?? 0) + 1, message }));
  };
  const undoLast = () => {
    if (undoing.current) return;
    if (notice?.undo) undo();
    else notify(NOTHING_TO_UNDO);
  };
  const run = async <T extends { undo: Undo }>(
    write: () => Promise<T>,
    message: (result: T) => string,
  ): Promise<T | null> => {
    try {
      const result = await write();
      notify(message(result), result.undo);
      return result;
    } catch (error) {
      notify(writeErrorMessage(error));
      return null;
    }
  };
  const dismiss = () => setNotice(null);
  return { notice, notify, inform, undoLast, run, undo, dismiss };
}

/** Room kept under a field the keyboard reaches while the floating status line is up. */
const NOTICE_CLEARANCE = "6rem";

/**
 * While the floating status line sits over the bottom of the page, keep a
 * field the keyboard lands on clear of it (WCAG 2.4.11).
 */
export function useFloatingClearance(floating: boolean): void {
  useEffect(() => {
    if (!floating) return;
    const root = document.documentElement;
    const before = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = NOTICE_CLEARANCE;
    return () => {
      root.style.scrollPaddingBottom = before;
    };
  }, [floating]);
}

/** Marks a status line whose timer waits while it is pointed at or focused (`../prototypes/p1/notice`, the pack tray). */
const NOTICE_HOLD_ATTR = "data-notice-hold";

/**
 * True while the pointer rests on, or the keyboard focus is inside, an
 * element marked `data-notice-hold` (the status line with its Undo, wherever
 * it is drawn: the page toast, the card drawer, the pack tray).
 */
function useNoticeHold(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let hover = false;
    let focus = false;
    const inLine = (t: EventTarget | null) =>
      t instanceof Element && t.closest(`[${NOTICE_HOLD_ATTR}]`) !== null;
    const sync = () => setHeld(hover || focus);
    const onOver = (e: MouseEvent) => {
      hover = inLine(e.target);
      sync();
    };
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) {
        hover = false;
        sync();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      focus = inLine(e.target);
      sync();
    };
    const onFocusOut = (e: FocusEvent) => {
      focus = inLine(e.relatedTarget);
      sync();
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return held;
}
