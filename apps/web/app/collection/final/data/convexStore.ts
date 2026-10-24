/**
 * NEO-358 — the Convex store: the collection contract (`./store`) over the
 * real catalog (`convex/collectionCatalog.ts`) and the signed-in collector's
 * own copies (`convex/collection.ts`). Mounted by `/collection`
 * (`../../page.tsx`). Capabilities are all off until each ships.
 *
 * Reads are `useQuery` (`undefined` while loading), hydrated into the view
 * model (`./types`) here and only here: the server's shapes never reach a
 * view. Writes are `useMutation` with optimistic updates on `copiesOf`,
 * `copiesInVariant` and `variantCompletion`, so a tile lights the moment it is
 * pressed; each resolves with the inverse write as its undo.
 *
 * Conversions between the server's copy and the view's (see `CopyDetails` in
 * `./types`): `costCents` ↔ `costBasis` dollars, `acquiredOn` ↔ `acquiredAt`,
 * `grading` ↔ `graded`, absent notes ↔ "". `updateCopy` on the server
 * REPLACES a copy's details, so a patch here is merged onto the copy first.
 */

import { createElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQueries, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import type { Infer } from "convex/values";
import { api } from "@/convex/_generated/api";
import type { copyDetailsValidator, copyValidator } from "@/convex/collection";
import type {
  CatalogCard,
  CatalogCardWithPath,
  catalogLevelValidator,
  SetRef as RawSetRef,
  VariantRef as RawVariantRef,
} from "@/convex/lib/catalogView";
import { finishForVariant } from "./finish";
import {
  CollectionStoreContext,
  completionOf,
  OWNED_CARDS_DEFAULT_LIMIT,
  searchable,
  todayIso,
  type CollectionActions,
  type CollectionData,
  type CollectionStoreValue,
} from "./store";
import {
  NO_CAPABILITIES,
  type Card,
  type Copy,
  type CopyDetails,
  type DrillItem,
  type DrillLevel,
  type HeldCount,
  type OwnedCards,
  type SetRef,
  type SetSummary,
  type Suggestion,
  type Variant,
  type VariantKind,
  type VariantRef,
} from "./types";

type RawCopy = Infer<typeof copyValidator>;
type RawDetails = Infer<typeof copyDetailsValidator>;
type RawDrill = FunctionReturnType<typeof api.collectionCatalog.drill>;
type RawDrillItem = RawDrill["items"][number];
type RawSummaryVariant = NonNullable<FunctionReturnType<typeof api.collectionCatalog.setSummary>>["variants"][number];
type RawSuggest = FunctionReturnType<typeof api.collectionCatalog.suggest>;
type RawEntityCards = { cards: CatalogCardWithPath[]; continueCursor: string | null };

/** The card search's page size (the server's cap). */
const SEARCH_LIMIT = 50;
/** One entity's cards per page (the server's cap). */
const ENTITY_LIMIT = 100;
/** Card ids per `cards` call (the server's cap). */
const CARDS_PER_CALL = 200;
/** Line items one `collection.ownedCards` page asks for (the server reads at most 64). */
const OWNED_LINES_PER_PAGE = 60;
/** Copies `removeCopies` takes per call (the server's cap). */
const REMOVE_BATCH = 200;

// ---------------------------------------------------------------------------
// Hydration: the server's shapes → the view model
// ---------------------------------------------------------------------------

/** "2024" from a year row's name; 0 when it does not lead with a year. */
function yearOf(name: string | undefined): number {
  const n = Number.parseInt(name ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

function toSetRef(raw: RawSetRef): SetRef {
  return {
    id: raw._id,
    name: raw.name,
    season: raw.season,
    year: yearOf(raw.year?.name ?? raw.season),
    brand: raw.manufacturer ? { id: raw.manufacturer._id, name: raw.manufacturer.name } : { id: "", name: "" },
    sport: raw.sport ? { id: raw.sport._id, name: raw.sport.name } : { id: "", name: "" },
  };
}

/** The fields a variant row and a set-summary row share. */
type RawVariantish = Pick<RawVariantRef, "_id" | "level" | "name" | "kind" | "variantType" | "insert">;

/**
 * What a card-bearing row is, in the view's terms. Under a Parallels type the
 * rows are stored at the `insert` level; a sub-variant under an insert is a
 * `parallel`-level row.
 */
function toVariantRef(raw: RawVariantish, order = 0): VariantRef {
  const typeKind = raw.kind;
  const typeId = raw.variantType?._id ?? raw._id;
  let kind: VariantKind;
  let name: string | null;
  let insertName: string | null = null;
  let path: VariantRef["path"];
  if (raw.level === "variantType") {
    kind = typeKind === "base" ? "base" : (typeKind ?? "other");
    name = kind === "base" ? null : raw.name;
    path = { typeId: raw._id, variantId: null, subVariantId: null };
  } else if (raw.level === "parallel") {
    kind = "parallel";
    name = raw.name;
    insertName = raw.insert?.name ?? null;
    path = { typeId, variantId: raw.insert?._id ?? null, subVariantId: raw._id };
  } else {
    kind = typeKind === "parallel" ? "parallel" : typeKind === "insert" ? "insert" : "other";
    name = raw.name;
    path = { typeId, variantId: raw._id, subVariantId: null };
  }
  return {
    id: raw._id,
    kind,
    name,
    insertName,
    printRun: null,
    order,
    path,
    finish: finishForVariant({ kind, name, insertName }),
  };
}

function toCard(raw: CatalogCard, set: SetRef, variant: VariantRef): Card {
  return {
    id: raw._id,
    set,
    variant,
    cardNumber: raw.cardNumber,
    players: raw.players.map((p) => ({ id: p._id, name: p.name, ...(p.nameOnCard ? { nameOnCard: p.nameOnCard } : {}) })),
    teams: raw.teams.map((t) => ({
      id: t._id,
      name: t.name,
      location: t.location ?? "",
      ...(t.primaryColor ? { primary: t.primaryColor } : {}),
      ...(t.secondaryColor ? { secondary: t.secondaryColor } : {}),
    })),
    printRun: raw.printRun ?? null,
    features: raw.features,
    cardVariation: raw.cardVariation ?? null,
    isVariation: raw.variationOfCardId !== undefined,
    sortOrder: raw.sortOrder,
    finish: variant.finish,
  };
}

/** A card that carries its own path; null when the path is gone (an orphaned row). */
function toCardWithPath(raw: CatalogCardWithPath | null): Card | null {
  if (!raw || !raw.set || !raw.variant) return null;
  return toCard(raw, toSetRef(raw.set), toVariantRef(raw.variant));
}

function toCards(raws: CatalogCardWithPath[]): Card[] {
  return raws.map(toCardWithPath).filter((c): c is Card => c !== null);
}

function toCopy(raw: RawCopy): Copy {
  return {
    id: raw._id,
    cardId: raw.cardId,
    variantId: raw.variantId,
    setId: raw.setId,
    homeId: raw.homeId,
    quantity: raw.quantity,
    ...(raw.condition ? { condition: raw.condition } : {}),
    ...(raw.grading ? { graded: raw.grading } : {}),
    ...(raw.serialNumber ? { serialNumber: raw.serialNumber } : {}),
    ...(raw.costCents !== undefined ? { costBasis: raw.costCents / 100 } : {}),
    acquiredAt: raw.acquiredOn ?? "",
    ...(raw.location ? { location: raw.location } : {}),
    notes: raw.notes ?? "",
  };
}

/** The view's details as the server writes them. Blank is absent; the demo's extras never leave. */
function toRawDetails(d: CopyDetails, homeId?: string): RawDetails {
  const notes = d.notes.trim();
  const location = d.location?.trim();
  const out: Record<string, unknown> = { quantity: d.quantity };
  if (d.condition) out.condition = d.condition;
  if (d.graded) {
    out.grading = {
      grader: d.graded.grader,
      grade: d.graded.grade,
      ...(d.graded.cert ? { cert: d.graded.cert } : {}),
    };
  }
  if (d.serialNumber?.trim()) out.serialNumber = d.serialNumber.trim();
  if (d.costBasis !== undefined) out.costCents = Math.round(d.costBasis * 100);
  if (d.acquiredAt) out.acquiredOn = d.acquiredAt;
  if (location) out.location = location;
  if (notes) out.notes = notes;
  if (homeId) out.homeId = homeId;
  return out as RawDetails;
}

/** A copy's details as the view holds them, from the server's write shape (`previous`, `removed`). */
function fromRawDetails(raw: RawDetails): CopyDetails {
  return {
    quantity: raw.quantity,
    ...(raw.condition ? { condition: raw.condition } : {}),
    ...(raw.grading ? { graded: raw.grading } : {}),
    ...(raw.serialNumber ? { serialNumber: raw.serialNumber } : {}),
    ...(raw.costCents !== undefined ? { costBasis: raw.costCents / 100 } : {}),
    acquiredAt: raw.acquiredOn ?? "",
    ...(raw.location ? { location: raw.location } : {}),
    notes: raw.notes ?? "",
  };
}

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

type CatalogLevel = Infer<typeof catalogLevelValidator>;

/**
 * Each column's request: the server level to list (omitted for a variant
 * type's children, which are stored at `insert` level under both Inserts and
 * Parallels types) and which picked id is its parent.
 */
const COLUMN: Record<DrillLevel, { level?: CatalogLevel; parent?: DrillLevel }> = {
  sport: { level: "sport" },
  year: { level: "year", parent: "sport" },
  brand: { level: "manufacturer", parent: "year" },
  set: { level: "setName", parent: "brand" },
  variantType: { level: "variantType", parent: "set" },
  variant: { parent: "variantType" },
  subVariant: { level: "parallel", parent: "variant" },
};

const CARD_BEARING = new Set(["variantType", "insert", "parallel"]);

function toDrillItem(level: DrillLevel, raw: RawDrillItem): DrillItem {
  const cardBearing = CARD_BEARING.has(raw.level);
  // A checklist: a card-bearing row with cards of its own, or with nothing
  // beneath it (an empty Base is still Base). An "Inserts" type that only
  // holds inserts is a step, not a checklist.
  const isChecklist = cardBearing && (raw.childCount === 0 || (raw.cardCount ?? 0) > 0);
  return {
    id: raw._id,
    level,
    name: raw.name,
    ...(raw.level === "variantType" ? { kind: raw.kind ?? "other" } : {}),
    ...(isChecklist ? { variantId: raw._id } : {}),
    ...(cardBearing ? { cardCount: raw.cardCount, baseCardCount: raw.baseCardCount } : {}),
    hasChildren: raw.childCount > 0,
  };
}

function toSummaryVariant(raw: RawSummaryVariant, order: number): Variant {
  return {
    ...toVariantRef(raw, order),
    cardCount: raw.cardCount ?? 0,
    baseCardCount: raw.baseCardCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const CONVEX_DATA: CollectionData = {
  useDrill(level, parents) {
    const column = level ? COLUMN[level] : null;
    const parentId = column?.parent ? parents[column.parent] : undefined;
    const ready = column !== null && (!column.parent || !!parentId);
    const raw = useQuery(
      api.collectionCatalog.drill,
      ready ? { ...(column!.level ? { level: column!.level } : {}), ...(parentId ? { parentId } : {}) } : "skip",
    );
    return useMemo(() => {
      if (!level || !column) return undefined;
      if (!ready) return [];
      return raw?.items.map((item) => toDrillItem(level, item));
    }, [level, column, ready, raw]);
  },

  useSetSummary(setId) {
    const raw = useQuery(api.collectionCatalog.setSummary, setId ? { setId } : "skip");
    return useMemo((): SetSummary | null | undefined => {
      if (raw === undefined) return undefined;
      if (raw === null) return null;
      // Container rows (an "Inserts" type that only holds inserts) are steps, not checklists.
      const variants = raw.variants
        .filter((v) => !(v.level === "variantType" && v.childCount > 0 && (v.cardCount ?? 0) === 0))
        .map(toSummaryVariant);
      return {
        set: toSetRef(raw.set),
        variants,
        totalCards: variants.reduce((n, v) => n + v.baseCardCount, 0),
        totalCardsAll: variants.reduce((n, v) => n + v.cardCount, 0),
      };
    }, [raw]);
  },

  useSetPath(setId) {
    const raw = useQuery(api.collectionCatalog.setPath, setId ? { setId } : "skip");
    return useMemo(() => {
      if (raw === undefined) return undefined;
      if (raw === null || !raw.sport || !raw.year || !raw.manufacturer) return null;
      return {
        sport: { id: raw.sport._id, name: raw.sport.name },
        year: { id: raw.year._id, name: raw.season || raw.year.name },
        brand: { id: raw.manufacturer._id, name: raw.manufacturer.name },
        set: { id: raw._id, name: raw.name },
      };
    }, [raw]);
  },

  useVariantCards(variantId) {
    const raw = useQuery(api.collectionCatalog.variantCards, variantId ? { variantId } : "skip");
    return useMemo(() => {
      if (raw === undefined) return undefined;
      if (raw === null || raw.set === null) return [];
      const set = toSetRef(raw.set);
      const variant = toVariantRef(raw.variant);
      return raw.cards.map((c) => toCard(c, set, variant));
    }, [raw]);
  },

  useVariantCompletion(variantId) {
    const raw = useQuery(api.collection.variantCompletion, variantId ? { variantId } : "skip");
    return useMemo(() => {
      if (raw === undefined) return undefined;
      if (raw === null) return completionOf({ owned: 0, total: 0 });
      // A total the server could not count is 0: the views read a total of
      // 0 as unknown and say "N owned", never "3 of 3, complete".
      return completionOf(
        { owned: raw.owned, total: raw.total ?? 0 },
        { owned: raw.ownedAll, total: raw.totalAll ?? 0 },
      );
    }, [raw]);
  },

  useCard(cardId) {
    const raw = useQuery(api.collectionCatalog.card, cardId ? { cardId } : "skip");
    return useMemo(() => (raw === undefined ? undefined : toCardWithPath(raw)), [raw]);
  },

  useCards(cardIds) {
    const key = cardIds ? cardIds.join("\n") : null;
    const requests = useMemo(() => {
      const ids = key ? key.split("\n") : [];
      return Object.fromEntries(
        chunk(ids, CARDS_PER_CALL).map((part, i) => [String(i), { query: api.collectionCatalog.cards, args: { cardIds: part } }]),
      );
    }, [key]);
    const results = useQueries(requests);
    return useMemo(() => {
      if (key === null) return undefined;
      if (key === "") return [];
      const out: (Card | null)[] = [];
      for (let i = 0; i < Object.keys(requests).length; i++) {
        const part = results[String(i)] as (CatalogCardWithPath | null)[] | undefined | Error;
        if (part === undefined) return undefined;
        if (part instanceof Error) throw part;
        out.push(...part.map(toCardWithPath));
      }
      return out;
    }, [key, requests, results]);
  },

  useSuggestions(text) {
    const q = text.trim();
    const raw = useQuery(api.collectionCatalog.suggest, searchable(q) ? { q } : "skip");
    return useMemo((): Suggestion[] | undefined => {
      if (!searchable(q)) return [];
      if (raw === undefined) return undefined;
      return suggestionsFrom(raw);
    }, [q, raw]);
  },

  useSearch(text, options) {
    const q = text.trim();
    const sportId = options?.sportId;
    const raw = useQuery(
      api.collectionCatalog.search,
      searchable(q) ? { q, limit: SEARCH_LIMIT, ...(sportId ? { sportId } : {}) } : "skip",
    );
    return useMemo(() => {
      if (!searchable(q)) return { cards: [], truncated: false };
      if (raw === undefined) return undefined;
      return { cards: toCards(raw.cards), truncated: raw.truncated };
    }, [q, raw]);
  },

  useEntityCards(pick) {
    const byPlayer = useQuery(
      api.collectionCatalog.cardsByPlayer,
      pick?.kind === "player" ? { playerId: pick.id, limit: ENTITY_LIMIT } : "skip",
    );
    const byTeam = useQuery(
      api.collectionCatalog.cardsByTeam,
      pick?.kind === "team" ? { teamId: pick.id, includeFranchise: pick.wholeFranchise, limit: ENTITY_LIMIT } : "skip",
    );
    const raw: RawEntityCards | undefined = pick?.kind === "player" ? byPlayer : pick?.kind === "team" ? byTeam : undefined;
    return useMemo(() => {
      if (!pick || raw === undefined) return undefined;
      return { cards: toCards(raw.cards), truncated: raw.continueCursor !== null };
    }, [pick, raw]);
  },

  useBuildingSets() {
    const raw = useQuery(api.collection.buildingSets, {});
    return useMemo(
      () => raw?.map((row) => (row.set ? toSetRef(row.set) : null)).filter((s): s is SetRef => s !== null),
      [raw],
    );
  },

  useCopiesOf(cardId) {
    const raw = useQuery(api.collection.copiesOf, cardId ? { cardId } : "skip");
    return useMemo(() => raw?.map(toCopy), [raw]);
  },

  useCopiesInVariant(variantId) {
    const raw = useQuery(api.collection.copiesInVariant, variantId ? { variantId } : "skip");
    return useMemo(() => raw?.map(toCopy), [raw]);
  },

  useSummary() {
    const raw = useQuery(api.collection.summary, {});
    return useMemo(
      () => (raw ? { copies: raw.copies, cards: raw.distinctCards, exact: raw.exact } : undefined),
      [raw],
    );
  },

  /**
   * "Everything I own", paged from the server (`collection.ownedCards`, most
   * recently touched first, each card once) for as many pages as `limit`
   * needs, and hydrated through `cards` in chunks of `CARDS_PER_CALL`. The
   * total is the collector's tally (`collection.summary`), so "of M" is the
   * whole collection's, not what has been paged in.
   *
   * A Have reorders the list and so re-asks for the cards. While that answer
   * is in flight the cards already hydrated stand in (a card is NB data and
   * rarely changes), so the list never blinks back to a skeleton; a card not
   * seen before joins the list when it lands.
   */
  useOwnedCards(options) {
    const limit = Math.max(1, Math.floor(options?.limit ?? OWNED_CARDS_DEFAULT_LIMIT));
    const tally = useQuery(api.collection.summary, {});
    const pages = usePaginatedQuery(api.collection.ownedCards, {}, { initialNumItems: OWNED_LINES_PER_PAGE });
    const held = useMemo(() => uniqueOwned(pages.results), [pages.results]);
    const canLoadMore = pages.status === "CanLoadMore";
    const { loadMore } = pages;
    useEffect(() => {
      if (canLoadMore && held.length < limit) loadMore(OWNED_LINES_PER_PAGE);
    }, [canLoadMore, held.length, limit, loadMore]);
    const firstPage = pages.status !== "LoadingFirstPage";
    const ids = useMemo(
      () => (firstPage ? held.slice(0, limit).map((c) => c.cardId as string) : null),
      [firstPage, held, limit],
    );
    const hydrated = CONVEX_DATA.useCards(ids);
    const seen = useRef(new Map<string, Card | null>());
    const exhausted = pages.status === "Exhausted";
    return useMemo((): OwnedCards | undefined => {
      if (!tally || ids === null) return undefined;
      if (hydrated) ids.forEach((id, i) => seen.current.set(id, hydrated[i] ?? null));
      else if (ids.some((id) => !seen.current.has(id)) && seen.current.size === 0) return undefined;
      const cards: Card[] = [];
      const goneCardIds: string[] = [];
      const copiesByCard: Record<string, HeldCount> = {};
      ids.forEach((id, i) => {
        if (!seen.current.has(id)) return;
        const card = seen.current.get(id);
        if (!card) {
          goneCardIds.push(id);
          return;
        }
        cards.push(card);
        copiesByCard[id] = { quantity: held[i].quantity, lines: held[i].lines };
      });
      return {
        cards,
        copiesByCard,
        total: tally.distinctCards,
        totalExact: tally.exact,
        goneCardIds,
        truncated: held.length > limit || !exhausted,
      };
    }, [tally, ids, hydrated, held, limit, exhausted]);
  },
};

type RawOwned = FunctionReturnType<typeof api.collection.ownedCards>["page"][number];

/**
 * The pages' cards, each once, in order. The server already lists a card only
 * at its newest line; this holds the list steady while a Have moves a card
 * between pages that have not both re-answered yet.
 */
function uniqueOwned(results: readonly RawOwned[]): RawOwned[] {
  const seen = new Set<string>();
  const out: RawOwned[] = [];
  for (const row of results) {
    if (seen.has(row.cardId)) continue;
    seen.add(row.cardId);
    out.push(row);
  }
  return out;
}

function suggestionsFrom(raw: RawSuggest): Suggestion[] {
  return [
    ...raw.players.map(
      (p): Suggestion => ({
        kind: "player",
        id: p._id,
        name: p.name,
        ...(p.matchedAlias ? { matchedAlias: p.matchedAlias } : {}),
        ...(p.sport ? { sport: p.sport.name } : {}),
      }),
    ),
    ...raw.teams.map(
      (t): Suggestion => ({
        kind: "team",
        id: t._id,
        name: t.name,
        location: t.location ?? "",
        ...(t.franchise ? { franchise: { id: t.franchise._id, name: t.franchise.name } } : {}),
      }),
    ),
    ...raw.sets.map(
      (s): Suggestion => ({
        kind: "set",
        id: s._id,
        label: `${s.season} ${s.name}`,
        sport: s.sport?.name ?? "",
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Optimistic updates
// ---------------------------------------------------------------------------

/** What an optimistic update needs to know about a card that its args do not say. */
interface CardPlace {
  variantId: string;
  setId: string;
  isVariation: boolean;
}

let optimisticSeq = 0;
function optimisticId(): RawCopy["_id"] {
  optimisticSeq += 1;
  return `optimistic:${optimisticSeq}` as RawCopy["_id"];
}

/** Rewrites every loaded copy list a card appears in. */
function rewriteCopies(
  local: OptimisticLocalStore,
  cardId: string,
  variantId: string,
  rewrite: (rows: RawCopy[]) => RawCopy[],
) {
  const ofCard = local.getQuery(api.collection.copiesOf, { cardId });
  if (ofCard !== undefined) local.setQuery(api.collection.copiesOf, { cardId }, rewrite(ofCard));
  const inVariant = local.getQuery(api.collection.copiesInVariant, { variantId });
  if (inVariant !== undefined) local.setQuery(api.collection.copiesInVariant, { variantId }, rewrite(inVariant));
}

/** Whether the collector held the card before this write, from whichever list is loaded. */
function heldBefore(local: OptimisticLocalStore, cardId: string, variantId: string): boolean | undefined {
  const ofCard = local.getQuery(api.collection.copiesOf, { cardId });
  if (ofCard !== undefined) return ofCard.length > 0;
  const inVariant = local.getQuery(api.collection.copiesInVariant, { variantId });
  if (inVariant !== undefined) return inVariant.some((c) => c.cardId === cardId);
  return undefined;
}

/** Moves the checklist's owned counts by one card, when the completion is loaded. */
function shiftCompletion(local: OptimisticLocalStore, variantId: string, isVariation: boolean, delta: 1 | -1) {
  const current = local.getQuery(api.collection.variantCompletion, { variantId });
  if (!current) return;
  local.setQuery(api.collection.variantCompletion, { variantId }, {
    ...current,
    owned: Math.max(0, current.owned + (isVariation ? 0 : delta)),
    ownedAll: Math.max(0, current.ownedAll + delta),
  });
}

/** The server's fold rule, as far as the client can see it (every new copy lands in Main). */
function foldsInto(row: RawCopy, next: RawDetails): boolean {
  if (row.grading?.cert || row.serialNumber || next.grading?.cert || next.serialNumber) return false;
  return (
    (next.homeId === undefined || row.homeId === next.homeId) &&
    row.condition === next.condition &&
    row.grading?.grader === next.grading?.grader &&
    row.grading?.grade === next.grading?.grade &&
    row.costCents === next.costCents &&
    row.acquiredOn === next.acquiredOn &&
    row.location === next.location &&
    row.notes === next.notes
  );
}

/**
 * An add, as the lists will read once the server has it. `fold: false` for a
 * restore, which the server always inserts as its own row.
 */
function applyAdd(
  local: OptimisticLocalStore,
  cardId: string,
  place: CardPlace | undefined,
  details: RawDetails,
  fold = true,
) {
  if (!place) return;
  const before = heldBefore(local, cardId, place.variantId);
  rewriteCopies(local, cardId, place.variantId, (rows) => {
    const own = rows.filter((r) => r.cardId === cardId);
    const into = fold ? own.find((r) => foldsInto(r, details)) : undefined;
    if (into) return rows.map((r) => (r === into ? { ...r, quantity: r.quantity + details.quantity } : r));
    const homeId = details.homeId ?? own[0]?.homeId ?? rows[0]?.homeId ?? ("" as RawCopy["homeId"]);
    return [
      ...rows,
      {
        ...details,
        _id: optimisticId(),
        cardId: cardId as RawCopy["cardId"],
        variantId: place.variantId as RawCopy["variantId"],
        setId: place.setId as RawCopy["setId"],
        homeId,
        lastUpdated: Date.now(),
      } as RawCopy,
    ];
  });
  if (before === false) shiftCompletion(local, place.variantId, place.isVariation, 1);
}

/** A removal, as the lists will read once the server has it. */
function applyRemove(local: OptimisticLocalStore, copyId: string, place: (CardPlace & { cardId: string }) | undefined) {
  if (!place) return;
  let stillHeld: boolean | undefined;
  rewriteCopies(local, place.cardId, place.variantId, (rows) => {
    const next = rows.filter((r) => r._id !== copyId);
    stillHeld = next.some((r) => r.cardId === place.cardId);
    return next;
  });
  if (stillHeld === false) shiftCompletion(local, place.variantId, place.isVariation, -1);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function useConvexActions(): CollectionActions {
  // What each optimistic update needs to know beyond its args: the card's
  // place, recorded by the action just before it calls the mutation.
  const cards = useRef(new Map<string, CardPlace>());
  const copies = useRef(new Map<string, CardPlace & { cardId: string }>());

  const addHaveBase = useMutation(api.collection.addHave);
  const addHavesBase = useMutation(api.collection.addHaves);
  const addLineItemBase = useMutation(api.collection.addLineItem);
  const restoreCopyBase = useMutation(api.collection.restoreCopy);
  const updateCopyBase = useMutation(api.collection.updateCopy);
  const removeCopyBase = useMutation(api.collection.removeCopy);
  const removeCopiesBase = useMutation(api.collection.removeCopies);
  const setBuilding = useMutation(api.collection.setBuilding);

  // `withOptimisticUpdate` hands back a new function each call: build them
  // once per mutation so the actions object stays put across renders.
  const { addHave, addHaves, addLineItem, restoreCopy, updateCopy, removeCopy, removeCopies } = useMemo(
    () => ({
      addHave: addHaveBase.withOptimisticUpdate((local, args) =>
        applyAdd(local, args.cardId, cards.current.get(args.cardId), {
          quantity: 1,
          ...(args.acquiredOn ? { acquiredOn: args.acquiredOn } : {}),
        }),
      ),
      addHaves: addHavesBase.withOptimisticUpdate((local, args) => {
        for (const cardId of args.cardIds) {
          applyAdd(local, cardId, cards.current.get(cardId), {
            quantity: 1,
            ...(args.acquiredOn ? { acquiredOn: args.acquiredOn } : {}),
          });
        }
      }),
      addLineItem: addLineItemBase.withOptimisticUpdate((local, args) =>
        applyAdd(local, args.cardId, cards.current.get(args.cardId), args.details),
      ),
      restoreCopy: restoreCopyBase.withOptimisticUpdate((local, args) =>
        applyAdd(local, args.cardId, cards.current.get(args.cardId), args.details, false),
      ),
      updateCopy: updateCopyBase.withOptimisticUpdate((local, args) => {
        const place = copies.current.get(args.copyId);
        if (!place) return;
        rewriteCopies(local, place.cardId, place.variantId, (rows) =>
          rows.map((r) =>
            r._id === args.copyId
              ? ({
                  _id: r._id,
                  cardId: r.cardId,
                  variantId: r.variantId,
                  setId: r.setId,
                  lastUpdated: Date.now(),
                  ...args.details,
                  homeId: args.details.homeId ?? r.homeId,
                } as RawCopy)
              : r,
          ),
        );
      }),
      removeCopy: removeCopyBase.withOptimisticUpdate((local, args) =>
        applyRemove(local, args.copyId, copies.current.get(args.copyId)),
      ),
      removeCopies: removeCopiesBase.withOptimisticUpdate((local, args) => {
        for (const copyId of args.copyIds) applyRemove(local, copyId, copies.current.get(copyId));
      }),
    }),
    [addHaveBase, addHavesBase, addLineItemBase, restoreCopyBase, updateCopyBase, removeCopyBase, removeCopiesBase],
  );

  return useMemo<CollectionActions>(() => {
    const placeCard = (card: Card) => {
      cards.current.set(card.id, { variantId: card.variant.id, setId: card.set.id, isVariation: card.isVariation });
    };
    const placeCopy = (copy: Pick<Copy, "id" | "cardId" | "variantId" | "setId">, isVariation = false) => {
      const known = cards.current.get(copy.cardId);
      copies.current.set(copy.id, {
        cardId: copy.cardId,
        variantId: copy.variantId,
        setId: copy.setId,
        isVariation: known?.isVariation ?? isVariation,
      });
    };
    /** The undo of an add: back to the folded row's details, or gone. */
    const undoAdd = (card: Card, result: { copyId: RawCopy["_id"]; merged: boolean; previous?: RawDetails }) => async () => {
      placeCopy({ id: result.copyId, cardId: card.id, variantId: card.variant.id, setId: card.set.id });
      if (result.merged && result.previous) await updateCopy({ copyId: result.copyId, details: result.previous });
      else await removeCopy({ copyId: result.copyId });
    };

    return {
      async addHave(card) {
        placeCard(card);
        const result = await addHave({ cardId: card.id as RawCopy["cardId"], acquiredOn: todayIso() });
        return { copyId: result.copyId, merged: result.merged, undo: undoAdd(card, result) };
      },

      async addMany(list) {
        list.forEach(placeCard);
        const byId = new Map(list.map((c) => [c.id, c]));
        const results = await addHaves({ cardIds: list.map((c) => c.id as RawCopy["cardId"]), acquiredOn: todayIso() });
        return {
          copyIds: results.map((r) => r.copyId),
          undo: async () => {
            const inserted = results.filter((r) => !r.merged);
            for (const r of inserted) {
              const card = byId.get(r.cardId);
              if (card) placeCopy({ id: r.copyId, cardId: card.id, variantId: card.variant.id, setId: card.set.id });
            }
            for (const part of chunk(inserted, REMOVE_BATCH)) {
              await removeCopies({ copyIds: part.map((r) => r.copyId) });
            }
            for (const r of results) {
              if (!r.merged || !r.previous) continue;
              const card = byId.get(r.cardId);
              if (card) placeCopy({ id: r.copyId, cardId: card.id, variantId: card.variant.id, setId: card.set.id });
              await updateCopy({ copyId: r.copyId, details: r.previous });
            }
          },
        };
      },

      async addLineItem(card, details) {
        placeCard(card);
        const result = await addLineItem({ cardId: card.id as RawCopy["cardId"], details: toRawDetails(details) });
        return { copyId: result.copyId, merged: result.merged, undo: undoAdd(card, result) };
      },

      async updateCopy(copy, patch) {
        placeCopy(copy);
        const merged: CopyDetails = { ...copy, ...patch };
        const { previous } = await updateCopy({
          copyId: copy.id as RawCopy["_id"],
          details: toRawDetails(merged, copy.homeId),
        });
        return {
          undo: async () => {
            placeCopy(copy);
            await updateCopy({ copyId: copy.id as RawCopy["_id"], details: previous });
          },
        };
      },

      async removeCopy(copy) {
        placeCopy(copy);
        const { removed } = await removeCopy({ copyId: copy.id as RawCopy["_id"] });
        return {
          removed: copy,
          undo: async () => {
            cards.current.set(copy.cardId, {
              variantId: copy.variantId,
              setId: copy.setId,
              isVariation: cards.current.get(copy.cardId)?.isVariation ?? false,
            });
            await restoreCopy({ cardId: removed.cardId, details: removed.details });
          },
        };
      },

      async restoreCopy(copy) {
        cards.current.set(copy.cardId, {
          variantId: copy.variantId,
          setId: copy.setId,
          isVariation: cards.current.get(copy.cardId)?.isVariation ?? false,
        });
        const { copyId } = await restoreCopy({
          cardId: copy.cardId as RawCopy["cardId"],
          details: toRawDetails(copy, copy.homeId),
        });
        return {
          copyId,
          merged: false,
          undo: async () => {
            placeCopy({ ...copy, id: copyId });
            await removeCopy({ copyId });
          },
        };
      },

      async setBuilding(set, building) {
        const { changed } = await setBuilding({ setId: set.id as RawCopy["setId"], building });
        return {
          building,
          undo: async () => {
            if (changed) await setBuilding({ setId: set.id as RawCopy["setId"], building: !building });
          },
        };
      },
    };
  }, [addHave, addHaves, addLineItem, updateCopy, removeCopy, removeCopies, restoreCopy, setBuilding]);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Mounts the Convex store. Inside the signed-in shell only (every read needs a collector). */
export function ConvexCollectionProvider({ children }: { children: ReactNode }) {
  const actions = useConvexActions();
  const value = useMemo<CollectionStoreValue>(
    () => ({ kind: "convex", capabilities: NO_CAPABILITIES, data: CONVEX_DATA, actions }),
    [actions],
  );
  return createElement(CollectionStoreContext.Provider, { value }, children);
}

/** Exported for unit tests. */
export const __test = { toVariantRef, toCard, toCopy, toRawDetails, fromRawDetails, toDrillItem, foldsInto };
