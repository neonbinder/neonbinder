/**
 * NEO-350 — types for the collection-tracker UI prototypes (kept as a
 * signed-in reference) and the permanent collection demo built from them
 * (`../../final`, at `/collection` and on `/binder-tracking`).
 *
 * Hard-coded fake data only: nothing here touches Convex. The shape mirrors
 * NB's own hierarchy (sport → year → brand → set → variant type → insert or
 * parallel → card) so a prototype that feels right on this data has a
 * realistic chance of feeling right on the real thing. Every cross-reference
 * is by id, never by a display name (product invariant 4).
 */

export type SportId = "baseball" | "football" | "hockey";
export type TeamId = string;
export type PlayerId = string;
export type BrandId = string;
export type SetId = string;
export type CardId = string;
export type CopyId = string;
export type BinderId = string;

export interface Sport {
  id: SportId;
  name: string;
}

export interface Brand {
  id: BrandId;
  name: string;
}

export interface Team {
  id: TeamId;
  /** Where the team is from: a city, a school, or an NPB sponsor. */
  location: string;
  /** The nickname collectors say: "Packers", "Red Wings", "Badgers". */
  name: string;
  league: "NFL" | "NHL" | "MLB" | "NCAA" | "NPB";
  /** Real livery, `#rrggbb`. */
  primary: string;
  secondary: string;
}

/** A stretch of a career with one team, college included. `to: null` = current. */
export interface Stint {
  teamId: TeamId;
  from: number;
  to: number | null;
}

export interface Player {
  id: PlayerId;
  name: string;
  sport: SportId;
  stints: Stint[];
  hallOfFame: boolean;
}

/**
 * Where a card sits inside its set. The variant TYPE's title is its kind
 * (NEO-334): Base, Inserts or Parallels. `name` is the insert or parallel
 * ("Pennant Flyers", "Gold Refractor"); null for the base set.
 */
export type VariantType = "Base" | "Inserts" | "Parallels";
export interface VariantPath {
  type: VariantType;
  name: string | null;
}

/** How the printed card looks: drives CardFace's treatment, nothing else. */
export type FinishKind =
  | "standard"
  | "refractor"
  | "foil"
  | "gold"
  | "superfractor";
export interface Finish {
  kind: FinishKind;
  /** Colour cast for coloured refractors / foils (`#rrggbb`). */
  tint?: string;
}

export type CardFeature = "RC" | "AU" | "Relic" | "SP";

export interface SetVariant {
  path: VariantPath;
  /** Print run every card in this variant shares; null = unnumbered. */
  printRun: number | null;
  finish: Finish;
}

export interface CardSet {
  id: SetId;
  sportId: SportId;
  /** The year the set is filed under (a hockey season files under its start). */
  year: number;
  /** What collectors call it: "1996" or "1996-97". */
  season: string;
  brandId: BrandId;
  /** The set's own name as it reads after the season: "Playoff Contenders". */
  name: string;
  /** Base first, then inserts, then parallels: the order the checklist shows. */
  variants: SetVariant[];
}

export interface Card {
  id: CardId;
  setId: SetId;
  variantPath: VariantPath;
  /** A string ("13b" exists) and NEVER unique, even inside one set. */
  cardNumber: string;
  playerIds: PlayerId[];
  /** Teams shown on the card (the uniform), not every team the player had. */
  teamIds: TeamId[];
  /** Numbered print run: 50 means "/50", 1 means a 1/1; null = unnumbered. */
  printRun: number | null;
  features: CardFeature[];
  /** Image or photo variation name ("Sliding"); null for the regular card. */
  variation: string | null;
  finish: Finish;
}

export type Condition =
  | "Mint"
  | "Near Mint"
  | "Excellent"
  | "Very Good"
  | "Good"
  | "Poor";

export type Grader = "PSA" | "BGS" | "SGC" | "CGC" | "TAG";

export interface Grading {
  grader: Grader;
  /** Kept as text: "10", "9.5", "Authentic". */
  grade: string;
  cert?: string;
}

/** Everything about a copy the collector can edit (NEO-27 shape). */
export interface CopyDetails {
  quantity: number;
  condition?: Condition;
  graded?: Grading;
  /** This copy's own serial, e.g. "23/50". Only meaningful on numbered cards. */
  serialNumber?: string;
  /** What the collector paid, in dollars. */
  costBasis?: number;
  /** NEO-378 — the lowest this copy sells for, in dollars. Only the real collection's box copies carry it. */
  minPrice?: number;
  /** ISO date, `YYYY-MM-DD`. */
  acquiredAt: string;
  /** Free text: "Box 3", "Top shelf". */
  location?: string;
  binderIds: BinderId[];
  notes: string;
  forSale: boolean;
  askPrice?: number;
}

/** One physical copy (or a stack of identical raw ones) the collector owns. */
export interface Copy extends CopyDetails {
  id: CopyId;
  cardId: CardId;
}

/**
 * A smart binder's rule. Every leaf names an id, never a display string, so
 * renaming a player, team or brand never changes what a binder holds.
 */
export type BinderRule =
  | { kind: "player"; playerId: PlayerId }
  | { kind: "teamOnCard"; teamId: TeamId }
  /** Any player on the card had a stint with the team: college counts. */
  | { kind: "playedFor"; teamId: TeamId }
  | { kind: "brand"; brandId: BrandId }
  | { kind: "set"; setId: SetId }
  | { kind: "sport"; sportId: SportId }
  | { kind: "yearRange"; from: number; to: number }
  | { kind: "feature"; feature: CardFeature }
  | { kind: "variantType"; type: VariantType }
  /** Numbered AND printRun < max: "numbered under /50" is `max: 50`. */
  | { kind: "printRunBelow"; max: number }
  | { kind: "hallOfFame" }
  | { kind: "and"; rules: BinderRule[] }
  | { kind: "or"; rules: BinderRule[] }
  | { kind: "not"; rule: BinderRule };

/** A nine-pocket page: exactly 9 slots, each a copy id or empty. */
export interface BinderPage {
  slots: (CopyId | null)[];
}

interface BinderBase {
  id: BinderId;
  name: string;
  description?: string;
}

export interface ManualBinder extends BinderBase {
  kind: "manual";
  /** Optional physical layout. Membership itself lives on `Copy.binderIds`. */
  layout?: BinderPage[];
}

export interface SmartBinder extends BinderBase {
  kind: "smart";
  rule: BinderRule;
}

export type Binder = ManualBinder | SmartBinder;
