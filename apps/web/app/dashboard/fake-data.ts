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
 * - Persona "collector" has no sales and no boxes: `sales` is null and
 *   `unlistedBoxes` is empty. Draw nothing for them, not an empty box.
 *
 * Entry point: `getDashboard(persona)` (or `useDashboard()` from
 * `./persona`, which reads the persona from the URL).
 */

import { generateListingTitle, type ListingCardInputs } from "@/convex/features/generateListing";
import { demoCard } from "@/app/collection/final/data/demoStore";
import { compareCardNumbers, printRunLabel, setLabel, variantLabel } from "@/app/collection/final/data/labels";
import type { Card, CardId, SetId, VariantKind } from "@/app/collection/final/data/types";
import {
  binders as seedBinders,
  buildingSetIds as seedBuildingSetIds,
  cards as fixtureCards,
  describeRule,
  evaluateRule,
  getCard as getFixtureCard,
  getSet as getFixtureSet,
  myCopies,
  type BinderRule,
  type Card as FixtureCard,
} from "@/app/collection/prototypes/_shared/data";

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

/**
 * Who is looking. "collector" never connected a marketplace: no sales, no
 * boxes. "dealer" sells on BuySportsCards, SportLots and eBay. The default is
 * "dealer" (the fuller page).
 */
export type Persona = "collector" | "dealer";

export const DEFAULT_PERSONA: Persona = "dealer";

/** The persona toggle's choices, in the order the toggle shows them. */
export const PERSONAS: ReadonlyArray<{ value: Persona; label: string }> = [
  { value: "collector", label: "Collector (no sales)" },
  { value: "dealer", label: "Dealer (sales)" },
];

/** The URL's `?as=` value as a persona; anything else is the default. */
export function parsePersona(value: string | null | undefined): Persona {
  return value === "collector" || value === "dealer" ? value : DEFAULT_PERSONA;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * One card, ready to draw and to caption. `card` goes to CardFace's `model`;
 * the rest is the caption a tile needs, already worded.
 */
export interface DashCard {
  /** The demo's card id (`<setId>:<variant>:<number>`). Stable: use it as a React key. */
  id: CardId;
  /** The demo card itself: pass it as `<CardFace model={...} />`. */
  card: Card;
  /** Lead player as printed: "Reggie White". */
  player: string;
  /** Team on the card: "Packers". Empty when the card names none. */
  team: string;
  /** Year and set: "1996 Playoff Contenders", "1996-97 Upper Deck". */
  setLabel: string;
  setId: SetId;
  /** The card number as printed ("13", "13b", "GJ1"). A string, never unique on its own. */
  cardNumber: string;
  /** base | insert | parallel. */
  variantKind: VariantKind;
  /** The insert or parallel's name ("Gold Refractor", "Pennant Flyers"); null on a base card. */
  variantName: string | null;
  /** "/50", "1/1"; null when unnumbered. */
  printRun: string | null;
  /** Image variation ("Sliding"); null for the regular card. */
  variation: string | null;
  /**
   * The card's full listing title, at most 80 characters, built by NB's own
   * listing-title generator (`generateListingTitle`) from the card's fields:
   * "2024 Topps Chrome Gold Refractor Parallel #1 Shohei Ohtani /50 Dodgers".
   * Added for the combined dashboard (NEO-464); additive, nothing else reads it.
   */
  title: string;
}

/** The generator's inputs, from a demo card's own fields. Nothing here is marketplace data. */
function titleInputs(card: Card): ListingCardInputs {
  const { variant } = card;
  const insertName = variant.kind === "insert" ? (variant.insertName ?? variant.name ?? undefined) : (variant.insertName ?? undefined);
  return {
    cardNumber: card.cardNumber,
    playerNames: card.players.map((p) => p.nameOnCard ?? p.name),
    year: card.set.season,
    manufacturer: card.set.brand.name,
    setName: card.set.name,
    insertName,
    parallelName: variant.kind === "parallel" && variant.name ? variant.name : "Base",
    parallelIsRole: variant.kind === "parallel",
    isRookie: card.features.includes("RC"),
    isRelic: card.features.includes("Relic"),
    autographed: card.features.includes("AU") ? "On Card" : "None",
    shortPrint: card.features.includes("SP") ? "SP" : "None",
    printRun: card.printRun ?? undefined,
    cardVariation: card.cardVariation ?? undefined,
    teamNames: card.teams.map((t) => (t.location ? `${t.location} ${t.name}` : t.name)),
    sport: card.set.sport.name,
  };
}

function toDash(card: Card): DashCard {
  return {
    title: generateListingTitle(titleInputs(card)),
    id: card.id,
    card,
    player: card.players[0]?.name ?? "",
    team: card.teams[0]?.name ?? "",
    setLabel: setLabel(card.set),
    setId: card.set.id,
    cardNumber: card.cardNumber,
    variantKind: card.variant.kind,
    variantName: card.variant.kind === "base" ? null : variantLabel(card.variant),
    printRun: printRunLabel(card),
    variation: card.cardVariation,
  };
}

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
 *   to say which line it is; it is never NB data.
 * - oversold: it sold more than your boxes hold.
 */
export type SaleProblem =
  | { kind: "unmatched"; listingTitle: string }
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
  /** In the order's own order. The first line always has a card (thumbnail + player). */
  lines: SaleLine[];
  /** Sum of the lines' quantities. */
  cardCount: number;
  /** The order's first card: its thumbnail and player lead the row. */
  firstCard: DashCard;
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
const DEALER_SALES: SalesData = { unshipped: UNSHIPPED };

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
  /** The needed base cards themselves, same order, for drawing them (EmptySleeve or `state="need"`). */
  neededCards: DashCard[];
  /** One bulb per base card, in number order: the Scoreboard's base strip. */
  baseBulbs: { cardNumber: string; owned: boolean }[];
  /** Base first, then inserts, then parallels: the Scoreboard's other strips. */
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

/** Scans uploaded and not yet in a binder. */
export interface IntakeInProgress {
  /** Every scan still in intake (waiting + needsYou). */
  total: number;
  /** Not identified yet. */
  waiting: number;
  /** Matched, waiting on the collector to say yes. */
  needsYou: number;
  /** The uploads they came from: "Garage shoebox, 24 scans, 6 done". */
  uploads: { id: string; name: string; scans: number; done: number }[];
  /** A few scans for thumbnails: the needs-you ones first, then the waiting. */
  preview: IntakeScan[];
}

/** The guesses are catalog cards the demo collector does not own. */
const INTAKE: IntakeInProgress = {
  total: 20,
  waiting: 18,
  needsYou: 2,
  uploads: [
    { id: "upload-shoebox", name: "Garage shoebox", scans: 24, done: 6 },
    { id: "upload-show", name: "Show pickups", scans: 2, done: 0 },
  ],
  preview: [
    { id: "scan-1", guess: pick(SET.udHockey, "Legends", 4) },
    { id: "scan-2", guess: pick(SET.score, "Gridiron Heritage", 3) },
    { id: "scan-3", guess: null },
    { id: "scan-4", guess: null },
  ],
};

/** A box (inventory for sale) holding cards not listed anywhere yet. Dealer only. */
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
  persona: Persona;
  /** null for "collector" (no marketplace connected): show no sales panel at all. */
  sales: SalesData | null;
  /** Newest batch first. */
  additions: AdditionBatch[];
  /** Ranked by fewest cards needed. */
  building: BuildingSet[];
  /** The checklist just finished, or null. */
  justCompleted: CompletedSet | null;
  smartBinders: SmartBinderSummary[];
  /** 5 chase cards, top chase first. */
  wantList: WantCard[];
  intake: IntakeInProgress;
  /** Empty for "collector". */
  unlistedBoxes: UnlistedBox[];
  tradePile: TradePile;
  /** For a greeting line: how big the collection is. No values. */
  totals: { cards: number; binders: number };
}

const BINDER_COUNT = seedBinders.filter((b) => b.id !== "binder-trade-bait").length + 1; // + Main
const CARD_COUNT = myCopies.reduce((n, c) => n + c.quantity, 0);

const SMART = smartBinders();

/** The dashboard as `persona` sees it. Pure and cheap: built once at load, the same objects every call. */
export function getDashboard(persona: Persona): DashboardData {
  const dealer = persona === "dealer";
  return {
    persona,
    sales: dealer ? DEALER_SALES : null,
    additions: ADDITIONS,
    building: BUILDING,
    justCompleted: JUST_COMPLETED,
    smartBinders: SMART,
    wantList: WANTS,
    intake: INTAKE,
    unlistedBoxes: dealer ? UNLISTED_BOXES : [],
    tradePile: TRADE_PILE,
    totals: { cards: CARD_COUNT, binders: BINDER_COUNT },
  };
}
