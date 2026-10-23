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
 * Reads are per checklist (variant), never a whole set's cards.
 *
 * ## Writes: async actions that hand back their undo
 *
 * `useCollectionActions()` returns promises. Each resolves with what it did
 * and an `undo` that takes exactly that write back (the inverse write, never
 * a snapshot restore): pass the undo straight to `notify(message, undo)`.
 * A write the server refuses rejects; show its message on the status line.
 * The Convex store applies each write optimistically to `useCopiesOf`,
 * `useCopiesInVariant` and `useVariantCompletion`, so a tile lights at once.
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
 * `useDemoExtension()` is the demo's own reducer store (binders, wants, Up for
 * Trade, card requests, the binder scope, spine labels) plus Reset, for the
 * views that only exist in the demo (My Binders, the Binder picker, the demo
 * bar). It is `undefined` under the Convex store: a view that needs it must be
 * gated by the matching capability.
 */

import { createContext, useContext } from "react";
import type { CollectionStore as DemoCollectionState } from "../store";
import type {
  AddManyResult,
  AddResult,
  BuildingResult,
  Capabilities,
  Card,
  CardId,
  CollectionSummary,
  Completion,
  Copy,
  OwnedCards,
  CopyDetails,
  DrillItem,
  DrillLevel,
  DrillParents,
  EntityPick,
  RemoveResult,
  SearchResult,
  SetId,
  SetPath,
  SetRef,
  SetSummary,
  Suggestion,
  UpdateResult,
  VariantId,
} from "./types";

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
  /** How much of a checklist the collector has (in the demo, inside the picked binder). */
  useVariantCompletion(variantId: VariantId | null): Completion | undefined;
  /** One card. `null`: no longer in the catalog. */
  useCard(cardId: CardId | null): Card | null | undefined;
  /** Several cards, aligned with `cardIds`; `null` where one is no longer in the catalog. */
  useCards(cardIds: readonly CardId[] | null): (Card | null)[] | undefined;
  /** Players (name or alias), teams and sets matching the text, best first. */
  useSuggestions(text: string): Suggestion[] | undefined;
  /** Cards whose title matches the text: every word, quoted phrases verbatim. */
  useSearch(text: string, options?: SearchOptions): SearchResult | undefined;
  /** The cards of a picked player, or of a team printed on the card (optionally its whole franchise). */
  useEntityCards(pick: EntityPick | null): SearchResult | undefined;
  /** "Sets I'm building", as the collector chose them (never inferred). */
  useBuildingSets(): SetRef[] | undefined;
  /** Every copy of one card the collector owns, in every home. */
  useCopiesOf(cardId: CardId | null): Copy[] | undefined;
  /** The collector's copies of every card in a checklist (in the demo, inside the picked binder). */
  useCopiesInVariant(variantId: VariantId | null): Copy[] | undefined;
  /** The whole collection at a glance. */
  useSummary(): CollectionSummary | undefined;
  /** Every card the collector holds, most recently touched first, up to `limit`. */
  useOwnedCards(options?: OwnedCardsOptions): OwnedCards | undefined;
}

export interface OwnedCardsOptions {
  /** Cards to hydrate; default `OWNED_CARDS_DEFAULT_LIMIT`. Raise it for "Show more". */
  limit?: number;
}

/** One page of the owned-cards list (one catalog read in the Convex store). */
export const OWNED_CARDS_DEFAULT_LIMIT = 200;

/** The writes. Each resolves with its undo; see the module comment. */
export interface CollectionActions {
  /** One raw copy, acquired today, into the default home (folds into an identical one). */
  addHave(card: Card): Promise<AddResult>;
  /** One raw copy of each card (a range, a need-list run); one undo for the batch. At most 200. */
  addMany(cards: readonly Card[]): Promise<AddManyResult>;
  /** A copy with details; the server folds it into an identical line item (never one with a cert or serial). */
  addLineItem(card: Card, details: CopyDetails): Promise<AddResult>;
  updateCopy(copy: Copy, patch: Partial<CopyDetails>): Promise<UpdateResult>;
  /** Deletes the copy; the undo puts the same fields back. */
  removeCopy(copy: Copy): Promise<RemoveResult>;
  /** Puts a removed copy back (what `removeCopy`'s undo does). */
  restoreCopy(copy: Copy): Promise<AddResult>;
  /** Puts a set on "Sets I'm building", or takes it off. */
  setBuilding(set: SetRef, building: boolean): Promise<BuildingResult>;
}

/** The demo's own store and Reset (see the module comment). */
export interface DemoExtension {
  /** The demo reducer store the demo-only views read. */
  state: DemoCollectionState;
  /** Back to the starting stack. */
  reset: () => void;
}

export interface CollectionStoreValue {
  kind: "demo" | "convex";
  capabilities: Capabilities;
  data: CollectionData;
  actions: CollectionActions;
  demo?: DemoExtension;
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

export function useCollectionActions(): CollectionActions {
  return useCollectionStore().actions;
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
export function useVariantCompletion(variantId: VariantId | null): Completion | undefined {
  return useCollectionStore().data.useVariantCompletion(variantId);
}
export function useCard(cardId: CardId | null): Card | null | undefined {
  return useCollectionStore().data.useCard(cardId);
}
export function useCards(cardIds: readonly CardId[] | null): (Card | null)[] | undefined {
  return useCollectionStore().data.useCards(cardIds);
}
export function useSuggestions(text: string): Suggestion[] | undefined {
  return useCollectionStore().data.useSuggestions(text);
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
export function useCopiesInVariant(variantId: VariantId | null): Copy[] | undefined {
  return useCollectionStore().data.useCopiesInVariant(variantId);
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

// ---------------------------------------------------------------------------
// Small shared rules both stores follow.
// ---------------------------------------------------------------------------

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

/** Blank details for a new copy: one raw card, acquired today. */
export function emptyCopyDetails(): CopyDetails {
  return { quantity: 1, acquiredAt: todayIso(), notes: "" };
}
