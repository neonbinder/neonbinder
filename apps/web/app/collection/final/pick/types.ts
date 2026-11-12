/**
 * NEO-500 — the Pick List's data, as any store hands it over.
 *
 * Two stores sit behind one UI, as everywhere on the collection page: the
 * public demo's hard-coded fixture (`./demoPickStore`) today, the seller's
 * real open orders on Convex later. The UI reads only what is here, so the
 * real store slots in by supplying a `PickListStore` through
 * `PickListStoreContext` (`./store`).
 *
 * One `SaleLine` is one line of one order: a copy NB has to pull from a box.
 * The UI merges and orders them (`./model`); a store never pre-merges.
 */

import type { Card } from "../data/types";

/** An order a line came from: the marketplace's own order number, shown as the seller sees it there. */
export interface PickOrder {
  /** NB's id for the order. */
  id: string;
  /** Where it sold, as a short label: "eBay", "BSC". */
  venue: string;
  /** The marketplace's order number: "12-3456". */
  number: string;
}

/** A slab's grade. */
export interface PickGrade {
  /** "PSA", "SGC", "BGS". */
  grader: string;
  /** "10", "9.5", "Authentic". */
  grade: string;
  /** The grader's certificate number. */
  cert: string;
}

/** Where the copy sits, so the seller can walk to it. */
export interface PickSpot {
  boxId: string;
  /** The slot inside the box, when the box keeps slots. */
  slot?: number;
}

/** A photo of the very copy that sold: the small one for the row, the big one for the dialog. */
export interface PickPhoto {
  thumbUrl: string;
  imageUrl: string;
}

/** A box the seller keeps inventory in. */
export interface PickBox {
  id: string;
  /** The box's own name: "2026 Baseball", "Box 2". */
  name: string;
  /** The catch-all box for copies not filed anywhere yet: always last. */
  unsorted?: boolean;
}

/**
 * NEO-509 — the card a sale line was listed as, in the marketplace's own
 * words, kept on the sale for the Pick List only (never written to an NB
 * card, set or player). The store resolves it: the sport through NB's own
 * sport row when the sale names one, the year as a number, the variant's
 * role from its word. Every field is optional: a line shows what it has.
 *
 * With a sport, a year, a set name and a card number the line is walked
 * with its set (`./model` `rowFacts`); with less it stays in "Can't find it".
 */
export interface ListedCard {
  /** NB's sport row, when the sale named one NB knows. */
  sportId?: string;
  /** NB's sport name when resolved, else the listing's own sport word. */
  sportName?: string;
  /** NB's sport code ("BB"), resolved sports only: it picks the divider colour. */
  sportCode?: string;
  /** The year the set files under (a season's start), 1800 to 2100. */
  year?: number;
  /** The listing's year as written ("2023-24"), for the label. */
  season?: string;
  /** The listing's set name: "Score", "Topps Chrome". */
  setName?: string;
  /** The listing's players, as written. */
  players?: string;
  cardNumber?: string;
  /** The divider the variant's word names; absent when the line names no variant. */
  role?: "base" | "parallel" | "insert";
  /** The insert or parallel's name: "1991 Throwback". */
  variantName?: string;
}

/**
 * One line of one order to pull.
 *
 * - `card` is NB's card when the sale matched one; null when NB could not
 *   match the listing to a card (it goes in "Can't find it" with `problem`,
 *   or with its set when `listed` says enough).
 * - `sportCode` is NB's own code for the card's sport (the sport row's SKU
 *   code: "BB", "FB", "BK", "HK"); it picks the divider colour. Never the
 *   sport's name.
 */
export interface SaleLine {
  id: string;
  card: Card | null;
  sportCode: string | null;
  /** The listing's own title, shown when there is no card. */
  listingTitle: string;
  /** NEO-509 — on a line with no card: what the sale says the card is, when it says anything. */
  listed?: ListedCard;
  /** Why NB could not match it (only on a line with no card). */
  problem?: string;
  /** Copies sold on this line. */
  quantity: number;
  /** "NM", "EX", "VG"; a slab's grade lives in `grade`. */
  condition: string;
  /** This copy's serial, "23/99", when it is numbered. */
  serial?: string;
  grade?: PickGrade;
  order: PickOrder;
  /**
   * Where the copy sits. On a `boxUnrecorded` line it is the box the listing
   * was pushed from, a best guess, when the store has one.
   */
  spot?: PickSpot;
  /**
   * NB did not note which box the copy came from (a sale applied before the
   * Pick List kept track). With no `spot` it is walked as its own stop.
   */
  boxUnrecorded?: boolean;
  /** The sold copy's own photo, when it has one; the row draws the card otherwise. */
  photo?: PickPhoto;
  /** The sale took every copy NB held. */
  lastOnes?: boolean;
  /** NB held fewer copies than sold: this many short. */
  short?: number;
  /** Arrived after the seller started this pull. */
  isNew?: boolean;
}

export interface PickListData {
  lines: readonly SaleLine[];
  boxes: readonly PickBox[];
  /** The store holds more to pull than it handed over (the list is cut short). */
  truncated?: boolean;
}

/**
 * What a Pick List store supplies. `data` is undefined while loading.
 * `pulled` holds sale-line ids; `setPulled` marks lines pulled or not and
 * resolves once it has landed.
 */
export interface PickListStore {
  kind: "demo" | "convex";
  data: PickListData | undefined;
  pulled: ReadonlySet<string>;
  /**
   * The demo's answers nothing (it is instant); the real one a promise that
   * resolves once the server has the mark and rejects (after putting the
   * tick back) when it could not save.
   */
  setPulled: (lineIds: readonly string[], pulled: boolean) => void | Promise<void>;
}
