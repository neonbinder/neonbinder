import { createContext, useContext } from "react";
import type { Card, Copy, SetId } from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";

/**
 * NEO-350 prototype 3 — what every panel needs from the page: the live store
 * and the handful of actions that always announce themselves and offer Undo.
 */

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface P3Api {
  store: PrototypeStore;
  /** +1 copy, announced, with Undo and "Add details". */
  addOne: (card: Card, how?: string) => void;
  /**
   * A tile press: a need becomes a have (+1 copy). A have with one copy
   * record loses it (Undo puts it back). A have with several copy records
   * opens the details drawer to pick which one goes.
   */
  toggleHave: (card: Card, rowLabel?: string) => void;
  addMany: (cards: Card[], summary: string) => void;
  removeCopy: (copy: Copy) => void;
  openCard: (card: Card, opts?: { adding?: boolean; note?: string }) => void;
  notify: (message: string, undo?: () => void, extra?: ToastAction) => void;
  openSet: (setId: SetId) => void;
  go: (view: "home" | "needs" | "checklists", setId?: SetId) => void;
}

export const P3Context = createContext<P3Api | null>(null);

export function useP3(): P3Api {
  const api = useContext(P3Context);
  if (!api) throw new Error("useP3 outside the Checklist Wall page");
  return api;
}

/** "Base #4 Reggie White" / "Blue Foil #4 Reggie White" / "Pennant Flyers #2 …" */
export function shortName(card: Card, playerName: string): string {
  const variant = card.variantPath.name ?? "Base";
  const variation = card.variation ? ` (${card.variation})` : "";
  return `${variant} #${card.cardNumber}${variation} ${playerName}`;
}
