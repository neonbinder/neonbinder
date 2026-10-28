/**
 * NEO-358 — the collection page's store contract: one interface, two stores.
 *
 * Views never import a store. They call the hooks exported here, which read
 * whichever store the page was mounted with:
 *
 *   <DemoCollectionProvider>    the public demo (`./demoStore`): fixture
 *                               catalog + sessionStorage reducer, every
 *                               capability on, never touches Convex or Clerk.
 *   <ConvexCollectionProvider>  signed-in `/collection` (`./convexStore`):
 *                               the real catalog and the collector's own
 *                               copies, capabilities off until each ships.
 *
 * ## Reads: hooks that return `undefined` while loading
 *
 * Every data hook answers `undefined` until its answer is in, then the answer.
 * Show a skeleton for `undefined`; never treat it as empty. A `null` input
 * (no set picked yet, say) skips the read and also returns `undefined`. Single
 * lookups (`useCard`, `useSetSummary`, `useSetPath`) answer `null` for an id
 * the catalog does not hold: a copy whose card was later removed renders "no
 * longer in the catalog", never a crash. Search hooks answer an empty result
 * straight away for text shorter than `MIN_SEARCH_LENGTH`; debounce the text
 * (300ms) before passing it in.
 *
 * Reads are per checklist (variant), never a whole set's cards, with one
 * exception: Browse a set (`useSetCards`), which pages a whole set in up to
 * a limit the view raises as the collector turns pages.
 *
 * ## Scope
 *
 * The page's scope (the "Binder: [All ▾]" picker) rides on the URL as
 * `scope=` (`../mode.tsx`), and the page puts it in `ScopeProvider`. Both
 * stores read it (`useScope()`): with a binder or box picked,
 * `useCopiesInVariant` and `useVariantCompletion` count only that home, and
 * `useCollectionActions()` files a Have there. `useCopiesOf` always lists
 * every copy, each with its home.
 *
 * ## Side (NEO-364)
 *
 * The page's side (`"collection"` on `/collection`, `"inventory"` on
 * `/inventory`; the demo's `side=` param) sits in `SideProvider`, put there
 * by the page (`../mode.tsx` decides it). `useCopiesInVariant`,
 * `useVariantCompletion` and `useSetCompletion` read only that side's copies:
 * binder homes for the collection, box homes for the inventory. Pass `side`
 * to a wrapper to read the other one; the store's own member always gets it.
 * Without a provider the side is `"collection"`.
 *
 * ## Writes: async actions that hand back their undo
 *
 * `useCollectionActions()` returns promises. Each resolves with what it did
 * and an `undo` that takes exactly that write back (the inverse write, never
 * a snapshot restore): pass the undo straight to `notify(message, undo)`.
 * A write the server refuses rejects; show its message on the status line.
 * The Convex store applies each write optimistically to `useCopiesOf`,
 * `useCopiesInVariant`, `useVariantCompletion`, `useContainerCopies`,
 * `useTradeCopies` and the shelf's counts, so a tile lights (and a moved
 * card leaves its pocket) at once.
 *
 * Moves: `moveCopy` is the only way a copy changes home. Moving part of a
 * stack splits it; landing on an identical line item folds into it; the
 * undo moves the same cards back (splitting them back out of a fold).
 * `updateCopy` never moves a copy and never folds.
 *
 * Writes take the hydrated `Card` / `Copy` (not bare ids) so a store can
 * update every view the write touches before the server answers.
 *
 * ## Capabilities
 *
 * `useCapabilities()` says what this store can do. Hide every control behind
 * a flag that is off; never show one that cannot work.
 *
 * ## The demo extension
 *
 * `useDemoExtension()` is what only the demo has: card requests, the Browse
 * shelf's sets and filters, a smart rule in words, and Reset. It is
 * `undefined` under the Convex store: a view that needs it must be gated by
 * the matching capability. Binders, boxes, wants, trade and scope are NOT
 * demo-only (NEO-359): read them through the hooks here.
 */

import { createContext, useContext, useMemo } from "react";
import type { BrowseFilter, CardRequest, NewCardRequest } from "../store";
import type {
  AddManyResult,
  BinderNeeds,
  BinderSettingsPatch,
  DeclinedCard,
  RuleBrand,
  FoundCards,
  PocketPlacement,
  SmartRule,
  InventoryCards,
  QuantityResult,
  Side,
  SystemKind,
  AddResult,
  BuildingResult,
  Capabilities,
  Card,
  CardId,
  Condition,
  CardTeam,
  CollectionSummary,
  Completion,
  Container,
  ContainerCopies,
  ContainerId,
  ContainerPatch,
  ContainerRule,
  Copy,
  CopyId,
  CreateContainerResult,
  DeleteContainerResult,
  MoveResult,
  NewContainer,
  OwnedCards,
  CopyDetails,
  PublicShelf,
  ShareLinkParts,
  ShareProfile,
  DrillItem,
  DrillLevel,
  DrillParents,
  EntityPick,
  RemoveResult,
  Scope,
  SearchResult,
  SetCards,
  SetId,
  SetPath,
  SetRef,
  SetCompletion,
  SetSummary,
  Suggestion,
  TeamId,
  UpdateResult,
  VariantId,
  Want,
  WantResult,
} from "./types";
import { DEFAULT_CONDITION, isHome } from "./types";

export type * from "./types";

/** Search text shorter than this (trimmed) is not searched. */
export const MIN_SEARCH_LENGTH = 2;
/** How long a view waits for a pause in typing before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface SearchOptions {
  /** Narrow the card search to one sport (a sport drill id). */
  sportId?: string;
}

/**
 * The reads. Each member is a React hook: call it unconditionally at the top
 * of a component, through the wrappers below (`useCard(id)`), never off the
 * store object.
 */
export interface CollectionData {
  /** One cascade column: the rows under the ids picked above it. */
  useDrill(level: DrillLevel | null, parents: DrillParents): DrillItem[] | undefined;
  /** The set and its variants (Base first), each with its card count. `null`: not in the catalog. */
  useSetSummary(setId: SetId | null): SetSummary | null | undefined;
  /** The drill steps above a set (sport, year, brand, set). `null`: not in the catalog. */
  useSetPath(setId: SetId | null): SetPath | null | undefined;
  /** A checklist's cards, in checklist order. */
  useVariantCards(variantId: VariantId | null): Card[] | undefined;
  /**
   * How much of a checklist the collector holds on `side` (inside the picked
   * home): the collection's binders, or the inventory's boxes. A copy on the
   * other side never counts.
   */
  useVariantCompletion(variantId: VariantId | null, side: Side): Completion | undefined;
  /**
   * How much of a whole set the collector has on `side`, every checklist
   * together (in the view scope; a copy on the other side never counts). The
   * totals are the set summary's; while the summary or the counts load,
   * `undefined`.
   */
  useSetCompletion(setId: SetId | null, side: Side): SetCompletion | undefined;
  /** One card. `null`: no longer in the catalog. */
  useCard(cardId: CardId | null): Card | null | undefined;
  /** Several cards, aligned with `cardIds`; `null` where one is no longer in the catalog. */
  useCards(cardIds: readonly CardId[] | null): (Card | null)[] | undefined;
  /** Players (name or alias), teams and sets matching the text, best first. */
  useSuggestions(text: string, options?: { sportId?: string }): Suggestion[] | undefined;
  /** One team, with its livery when NB has it. `null`: not in the catalog. */
  useTeam(teamId: TeamId | null): CardTeam | null | undefined;
  /** Cards whose title matches the text: every word, quoted phrases verbatim. */
  useSearch(text: string, options?: SearchOptions): SearchResult | undefined;
  /** The cards of a picked player, or of a team printed on the card (optionally its whole franchise). */
  useEntityCards(pick: EntityPick | null): SearchResult | undefined;
  /** "Sets I'm building", as the collector chose them (never inferred). */
  useBuildingSets(): SetRef[] | undefined;
  /**
   * Every copy of one card the collector owns, in every home, boxes too:
   * the card's drawer. A collection screen passes it through
   * `collectionCopiesIn`.
   */
  useCopiesOf(cardId: CardId | null): Copy[] | undefined;
  /**
   * The collector's copies of every card in a checklist on `side` (inside
   * the picked home): binder copies for the collection, box copies for the
   * inventory. Never one from the other side.
   */
  useCopiesInVariant(variantId: VariantId | null, side: Side): Copy[] | undefined;
  /** The whole collection at a glance: copies in a box are inventory, not counted. */
  useSummary(): CollectionSummary | undefined;
  /**
   * Every card the collector holds in the collection (never a copy in a
   * box), most recently touched first, up to
   * `limit`: raise the limit to page further. The Convex store pages the
   * server for as many as it needs, so there is no ceiling but the limit.
   */
  useOwnedCards(options?: OwnedCardsOptions): OwnedCards | undefined;
  /**
   * The Inventory list: every card held in a box (never a binder copy), one
   * item per card with its count and the boxes it sits in. `boxId` narrows
   * to one box (Unsorted or the collector's own); Up for Trade is not a box,
   * so filter on `upForTrade` instead. Inventory side only.
   */
  useInventoryCards(options?: InventoryCardsOptions): InventoryCards | undefined;

  // --- NEO-359: binders, boxes, wants, trade ---------------------------------

  /** The shelf: system containers first (Main, Unsorted, Up for Trade, Want List), then the collector's own as made. */
  useContainers(): Container[] | undefined;
  /**
   * The copies in one container, in slot order (unslotted last), up to
   * `limit`. A binder or box: the copies whose home it is (a box's for My
   * Boxes). The Up for Trade pile: every flagged copy, a box's too
   * (same as `useTradeCopies`). A smart binder: the copies its rule matches
   * (demo only), never one in a box. The Want List: none (`useWants`).
   */
  useContainerCopies(containerId: ContainerId | null, options?: PageOptions): ContainerCopies | undefined;
  /**
   * Every copy flagged Up for Trade, in a binder or a box (trade spans
   * collection and inventory; see `inCollection`), up to `limit`.
   */
  useTradeCopies(options?: PageOptions): ContainerCopies | undefined;
  /** The Want List: every want (at most `MAX_WANTS`). */
  useWants(): Want[] | undefined;
  /**
   * NEO-380: the condition a raw copy gets when none is named (Profile →
   * Settings), `DEFAULT_CONDITION` until the collector picks one or while it
   * loads. The demo has no settings: always `DEFAULT_CONDITION`.
   */
  useDefaultCondition(): Condition;
  /**
   * The collector's copies of each card asked for (the hunt tray), keyed by
   * card id; a card held nowhere maps to `[]`. Every home, boxes too: a
   * collection screen passes the answer through `collectionCopiesOfCards`,
   * an inventory screen (My Boxes' tray) through `inventoryCopiesOfCards`. Keep the list short: the
   * Convex store asks in chunks of 50, and lists at most ten line items of a
   * card (enough to say "you have it, here"; `useCopiesOf` has them all).
   */
  useCopiesOfCards(cardIds: readonly CardId[] | null): Record<CardId, Copy[]> | undefined;
  /**
   * Browse a set: every card of every checklist, in set order (Base, then
   * inserts, then parallels; each in checklist order), up to `limit`.
   */
  useSetCards(setId: SetId | null, options?: PageOptions): SetCards | undefined;

  // --- NEO-362: smart binders and binder settings ----------------------------

  /**
   * The catalog cards a binder's empty slots stand for (none of them in it):
   * a smart binder's rule matches, else the checklists the binder holds a
   * card from. Ask only while empty slots are drawn.
   */
  useBinderNeeds(containerId: ContainerId | null): BinderNeeds | undefined;
  /**
   * Which of `cardIds` fit a smart binder's rule (capability `binderRules`):
   * the Checklists filter and "outside the rule". Empty for a binder without
   * a rule, and from a store without rules.
   */
  useRuleMatches(containerId: ContainerId | null, cardIds: readonly CardId[] | null): ReadonlySet<CardId> | undefined;
  /** "Find cards for this binder" (capability `binderRules`); `null` asks nothing. */
  useFindCards(containerId: ContainerId | null): FoundCards | undefined;
  /** The cards declined for a smart binder, newest first (capability `binderRules`). */
  useDeclined(containerId: ContainerId | null): DeclinedCard[] | undefined;
  /**
   * A sport's brands for the rule builder, each with every year's row of it
   * (capability `binderRules`); `null` asks nothing.
   */
  useRuleBrands(sportId: string | null): RuleBrand[] | undefined;

  // --- NEO-378: common prices ------------------------------------------------

  /**
   * The collector's common price (dollars) for each variant asked about that
   * has one; a variant with none is absent from the record. At most 200 ids.
   */
  useCommonPrices(variantIds: readonly VariantId[] | null): Record<VariantId, number> | undefined;
}

export interface PageOptions {
  /** How many to list; raise it to page further. */
  limit?: number;
}

/** `useContainerCopies` / `useTradeCopies` when no limit is asked for. */
export const CONTAINER_COPIES_DEFAULT_LIMIT = 300;
/** `useSetCards` when no limit is asked for. */
export const SET_CARDS_DEFAULT_LIMIT = 300;

export interface OwnedCardsOptions {
  /** Cards to hydrate; default `OWNED_CARDS_DEFAULT_LIMIT`. Raise it for "Show more". */
  limit?: number;
}

/** The owned-cards list's limit when none is asked for. */
export const OWNED_CARDS_DEFAULT_LIMIT = 200;

export interface InventoryCardsOptions {
  /** How many cards to list; raise it to page further. */
  limit?: number;
  /** One box's cards only (Unsorted or one of the collector's boxes). Absent: every box. */
  boxId?: ContainerId;
}

/**
 * The writes. Each resolves with its undo; see the module comment. Take them
 * from `useCollectionActions()`, which files adds into the page's scope.
 */
export interface CollectionActions {
  /**
   * One raw copy, acquired today (folds into an identical one), in `homeId`:
   * by default the page's scope when that is a home, else Main.
   */
  addHave(card: Card, homeId?: ContainerId): Promise<AddResult>;
  /** One raw copy of each card (a range, a need-list run) in `homeId` as for `addHave`; one undo for the batch. At most 200. */
  addMany(cards: readonly Card[], homeId?: ContainerId): Promise<AddManyResult>;
  /**
   * A copy with details (`details.homeId`, else the scope, else Main); the
   * server folds it into an identical line item (never one with a cert or
   * serial).
   */
  addLineItem(card: Card, details: CopyDetails): Promise<AddResult>;
  /** Edits a copy in place. Refuses a change of `homeId` (that is `moveCopy`); never folds. */
  updateCopy(copy: Copy, patch: Partial<CopyDetails>): Promise<UpdateResult>;
  /** Deletes the copy; the undo puts the same fields back. */
  removeCopy(copy: Copy): Promise<RemoveResult>;
  /** Puts a removed copy back (what `removeCopy`'s undo does). */
  restoreCopy(copy: Copy): Promise<AddResult>;
  /** Puts a set on "Sets I'm building", or takes it off. */
  setBuilding(set: SetRef, building: boolean): Promise<BuildingResult>;

  // --- NEO-359 ---------------------------------------------------------------

  /**
   * Moves `quantity` of a copy (default all of it) to another home, into
   * `slot` there when given (else unslotted). Folds into an identical line
   * item there; part of a stack splits off. Refuses the Want List, the Up
   * for Trade pile, a smart binder, and a binder pocket another line item
   * holds. A copy keeps its Up for Trade flag.
   */
  moveCopy(copy: Copy, toHomeId: ContainerId, options?: MoveOptions): Promise<MoveResult>;
  /**
   * Puts a copy in a pocket or row of the home it is in (`null`: out of it).
   * Folds into an identical line item already in that row; refuses a binder
   * pocket another line item holds. The undo puts it back where it was.
   */
  placeCopy(copy: Copy, slot: number | null): Promise<MoveResult>;
  /** Flags a copy Up for Trade, or takes the flag off. It stays where it lives. */
  setTrade(copy: Copy, on: boolean): Promise<UpdateResult>;
  /**
   * Wants a card for one binder or box (or `null`: just wants it), or stops
   * wanting it (`on: false` clears the card's want, whatever it was for).
   * One want per card: wanting it for another binder moves the want there.
   * Refuses past `MAX_WANTS`.
   */
  setWant(cardId: CardId, binderId: ContainerId | null, on: boolean): Promise<WantResult>;
  /** A new binder or box. Refuses past `MAX_CONTAINERS`. */
  createContainer(input: NewContainer): Promise<CreateContainerResult>;
  /** Renames, re-describes or re-labels. A system container takes a label only. */
  updateContainer(container: Container, patch: ContainerPatch): Promise<UpdateResult>;
  /**
   * Deletes a binder or box the collector made: a binder's copies go back to
   * Main, a box's into Unsorted (pockets and rows cleared, trade flags kept),
   * its wants become plain wants. No undo: the confirm must say so.
   */
  deleteContainer(container: Container): Promise<DeleteContainerResult>;

  // --- NEO-364 ---------------------------------------------------------------

  /**
   * Sets how many PLAIN copies of `card` sit in `box` (a box, Unsorted
   * included; refuses a binder): raw, no condition, serial, cost, location
   * or notes, not up for trade. Raising adds raw copies acquired today,
   * unslotted (folding into today's plain unslotted line). Lowering takes
   * from the plain lines newest first. The card's other lines in the box are
   * never touched. `quantity` is a whole number from 0; the current value
   * writes nothing. One write; the undo puts exactly those lines back.
   */
  setBoxQuantity(card: Card, box: Container, quantity: number): Promise<QuantityResult>;

  // --- NEO-362 ---------------------------------------------------------------

  /** Changes a binder's settings (Main included; capability `binderSettings`). */
  setBinderSettings(container: Container, patch: BinderSettingsPatch): Promise<UpdateResult>;
  /**
   * Puts every line item of a binder in the pocket given (Sort now; turning a
   * sort off so the pockets match what was drawn). Name every line once.
   */
  relayPockets(container: Container, placements: readonly PocketPlacement[]): Promise<UpdateResult>;
  /** Gives one of the collector's binders a rule, changes it, or takes it off (`null`). Never moves a card. */
  setSmartRule(container: Container, rule: SmartRule | null): Promise<UpdateResult>;
  /** Leaves a card out of a smart binder's Find cards. */
  declineCard(container: Container, cardId: CardId): Promise<UpdateResult>;
  /** Pulls a declined card back into Find cards. */
  undeclineCard(container: Container, cardId: CardId): Promise<UpdateResult>;

  // --- NEO-378 ---------------------------------------------------------------

  /**
   * Sets the collector's common price (dollars, zero or more) for one exact
   * variant, or clears it (`null`). Every copy of the variant with no
   * minimum price of its own sells at no less than this.
   */
  setCommonPrice(variantId: VariantId, price: number | null): Promise<UpdateResult>;
}

export interface MoveOptions {
  /** How many of the stack to move (1 to its quantity); default all of it. */
  quantity?: number;
  /** The pocket or row at the destination. */
  slot?: number;
}

/** What only the demo has (see the module comment). */
export interface DemoExtension {
  /** "Can't find it? Ask us to add it" (capability `cardRequests`): local and private. */
  cardRequests: CardRequest[];
  requestCard: (input: NewCardRequest) => CardRequest;
  /** Every set the Browse shelf can show, in shelf order. */
  browseSets: SetRef[];
  /** The Browse shelf's filters, kept so leaving the tab keeps them. */
  browseFilter: BrowseFilter;
  setBrowseFilter: (patch: Partial<BrowseFilter>) => void;
  /** A smart binder's rule in words ("Reggie White", "Score, and not numbered under /50"). */
  describeRule: (rule: ContainerRule) => string;
  /** Back to the starting stack. */
  reset: () => void;
}

/**
 * NEO-360 — real share links (capability `shareLinks`): the Convex store's
 * only. `undefined` under the demo, whose Share button is an example.
 * Each write rejects with the server's message when it refuses.
 */
export interface SharingExtension {
  /** The caller's public name and shelf switches; `undefined` while loading. */
  useShareProfile(): ShareProfile | undefined;
  /** A binder's link name, minted now for one made before share links. */
  ensureLink(container: Container): Promise<ShareLinkParts>;
  /** A new link name for a binder; the old link stops working. Refused when another binder uses it. */
  setSlug(container: Container, slug: string): Promise<ShareLinkParts>;
  /** A binder or the Want List: public, or private (the default). */
  setVisibility(container: Container, isPublic: boolean): Promise<void>;
  /** Up for Trade or the for-sale stock: public (the default), or private. */
  setShelfVisibility(shelf: PublicShelf, isPublic: boolean): Promise<void>;
}

export interface CollectionStoreValue {
  kind: "demo" | "convex";
  capabilities: Capabilities;
  data: CollectionData;
  actions: CollectionActions;
  demo?: DemoExtension;
  sharing?: SharingExtension;
}

export const CollectionStoreContext = createContext<CollectionStoreValue | null>(null);

/** The store the page was mounted with. Throws outside a collection provider. */
export function useCollectionStore(): CollectionStoreValue {
  const store = useContext(CollectionStoreContext);
  if (!store) throw new Error("useCollectionStore: outside DemoCollectionProvider / ConvexCollectionProvider");
  return store;
}

export function useCapabilities(): Capabilities {
  return useCollectionStore().capabilities;
}

/** NEO-360 — real share links; `undefined` when the store has none (the demo). */
export function useSharing(): SharingExtension | undefined {
  return useCollectionStore().sharing;
}

/**
 * The writes, with adds filed into the page's scope when it is a home (a
 * binder or box), else Main. An explicit `homeId` (or `details.homeId`)
 * still wins.
 */
export function useCollectionActions(): CollectionActions {
  const actions = useCollectionStore().actions;
  const scope = useScope();
  return useMemo(() => (scope === "all" ? actions : withScope(actions, scope)), [actions, scope]);
}

function withScope(actions: CollectionActions, scope: ContainerId): CollectionActions {
  return {
    ...actions,
    addHave: (card, homeId) => actions.addHave(card, homeId ?? scope),
    addMany: (cards, homeId) => actions.addMany(cards, homeId ?? scope),
    addLineItem: (card, details) => actions.addLineItem(card, details.homeId ? details : { ...details, homeId: scope }),
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

const ScopeContext = createContext<Scope>("all");

/**
 * Puts the page's scope where both stores read it. The page reads it off the
 * URL (`scopeFromParams` in `../mode.tsx`, which also validates it) and
 * passes only a home or `"all"`.
 */
export const ScopeProvider = ScopeContext.Provider;

/** The page's scope: `"all"`, or the binder or box it is looking through. */
export function useScope(): Scope {
  return useContext(ScopeContext);
}

// ---------------------------------------------------------------------------
// Side
// ---------------------------------------------------------------------------

const SideContext = createContext<Side>("collection");

/**
 * Puts the page's side where the side-aware wrappers read it. The page
 * decides it (`../mode.tsx`: by route in the app, `side=` in the public demo).
 */
export const SideProvider = SideContext.Provider;

/** The page's side: `"collection"` (the default) or `"inventory"`. */
export function useSide(): Side {
  return useContext(SideContext);
}

/** The demo's reducer store and Reset; `undefined` under the Convex store. */
export function useDemoExtension(): DemoExtension | undefined {
  return useCollectionStore().demo;
}

// ---------------------------------------------------------------------------
// The read hooks. A provider's `data` never changes kind while it is mounted,
// so each wrapper calls the same hook on every render.
// ---------------------------------------------------------------------------

export function useDrill(level: DrillLevel | null, parents: DrillParents): DrillItem[] | undefined {
  return useCollectionStore().data.useDrill(level, parents);
}
export function useSetSummary(setId: SetId | null): SetSummary | null | undefined {
  return useCollectionStore().data.useSetSummary(setId);
}
export function useSetPath(setId: SetId | null): SetPath | null | undefined {
  return useCollectionStore().data.useSetPath(setId);
}
export function useVariantCards(variantId: VariantId | null): Card[] | undefined {
  return useCollectionStore().data.useVariantCards(variantId);
}
export function useVariantCompletion(variantId: VariantId | null, side?: Side): Completion | undefined {
  const pageSide = useSide();
  return useCollectionStore().data.useVariantCompletion(variantId, side ?? pageSide);
}
export function useSetCompletion(setId: SetId | null, side?: Side): SetCompletion | undefined {
  const pageSide = useSide();
  return useCollectionStore().data.useSetCompletion(setId, side ?? pageSide);
}
export function useCard(cardId: CardId | null): Card | null | undefined {
  return useCollectionStore().data.useCard(cardId);
}
export function useCards(cardIds: readonly CardId[] | null): (Card | null)[] | undefined {
  return useCollectionStore().data.useCards(cardIds);
}
export function useSuggestions(text: string, options?: { sportId?: string }): Suggestion[] | undefined {
  return useCollectionStore().data.useSuggestions(text, options);
}
export function useTeam(teamId: TeamId | null): CardTeam | null | undefined {
  return useCollectionStore().data.useTeam(teamId);
}
export function useSearch(text: string, options?: SearchOptions): SearchResult | undefined {
  return useCollectionStore().data.useSearch(text, options);
}
export function useEntityCards(pick: EntityPick | null): SearchResult | undefined {
  return useCollectionStore().data.useEntityCards(pick);
}
export function useBuildingSets(): SetRef[] | undefined {
  return useCollectionStore().data.useBuildingSets();
}
export function useCopiesOf(cardId: CardId | null): Copy[] | undefined {
  return useCollectionStore().data.useCopiesOf(cardId);
}
export function useCopiesInVariant(variantId: VariantId | null, side?: Side): Copy[] | undefined {
  const pageSide = useSide();
  return useCollectionStore().data.useCopiesInVariant(variantId, side ?? pageSide);
}
export function useSummary(): CollectionSummary | undefined {
  return useCollectionStore().data.useSummary();
}
/**
 * "Everything I own" (named apart from `cards/context.ts`'s `useMyCards`, the
 * My Cards tab's own context).
 */
export function useOwnedCards(options?: OwnedCardsOptions): OwnedCards | undefined {
  return useCollectionStore().data.useOwnedCards(options);
}
export function useInventoryCards(options?: InventoryCardsOptions): InventoryCards | undefined {
  return useCollectionStore().data.useInventoryCards(options);
}

export function useContainers(): Container[] | undefined {
  return useCollectionStore().data.useContainers();
}
/** One container off the shelf. `null`: not one of the collector's (deleted, or a stale link). */
export function useContainer(containerId: ContainerId | null): Container | null | undefined {
  const containers = useContainers();
  if (containerId === null) return undefined;
  if (containers === undefined) return undefined;
  return containers.find((c) => c.id === containerId) ?? null;
}
export function useContainerCopies(containerId: ContainerId | null, options?: PageOptions): ContainerCopies | undefined {
  return useCollectionStore().data.useContainerCopies(containerId, options);
}
export function useTradeCopies(options?: PageOptions): ContainerCopies | undefined {
  return useCollectionStore().data.useTradeCopies(options);
}
export function useWants(): Want[] | undefined {
  return useCollectionStore().data.useWants();
}
export function useDefaultCondition(): Condition {
  return useCollectionStore().data.useDefaultCondition();
}
export function useCopiesOfCards(cardIds: readonly CardId[] | null): Record<CardId, Copy[]> | undefined {
  return useCollectionStore().data.useCopiesOfCards(cardIds);
}
export function useBinderNeeds(containerId: ContainerId | null): BinderNeeds | undefined {
  return useCollectionStore().data.useBinderNeeds(containerId);
}
export function useRuleMatches(
  containerId: ContainerId | null,
  cardIds: readonly CardId[] | null,
): ReadonlySet<CardId> | undefined {
  return useCollectionStore().data.useRuleMatches(containerId, cardIds);
}
export function useFindCards(containerId: ContainerId | null): FoundCards | undefined {
  return useCollectionStore().data.useFindCards(containerId);
}
export function useDeclined(containerId: ContainerId | null): DeclinedCard[] | undefined {
  return useCollectionStore().data.useDeclined(containerId);
}
export function useRuleBrands(sportId: string | null): RuleBrand[] | undefined {
  return useCollectionStore().data.useRuleBrands(sportId);
}
/** NEO-378 — the collector's common prices (dollars) for these variants; one with none is absent. */
export function useCommonPrices(variantIds: readonly VariantId[] | null): Record<VariantId, number> | undefined {
  return useCollectionStore().data.useCommonPrices(variantIds);
}
export function useSetCards(setId: SetId | null, options?: PageOptions): SetCards | undefined {
  return useCollectionStore().data.useSetCards(setId, options);
}

// ---------------------------------------------------------------------------
// Small shared rules both stores follow.
// ---------------------------------------------------------------------------

/** The system container of a kind on the shelf (`"unsorted"`: the inventory's Main), once the shelf is in. */
export function systemContainer(containers: readonly Container[] | undefined, kind: SystemKind): Container | undefined {
  return containers?.find((c) => c.system === kind);
}

/** The homes a copy can be filed or moved into: Main first, then the collector's binders and boxes. */
export function homesOf(containers: readonly Container[] | undefined): Container[] {
  return (containers ?? []).filter(isHome);
}

/**
 * The binders a copy can live in: Main first, then the collector's own. The
 * collection's screens (the Binder picker, My Binders, the My Cards rail,
 * the drawer's Move) offer only these. Boxes are Inventory's (NEO-359).
 */
export function bindersOf(containers: readonly Container[] | undefined): Container[] {
  return homesOf(containers).filter((c) => c.kind !== "box");
}

/**
 * The boxes a copy can live in: Unsorted first, then the collector's own.
 * The inventory's screens (the target box picker, My Boxes, the list's rail,
 * the drawer's Sell) offer only these.
 */
export function boxesOf(containers: readonly Container[] | undefined): Container[] {
  const boxes = homesOf(containers).filter((c) => c.kind === "box");
  const unsorted = boxes.filter((c) => c.system === "unsorted");
  return unsorted.length ? [...unsorted, ...boxes.filter((c) => c.system !== "unsorted")] : boxes;
}

/** The homes a screen on `side` offers: `bindersOf` for the collection, `boxesOf` for the inventory. */
export function homesOnSide(containers: readonly Container[] | undefined, side: Side): Container[] {
  return side === "inventory" ? boxesOf(containers) : bindersOf(containers);
}

/**
 * Whether a card reads as wanted under a scope: with a home picked, wanted
 * for that home; under All, wanted at all.
 */
export function isWantedIn(wants: readonly Want[] | undefined, cardId: CardId, scope: Scope): boolean {
  if (!wants) return false;
  return scope === "all"
    ? wants.some((w) => w.cardId === cardId)
    : wants.some((w) => w.cardId === cardId && w.binderId === scope);
}

/**
 * The `setWant` call that flips a Want toggle under a scope: with a home
 * picked, on wants it for that home (moving a want it had for another) and
 * off clears it; under All, on adds a plain want and off clears it.
 */
export function wantToggle(
  wants: readonly Want[],
  cardId: CardId,
  scope: Scope,
): { cardId: CardId; binderId: ContainerId | null; on: boolean } {
  const on = !isWantedIn(wants, cardId, scope);
  return { cardId, binderId: scope === "all" ? null : scope, on };
}

/** The want a card has, if any (one per card). */
export function wantOf(wants: readonly Want[] | undefined, cardId: CardId): Want | undefined {
  return wants?.find((w) => w.cardId === cardId);
}

/** True when the copy's home is a box: it is for sale. */
export function isForSale(copy: Pick<Copy, "homeKind">): boolean {
  return copy.homeKind === "box";
}

// ---------------------------------------------------------------------------
// The collection never shows a card that is for sale (NEO-359)
// ---------------------------------------------------------------------------
//
// Jason, 2026-10-24: "cards that are for sale should not be in binders. They
// are two different concepts. Binders are your collection and For Sale are
// your inventory. When a card is put up for sale it should be taken out of
// the binder and moved to whatever box it is in."
//
// A copy whose home is a box is inventory. It never appears on a collection
// screen: My Binders (every binder, All my cards, a smart binder, the Want
// List's "landed", a browsed set, the hunt tray), My Cards (scoreboards, the
// wall, the need list, every owned-card shelf, "Everything else"), Checklists
// (Have, completion, row stacks, the drill's "have N of M") and the shelf's
// counts. It appears on the inventory's screens and in the card's own drawer
// (`useCopiesOf`), whose line reads "For sale · <box>" so it can be taken off
// sale.
//
// One exception: the Up for Trade pile. Jason, 2026-10-24: Up for Trade
// crosses both, because trade spans collection and inventory. A copy flagged
// up for trade shows there wherever it lives, binder or box, and the pile's
// spine counts it; a box copy's pocket wears a "For sale" tag so it reads as
// inventory. The pile's hunt tray ("Hunt for a card to trade") lists box
// copies too, each place marked "for sale", so one can be flagged from there.
// The pile and its tray are the only collection views that include box
// copies; the other My Binders hunts (a binder, All my cards, the Want List)
// still hide them.
//
// The rule lives here, once. Both stores apply it to their collection reads
// (`useCopiesInVariant`, `useVariantCompletion`, `useSetCompletion`,
// `useDrill`, `useSummary`, `useOwnedCards` and smart binders'
// `useContainerCopies`), and never to the trade pile's (`useTradeCopies`
// and its `useContainerCopies`); a view that reads every home (`useCopiesOf`,
// `useCopiesOfCards`) for a collection screen passes the answer through
// `collectionCopies` / `collectionCopiesIn` / `collectionCopiesOfCards`,
// except the trade pile's hunt tray, which takes `useCopiesOfCards` as is.

/** True when a copy may show on a collection screen: its home is a binder, not a box. */
export function inCollection(copy: Pick<Copy, "homeKind">): boolean {
  return !isForSale(copy);
}

/** The copies a collection screen shows: every one whose home is not a box. `undefined` (loading) stays `undefined`. */
export function collectionCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[]): T[];
export function collectionCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[] | undefined): T[] | undefined;
export function collectionCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[] | undefined): T[] | undefined {
  return copies?.filter(inCollection);
}

/**
 * A collection screen's copies of a card under the page's scope: the
 * collection's only, narrowed to the picked binder when one is picked.
 */
export function collectionCopiesIn<T extends Pick<Copy, "homeKind" | "homeId">>(
  copies: readonly T[] | undefined,
  scope: Scope,
): T[] | undefined {
  const kept = collectionCopies(copies);
  return kept && scope !== "all" ? kept.filter((c) => c.homeId === scope) : kept;
}

/** `useCopiesOfCards`' answer for a collection screen: each card's collection copies (`[]` when only a box holds it). */
export function collectionCopiesOfCards(
  byCard: Record<CardId, Copy[]> | undefined,
): Record<CardId, Copy[]> | undefined {
  if (!byCard) return byCard;
  const out: Record<CardId, Copy[]> = {};
  for (const [id, copies] of Object.entries(byCard)) out[id] = collectionCopies(copies);
  return out;
}

// ---------------------------------------------------------------------------
// The inventory never shows a binder copy (NEO-364, the mirror of the above)
// ---------------------------------------------------------------------------
//
// Hard line: Collection = Binders, Inventory = Boxes. A copy whose home is a
// binder (Main included) never appears on an inventory screen: the
// Inventory list, My Boxes (every box, Unsorted, a box's hunt tray), the
// inventory's Checklists (quantity fields, completion, "have N of M") and
// the boxes' counts. The Up for Trade pile is again the one exception: drawn
// as a box from the inventory side, it lists binder copies too, each tagged
// "In <binder>". A view that reads every home (`useCopiesOf`,
// `useCopiesOfCards`) for an inventory screen passes the answer through
// `inventoryCopies` / `inventoryCopiesOfCards`, except that trade view.

/** True when a copy may show on an inventory screen: its home is a box (Unsorted included). */
export function inInventory(copy: Pick<Copy, "homeKind">): boolean {
  return isForSale(copy);
}

/** The copies an inventory screen shows: every one whose home is a box. `undefined` (loading) stays `undefined`. */
export function inventoryCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[]): T[];
export function inventoryCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[] | undefined): T[] | undefined;
export function inventoryCopies<T extends Pick<Copy, "homeKind">>(copies: readonly T[] | undefined): T[] | undefined {
  return copies?.filter(inInventory);
}

/** `useCopiesOfCards`' answer for an inventory screen: each card's box copies (`[]` when only a binder holds it). */
export function inventoryCopiesOfCards(
  byCard: Record<CardId, Copy[]> | undefined,
): Record<CardId, Copy[]> | undefined {
  if (!byCard) return byCard;
  const out: Record<CardId, Copy[]> = {};
  for (const [id, copies] of Object.entries(byCard)) out[id] = inventoryCopies(copies);
  return out;
}

/** The copies a screen on `side` shows: `collectionCopies` or `inventoryCopies`. */
export function copiesOnSide<T extends Pick<Copy, "homeKind">>(copies: readonly T[] | undefined, side: Side): T[] | undefined {
  return side === "inventory" ? inventoryCopies(copies) : collectionCopies(copies);
}

/** A line item's slot order: slotted first, by slot; then the rest as they came. */
export function bySlot<T extends { slot?: number }>(list: readonly T[]): T[] {
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.slot ?? Infinity) - (b.item.slot ?? Infinity) || a.i - b.i)
    .map(({ item }) => item);
}

/** Ids of copies, for a set-membership test. */
export function idsOf(copies: readonly { id: CopyId }[] | undefined): Set<CopyId> {
  return new Set((copies ?? []).map((c) => c.id));
}

/** True when the text is long enough to search. */
export function searchable(text: string): boolean {
  return text.trim().length >= MIN_SEARCH_LENGTH;
}

/** 0-100, rounded down so 99.6% never reads as done. */
export function percentOf(owned: number, total: number): number {
  return total > 0 ? Math.floor((owned / total) * 100) : 0;
}

/** Both completion pairs: without variations (the default to show), and with them. */
export function completionOf(
  base: { owned: number; total: number },
  all: { owned: number; total: number } = base,
): Completion {
  return {
    owned: base.owned,
    total: base.total,
    percent: percentOf(base.owned, base.total),
    ownedAll: all.owned,
    totalAll: all.total,
    percentAll: percentOf(all.owned, all.total),
  };
}

/**
 * What a refused write says, for the status line: the server's own words when
 * it sent them (a `ConvexError` carrying `{ message }`), else the error's.
 */
export function writeErrorMessage(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message;
  }
  if (typeof data === "string" && data) return data;
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

/** Today in the viewer's own calendar, `YYYY-MM-DD`. */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Blank details for a new copy: one raw card in the default condition (NEO-380), acquired today. */
export function emptyCopyDetails(condition: Condition = DEFAULT_CONDITION): CopyDetails {
  return { quantity: 1, condition, acquiredAt: todayIso(), notes: "" };
}
