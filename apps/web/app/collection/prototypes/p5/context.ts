import { createContext, useContext } from "react";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import type { CardId } from "../_shared/data";
import type { PcRef } from "./model";

/** Prototype 5's views, kept in the URL so Back works. */
export type View = "pcs" | "rainbows" | "binders" | "checklists";

export interface P5 {
  store: PrototypeStore;
  /** Distinct card ids with a copy, from the live store. */
  owned: Set<CardId>;

  /** Open the card drawer; focus returns to the opener when it closes. */
  openCard: (cardId: CardId) => void;
  /** "+": one raw copy, right now, with Undo. */
  quickAdd: (cardId: CardId) => void;
  /** Say something in the live region; an Undo button rides along when given. */
  announce: (message: string, undo?: () => void) => void;

  goView: (view: View) => void;
  goPc: (ref: PcRef) => void;

  followed: PcRef[];
  isFollowed: (ref: PcRef) => boolean;
  follow: (ref: PcRef) => void;
  unfollow: (ref: PcRef) => void;

  /** Rainbow roots (the base card's id) the collector is chasing. */
  chased: CardId[];
  toggleChase: (rootId: CardId) => void;
}

export const P5Context = createContext<P5 | null>(null);

export function useP5(): P5 {
  const ctx = useContext(P5Context);
  if (!ctx) throw new Error("useP5 outside prototype 5");
  return ctx;
}
