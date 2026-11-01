import { createContext, useContext } from "react";
import type { Card, CardId, SetId } from "../../prototypes/_shared/data";
import type { CollectionStore, CollectionTabProps } from "../store";

/**
 * NEO-350 — what every My Cards panel needs: the shared store and drawer
 * (through the tab props), plus the handful of actions that always announce
 * themselves on the page's status line and offer Undo.
 */
export type MyCardsView = "home" | "needs";

export interface MyCardsApi extends CollectionTabProps {
  store: CollectionStore;
  /** "Base #4 Reggie White": how a notice names a card. */
  label: (card: Card) => string;
  /** Have: one raw copy into the target binder, announced, with Undo. */
  addOne: (card: Card) => void;
  /**
   * A tile press. A need becomes a have. A have held as one line item of one
   * card is removed (with Undo). Anything more opens the drawer to pick.
   * `list` is what the drawer's ↑ ↓ step through.
   */
  toggleHave: (card: Card, list: CardId[]) => void;
  /** Several haves at once (a range, a need list run), one Undo for all. */
  addMany: (cards: Card[], summary: (into: string) => string) => void;
  openSet: (setId: SetId) => void;
  go: (view: MyCardsView, setId?: SetId) => void;
  /** The binder that counts are narrowed to, when one is picked. */
  scopedName: string | null;
}

export const MyCardsContext = createContext<MyCardsApi | null>(null);

export function useMyCards(): MyCardsApi {
  const api = useContext(MyCardsContext);
  if (!api) throw new Error("useMyCards outside the My Cards tab");
  return api;
}
