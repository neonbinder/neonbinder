import { createContext, useContext } from "react";
import type { Notify } from "../prototypes/p1/notice";
import type { EntityParam } from "./checklistParams";
import type { Card, CardId, CopyId, Suggestion, Undo } from "./data/types";

/**
 * NEO-358 — what the collection page hands its My Cards and Checklists views:
 * the one card drawer, the way to Checklists, and the status line with Undo.
 * The views read the catalog and the collection from the store hooks
 * (`./data/store`); nothing here holds data.
 */

export interface OpenCardOptions {
  mode?: "view" | "add";
  /** Ring this line item in "Your copies". */
  copyId?: CopyId;
  /** Card ids the drawer's ↑ ↓ step through; defaults to just this card. */
  list?: CardId[];
  /** The card as the opener already has it, so the drawer draws at once. */
  seed?: Card;
  /**
   * The home the add form files into instead of the page's scope (the
   * binder a want is for, the binder or box the drawer was opened from).
   */
  binderId?: string;
  /** NEO-377: open the `copyId` line's Edit form, when it is the card's one line. */
  edit?: boolean;
}

/** Where Checklists opens. Each is a history entry of its own. */
export type ChecklistsTarget =
  | { q?: string }
  | { cardId: CardId }
  /** A card in hand: straight to its checklist, its row ringed. */
  | { card: Card }
  | { setId: string }
  | { entity: EntityParam };

export interface PageApi {
  openCard: (cardId: CardId, opts?: OpenCardOptions) => void;
  goToChecklists: (target?: ChecklistsTarget) => void;
  /** A picked search suggestion: a player's or team's cards, or a set's checklist, in Checklists. */
  openSuggestion: (s: Suggestion) => void;
  notify: Notify;
  /**
   * An aside with no Undo of its own ("Nothing changed."): said on the
   * status line unless the line still offers an Undo, which it never
   * replaces. An aside never costs the collector an Undo.
   */
  inform: (message: string) => void;
  /**
   * Takes back the last change, as the status line's Undo does (the
   * keyboard's Ctrl/⌘+Z in quick entry). While a write is still saving it
   * says so, leaving the line's words up; with nothing to take back it says
   * that; while an undo is running it does nothing.
   */
  undoLast: () => void;
  /**
   * Runs a store write: on success says `message(result)` with an Undo, on a
   * refusal says why (`writeErrorMessage`). Resolves with the result, or null
   * when it was refused.
   */
  run: <T extends { undo: Undo }>(write: () => Promise<T>, message: (result: T) => string) => Promise<T | null>;
  /**
   * NEO-460: for a write that does not go through `run` (its own queue, a
   * dialog that shows its own refusal). Call it as the write starts: the
   * line's live Undo (the write before it) goes at once, so it is never
   * pressed while this one saves. The ticket says how the write went, and
   * every ticket must be answered (`done`, `refused` or `refusedElsewhere`):
   * until then Ctrl/⌘+Z says "Still saving.". Read
   * it through `startWrite(api)`. Every page that holds a status line gives
   * it; optional only so a test rig may leave it out.
   */
  beginWrite?: () => WriteTicket;
}

/** How a write started with `beginWrite` went, said on the status line. */
export interface WriteTicket {
  /** It landed: the words, with its Undo while no later write has started. */
  done: (message: string, undo?: () => void) => void;
  /** It was refused: why. Never left unsaid; a newer write's Undo stays. */
  refused: (message: string) => void;
  /**
   * It was refused, and the caller says why itself (a dialog's own error
   * line): nothing is said on the status line, and the write stops counting
   * as saving, so Ctrl/⌘+Z is not left saying "Still saving.".
   */
  refusedElsewhere: () => void;
}

/** `api.beginWrite()`, or plain `notify` where the page gives none (a test rig). */
export function startWrite(api: PageApi): WriteTicket {
  return (
    api.beginWrite?.() ?? {
      done: (message, undo) => api.notify(message, undo),
      refused: (message) => api.notify(message),
      refusedElsewhere: () => {},
    }
  );
}

export const PageApiContext = createContext<PageApi | null>(null);

export function usePageApi(): PageApi {
  const api = useContext(PageApiContext);
  if (!api) throw new Error("usePageApi: outside the collection page");
  return api;
}
