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
   * Runs a store write: on success says `message(result)` with an Undo, on a
   * refusal says why (`writeErrorMessage`). Resolves with the result, or null
   * when it was refused.
   */
  run: <T extends { undo: Undo }>(write: () => Promise<T>, message: (result: T) => string) => Promise<T | null>;
}

export const PageApiContext = createContext<PageApi | null>(null);

export function usePageApi(): PageApi {
  const api = useContext(PageApiContext);
  if (!api) throw new Error("usePageApi: outside the collection page");
  return api;
}
