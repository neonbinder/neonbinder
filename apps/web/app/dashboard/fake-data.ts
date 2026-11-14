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
 * match what the demo binder shows. Where a card lives (a binder, a box), the
 * Want List and the trade pile come from the demo's collection store as it
 * starts (`initialCollectionState`), because that is what a card's panel
 * opens on: every card here says what its panel says (a Fresh Pull is filed in
 * the binder it names, a New Listing, an order line and a held-back card sit in
 * a box, the chase is the Want List). Only the intake guesses go past the seed,
 * on purpose: they are cards the collector does not own yet.
 *
 * Rules the fixture keeps, so a prototype never has to:
 * - No values or worth anywhere: the only money is the price the collector
 *   set on a card for sale (New Listings, which Jason asked to carry it). No
 *   dates either: time is "days ago" (a whole number) or a relative label
 *   ("Today", "Tuesday").
 * - Sales are one row per order, oldest first. No buyer, no ship-by.
 *   `statusText` is the marketplace's own word, shown as it is.
 * - Sets on the board rank by FEWEST cards needed (base checklist).
 * - A smart binder carries a percent only when its rule names a checklist.
 * - One fake collector who has a bit of everything (sales, boxes, binders,
 *   boards, scans), so the one dashboard screen draws every section. The
 *   screen shows a section only when the data has something for it.
 *
 * Entry point: `getDashboard()`.
 *
 * The demo's sample (`final/data/sample`, loaded first) is what fills the
 * cheer and the Reggie White binder: the 1989 Score set, finished today, and
 * real Reggie White cards. Sample data from published checklists, not NB data.
 */

// First: the sample adds its sets and copies before anything below reads them.
import { SCORE_1989_FOOTBALL_ID, SCORE_1989_LAST_CARD, SCORE_1989_TODAY } from "@/app/collection/final/data/sample";
import { demoCard } from "@/app/collection/final/data/demoStore";
import { initialCollectionState, MAIN_BINDER_ID } from "@/app/collection/final/store";
import { compareCardNumbers } from "@/app/collection/final/data/labels";
import type { CardId, ListingProblemReason, SetId, VariantKind } from "@/app/collection/final/data/types";
import { dashSetLabel, setRefLabel, toDash, type DashCard } from "./dash-card";
import type { Marketplace } from "./dash-labels";
import { DEFAULT_SPINE_FONT_ID } from "@/lib/print/spine-fonts";
import { labelOf, PLAIN_LABEL } from "@/app/collection/final/binders/label";
import type { ContainerLabel } from "@/app/collection/final/data/types";
import type { Pocket, ShelfBinder } from "./screen/shelf-model";
import {
  binderCards,
  binderCopies,
  binders as seedBinders,
  buildingSetIds as seedBuildingSetIds,
  cards as fixtureCards,
  describeRule,
  evaluateRule,
  getBrand as getFixtureBrand,
  getCard as getFixtureCard,
  getSet as getFixtureSet,
  getSport as getFixtureSport,
  myCopies,
  type Binder,
  type BinderRule,
  type Card as FixtureCard,
} from "@/app/collection/prototypes/_shared/data";

export type { DashCard } from "./dash-card";

/** A demo set as the dashboard names it, brand and all, the way its cards' titles do ("1993 Topps Finest"). */
function fixtureSetLabel(set: { season: string; name: string; brandId: string }): string {
  return dashSetLabel({ season: set.season, name: set.name, brand: getFixtureBrand(set.brandId).name });
}

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
  score89: SCORE_1989_FOOTBALL_ID,
  contenders: "1996-playoff-contenders",
  udHockey: "1996-97-upper-deck-hockey",
  score: "2024-score-football",
  finest: "1993-finest-baseball",
  chrome: "2024-topps-chrome-baseball",
  topps: "2000-topps-football",
} as const;

// ---------------------------------------------------------------------------
// Where the demo's cards live: the collection store as it starts
// ---------------------------------------------------------------------------

/** The demo store as `/demo/collection` and every card panel start it. */
const STORE = initialCollectionState();
const CONTAINERS = new Map(STORE.containers.map((c) => [c.id, c]));

/** The store's lines in a box (Inventory), in the store's order. */
const BOX_LINES = STORE.copies.filter((c) => CONTAINERS.get(c.homeId)?.kind === "box");

/** Copies of a card in the collector's boxes. */
function inBoxes(cardId: CardId): number {
  return BOX_LINES.filter((c) => c.cardId === cardId).reduce((n, c) => n + c.quantity, 0);
}

/** The binder the store files a copy of the card in (the first, in the store's order); null when none is in a binder. */
function binderOf(cardId: CardId): string | null {
  for (const copy of STORE.copies) {
    if (copy.cardId !== cardId) continue;
    const home = CONTAINERS.get(copy.homeId);
    if (home?.kind === "binder") return home.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sales (dealer only)
// ---------------------------------------------------------------------------

// The shared words (badges, "3 days ago") live in `./dash-labels`, which the
// signed-in page imports without loading this file's demo store and catalog.
export { daysAgoLabel, isLate, MARKETPLACES, type Marketplace } from "./dash-labels";

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

/** The cards the demo's Show box holds (the store's box lines): what its orders sold. */
const YZERMAN = pick(SET.udHockey, null, 1);
const SCORE_PROOF = pick(SET.score, "Artist's Proof", 301);
const SKENES_AUTO = pick(SET.chrome, "Chrome Rookie Autographs", "RA-PS");
const THURMAN = pick(SET.score89, null, 211);
const GRIFFEY = pick(SET.finest, null, 2);
/** In the Show box with no price yet, so the sync holds it back. */
const RIPKEN = pick(SET.finest, null, 5);

/**
 * Built in any order; sorted oldest first below. Every line sells a card the
 * store keeps in a box, so its panel opens on that box's copies; the oversold
 * line counts what the boxes really hold.
 */
const UNSHIPPED_AS_BUILT: UnshippedSale[] = [
  sale("sale-bsc-1", "bsc", "DEMO-1001", 3, "Ready to ship", [
    { card: YZERMAN, quantity: 4, problem: { kind: "oversold", sold: 4, inBoxes: inBoxes(YZERMAN.id) } },
  ]),
  sale("sale-ebay-1", "ebay", "12-34567-89012", 2, "Paid", [{ card: SKENES_AUTO, quantity: 1 }]),
  sale("sale-bsc-3", "bsc", "DEMO-1002", 1, "Ready to ship", [
    { card: THURMAN, quantity: 1 },
    { card: GRIFFEY, quantity: 1 },
  ]),
  sale("sale-bsc-2", "bsc", "DEMO-1003", 0, "Ready to ship", [
    { card: SCORE_PROOF, quantity: 1 },
    { card: null, quantity: 1, problem: { kind: "unmatched", listingTitle: "2024 Score #333 Rome Odunze RC" } },
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

/**
 * A batch of the cards given, newest first, each filed where the store files
 * it, grouped by binder in the order the binders first come up. A card the
 * store holds in no binder is not a pull of the collection, so it is left out.
 */
function batch(id: string, whenLabel: string, daysAgo: number, sinceLastVisit: boolean, list: DashCard[]): AdditionBatch {
  const groups = new Map<string, DashCard[]>();
  for (const card of list) {
    const binderName = binderOf(card.id);
    if (binderName === null) continue;
    groups.set(binderName, [...(groups.get(binderName) ?? []), card]);
  }
  const cards: AddedCard[] = [...groups].flatMap(([binderName, cs]) => cs.map((c) => ({ ...c, binderName })));
  return {
    id,
    whenLabel,
    daysAgo,
    cards,
    binders: [...groups].map(([name, cs]) => ({ name, count: cs.length })),
    sinceLastVisit,
  };
}

/** The batches, newest first: cards the demo collector owns, filed where the demo files them. */
const ADDITIONS: AdditionBatch[] = [
  batch("batch-today", "Today", 0, true, [
    // The four that finished the 1989 Score set, the last card first.
    ...SCORE_1989_TODAY.map((n) => pick(SET.score89, null, n)),
    pick(SET.score, "Gridiron Heritage", 1),
    pick(SET.score, "Gridiron Heritage", 2),
    pick(SET.score, "Gold Zone", 10),
    pick(SET.score, "Lava", 302),
    pick(SET.score, null, 11),
    pick(SET.score, null, 12),
  ]),
  batch("batch-yesterday", "Yesterday", 1, true, [
    pick(SET.chrome, "Gold Refractor", 1),
    pick(SET.chrome, "Green Refractor", 1),
    pick(SET.chrome, "Aqua Refractor", 1),
    pick(SET.chrome, "Negative Refractor", 1),
    pick(SET.chrome, "Orange Refractor", 25),
    pick(SET.chrome, "Refractor", 25),
  ]),
  batch("batch-tuesday", "Tuesday", 3, true, [
    ...["1", "2", "4", "5", "7", "8", "10", "11", "12", "14", "15", "16", "18", "19", "21", "23", "24", "25", "27", "29", "30", "32", "34", "39"]
      .reverse()
      .map((n) => pick(SET.contenders, null, n)),
    ...["11", "10", "9", "8", "7", "5", "4", "3", "2", "1"].map((n) => pick(SET.udHockey, null, n)),
  ]),
  batch("batch-weekend", "Last weekend", 6, false, [
    pick(SET.udHockey, "Legends", 2),
    pick(SET.udHockey, "Legends", 1),
    pick(SET.udHockey, null, 18),
    pick(SET.udHockey, "Game Jerseys", "GJ1"),
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
    setLabel: fixtureSetLabel(set),
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
  /** At most nine of its cards for the cheer's thumbnails, the last to arrive first (as the signed-in page's `CHEER_CARDS`). */
  cards: DashCard[];
  /** Relative, like the batches: "Yesterday". */
  whenLabel: string;
}

/** The cheer's thumbnails, at most nine (the signed-in page's `CHEER_CARDS`). */
const CHEER_CARDS = 9;

/**
 * The demo collector finished the 1989 Score base set today: every card is in
 * the '89 Score binder, Barry Sanders the last in. The cheer's cards are the
 * last to arrive first: today's four, then the newest before them. Null if a
 * card were missing (a panel would say otherwise).
 */
const JUST_COMPLETED: CompletedSet | null = (() => {
  const base = variantCards(SET.score89, null).filter((c) => c.variation === null);
  if (base.length === 0 || !base.every((c) => owned.has(c.id))) return null;
  const inSet = new Set(base.map((c) => c.id));
  const arrived = new Map(myCopies.filter((c) => inSet.has(c.cardId)).map((c) => [c.cardId, c.acquiredAt]));
  const byArrival = [...base].sort((a, b) => (arrived.get(b.id) ?? "").localeCompare(arrived.get(a.id) ?? ""));
  const today = SCORE_1989_TODAY.map((n) => base.find((c) => c.cardNumber === n)!);
  const cards = [...today, ...byArrival.filter((c) => !today.includes(c))].slice(0, CHEER_CARDS).map((c) => dashCard(c.id));
  const set = getFixtureSet(SET.score89);
  const label = fixtureSetLabel(set);
  return {
    id: `done-${SET.score89}-base`,
    label,
    setLabel: label,
    checklistName: null,
    total: base.length,
    lastCard: pick(SET.score89, null, SCORE_1989_LAST_CARD),
    cards,
    whenLabel: "Today",
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

/** The chase: the store's Want List, in its order, each with the binder it is wanted for. */
const WANTS: WantCard[] = STORE.wants.map((w) => ({
  ...dashCard(w.cardId),
  forBinder: w.binderId ? (CONTAINERS.get(w.binderId)?.name ?? null) : null,
}));

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
  /** "Last scan 3:42 PM", "Last scan yesterday": two runs into one binder read apart by it. */
  lastScan: string;
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
  // The runs' scans not yet done add up to `total` (24 - 6 + 2 = 20). The /demo
  // page adds one Want List scan to "Show pickups" (demo/fixture.ts), so there it
  // reads "0 of 3 scans": both numbers are right.
  uploads: [
    {
      id: "upload-shoebox",
      name: "Garage shoebox",
      scans: 24,
      done: 6,
      side: "collection",
      href: "/demo/collection?tab=add",
      lastScan: "Last scan 9:14 AM",
    },
    {
      id: "upload-show",
      name: "Show pickups",
      scans: 2,
      done: 0,
      side: "inventory",
      href: "/demo/inventory?side=inventory&tab=add",
      lastScan: "Last scan yesterday",
    },
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

/** The store's boxes held off the marketplaces and holding cards, as the signed-in page finds them. */
const UNLISTED_BOXES: UnlistedBox[] = STORE.containers
  .filter((c) => c.kind === "box" && c.listedOnMarketplaces === false)
  .map((c) => ({
    id: c.id,
    name: c.name,
    unlisted: BOX_LINES.filter((l) => l.homeId === c.id).reduce((n, l) => n + l.quantity, 0),
  }))
  .filter((b) => b.unlisted > 0);

/** Copies flagged Up for Trade. */
export interface TradePile {
  count: number;
  /** A few of them, for thumbnails. */
  cards: DashCard[];
}

/** The store's copies flagged up for trade, counted by physical card. */
const TRADE_PILE: TradePile = (() => {
  const flagged = STORE.copies.filter((c) => c.upForTrade);
  const seen = new Set<CardId>();
  const cards = flagged.filter((c) => !seen.has(c.cardId) && seen.add(c.cardId)).map((c) => dashCard(c.cardId));
  return { count: flagged.reduce((n, c) => n + c.quantity, 0), cards };
})();

// ---------------------------------------------------------------------------
// The whole page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// New on NeonBinder: the catalog's newest sets
// ---------------------------------------------------------------------------

/** A set new to NB's catalog. The same news for every collector. */
export interface NewSet {
  /** The entry's own key: the set's id, or the set's and the variant's for one variant. */
  id: string;
  /** Season, brand and name: "2024 Topps Chrome". */
  label: string;
  /** One variant uploaded on its own ("Gold Refractor"); null for a whole set's load. */
  variant: string | null;
  /** Where its checklist opens on Collection: the Checklists tab's params. */
  checklist: Record<string, string>;
  /** "Baseball"; null when the set sits under no sport. */
  sport: string | null;
  /** Every card in the set; null when never counted. */
  cardCount: number | null;
  /** The first card of its Base, drawn as the set's cover; null when it has none yet. */
  cover: DashCard | null;
}

/** A demo set as news: its first Base card as the cover, every card counted. */
function newSet(setId: SetId): NewSet {
  const set = getFixtureSet(setId);
  const inSet = fixtureCards.filter((c) => c.setId === setId);
  const first = inSet.find((c) => c.variantPath.name === null && c.variation === null);
  const cover = first ? dashCard(first.id) : null;
  return {
    id: setId,
    label: cover?.setLabel ?? fixtureSetLabel(set),
    variant: null,
    checklist: { tab: "checklists", set: setId },
    sport: getFixtureSport(set.sportId).name,
    cardCount: inSet.length,
    cover,
  };
}

/** Newest first. */
const NEW_SETS: NewSet[] = [SET.chrome, SET.score, SET.udHockey, SET.finest, SET.topps, SET.contenders].map(newSet);

// ---------------------------------------------------------------------------
// New Listings: cards that landed in Inventory lately
// ---------------------------------------------------------------------------

/**
 * One line of cards that landed in a box (Inventory) lately: an add into a
 * box, a box raise, a Sell from a binder. Synced or not, it is listed in NB
 * (Jason, 2026-11-10: "Listings come from our Inventory").
 */
export interface NewListing extends DashCard {
  /** The line's own key. */
  lineId: string;
  /** Copies on the line. */
  quantity: number;
  /** NB's price for one copy, in cents: the card's own, else the set's common price; null when neither is set. */
  priceCents: number | null;
  /** The box it landed in, and its id (the tile opens the card there). */
  boxId: string;
  boxName: string;
  /** Whole days ago, 0 = today. */
  daysAgo: number;
}

/** Whole days ago for the store's box lines, newest first: the rest are a week old. */
const LISTED_DAYS_AGO = [0, 1, 1, 1, 1, 3, 5];

/** The store's box lines, newest first (by when they came in; ties in the store's order): what the card panel shows in the box, price and all. */
const NEW_LISTINGS: NewListing[] = [...BOX_LINES]
  .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))
  .map((line, i) => {
  const card = dashCard(line.cardId);
  const price = line.minPrice ?? STORE.commonPrices?.[card.card.variant.id];
  const box = CONTAINERS.get(line.homeId);
  return {
    ...card,
    lineId: line.id,
    quantity: line.quantity,
    priceCents: price === undefined ? null : Math.round(price * 100),
    boxId: line.homeId,
    boxName: box?.name ?? "",
    daysAgo: LISTED_DAYS_AGO[i] ?? 7,
  };
  });

// ---------------------------------------------------------------------------
// Sync status: what has not synced yet, and what keeps failing
// ---------------------------------------------------------------------------

/** One card the last sync held back, and why, in NB's words. */
export interface HeldBackCard {
  card: DashCard;
  reason: string;
  /** The reason's code, so the card's panel can say it and open on the fix; absent when not known. */
  code?: ListingProblemReason;
}

/** A set whose last sync to a marketplace failed, or held cards back. */
export interface SyncProblemSet {
  id: string;
  marketplace: Marketplace;
  /** "2024 Topps Chrome Base". */
  setLabel: string;
  /** NB's sentence for the failure, when the last sync failed; null when it ran and only held cards back. */
  failure: string | null;
  /** Cards it held back (every one, counted); `cards` names the first few. */
  heldBack: number;
  cards: HeldBackCard[];
  /** NB's id for the set (its variant), so it can be reported to the crew; absent in the demo. */
  variantId?: string;
  /**
   * NEO-536: held-back cards only the crew can fix (`lib/collection/sync-report`):
   * "all" of them, "some" beside ones the collector fixes; absent when none, or
   * when the last sync failed (NB tries that again on its own).
   */
  crewFix?: "all" | "some";
}

/**
 * The dashboard's sync status. Only what has not put itself right: a set
 * whose LATEST sync failed or held cards back, never one a later clean sync
 * fixed. `null` when nothing is waiting and nothing is wrong (no section).
 */
export interface SyncStatusData {
  /** Cards waiting for the next sync, per marketplace with any. `more`: at least `cards`. */
  pending: { marketplace: Marketplace; cards: number; more: boolean }[];
  problems: SyncProblemSet[];
  /** More sets need a look than are named. */
  more: boolean;
}

/**
 * A held-back set as Sync status names it, in the words its cards' listing
 * titles use, so the heading and the titles under it read as one set:
 * "2024 Score Artist's Proof", "1993 Topps Finest Base".
 */
function heldSetLabel(card: DashCard): string {
  return `${setRefLabel(card.card.set)} ${card.variantName ?? "Base"}`;
}

/** Why the demo's sync held a card back, in the words the signed-in page says them (`real/heldBackReason`). */
const HELD_WORDS = {
  noPrice: "No price yet. Set one on the card, or a common price for the set.",
  noPhoto: "eBay listings need a photo. Add one to a copy of this card and it goes up.",
} as const;

function heldBackSet(id: string, marketplace: Marketplace, held: { card: DashCard; code: keyof typeof HELD_WORDS }[]): SyncProblemSet {
  return {
    id,
    marketplace,
    setLabel: heldSetLabel(held[0].card),
    failure: null,
    heldBack: held.length,
    cards: held.map(({ card, code }) => ({ card, reason: HELD_WORDS[code], code })),
  };
}

/** A Finest dupe in the Show box (the sample's `copy-box-06` to `-12`), held back for want of a price or, priced, a photo. */
const finestDupe = (n: number, code: keyof typeof HELD_WORDS) => ({ card: pick(SET.finest, null, n), code });

/**
 * Box cards only (a held-back card is one for sale), and never one an eBay
 * order just sold. The Finest build's dupes hold back more cards than the set
 * shows before "Show all".
 */
const SYNC_STATUS: SyncStatusData = {
  pending: [{ marketplace: "bsc", cards: 3, more: false }],
  problems: [
    heldBackSet("sync-ebay-score-proof", "ebay", [{ card: SCORE_PROOF, code: "noPhoto" }]),
    heldBackSet("sync-ebay-finest", "ebay", [
      { card: RIPKEN, code: "noPrice" },
      finestDupe(1, "noPrice"),
      finestDupe(4, "noPhoto"),
      finestDupe(6, "noPrice"),
      finestDupe(7, "noPhoto"),
      finestDupe(8, "noPhoto"),
      finestDupe(9, "noPrice"),
      finestDupe(10, "noPhoto"),
    ]),
  ],
  more: false,
};

// ---------------------------------------------------------------------------
// Boxes on the shelf
// ---------------------------------------------------------------------------

/** A box the collector is using, stood on the third shelf. */
export interface ShelfBox {
  id: string;
  name: string;
  /** Physical cards in it (copies). */
  cardCount: number;
  /** Unsorted, NB's own catch-all box. */
  unsorted: boolean;
  /** The label it wears on My Boxes (`labelOf`), so it looks the same on both shelves. */
  label: ContainerLabel;
}

/** The store's boxes in use (Unsorted only once it holds a card), with what each holds. */
const SHELF_BOXES: ShelfBox[] = STORE.containers
  .filter((c) => c.kind === "box")
  .map((c) => ({
    id: c.id,
    name: c.name,
    cardCount: BOX_LINES.filter((l) => l.homeId === c.id).reduce((n, l) => n + l.quantity, 0),
    unsorted: c.system === "unsorted",
    label: labelOf(c),
  }))
  .filter((b) => !b.unsorted || b.cardCount > 0);

export interface DashboardData {
  /** null when the account has no order stored: no sales section at all. */
  sales: SalesData | null;
  /** Newest batch first. Empty: no Fresh Pulls section. */
  additions: AdditionBatch[];
  /** New Listings, newest first. Empty: no New Listings section. */
  newListings: NewListing[];
  /** The sync status at the top; null: nothing waiting and nothing wrong, no section. */
  syncStatus: SyncStatusData | null;
  /**
   * The boxes the collector is using (a box they made, or Unsorted holding a
   * card), for the third shelf. Empty or absent: the third shelf holds
   * binders, then the way into Inventory's Add cards.
   */
  shelfBoxes?: ShelfBox[];
  /** New on NeonBinder, newest first: the catalog's news, shown to every collector. */
  newSets: NewSet[];
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
   * (absent reads as exact). `boxes`: how many boxes they have; none (or
   * absent) and the third shelf carries the way into Inventory's Add cards.
   */
  totals: { cards: number; binders: number; boxes?: number; exact?: boolean };
  /**
   * The binders on the shelf, each with its pockets already laid out: the
   * signed-in page's from the collection store, the demo's from `bindersOf`
   * (`getDashboard` fills it in). Absent or empty: no binders on the shelf.
   */
  binders?: ShelfBinder[];
}

const BINDER_COUNT = seedBinders.filter((b) => b.id !== "binder-trade-bait").length + 1; // + Main
const CARD_COUNT = myCopies.reduce((n, c) => n + c.quantity, 0);

const SMART = smartBinders();

const DASHBOARD: DashboardData = {
  sales: SALES,
  additions: ADDITIONS,
  newListings: NEW_LISTINGS,
  syncStatus: SYNC_STATUS,
  shelfBoxes: SHELF_BOXES,
  newSets: NEW_SETS,
  building: BUILDING,
  justCompleted: JUST_COMPLETED,
  smartBinders: SMART,
  wantList: WANTS,
  intake: INTAKE,
  unlistedBoxes: UNLISTED_BOXES,
  tradePile: TRADE_PILE,
  totals: { cards: CARD_COUNT, binders: BINDER_COUNT, boxes: SHELF_BOXES.length },
};

/**
 * The fake collector's dashboard, every section filled, its shelf laid out
 * (`bindersOf`). Built once, on the first call: the same object every call.
 */
export function getDashboard(): DashboardData {
  DASHBOARD.binders ??= bindersOf(DASHBOARD);
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

function liveryOf(cards: DashCard[]): Pick<ShelfBinder, "label" | "vinyl" | "stripe"> {
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
  // A binder of one team's cards wears that team, as My Binders' default does for a smart binder.
  return worn(best ? { background: best.primary, text: best.secondary, fontId: DEFAULT_SPINE_FONT_ID } : PLAIN_LABEL);
}

/** A label, and its colours as the spine's vinyl and stripe. */
function worn(label: ContainerLabel): Pick<ShelfBinder, "label" | "vinyl" | "stripe"> {
  return { label, vinyl: label.background, stripe: label.text };
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

/** Main's copies as the store files them (its up-for-trade copies stay in Main). */
function mainCopies() {
  return STORE.copies.filter((c) => c.homeId === MAIN_BINDER_ID);
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
    ...worn(labelOf({ kind: "binder", system: "main" })),
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
