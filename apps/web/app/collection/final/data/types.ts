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
 * Everything about a copy the collector edits. Field names match the
 * prototypes' `CopyDetails` (so `CopyDetailsForm` takes them unchanged); the
 * Convex store converts on the way through (`costBasis` dollars ↔ cents,
 * `acquiredAt` ↔ `acquiredOn`, `graded` ↔ `grading`).
 *
 * NEO-359: a copy has ONE home (`homeId`, a binder or a box) and is for sale
 * exactly when that home is a box (Jason, 2026-10-24): there is no for-sale
 * flag and no asking price (price belongs to a listing). Up for Trade is a
 * flag on the copy; the card stays where it lives.
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
  /**
   * Where the copy lives. On an add: absent files it in the page's scope
   * (`useScope`) when that is a binder or box, else in Main. On an edit it
   * must stay the same: a change of home is `moveCopy`, never `updateCopy`.
   */
  homeId?: ContainerId;
  /**
   * Where inside its home: a binder pocket (`page * 9 + pocket`, both from
   * 0; a pocket holds one line item) or a box row (0 to `BOX_ROWS - 1`, a
   * row holds many). Absent: not in a pocket or row yet.
   */
  slot?: number;
  /** On the Up for Trade pile. The copy stays in its home. */
  upForTrade?: boolean;
}

/** One line item the collector owns: one physical copy, or an identical stack. */
export interface Copy extends CopyDetails {
  id: CopyId;
  cardId: CardId;
  variantId: VariantId;
  setId: SetId;
  /** The copy's one home: a binder, or a box (for sale). */
  homeId: ContainerId;
  /** What the home is. `"box"`: the copy is for sale. "binder" while the store does not know yet. */
  homeKind: ContainerKind;
  /** "Main", "Show box", when the store knows it. */
  homeName?: string;
  upForTrade: boolean;
}

/** Rows in a box (a long box's dividers): `slot` 0 to 4. */
export const BOX_ROWS = 5;
/** Pockets on a binder page. */
export const POCKETS_PER_PAGE = 9;
/** Pages a binder's pockets run to: `slot` 0 to `POCKETS_PER_PAGE * MAX_BINDER_PAGES - 1`. */
export const MAX_BINDER_PAGES = 1000;

/** A binder pocket's `slot`, from its page and pocket (both from 0). */
export function pocketSlot(page: number, pocket: number): number {
  return page * POCKETS_PER_PAGE + pocket;
}

/** The page and pocket (both from 0) a binder `slot` names. */
export function pocketOf(slot: number): { page: number; pocket: number } {
  return { page: Math.floor(slot / POCKETS_PER_PAGE), pocket: slot % POCKETS_PER_PAGE };
}

// ---------------------------------------------------------------------------
// Binders and boxes
// ---------------------------------------------------------------------------

/** A container is a binder (keeps cards) or a box (cards for sale). */
export type ContainerKind = "binder" | "box";

/**
 * The containers every collector has. `main`: where a card lands until it is
 * filed elsewhere. `want`: the Want List (holds wants, never copies). `trade`:
 * the Up for Trade pile (shows the copies flagged `upForTrade`; never a home).
 * System containers sort first and cannot be renamed or deleted; their label
 * can be set.
 */
export type SystemKind = "main" | "want" | "trade";

/** A spine label in the Print Shop's look: a `#rrggbb` pair and a spine font id. */
export interface ContainerLabel {
  background: string;
  text: string;
  fontId: string;
}

/**
 * One test of a smart binder's rule. Every leaf names an NB id, never a
 * display string, so a rename never changes what a binder holds.
 */
export type RuleLeaf =
  | { kind: "player"; playerId: PlayerId }
  /** The team printed on the card (the uniform). */
  | { kind: "teamOnCard"; teamId: TeamId }
  /** Any player on the card had a stint with the team: college counts. */
  | { kind: "playedFor"; teamId: TeamId }
  | { kind: "brand"; brandId: string }
  | { kind: "set"; setId: SetId }
  | { kind: "sport"; sportId: string }
  /** Inclusive years. */
  | { kind: "yearRange"; from: number; to: number }
  | { kind: "feature"; feature: CardFeature }
  /** Numbered AND print run under `max`: "numbered under /50" is `max: 50`. */
  | { kind: "printRunBelow"; max: number }
  | { kind: "hallOfFame" };

/** A leaf, or a leaf turned around. */
export type RuleTerm = RuleLeaf | { kind: "not"; rule: RuleLeaf };

/** A smart binder's rule: one term, or one level of and / or over terms. Never deeper. */
export type ContainerRule = RuleTerm | { kind: "and" | "or"; rules: RuleTerm[] };

/** What a container holds, kept on the server by every write (never counted on read). */
export interface ContainerCount {
  /** Physical cards: quantities summed. On the Want List, the want count. */
  copies: number;
  /** Line items. On the Want List, the want count. */
  lines: number;
}

/** A binder or a box, as the shelf lists it. */
export interface Container {
  id: ContainerId;
  kind: ContainerKind;
  /** Set on the three every collector has; absent on the collector's own. */
  system?: SystemKind;
  name: string;
  description?: string;
  /** The collector's own spine label; absent for the default (`binders/label.ts`). */
  label?: ContainerLabel;
  /**
   * A smart binder: fills itself from this rule (capability
   * `smartBinders`; demo only until NEO-362). Never a home.
   */
  rule?: ContainerRule;
  /**
   * A home (Main, a binder, a box): the copies whose home it is. Up for
   * Trade: the flagged copies. The Want List: the wants (both numbers). A
   * smart binder: the copies its rule matches (demo only). `null`: not
   * counted yet; show it as unknown, never as 0.
   */
  count: ContainerCount | null;
}

/** True when a copy can live here: a binder or box that is not the Want List, the trade pile or a smart binder. */
export function isHome(container: Pick<Container, "system" | "rule"> | undefined): boolean {
  return !!container && !container.rule && container.system !== "want" && container.system !== "trade";
}

/**
 * A card on the Want List: for one binder or box ("for my Ohtani rainbow"),
 * or (null) just wanted. At most ONE want per card: wanting it for another
 * binder moves the want there.
 */
export interface Want {
  cardId: CardId;
  binderId: ContainerId | null;
}

/**
 * What the page is looking through: everything, or one home (the "Binder:
 * [All ▾]" picker, `scope=` on the URL). A scope narrows `useCopiesInVariant`
 * and `useVariantCompletion`, and is where Have files a new copy.
 */
export type Scope = "all" | ContainerId;

/** Copies listed out of one container, up to the limit asked for. */
export interface ContainerCopies {
  copies: Copy[];
  /** True while more exist than `copies` lists: raise the limit to see them. */
  truncated: boolean;
}

/** A whole set's cards for Browse, every checklist in order, up to the limit asked for. */
export interface SetCards {
  cards: Card[];
  /** True while the set holds more cards than `cards` lists: raise the limit to page further. */
  truncated: boolean;
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

/**
 * How much of a whole set the collector has: every checklist of the set
 * (Base, inserts, parallels) counted together, against the set summary's
 * `totalCards` / `totalCardsAll`. Honours the view scope like
 * `useVariantCompletion`.
 */
export interface SetCompletion extends Completion {
  /**
   * False when the store could count only part of the set's copies (a very
   * large holding): `owned` is then a floor, to read as "N+", never as the
   * answer.
   */
  exact: boolean;
}

/** The whole collection at a glance. */
export interface CollectionSummary {
  /** Physical cards: quantities summed. */
  copies: number;
  /** Distinct checklist cards owned. */
  cards: number;
  /**
   * False when the store could only count part of the collection: both
   * numbers are then a floor, and read as "5,000+", never as the answer.
   */
  exact: boolean;
  /**
   * Distinct cards not in any set the collector is building ("Everything
   * else"). Null when the store could not count it exactly: unknown, never
   * a floor.
   */
  offBuild: number | null;
}

/** One card the collector holds, as the owned-cards list counts it. */
export interface HeldCount {
  /** Physical copies: quantities summed over every line item. */
  quantity: number;
  /** Line items (a stack of identical copies is one). */
  lines: number;
  /** True when any of its copies is graded (a slab); absent when none is. */
  graded?: boolean;
}

/** "Everything I own": the collector's cards, most recently touched first. */
export interface OwnedCards {
  /** Up to the limit asked for, hydrated. */
  cards: Card[];
  /** How many of each listed card the collector holds, by card id. */
  copiesByCard: Record<CardId, HeldCount>;
  /** Distinct cards held, the whole collection's (see `totalExact`). */
  total: number;
  /** False when `total` is only a floor (read it as "5,000+"). */
  totalExact: boolean;
  /** Held cards that are no longer in the catalog, within the limit: say so, never crash. */
  goneCardIds: CardId[];
  /** True when the collection holds more cards than `cards` and `goneCardIds` list. */
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
      /** Livery, `#rrggbb`, when NB has it (the label designer's team colours). */
      primary?: string;
      secondary?: string;
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
  /** My Binders: the shelf, binders and boxes, filing, pockets and rows, spine labels. */
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
  /** Making a smart binder (a rule that fills it). Real ones arrive with NEO-362. */
  smartBinders: boolean;
  /** Share links for a binder, the Want List or a set (no public profile route yet). */
  share: boolean;
}

export const ALL_CAPABILITIES: Capabilities = {
  binders: true,
  wants: true,
  trade: true,
  scope: true,
  cardRequests: true,
  demoChrome: true,
  smartBinders: true,
  share: true,
};

export const NO_CAPABILITIES: Capabilities = {
  binders: false,
  wants: false,
  trade: false,
  scope: false,
  cardRequests: false,
  demoChrome: false,
  smartBinders: false,
  share: false,
};

/** What the real collection can do today (NEO-359: binders, boxes, wants, trade and scope). */
export const REAL_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  binders: true,
  wants: true,
  trade: true,
  scope: true,
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

/** A copy moved (`moveCopy`) or placed (`placeCopy`, which can fold too). */
export interface MoveResult {
  /** The line item the moved cards are now: the same row, a new one split off, or the twin it folded into. */
  copyId: CopyId;
  /** True when it folded into an identical line item at the destination. */
  folded: boolean;
  /** True when only part of the stack moved: the source kept the rest. */
  split: boolean;
  /** Moves exactly these cards back where they were (splitting them back out of a fold). */
  undo: Undo;
}

export interface WantResult {
  /** False when the want already read as asked (nothing was written). */
  changed: boolean;
  undo: Undo;
}

/** A new binder or box. `rule` only with the `smartBinders` capability. */
export interface NewContainer {
  kind: ContainerKind;
  name: string;
  description?: string;
  label?: ContainerLabel;
  rule?: ContainerRule;
}

/** What `updateContainer` may change. On a system container, only `label`. `label: null` goes back to the default. */
export interface ContainerPatch {
  name?: string;
  description?: string;
  label?: ContainerLabel | null;
}

export interface CreateContainerResult {
  containerId: ContainerId;
  /** Takes the new container back down, while it is still empty. */
  undo: Undo;
}

export interface DeleteContainerResult {
  /** Copies sent back to Main (their pocket or row cleared). Deleting has no undo. */
  moved: number;
}

/** The most containers one collector may have (the server refuses past it). */
export const MAX_CONTAINERS = 200;
/** The most wants one collector may have (the server refuses past it). */
export const MAX_WANTS = 2000;
