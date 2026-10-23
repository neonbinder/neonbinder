/**
 * NEO-358 — the collection page's view model: what every view of `/collection`
 * (and the public demo on `/binder-tracking`) reads, whichever store is behind
 * it.
 *
 * Two stores answer to this one shape (see `./store`):
 * - the demo store (`./demoStore`): the hard-coded fixture catalog and the
 *   sessionStorage reducer, for the public demo. It never reaches Convex or
 *   Clerk.
 * - the Convex store (`./convexStore`): the real catalog and the signed-in
 *   collector's own copies.
 *
 * Everything here is HYDRATED: a card carries its set, variant, players and
 * teams, so a view never looks anything up by id. Ids are opaque strings: a
 * Convex id in the real store, a fixture slug in the demo. Never compare an id
 * against a literal, and never key behaviour on a display name (product
 * invariant 4). The one exception is the presentational finish (`./finish`),
 * which draws a card from its variant's title and drives nothing else.
 */

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export type CardId = string;
export type CopyId = string;
/** A set: the `setName` row in the real catalog. */
export type SetId = string;
/**
 * A checklist: the row a card belongs to. In the real catalog that is the
 * Base `variantType` row, an `insert` row, or a `parallel` row (including a
 * sub-parallel under an insert).
 */
export type VariantId = string;
export type PlayerId = string;
export type TeamId = string;
/** A binder or a box. Every copy has exactly one home. */
export type ContainerId = string;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** One step of the catalog above a card: its id and what it reads as. */
export interface NamedRef {
  id: string;
  name: string;
}

/** A set, with what a label needs: "2024 Topps Chrome", "1996-97 Upper Deck". */
export interface SetRef {
  id: SetId;
  /** The set's own name after the season: "Topps Chrome", "Playoff Contenders". */
  name: string;
  /** What collectors call the year: "1996" or "1996-97". */
  season: string;
  /** The year the set is filed under (a hockey season files under its start). */
  year: number;
  brand: NamedRef;
  sport: NamedRef;
}

/**
 * The drill ids above a set, in the cascade's order. `id`s are what the
 * Checklists URL carries (`sport`, `year`, `brand`, `set`); pass them back as
 * `DrillParents` to list the next column.
 */
export interface SetPath {
  sport: NamedRef;
  year: NamedRef;
  brand: NamedRef;
  set: NamedRef;
}

/**
 * What a variant IS. The set's Base, an Insert, or a Parallel (a sub-parallel
 * under an insert is a parallel whose `insertName` is set). Read once from
 * NB's own variant-type title on the server (`convex/variantRole.ts`).
 * `"other"`: a variant type whose title is none of the three words ("Promo",
 * "Base Set"); it reads like an insert, and sorts after the three.
 */
export type VariantKind = "base" | "insert" | "parallel" | "other";

/**
 * The drill ids BELOW the set that reach a variant, as the Checklists URL
 * carries them: `type` (the variant-type step), `variant` (the insert or
 * parallel step, null for Base) and `sub` (a sub-parallel under an insert).
 */
export interface VariantDrillPath {
  typeId: string;
  variantId: string | null;
  subVariantId: string | null;
}

/** How the printed card looks: drives CardFace's treatment, nothing else. */
export type FinishKind = "standard" | "refractor" | "foil" | "gold" | "superfractor";
export interface Finish {
  kind: FinishKind;
  /** Colour cast for a coloured refractor or foil (`#rrggbb`). */
  tint?: string;
}

/** A card's checklist: where it sits in its set. */
export interface VariantRef {
  id: VariantId;
  kind: VariantKind;
  /** The insert or parallel's name ("Pennant Flyers", "Gold Refractor"); null for Base. */
  name: string | null;
  /** A sub-parallel's insert ("Pennant Flyers" for "Pennant Flyers Gold"); else null. */
  insertName: string | null;
  /** The print run every card in it shares; null = unnumbered or mixed. */
  printRun: number | null;
  /** Position among the set's variants (Base first); ties sort by name. */
  order: number;
  path: VariantDrillPath;
  /** Presentational only (`./finish`). */
  finish: Finish;
}

/**
 * A variant as the set summary lists it: with how many cards it holds. Both
 * counts are stored on the server, never counted on read (Jason,
 * 2026-10-23). Show `baseCardCount` by default.
 */
export interface Variant extends VariantRef {
  /**
   * Every card in this checklist, image variations included. 0 for a row the
   * server has never counted and could not count on the spot (the card-count
   * backfill fills those).
   */
  cardCount: number;
  /** Cards without an image variation: the number a collector means by "the checklist". */
  baseCardCount: number;
}

export interface SetSummary {
  set: SetRef;
  /** Base first, then inserts (each followed by its sub-parallels), then parallels. */
  variants: Variant[];
  /** The sum of every variant's `baseCardCount` (the default to show). */
  totalCards: number;
  /** The sum of every variant's `cardCount`, variations included. */
  totalCardsAll: number;
}

export type CardFeature = "RC" | "AU" | "Relic" | "SP";

export interface CardPlayer {
  id: PlayerId;
  name: string;
  /** How the card prints the name, when it differs ("Ken Griffey Jr."). */
  nameOnCard?: string;
}

export interface CardTeam {
  id: TeamId;
  /** The nickname collectors say: "Packers", "Red Wings", "Badgers". */
  name: string;
  /** Where the team is from: a city, a state, a school or a sponsor. Blank when none leads the name. */
  location: string;
  /** Livery, `#rrggbb`, when NB has it. */
  primary?: string;
  secondary?: string;
}

/** A checklist card, hydrated. */
export interface Card {
  id: CardId;
  set: SetRef;
  variant: VariantRef;
  /** A string ("13b" exists) and NEVER unique, even inside one set (invariant 7). */
  cardNumber: string;
  /** In the card's own order: the first leads the face and the label. */
  players: CardPlayer[];
  /** Teams printed on the card (the uniform), not every team the player had. */
  teams: CardTeam[];
  /** Numbered print run: 50 means "/50", 1 a 1/1; null = unnumbered. */
  printRun: number | null;
  features: CardFeature[];
  /** Image or photo variation name ("Sliding"); null for the regular card. */
  cardVariation: string | null;
  /**
   * An image variation of another card in the checklist: left out of the
   * default (base) counts, kept in the `All` ones.
   */
  isVariation: boolean;
  /** Checklist position inside its variant. */
  sortOrder: number;
  /** Presentational only (`./finish`). */
  finish: Finish;
}

// ---------------------------------------------------------------------------
// The Checklists drill
// ---------------------------------------------------------------------------

/**
 * The cascade's columns. `variant` is an insert or a parallel; `subVariant`
 * a parallel under an insert (the demo has none).
 */
export type DrillLevel = "sport" | "year" | "brand" | "set" | "variantType" | "variant" | "subVariant";

export const DRILL_LEVELS: readonly DrillLevel[] = [
  "sport",
  "year",
  "brand",
  "set",
  "variantType",
  "variant",
  "subVariant",
];

/**
 * The ids picked ABOVE the column being listed. The Convex store reads only
 * the nearest one; the demo reads them all (its years are not rows).
 */
export type DrillParents = Partial<Record<DrillLevel, string>>;

export interface DrillItem {
  /** What the URL carries for this step. */
  id: string;
  level: DrillLevel;
  name: string;
  /** A ready-made line under the name, when the store has one ("/50 · have 2 of 30"). */
  description?: string;
  /** Variant-type rows: what the row is (and its children are). */
  kind?: VariantKind;
  /** Card-bearing rows: cards hanging off this row, variations included; null when uncounted. */
  cardCount?: number | null;
  /** The same without image variations: the default "of M". */
  baseCardCount?: number | null;
  /** Set when picking this row opens a checklist: pass it to `useVariantCards`. */
  variantId?: VariantId;
  /** True when the row has a column beneath it (an insert with sub-parallels has both). */
  hasChildren: boolean;
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

export type Condition = "Mint" | "Near Mint" | "Excellent" | "Very Good" | "Good" | "Poor";
export type Grader = "PSA" | "BGS" | "SGC" | "CGC" | "TAG";

export interface Grading {
  grader: Grader;
  /** Kept as text: "10", "9.5", "Authentic". */
  grade: string;
  cert?: string;
}

/**
 * The demo's binder filing and sale fields. Only the demo store reads or
 * writes them; the Convex store never sets them and ignores them on a write
 * (real binders and boxes arrive with NEO-359, and price belongs to a listing).
 */
export interface DemoCopyExtras {
  binderIds: string[];
  forSale: boolean;
  askPrice?: number;
}

/**
 * Everything about a copy the collector edits. Field names match the
 * prototypes' `CopyDetails` (so `CopyDetailsForm` takes them unchanged); the
 * Convex store converts on the way through (`costBasis` dollars ↔ cents,
 * `acquiredAt` ↔ `acquiredOn`, `graded` ↔ `grading`).
 */
export interface CopyDetails {
  /** An integer ≥ 1: a stack of identical copies is one line item. */
  quantity: number;
  condition?: Condition;
  graded?: Grading;
  /** This copy's own serial ("23/50"). Only meaningful on numbered cards. */
  serialNumber?: string;
  /** What the collector paid per copy, in dollars. */
  costBasis?: number;
  /** `YYYY-MM-DD`. Defaults to today on a new copy. */
  acquiredAt: string;
  /** Free text: "Box 3", "Top shelf". */
  location?: string;
  /** Blank is "". */
  notes: string;
  /** Demo only (see `DemoCopyExtras`). */
  demo?: DemoCopyExtras;
}

/** One line item the collector owns: one physical copy, or an identical stack. */
export interface Copy extends CopyDetails {
  id: CopyId;
  cardId: CardId;
  variantId: VariantId;
  setId: SetId;
  /** The copy's one home: a binder, or a box for cards for sale. */
  homeId: ContainerId;
  /** "Main", when the store knows it. */
  homeName?: string;
}

/**
 * How much of a checklist the collector has, two ways (Jason, 2026-10-23).
 * The plain pair counts cards without an image variation and is what a view
 * shows by default; the `All` pair counts variations too.
 */
export interface Completion {
  /** Distinct non-variation cards with at least one copy. */
  owned: number;
  /** Non-variation cards in the checklist. */
  total: number;
  /** 0-100, rounded DOWN so 99.6% never reads as done. */
  percent: number;
  /** Distinct cards owned, variations included. */
  ownedAll: number;
  /** Every card in the checklist, variations included. */
  totalAll: number;
  percentAll: number;
}

/** The whole collection at a glance. */
export interface CollectionSummary {
  /** Physical cards: quantities summed. */
  copies: number;
  /** Distinct checklist cards owned. */
  cards: number;
}

/** One card the collector holds, as the owned-cards list counts it. */
export interface HeldCount {
  /** Physical copies: quantities summed over every line item. */
  quantity: number;
  /** Line items (a stack of identical copies is one). */
  lines: number;
}

/** "Everything I own": the collector's cards, most recently touched first. */
export interface OwnedCards {
  /** Up to the limit asked for, hydrated. */
  cards: Card[];
  /** How many of each listed card the collector holds, by card id. */
  copiesByCard: Record<CardId, HeldCount>;
  /** Distinct cards held, as far as the store could read (see `truncated`). */
  total: number;
  /** Held cards that are no longer in the catalog, within the limit: say so, never crash. */
  goneCardIds: CardId[];
  /**
   * True when there is more than `cards` shows: past the limit asked for, or
   * past what the store reads in one go.
   */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * An entity the search box offers before any card (Jason, 2026-10-23):
 * players by name or alias ("Doc Gooden" offers Dwight Gooden), the team
 * printed on the card, and sets (picking one opens its checklist).
 */
export type Suggestion =
  | {
      kind: "player";
      id: PlayerId;
      name: string;
      /** The alias the text matched, when it was not the name ("Doc Gooden"). */
      matchedAlias?: string;
      sport?: string;
    }
  | {
      kind: "team";
      id: TeamId;
      name: string;
      location: string;
      /** Set when the team belongs to a franchise: offer "include the whole franchise". */
      franchise?: NamedRef;
    }
  | {
      kind: "set";
      id: SetId;
      /** "2024 Topps Chrome". */
      label: string;
      sport: string;
    };

/** The cards an entity suggestion stands for. */
export type EntityPick =
  | { kind: "player"; id: PlayerId }
  /** `wholeFranchise`: every team of the franchise (Commanders, Redskins, Football Team). */
  | { kind: "team"; id: TeamId; wholeFranchise: boolean };

export interface SearchResult {
  /**
   * Search: cards whose title holds every unquoted word (anywhere, any order)
   * and every quoted phrase verbatim (case-insensitive), best first. An
   * entity pick: that player's or team's cards, in catalog order.
   */
  cards: Card[];
  /** True when the store stopped at its cap: say there may be more, and offer suggestions. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What the store behind the page can do. All on for the demo, all off for the
 * real collection until each ships: hide the control, never show a dead one.
 */
export interface Capabilities {
  /** The My Binders tab, filing into binders, share links and spine labels. */
  binders: boolean;
  /** The Want List and Want toggles. */
  wants: boolean;
  /** Up for Trade. */
  trade: boolean;
  /** The "Binder: [All ▾]" picker and every scoped count. */
  scope: boolean;
  /** "Can't find it? Ask us to add it" (real requests arrive with NEO-361). */
  cardRequests: boolean;
  /** The demo bar, its Reset, and the demo's Light / Dark switch. */
  demoChrome: boolean;
  /** For sale and asking price on the copy form. */
  saleFields: boolean;
}

export const ALL_CAPABILITIES: Capabilities = {
  binders: true,
  wants: true,
  trade: true,
  scope: true,
  cardRequests: true,
  demoChrome: true,
  saleFields: true,
};

export const NO_CAPABILITIES: Capabilities = {
  binders: false,
  wants: false,
  trade: false,
  scope: false,
  cardRequests: false,
  demoChrome: false,
  saleFields: false,
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Takes exactly one write back. Rejects when the server refuses. */
export type Undo = () => Promise<void>;

export interface AddResult {
  /** The line item the card landed in: new, or the identical one it folded into. */
  copyId: CopyId;
  /** True when it folded into an identical line item as extra quantity. */
  merged: boolean;
  undo: Undo;
}

export interface AddManyResult {
  copyIds: CopyId[];
  /** Takes the whole batch back. */
  undo: Undo;
}

export interface UpdateResult {
  undo: Undo;
}

export interface RemoveResult {
  /** The copy as it was, for the notice ("Removed Raw, Mint ×2"). */
  removed: Copy;
  undo: Undo;
}

export interface BuildingResult {
  /** Whether the set is now on "Sets I'm building". */
  building: boolean;
  undo: Undo;
}
