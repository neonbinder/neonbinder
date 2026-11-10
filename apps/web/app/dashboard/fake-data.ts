/**
 * NEO-464 — the dashboard prototypes' hard-coded fixture: everything a
 * collector's after-sign-in page could show, for one fake collector. Never
 * Convex, never Clerk; nothing here is read from or written to anywhere.
 *
 * Every card is a real card of the collection demo's fake catalog
 * (`app/collection/prototypes/_shared/catalog.ts`), handed out as the demo's
 * own view model (`demoCard`), so `CardFace` draws it with its art:
 *
 *   import CardFace from "@/app/collection/prototypes/_shared/CardFace";
 *   <CardFace model={dash.card} size="sm" />
 *
 * Counts come from the demo's seed (`myCopies`, `binders`, `buildingSetIds`,
 * the same seed the collection demo at `/demo/collection` starts from), so the numbers here
 * match what the demo binder shows. Two things go past the seed, on purpose,
 * and say so where they are built: the just-completed checklist (its last card
 * is "new" here) and the intake guesses.
 *
 * Rules the fixture keeps, so a prototype never has to:
 * - No values, prices or worth anywhere. No dates either: time is "days ago"
 *   (a whole number) or a relative label ("Today", "Tuesday").
 * - Sales are one row per order, oldest first. No buyer, no ship-by.
 *   `statusText` is the marketplace's own word, shown as it is.
 * - Sets on the board rank by FEWEST cards needed (base checklist).
 * - A smart binder carries a percent only when its rule names a checklist.
 * - One fake collector who has a bit of everything (sales, boxes, binders,
 *   boards, scans), so the one dashboard screen draws every section. The
 *   screen shows a section only when the data has something for it.
 *
 * Entry point: `getDashboard()`.
 */

import { demoCard } from "@/app/collection/final/data/demoStore";
import { compareCardNumbers } from "@/app/collection/final/data/labels";
import type { CardId, SetId, VariantKind } from "@/app/collection/final/data/types";
import { toDash, type DashCard } from "./dash-card";
import { HOUSE_VINYL, type Pocket, type ShelfBinder } from "./screen/shelf-model";
import {
  binderCards,
  binderCopies,
  binders as seedBinders,
  buildingSetIds as seedBuildingSetIds,
  cards as fixtureCards,
  describeRule,
  evaluateRule,
  getCard as getFixtureCard,
  getSet as getFixtureSet,
  myCopies,
  type Binder,
  type BinderRule,
  type Card as FixtureCard,
} from "@/app/collection/prototypes/_shared/data";

export type { DashCard } from "./dash-card";

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A demo card by id, as a DashCard. Throws on an id the demo does not hold. */
export function dashCard(id: CardId): DashCard {
  const card = demoCard(id);
  if (!card) throw new Error(`dashboard fixture: no demo card ${id}`);
  return toDash(card);
}

/**
 * The one demo card at (set, variant name, number, variation). Throws unless
 * exactly one matches: a card number is never unique on its own.
 */
function pick(setId: SetId, variantName: string | null, cardNumber: string | number, variation: string | null = null): DashCard {
  const matches = fixtureCards.filter(
    (c) =>
      c.setId === setId &&
      c.variantPath.name === variantName &&
      c.cardNumber === String(cardNumber) &&
      c.variation === variation,
  );
  if (matches.length !== 1) {
    throw new Error(`dashboard fixture: ${setId} ${variantName ?? "Base"} #${cardNumber} matched ${matches.length} cards`);
  }
  return dashCard(matches[0].id);
}

const SET = {
  contenders: "1996-playoff-contenders",
  udHockey: "1996-97-upper-deck-hockey",
  score: "2024-score-football",
  finest: "1993-finest-baseball",
  chrome: "2024-topps-chrome-baseball",
  topps: "2000-topps-football",
} as const;

// ---------------------------------------------------------------------------
// Sales (dealer only)
// ---------------------------------------------------------------------------

export type Marketplace = "bsc" | "sportlots" | "ebay";

/** How a marketplace badge reads. `short` fits a small pill; `name` is for an accessible name. */
export const MARKETPLACES: Record<Marketplace, { name: string; short: string }> = {
  bsc: { name: "BuySportsCards", short: "BSC" },
  sportlots: { name: "SportLots", short: "SportLots" },
  ebay: { name: "eBay", short: "eBay" },
};

/**
 * What is wrong with one line of an order.
 * - unmatched: the marketplace sold a listing NB cannot tie to a card of
 *   yours. `listingTitle` is the marketplace's own listing text, shown only
 *   to say which line it is; it is never NB data. Absent when NB has none
 *   (the signed-in page: NB stores no listing title on an order).
 * - oversold: it sold more than your boxes hold.
 */
export type SaleProblem =
  | { kind: "unmatched"; listingTitle?: string }
  | { kind: "oversold"; sold: number; inBoxes: number };

export interface SaleLine {
  /** The card sold; null only on an unmatched line. */
  card: DashCard | null;
  quantity: number;
  problem?: SaleProblem;
}

/** One order waiting to go out. */
export interface UnshippedSale {
  /** Stable key. */
  id: string;
  marketplace: Marketplace;
  /** The marketplace's order number, as it shows it. */
  orderNumber: string;
  /** Whole days since it sold: 0 = today. Warn from 2 (`isLate`). */
  daysSinceSold: number;
  /** The marketplace's own status word, verbatim. */
  statusText: string;
  /** In the order's own order. The demo's first line always has a card; a signed-in order's may not. */
  lines: SaleLine[];
  /** Sum of the lines' quantities (every line of the order, also any not listed in `lines`). */
  cardCount: number;
  /** The order's first card: its thumbnail and player lead the row. Null when no line is tied to a card. */
  firstCard: DashCard | null;
  /** True when any line has a problem. */
  hasProblem: boolean;
}

export interface SalesData {
  /** Every order not shipped yet, OLDEST FIRST. Empty means "All shipped. Nice." */
  unshipped: UnshippedSale[];
}

/** A row turns the warning colour from day 2. */
export function isLate(sale: Pick<UnshippedSale, "daysSinceSold">): boolean {
  return sale.daysSinceSold >= 2;
}

/** "Today", "Yesterday", "3 days ago". */
export function daysAgoLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function sale(id: string, marketplace: Marketplace, orderNumber: string, daysSinceSold: number, statusText: string, lines: SaleLine[]): UnshippedSale {
  const first = lines[0]?.card;
  if (!first) throw new Error(`dashboard fixture: sale ${id} must lead with a matched card`);
  return {
    id,
    marketplace,
    orderNumber,
    daysSinceSold,
    statusText,
    lines,
    cardCount: lines.reduce((n, l) => n + l.quantity, 0),
    firstCard: first,
    hasProblem: lines.some((l) => l.problem),
  };
}

/** Built in any order; sorted oldest first below. */
const UNSHIPPED_AS_BUILT: UnshippedSale[] = [
  sale("sale-sl-1", "sportlots", "1184207", 5, "Paid", [{ card: pick(SET.topps, null, 340), quantity: 1 }]),
  sale("sale-bsc-1", "bsc", "BSC-3920118", 3, "Ready to ship", [
    { card: pick(SET.udHockey, null, 1), quantity: 2 },
    { card: pick(SET.udHockey, null, 2), quantity: 1 },
    { card: pick(SET.udHockey, null, 18), quantity: 2, problem: { kind: "oversold", sold: 2, inBoxes: 1 } },
  ]),
  sale("sale-ebay-1", "ebay", "14-12873-40211", 2, "Paid", [
    { card: pick(SET.chrome, "Chrome Rookie Autographs", "RA-PS"), quantity: 1 },
  ]),
  sale("sale-bsc-2", "bsc", "BSC-3921456", 1, "Ready to ship", [
    { card: pick(SET.score, null, 301), quantity: 1 },
    { card: pick(SET.score, null, 302), quantity: 1 },
    { card: null, quantity: 1, problem: { kind: "unmatched", listingTitle: "2024 Score #333 Rome Odunze RC" } },
  ]),
  sale("sale-ebay-2", "ebay", "14-12880-11972", 0, "Paid", [{ card: pick(SET.contenders, null, 1), quantity: 1 }]),
  sale("sale-sl-2", "sportlots", "1184388", 0, "Paid", [
    { card: pick(SET.finest, null, 9), quantity: 1 },
    { card: pick(SET.finest, null, 10), quantity: 1 },
    { card: pick(SET.finest, null, 12), quantity: 1 },
  ]),
];

/** Oldest first: the order every sales list shows. */
const UNSHIPPED = [...UNSHIPPED_AS_BUILT].sort((a, b) => b.daysSinceSold - a.daysSinceSold);
const SALES: SalesData = { unshipped: UNSHIPPED };

// ---------------------------------------------------------------------------
// Newest additions
// ---------------------------------------------------------------------------

/** One card that came in, and the binder it went to. */
export interface AddedCard extends DashCard {
  /** The binder it was filed in ("'96 Contenders", "Main"). */
  binderName: string;
}

/** Cards that came in together. */
export interface AdditionBatch {
  id: string;
  /** Relative day: "Today", "Yesterday", "Tuesday", "Last weekend". Never a date. */
  whenLabel: string;
  /** Whole days ago (0 = today), for ordering and for prototypes that prefer a number. */
  daysAgo: number;
  /** The cards, NEWEST FIRST. Every card the batch holds: slice for a preview. */
  cards: AddedCard[];
  /** The binders they went into, with how many each: "34 cards into 2 binders". */
  binders: { name: string; count: number }[];
  /** True for batches since the collector's last visit (what "N new" counts). */
  sinceLastVisit: boolean;
}

function batch(id: string, whenLabel: string, daysAgo: number, sinceLastVisit: boolean, groups: [string, DashCard[]][]): AdditionBatch {
  const cards: AddedCard[] = groups.flatMap(([binderName, list]) => list.map((c) => ({ ...c, binderName })));
  return {
    id,
    whenLabel,
    daysAgo,
    cards,
    binders: groups.map(([name, list]) => ({ name, count: list.length })),
    sinceLastVisit,
  };
}

/**
 * The batches, newest first. All are cards the demo collector owns (the seed's
 * copies, filed where the demo files them), except the Topps Chrome Refractor
 * #13 in "Yesterday": the card that completed that checklist (`JUST_COMPLETED`).
 */
const ADDITIONS: AdditionBatch[] = [
  batch("batch-today", "Today", 0, true, [
    [
      "Main",
      [
        pick(SET.score, "Gridiron Heritage", 1),
        pick(SET.score, "Gridiron Heritage", 2),
        pick(SET.score, "Gold Zone", 10),
        pick(SET.score, "Lava", 302),
        pick(SET.score, null, 11),
        pick(SET.score, null, 12),
      ],
    ],
  ]),
  batch("batch-yesterday", "Yesterday", 1, true, [
    [
      "Ohtani rainbow",
      [
        pick(SET.chrome, "Gold Refractor", 1),
        pick(SET.chrome, "Green Refractor", 1),
        pick(SET.chrome, "Aqua Refractor", 1),
        pick(SET.chrome, "Negative Refractor", 1),
      ],
    ],
    ["Main", [pick(SET.chrome, "Refractor", 13), pick(SET.chrome, "Orange Refractor", 25), pick(SET.chrome, "Refractor", 25)]],
  ]),
  batch("batch-tuesday", "Tuesday", 3, true, [
    [
      "'96 Contenders",
      ["1", "2", "4", "5", "7", "8", "10", "11", "12", "14", "15", "16", "18", "19", "21", "23", "24", "25", "27", "29", "30", "32", "34", "39"]
        .reverse()
        .map((n) => pick(SET.contenders, null, n)),
    ],
    ["Main", ["11", "10", "9", "8", "7", "5", "4", "3", "2", "1"].map((n) => pick(SET.udHockey, null, n))],
  ]),
  batch("batch-weekend", "Last weekend", 6, false, [
    ["Main", [pick(SET.udHockey, "Legends", 2), pick(SET.udHockey, "Legends", 1), pick(SET.udHockey, null, 18)]],
    ["Slab case", [pick(SET.udHockey, "Game Jerseys", "GJ1")]],
  ]),
];

// ---------------------------------------------------------------------------
// Sets on the board
// ---------------------------------------------------------------------------

/** One checklist strip of a set (Scoreboard's dot strips): base, an insert, a parallel. */
export interface ChecklistStrip {
  /** "Base", "Pennant Flyers", "Blue Foil". */
  name: string;
  kind: VariantKind;
  have: number;
  total: number;
}

/** A set the collector is building. Counts are the BASE checklist unless a field says otherwise. */
export interface BuildingSet {
  setId: SetId;
  /** "1996 Playoff Contenders". */
  setLabel: string;
  have: number;
  total: number;
  /** total - have: what the board ranks by (fewest first). */
  need: number;
  /** Whole percent, floored: 24 of 40 is 60. Never 100 while one is needed. */
  percent: number;
  /** Every base card number still needed, in number order. Show a few ("Need: #3, #6, #9") and "+N more". */
  neededNumbers: string[];
  /**
   * The needed base cards themselves, for drawing and naming them. The demo
   * lists every one, in order. The signed-in page lists only the few the
   * board names (Want List cards first, then checklist order), since a big
   * set's needs are never all read: count with `need`, never with this.
   */
  neededCards: DashCard[];
  /**
   * One bulb per base card, in number order: the Scoreboard's base strip.
   * `cardId` when it is known for sure (the signed-in page knows every one);
   * absent, the board looks it up among `neededCards` by number.
   */
  baseBulbs: { cardNumber: string; owned: boolean; cardId?: string }[];
  /**
   * Base first, then inserts, then parallels: the Scoreboard's other strips.
   * The signed-in page lists only the Base strip (the board draws none).
   */
  checklists: ChecklistStrip[];
}

const owned = new Set(myCopies.map((c) => c.cardId));

function variantCards(setId: SetId, variantName: string | null): FixtureCard[] {
  return fixtureCards
    .filter((c) => c.setId === setId && c.variantPath.name === variantName)
    .sort(
      (a, b) =>
        compareCardNumbers(a.cardNumber, b.cardNumber) || Number(a.variation !== null) - Number(b.variation !== null),
    );
}

function buildingSet(setId: SetId): BuildingSet {
  const set = getFixtureSet(setId);
  // Base counts leave out image variations, as the demo's do.
  const base = variantCards(setId, null).filter((c) => c.variation === null);
  const have = base.filter((c) => owned.has(c.id)).length;
  const needed = base.filter((c) => !owned.has(c.id));
  const total = base.length;
  return {
    setId,
    setLabel: `${set.season} ${set.name}`,
    have,
    total,
    need: total - have,
    percent: total === 0 ? 0 : Math.floor((have / total) * 100),
    neededNumbers: needed.map((c) => c.cardNumber),
    neededCards: needed.map((c) => dashCard(c.id)),
    baseBulbs: base.map((c) => ({ cardNumber: c.cardNumber, owned: owned.has(c.id) })),
    checklists: set.variants.map((v) => {
      const list = variantCards(setId, v.path.name).filter((c) => v.path.type !== "Base" || c.variation === null);
      return {
        name: v.path.name ?? "Base",
        kind: v.path.type === "Base" ? "base" : v.path.type === "Inserts" ? "insert" : "parallel",
        have: list.filter((c) => owned.has(c.id)).length,
        total: list.length,
      };
    }),
  };
}

/** The demo's building sets, ranked by fewest needed (ties: higher percent first). */
const BUILDING: BuildingSet[] = seedBuildingSetIds
  .map(buildingSet)
  .sort((a, b) => a.need - b.need || b.percent - a.percent);

/** A checklist the collector just finished. Celebrate it once. */
export interface CompletedSet {
  /** Stable id: a prototype that celebrates once can remember it by this. */
  id: string;
  /** "2024 Topps Chrome Refractor". */
  label: string;
  setLabel: string;
  /** The checklist's name ("Refractor"); null when it is the base set. */
  checklistName: string | null;
  total: number;
  /** The card that finished it. */
  lastCard: DashCard;
  /** Every card in the checklist, in number order. */
  cards: DashCard[];
  /** Relative, like the batches: "Yesterday". */
  whenLabel: string;
}

/**
 * Goes one card past the demo seed: the seed owns Ohtani #1 and Skenes #25 of
 * the three Refractors; here De La Cruz #13 came in yesterday and finished it.
 */
const JUST_COMPLETED: CompletedSet = (() => {
  const cards = variantCards(SET.chrome, "Refractor").map((c) => dashCard(c.id));
  return {
    id: "done-2024-chrome-refractor",
    label: "2024 Topps Chrome Refractor",
    setLabel: "2024 Topps Chrome",
    checklistName: "Refractor",
    total: cards.length,
    lastCard: pick(SET.chrome, "Refractor", 13),
    cards,
    whenLabel: "Yesterday",
  };
})();

// ---------------------------------------------------------------------------
// Smart binders
// ---------------------------------------------------------------------------

export interface SmartBinderSummary {
  id: string;
  name: string;
  /** The rule in words: "Reggie White, any card". */
  ruleText: string;
  /** Cards of yours the rule holds now. */
  cardCount: number;
  /** How many came in since the last visit. 0 is real: say nothing new, don't hide the binder. */
  newCount: number;
  /** Those new cards, newest first (all of them; slice for thumbnails). */
  newCards: DashCard[];
  /**
   * Only when the rule names a checklist (a set): how complete it is. Absent
   * for a player, team, brand or alumni binder: never show a percent there.
   */
  checklist?: { have: number; total: number; percent: number };
}

/** A smart binder that names a checklist, so the percent case exists. Not in the demo's seed. */
const FINEST_BINDER: { id: string; name: string; rule: BinderRule } = {
  id: "smart-93-finest",
  name: "'93 Finest, every card",
  rule: { kind: "set", setId: SET.finest },
};

function smartBinders(): SmartBinderSummary[] {
  const recent = ADDITIONS.filter((b) => b.sinceLastVisit).flatMap((b) => b.cards);
  const smart = seedBinders.flatMap((b) => (b.kind === "smart" ? [{ id: b.id, name: b.name, rule: b.rule }] : []));
  return [...smart, FINEST_BINDER].map(({ id, name, rule }) => {
    const matches = (cardId: CardId) => evaluateRule(rule, getFixtureCard(cardId));
    const mine = myCopies.filter((c) => matches(c.cardId));
    const seen = new Set<CardId>();
    const newCards = recent.filter((c) => {
      if (seen.has(c.id) || !matches(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    const summary: SmartBinderSummary = {
      id,
      name,
      ruleText: describeRule(rule),
      cardCount: mine.reduce((n, c) => n + c.quantity, 0),
      newCount: newCards.length,
      newCards,
    };
    if (rule.kind === "set") {
      const all = fixtureCards.filter((c) => matches(c.id));
      const have = all.filter((c) => owned.has(c.id)).length;
      summary.checklist = { have, total: all.length, percent: Math.floor((have / all.length) * 100) };
    }
    return summary;
  });
}

// ---------------------------------------------------------------------------
// Want List, intake, boxes, trade pile
// ---------------------------------------------------------------------------

/** A card on the Want List. */
export interface WantCard extends DashCard {
  /** The binder it is wanted for ("Ohtani rainbow"); null for "just want it". */
  forBinder: string | null;
}

/** The demo seed's four wants, plus the Ohtani SuperFractor 1/1 as the top chase. */
const WANTS: WantCard[] = [
  { ...pick(SET.chrome, "SuperFractor", 1), forBinder: "Ohtani rainbow" },
  { ...pick(SET.chrome, "Red Refractor", 1), forBinder: "Ohtani rainbow" },
  { ...pick(SET.chrome, "Orange Refractor", 1), forBinder: "Ohtani rainbow" },
  { ...pick(SET.chrome, null, 12), forBinder: null },
  { ...pick(SET.contenders, null, 13), forBinder: null },
];

/** One uploaded scan still in intake. */
export interface IntakeScan {
  id: string;
  /**
   * The best match so far, waiting for the collector to confirm; null when
   * the scan has not been identified yet (draw an `EmptySleeve`, not a card).
   */
  guess: DashCard | null;
}

/** One upload still in intake, and where to finish it. */
export interface IntakeUpload {
  id: string;
  /** "Garage shoebox"; signed in, the name of the binder or box it is going to. */
  name: string;
  scans: number;
  done: number;
  /** Where the run is finished: Collection for a binder's, Inventory for a box's. */
  side: "collection" | "inventory";
  /** The Add cards tab on that screen, opened on this run. */
  href: string;
}

/** Scans uploaded and not yet in a binder. */
export interface IntakeInProgress {
  /** Every scan still in intake (waiting + needsYou). */
  total: number;
  /** Not identified yet. */
  waiting: number;
  /** Matched, waiting on the collector to say yes. */
  needsYou: number;
  /** The uploads they came from: "Garage shoebox, 24 scans, 6 done". */
  uploads: IntakeUpload[];
  /** A few scans for thumbnails: the needs-you ones first, then the waiting. */
  preview: IntakeScan[];
}

/** The guesses are catalog cards the demo collector does not own. */
const INTAKE: IntakeInProgress = {
  total: 20,
  waiting: 18,
  needsYou: 2,
  // The demo's runs are pretend, so each opens the demo's Add cards tab on its side.
  uploads: [
    { id: "upload-shoebox", name: "Garage shoebox", scans: 24, done: 6, side: "collection", href: "/demo/collection?tab=add" },
    { id: "upload-show", name: "Show pickups", scans: 2, done: 0, side: "inventory", href: "/demo/inventory?side=inventory&tab=add" },
  ],
  preview: [
    { id: "scan-1", guess: pick(SET.udHockey, "Legends", 4) },
    { id: "scan-2", guess: pick(SET.score, "Gridiron Heritage", 3) },
    { id: "scan-3", guess: null },
    { id: "scan-4", guess: null },
  ],
};

/** A box (inventory for sale) holding cards not listed anywhere yet. */
export interface UnlistedBox {
  id: string;
  name: string;
  /** Cards in it not listed on any marketplace. */
  unlisted: number;
}

const UNLISTED_BOXES: UnlistedBox[] = [
  { id: "box-unsorted", name: "Unsorted", unlisted: 12 },
  { id: "box-show", name: "Show box", unlisted: 3 },
];

/** Copies flagged Up for Trade. */
export interface TradePile {
  count: number;
  /** A few of them, for thumbnails. */
  cards: DashCard[];
}

/**
 * The demo's trade rule (`final/store.ts` seedCopy): a single Trade bait copy
 * with no serial and no cost stays in the collection, up for trade.
 */
const TRADE_PILE: TradePile = (() => {
  const flagged = myCopies.filter(
    (c) => c.binderIds.includes("binder-trade-bait") && c.quantity === 1 && !c.serialNumber && c.costBasis === undefined,
  );
  return { count: flagged.length, cards: flagged.map((c) => dashCard(c.cardId)) };
})();

// ---------------------------------------------------------------------------
// The whole page
// ---------------------------------------------------------------------------

export interface DashboardData {
  /** null when the account does not sell (no listing platform, no order): no sales section at all. */
  sales: SalesData | null;
  /** Newest batch first. */
  additions: AdditionBatch[];
  /** Ranked by fewest cards needed. */
  building: BuildingSet[];
  /** The checklist just finished, or null. */
  justCompleted: CompletedSet | null;
  smartBinders: SmartBinderSummary[];
  /**
   * The chase, top chase first. The demo holds five; the signed-in page
   * takes the Want List's newest, at most `CHASE_CAP` (12, `real/useRealDashboard`).
   */
  wantList: WantCard[];
  intake: IntakeInProgress;
  /** Boxes with cards held off the marketplaces; empty draws nothing. */
  unlistedBoxes: UnlistedBox[];
  tradePile: TradePile;
  /**
   * For a greeting line: how big the collection is. No values. `exact`
   * false: the store could count only part of it, so `cards` is a floor
   * (absent reads as exact).
   */
  totals: { cards: number; binders: number; exact?: boolean };
  /**
   * The binders on the shelf, each with its pockets already laid out. The
   * signed-in page supplies them from the collection store; absent (the
   * demo), the screen derives the demo's shelf from the rest (`bindersOf`).
   */
  binders?: ShelfBinder[];
}

const BINDER_COUNT = seedBinders.filter((b) => b.id !== "binder-trade-bait").length + 1; // + Main
const CARD_COUNT = myCopies.reduce((n, c) => n + c.quantity, 0);

const SMART = smartBinders();

const DASHBOARD: DashboardData = {
  sales: SALES,
  additions: ADDITIONS,
  building: BUILDING,
  justCompleted: JUST_COMPLETED,
  smartBinders: SMART,
  wantList: WANTS,
  intake: INTAKE,
  unlistedBoxes: UNLISTED_BOXES,
  tradePile: TRADE_PILE,
  totals: { cards: CARD_COUNT, binders: BINDER_COUNT },
};

/** The fake collector's dashboard, every section filled. Built once at load: the same object every call. */
export function getDashboard(): DashboardData {
  return DASHBOARD;
}

// ---------------------------------------------------------------------------
// The demo's shelf
// ---------------------------------------------------------------------------
//
// One shelf, no split: Main, the seed's manual binders (minus Trade bait,
// whose single copies are the trade pile) and the smart binders stand
// together, ordered by the shelf (`shelfOrder`).
//
// Smart binders here do NOT fill themselves. A smart binder holds the cards
// you filed in it; its rule only says which of your cards could fit. The
// fixture has no "filed" flag, so the demo draws the line at the last visit:
// matching cards you owned before it are filed; matching cards that came in
// since (`SmartBinderSummary.newCards`) are not filed yet, so they are the
// "could fit" candidates, and a smart spine wears no "new" sticker this
// visit. A percent shows only where the rule names a checklist.
//
// Spine colours are the vinyl of a physical binder: the livery of the team
// most of its cards wear, never a theme colour.

const MAIN_ID = "main";
const TRADE_BAIT_ID = "binder-trade-bait";

/**
 * The fixture's one smart binder that is not in the demo seed ('93 Finest,
 * every card) does not export its rule; it is restated here so its pocket
 * page can draw the checklist. Keep in step with `FINEST_BINDER` above.
 */
const EXTRA_RULES: Record<string, BinderRule> = {
  [FINEST_BINDER.id]: FINEST_BINDER.rule,
};

function liveryOf(cards: DashCard[]): { vinyl: string; stripe: string } {
  const tally = new Map<string, { n: number; primary: string; secondary: string }>();
  for (const c of cards) {
    const team = c.card.teams[0];
    if (!team?.primary) continue;
    const prev = tally.get(team.name);
    if (prev) prev.n += 1;
    else tally.set(team.name, { n: 1, primary: team.primary, secondary: team.secondary ?? team.primary });
  }
  let best: { n: number; primary: string; secondary: string } | null = null;
  for (const t of tally.values()) if (!best || t.n > best.n) best = t;
  return best ? { vinyl: best.primary, stripe: best.secondary } : HOUSE_VINYL;
}

/** Distinct cards of a list of copies, in the order given. */
function distinctCards(copies: { cardId: string }[]): DashCard[] {
  const seen = new Set<string>();
  const out: DashCard[] = [];
  for (const c of copies) {
    if (seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    out.push(dashCard(c.cardId));
  }
  return out;
}

function mainCopies() {
  return myCopies.filter((c) => c.binderIds.length === 0);
}

function quantityOf(copies: { quantity: number }[]): number {
  return copies.reduce((n, c) => n + c.quantity, 0);
}

/** New cards since the last visit, by the binder they were filed in. */
function newByBinderName(data: DashboardData): Map<string, DashCard[]> {
  const out = new Map<string, DashCard[]>();
  for (const batch of data.additions) {
    if (!batch.sinceLastVisit) continue;
    for (const c of batch.cards) {
      const list = out.get(c.binderName) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      out.set(c.binderName, list);
    }
  }
  return out;
}

function binderById(id: string): Binder | null {
  const seed = seedBinders.find((b) => b.id === id);
  if (seed) return seed;
  const rule = EXTRA_RULES[id];
  return rule ? { id, kind: "smart", name: id, description: "", rule } : null;
}

/**
 * What a binder holds, in its own order: a binder with pages keeps them
 * (empty pockets included); a checklist binder shows every card of the
 * checklist, with an empty pocket where one is not filed; anything else is
 * the cards filed in it. `unfiled` leaves a smart binder's could-fit cards out.
 */
function contentsOf(
  id: string,
  unfiled: Set<string> = new Set(),
): { cards: DashCard[]; pages: (string | null)[][] | null; checklist: boolean } {
  if (id === MAIN_ID) return { cards: distinctCards(mainCopies()), pages: null, checklist: false };
  const binder = binderById(id);
  if (!binder) return { cards: [], pages: null, checklist: false };
  if (binder.kind === "manual" && binder.layout) {
    const cardOfCopy = new Map(myCopies.map((c) => [c.id, c.cardId]));
    const pages = binder.layout.map((p) => p.slots.map((slot) => (slot ? (cardOfCopy.get(slot) ?? null) : null)));
    return { cards: distinctCards(binderCopies(binder)), pages, checklist: false };
  }
  if (binder.kind === "smart" && binder.rule.kind === "set") {
    return { cards: binderCards(binder).map((c) => dashCard(c.id)), pages: null, checklist: true };
  }
  return {
    cards: distinctCards(binderCopies(binder).filter((c) => !unfiled.has(c.cardId))),
    pages: null,
    checklist: false,
  };
}

/** A shelf binder before its pockets are laid out. */
type BareBinder = Omit<ShelfBinder, "pockets" | "checklistCards">;

/**
 * The binder's pockets, nine to a page. A plain binder leads with what came
 * in since the last visit (so the first page is the news), then the rest in
 * checklist order. A binder with pages, or a checklist, keeps its own order
 * and marks the new ones where they sit.
 */
function demoPockets(binder: BareBinder): Pocket[] {
  const unfiled = new Set(binder.couldFit.map((c) => c.id));
  const { cards, pages, checklist } = contentsOf(binder.id, unfiled);
  const fresh = new Set(binder.newCards.map((c) => c.id));

  if (pages) {
    return pages.flatMap((slots, p) =>
      slots.map((cardId, s): Pocket => {
        const key = `p${p}-s${s}`;
        if (!cardId) return { kind: "empty", key, card: null };
        return { kind: "card", card: dashCard(cardId), isNew: fresh.has(cardId), key };
      }),
    );
  }

  if (checklist) {
    return cards.map(
      (c): Pocket =>
        owned.has(c.id) && !unfiled.has(c.id)
          ? { kind: "card", card: c, isNew: fresh.has(c.id), key: c.id }
          : { kind: "empty", key: c.id, card: c },
    );
  }

  const rest = cards.filter((c) => !fresh.has(c.id));
  return [
    ...binder.newCards.map((c): Pocket => ({ kind: "card", card: c, isNew: true, key: c.id })),
    ...rest.map((c): Pocket => ({ kind: "card", card: c, isNew: false, key: c.id })),
  ];
}

/**
 * A smart binder's checklist, card by card, when its rule names one (else
 * null): every card the rule names, in checklist order, and whether it is
 * filed in the binder.
 */
function demoChecklist(binder: BareBinder): { card: DashCard; filed: boolean }[] | null {
  if (binder.kind !== "smart" || !binder.checklist) return null;
  const unfiled = new Set(binder.couldFit.map((c) => c.id));
  const { cards, checklist } = contentsOf(binder.id, unfiled);
  if (!checklist) return null;
  return cards.map((card) => ({ card, filed: owned.has(card.id) && !unfiled.has(card.id) }));
}

function laidOut(binder: BareBinder): ShelfBinder {
  return { ...binder, pockets: demoPockets(binder), checklistCards: demoChecklist(binder) };
}

/** Every binder on the demo's shelf, in the fixture's order (Main first), pockets laid out. `shelfOrder` sorts them. */
export function bindersOf(data: DashboardData): ShelfBinder[] {
  const fresh = newByBinderName(data);

  const main: BareBinder = {
    id: MAIN_ID,
    name: "Main",
    kind: "manual",
    ruleText: null,
    cardCount: quantityOf(mainCopies()),
    newCards: fresh.get("Main") ?? [],
    couldFit: [],
    checklist: null,
    ...HOUSE_VINYL,
  };

  const manual: BareBinder[] = seedBinders
    .filter((b) => b.kind === "manual" && b.id !== TRADE_BAIT_ID)
    .map((b) => {
      const copies = binderCopies(b);
      return {
        id: b.id,
        name: b.name,
        kind: "manual",
        ruleText: null,
        cardCount: quantityOf(copies),
        newCards: fresh.get(b.name) ?? [],
        couldFit: [],
        checklist: null,
        ...liveryOf(distinctCards(copies)),
      };
    });

  const smart: BareBinder[] = data.smartBinders.map((s) => {
    // Cards that came in since the last visit match the rule but are not filed in it (see above).
    const couldFit = s.newCards;
    const unfiled = new Set(couldFit.map((c) => c.id));
    const unfiledCopies = myCopies.filter((c) => unfiled.has(c.cardId));
    return {
      id: s.id,
      name: s.name,
      kind: "smart",
      ruleText: s.ruleText,
      cardCount: s.cardCount - quantityOf(unfiledCopies),
      newCards: [],
      couldFit,
      checklist: s.checklist ?? null,
      ...liveryOf(contentsOf(s.id, unfiled).cards),
    };
  });

  return [main, ...manual, ...smart].map(laidOut);
}
