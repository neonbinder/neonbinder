import { useEffect, useRef, useState } from "react";
import type { Notice } from "../prototypes/p1/notice";
import { writeErrorMessage } from "./data/store";
import type { Undo } from "./data/types";
import type { PageApi, WriteTicket } from "./pageApi";

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

/**
 * What Ctrl/⌘+Z says while a write is still saving: said only (the words on
 * the line stay), since there is nothing to take back until it answers.
 */
export const STILL_SAVING = "Still saving.";

/** What an undo that the server refused says on the status line. */
function undoFailed(error: unknown): string {
  return `That undo didn't go through. ${writeErrorMessage(error)}`;
}

export const NOTICE_MS = 10_000;

/** The status line a page holds, and the page API's half that speaks on it. */
export interface StatusLine extends Pick<PageApi, "notify" | "inform" | "undoLast" | "run"> {
  beginWrite: () => WriteTicket;
  notice: Notice | null;
  /** The line's Undo button. */
  undo: () => void;
  /** The line's dismiss button: takes it down now. */
  dismiss: () => void;
}

export function useStatusLine(): StatusLine {
  const [notice, setNotice] = useState<Notice | null>(null);
  const held = useNoticeHold();
  // Every notice gets an id never used before on this line, even after the
  // line was taken down: an undo's answer finds the notice it ran from by id
  // (NEO-460), so a later notice must never wear the same one.
  const lastId = useRef(0);
  const nextId = () => ++lastId.current;
  // Writes started and not yet answered. Read from a ref, never from the
  // notice a render closed over: a Ctrl/⌘+Z in the same tick as `beginWrite`
  // still sees the earlier Undo on that notice.
  const saving = useRef(new Set<number>());
  // Notices up to this id lost their Undo to a write started since; one said
  // after it (that write's own, say) keeps its Undo.
  const undoFloor = useRef(0);
  // No manual memo here: the React Compiler memoizes these handlers itself.
  const notify = (message: string, undo?: () => void) => {
    const id = nextId();
    setNotice({ id, message, undo });
  };
  useEffect(() => {
    // A running undo keeps its line up: "Undone." (or why not) replaces it.
    if (!notice || held || notice.undoing) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, held]);
  /**
   * Says a refusal (a write's, or an undo's), which is never left unsaid. A
   * line holding a newer write's live Undo keeps it: the refusal goes first in
   * its words, and only the refusal is said (the newer words were said when
   * they landed). The Undo still belongs to that newer write, never to the
   * refusal in front of it. One refusal at a time goes in front: a later one
   * replaces it ("R2 R1 B" would read as two live problems; it is "R2 B").
   * Anything else on the line (the notice the undo ran from, a plain word, a
   * running undo's line) gives way to it.
   */
  const refuse = (message: string, ran?: number) => {
    const id = nextId();
    setNotice((prev) => {
      if (prev && prev.id !== ran && prev.undo && !prev.undoing) {
        const undoWords = prev.undoWords ?? prev.message;
        return { ...prev, id, kind: "refusal", message: `${message} ${undoWords}`, announce: message, undoWords };
      }
      return { id, message, kind: "refusal" };
    });
  };
  /** Says `message` with the line's words left as they are (shown when it has none). */
  const sayOnly = (message: string) => {
    const id = nextId();
    setNotice((prev) => (prev ? { ...prev, id, announce: message } : { id, message }));
  };
  // One undo at a time: a second press while the first is running does nothing.
  const undoing = useRef(false);
  const undo = () => {
    // `notice` is the one this render saw: an Undo a write started since
    // has taken (`beginWrite`, same tick) must not run from it.
    if (!notice?.undo || undoing.current || notice.id <= undoFloor.current) return;
    const run = notice.undo;
    undoing.current = true;
    const ran = notice.id;
    // Undo stays on the line, inert, until the write lands; "Undone." waits
    // for it, so whatever it put back is already the server's when the
    // collector reaches for it.
    setNotice((prev) => (prev && prev.id === ran ? { ...prev, undoing: true } : prev));
    // NEO-460: "Undone." takes the line only while it still shows the notice
    // the undo ran from. Anything newer said since stays, with or without an
    // Undo of its own, and "Undone." goes unsaid. A line taken down meanwhile
    // (dismissed) has nothing newer on it, so it is said. A refusal is never
    // left unsaid (`refuse`).
    runUndo(
      run,
      () => {
        undoing.current = false;
        const id = nextId();
        setNotice((prev) => (!prev || prev.id === ran ? { id, message: "Undone." } : prev));
      },
      (error) => {
        undoing.current = false;
        refuse(undoFailed(error), ran);
      },
    );
  };
  // An aside keeps a live Undo on the line: it is skipped rather than replace
  // it (an undo running counts too: its "Undone." is on the way). It never
  // replaces a refusal either: a refusal is never left unsaid.
  //
  // So the words of a write a later one overtook (its ticket's `done` comes
  // here) are dropped whenever the newest write's Undo, or a refusal, is on
  // the line. That is deliberate: they are old news, their Undo was never
  // offered, and the line on show is the one that matters. Don't "fix" it by
  // merging them in.
  const inform = (message: string) => {
    const id = nextId();
    setNotice((prev) => (prev?.undo || prev?.kind === "refusal" ? prev : { id, message }));
  };
  /**
   * Ctrl/⌘+Z from quick entry: the line's Undo; "Still saving." while a write
   * is still saving (its words stay up); or a word that there is none.
   */
  const undoLast = () => {
    if (undoing.current) return;
    if (notice?.undo && notice.id > undoFloor.current) undo();
    else if (saving.current.size > 0) sayOnly(STILL_SAVING);
    else notify(NOTHING_TO_UNDO);
  };
  // The newest write started on this line (NEO-460).
  const lastWrite = useRef(0);
  const beginWrite = (): WriteTicket => {
    const mine = ++lastWrite.current;
    saving.current.add(mine);
    undoFloor.current = lastId.current;
    const settle = () => saving.current.delete(mine);
    // NEO-460: a new write is under way, so the line's Undo (the write before
    // it) goes now, its words staying until this one answers: an Undo, or
    // Ctrl/⌘+Z ("Still saving."), in that gap must never take back the
    // earlier write. An undo already running keeps its inert button: its
    // "Undone." is on the way.
    setNotice((prev) => (prev?.undo && !prev.undoing ? { ...prev, undo: undefined } : prev));
    return {
      // Only the newest write's answer brings its Undo. One a later write
      // overtook is an aside: said while that write is still saving (no Undo
      // on the line), never over the Undo the later one brought.
      done: (message, undo) => {
        settle();
        if (mine === lastWrite.current) notify(message, undo);
        else inform(message);
      },
      refused: (message) => {
        settle();
        refuse(message);
      },
      refusedElsewhere: settle,
    };
  };
  const run = async <T extends { undo: Undo }>(
    write: () => Promise<T>,
    message: (result: T) => string,
  ): Promise<T | null> => {
    const ticket = beginWrite();
    try {
      const result = await write();
      ticket.done(message(result), result.undo);
      return result;
    } catch (error) {
      ticket.refused(writeErrorMessage(error));
      return null;
    }
  };
  const dismiss = () => setNotice(null);
  return { notice, notify, inform, undoLast, run, beginWrite, undo, dismiss };
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
