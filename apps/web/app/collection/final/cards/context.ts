import { createContext, useContext } from "react";
import type { Card, CardId, Copy, SetId } from "../data/types";
import type { PageApi } from "../pageApi";

/**
 * NEO-350 / NEO-358 — what every My Cards panel needs on top of the page's
 * drawer and status line: the handful of writes that always announce
 * themselves with an Undo, and the moves between the tab's views.
 */
export type MyCardsView = "home" | "needs";

export interface MyCardsApi extends PageApi {
  /** "Base #4 Reggie White": how a notice names a card. */
  label: (card: Card) => string;
  /** Have: one raw copy into the default home, announced, with Undo. `owned`: how many were already in hand. */
  addOne: (card: Card, owned?: number) => void;
  /**
   * A tile press. A need becomes a have. A have held as one line item of one
   * card is removed (with Undo). Anything more opens the drawer to pick.
   * `copies` are the card's copies in scope; `list` is what the drawer's ↑ ↓
   * step through.
   */
  toggleHave: (card: Card, copies: readonly Copy[], list: CardId[]) => void;
  /** Several haves at once (a range, a need list run), one Undo for all. */
  addMany: (cards: Card[], summary: (into: string) => string) => void;
  openSet: (setId: SetId) => void;
  go: (view: MyCardsView, setId?: SetId) => void;
  /** Where a new Have lands ("Main", "your collection"). */
  into: string;
  /** Demo: the binder that counts are narrowed to, when one is picked. */
  scopedName: string | null;
  /** Demo: on the Want List (always false without the `wants` capability). */
  isWanted: (cardId: CardId) => boolean;
}

export const MyCardsContext = createContext<MyCardsApi | null>(null);

export function useMyCards(): MyCardsApi {
  const api = useContext(MyCardsContext);
  if (!api) throw new Error("useMyCards outside the My Cards tab");
  return api;
}
