/**
 * NEO-358 — the Convex store: the collection contract (`./store`) over the
 * real catalog (`convex/collectionCatalog.ts`) and the signed-in collector's
 * own copies (`convex/collection.ts`). Mounted by `/collection`
 * (`../../page.tsx`). Capabilities: `REAL_CAPABILITIES` (NEO-359 turns on
 * binders and boxes, wants, trade and scope; smart binders, share links and
 * card requests stay off).
 *
 * Reads are `useQuery` / `usePaginatedQuery` (`undefined` while loading),
 * hydrated into the view model (`./types`) here and only here: the server's
 * shapes never reach a view. The page's scope (`useScope`) narrows
 * `copiesInVariant` and `variantCompletion` to one home.
 *
 * Writes are `useMutation`, each resolving with the inverse write as its
 * undo. Every write that touches a copy runs ONE optimistic engine
 * (`applyChange`): the rows as they were and as they will be, applied to
 * every loaded list a row can appear in (`copiesOf`, `copiesInVariant` at
 * any scope, `copiesInContainer`, `tradeCopies`), the checklist counts
 * (`variantCompletion` at any scope) and the shelf counts
 * (`collectionContainers.list`). A move removes the row from every list it
 * leaves in the same update that adds it where it lands, so a card never
 * shows in two places.
 *
 * NEO-359 / NEO-364: a copy in a box is for sale: the inventory's, never
 * on a collection screen; a copy in a binder is the collection's, never on
 * an inventory screen. `collection.copiesInVariant`, `variantCompletion` and
 * `setCompletion` take the reading `side` and answer that side only (a
 * scope on the other side reads as empty); `summary` and `ownedCards` are
 * collection-only. The optimistic engine follows the same line: a box home
 * never counts toward a collection checklist, a binder home never toward an
 * inventory one (it tells them apart by the shelf, so a home it cannot place
 * reads as a binder, like `toCopy`). The trade pile is the one view that
 * spans both (`collection.tradeCopies`).
 *
 * NEO-364 inventory: `useInventoryCards` reads `collectionInventory.inventoryCards`
 * (every box, at most the server's line budget) or, narrowed to one box, pages
 * that box's `copiesInContainer`. `setBoxQuantity` is
 * `collectionInventory.setBoxQuantity` with the plain-line rule drawn ahead
 * of the server; its undo is `collectionInventory.undoBoxQuantity` with the
 * write's exact `inverse`.
 *
 * Conversions between the server's copy and the view's (see `CopyDetails` in
 * `./types`): `costCents` ↔ `costBasis` dollars, `acquiredOn` ↔ `acquiredAt`,
 * `grading` ↔ `graded`, absent notes ↔ "". `updateCopy` on the server
 * REPLACES a copy's details, so a patch here is merged onto the copy first.
 */

import { createElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  useMutation,
  usePaginatedQuery,
  useQueries,
  useQuery,
  type PaginatedQueryArgs,
  type PaginatedQueryItem,
  type PaginatedQueryReference,
} from "convex/react";
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
import { isOptimisticId, OPTIMISTIC_ID_PREFIX } from "../lineKeys";
import { finishForVariant } from "./finish";
import {
  bySlot,
  CollectionStoreContext,
  copiesOnSide,
  completionOf,
  CONTAINER_COPIES_DEFAULT_LIMIT,
  OWNED_CARDS_DEFAULT_LIMIT,
  searchable,
  SET_CARDS_DEFAULT_LIMIT,
  todayIso,
  useScope,
  type CollectionActions,
  type CollectionData,
  type CollectionStoreValue,
} from "./store";
import {
  REAL_CAPABILITIES,
  type Card,
  type CardTeam,
  type Container,
  type ContainerCopies,
  type ContainerPatch,
  type Copy,
  type CopyDetails,
  type DrillItem,
  type DrillLevel,
  type HeldCount,
  type InventoryCards,
  type InventoryItem,
  type OwnedCards,
  type SetCompletion,
  type Side,
  type SetRef,
  type SetSummary,
  type Suggestion,
  type Variant,
  type VariantKind,
  type VariantRef,
  type Want,
} from "./types";

type RawCopy = Infer<typeof copyValidator>;
type RawContainer = FunctionReturnType<typeof api.collectionContainers.list>[number];
type RawWant = FunctionReturnType<typeof api.collectionWants.list>[number];
type RawMove = FunctionReturnType<typeof api.collection.moveCopy>;
type RawCopiesOfMany = FunctionReturnType<typeof api.collection.copiesOfMany>;
type RawDetails = Infer<typeof copyDetailsValidator>;
type RawDrill = FunctionReturnType<typeof api.collectionCatalog.drill>;
type RawDrillItem = RawDrill["items"][number];
type RawSummaryVariant = NonNullable<FunctionReturnType<typeof api.collectionCatalog.setSummary>>["variants"][number];
type RawSuggest = FunctionReturnType<typeof api.collectionCatalog.suggest>;
type RawEntityCards = { cards: CatalogCardWithPath[]; continueCursor: string | null };
type RawInventory = FunctionReturnType<typeof api.collectionInventory.inventoryCards>;
type RawInventoryItem = RawInventory["items"][number];
type RawBoxQuantity = FunctionReturnType<typeof api.collectionInventory.setBoxQuantity>;
type RawBoxInverse = RawBoxQuantity["inverse"];

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
/** Card ids per `copiesOfMany` call (the server's cap). */
const COPIES_OF_MANY = 50;
/** Rows a container / trade / set page asks for. */
const PAGE_SIZE = 100;
/** `empty` calls `deleteContainer` makes before it gives up (200 copies each). */
const MAX_EMPTY_ROUNDS = 100;
/** Lines one box's Inventory list pages in, at most (the server's `MAX_INVENTORY_LINES`). */
const MAX_BOX_LIST_LINES = 2000;
/** The most copies one line holds (the server's `MAX_COPY_QUANTITY`). */
const MAX_LINE_QUANTITY = 999;

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
    ...(raw.notes ? { notes: raw.notes } : {}),
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

/** What a copy's hydration needs to know about its home. */
type Homes = ReadonlyMap<string, Pick<Container, "kind" | "name">>;

function toCopy(raw: RawCopy, homes?: Homes): Copy {
  const home = homes?.get(raw.homeId);
  return {
    id: raw._id,
    cardId: raw.cardId,
    variantId: raw.variantId,
    setId: raw.setId,
    homeId: raw.homeId,
    homeKind: home?.kind ?? "binder",
    ...(home ? { homeName: home.name } : {}),
    upForTrade: raw.upForTrade === true,
    ...(raw.slot !== undefined ? { slot: raw.slot } : {}),
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

/**
 * A shelf row as the view reads it. A rule is not carried: the server's
 * stored shape is NEO-362's and nothing on Convex can make one yet
 * (`smartBinders` is off). `count: null` is "not counted yet".
 */
function toContainer(raw: RawContainer): Container {
  return {
    id: raw._id,
    kind: raw.kind,
    ...(raw.system ? { system: raw.system } : {}),
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.label ? { label: raw.label } : {}),
    count: raw.count ?? null,
  };
}

function toWant(raw: RawWant): Want {
  return { cardId: raw.cardId, binderId: raw.binderId ?? null };
}

/** A view copy as the server lists it (for the optimistic engine's fallback). */
function toRawCopy(copy: Copy): RawCopy {
  return {
    ...toRawDetails(copy, copy.homeId),
    _id: copy.id as RawCopy["_id"],
    cardId: copy.cardId as RawCopy["cardId"],
    variantId: copy.variantId as RawCopy["variantId"],
    setId: copy.setId as RawCopy["setId"],
    homeId: copy.homeId as RawCopy["homeId"],
    lastUpdated: Date.now(),
  } as RawCopy;
}

/** The view's details as the server writes them. Blank is absent; off is absent. */
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
  if (d.slot !== undefined) out.slot = d.slot;
  if (d.upForTrade) out.upForTrade = true;
  const home = homeId ?? d.homeId;
  if (home) out.homeId = home;
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
    ...(raw.homeId ? { homeId: raw.homeId } : {}),
    ...(raw.slot !== undefined ? { slot: raw.slot } : {}),
    ...(raw.upForTrade ? { upForTrade: true } : {}),
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

  useVariantCompletion(variantId, side) {
    const homeId = useScopedHome();
    const raw = useQuery(
      api.collection.variantCompletion,
      variantId ? { variantId, side, ...(homeId ? { homeId } : {}) } : "skip",
    );
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

  useSetCompletion(setId, side) {
    const homeId = useScopedHome();
    // The owned counts come in one read of the set's copies; the totals are
    // the set summary's (the same numbers the browse header shows).
    const summary = CONVEX_DATA.useSetSummary(setId);
    const raw = useQuery(
      api.collection.setCompletion,
      setId ? { setId, side, ...(homeId ? { homeId } : {}) } : "skip",
    );
    return useMemo((): SetCompletion | undefined => {
      if (setId === null || summary === undefined || raw === undefined) return undefined;
      const total = summary?.totalCards ?? 0;
      const totalAll = summary?.totalCardsAll ?? 0;
      return {
        ...completionOf({ owned: raw.owned, total }, { owned: raw.ownedAll, total: totalAll }),
        exact: !raw.truncated,
      };
    }, [setId, summary, raw]);
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

  useTeam(teamId) {
    const raw = useQuery(api.collectionCatalog.team, teamId ? { teamId } : "skip");
    return useMemo((): CardTeam | null | undefined => {
      if (teamId === null || raw === undefined) return undefined;
      if (raw === null) return null;
      return {
        id: raw._id,
        name: raw.name,
        location: raw.location ?? "",
        ...(raw.primaryColor ? { primary: raw.primaryColor } : {}),
        ...(raw.secondaryColor ? { secondary: raw.secondaryColor } : {}),
      };
    }, [teamId, raw]);
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
    const homes = useHomes();
    const raw = useQuery(api.collection.copiesOf, cardId ? { cardId } : "skip");
    // Waits for the shelf: until a copy's home is known it cannot be told
    // apart from one in a box, and a collection screen never shows those.
    return useMemo(() => (homes ? raw?.map((r) => toCopy(r, homes)) : undefined), [raw, homes]);
  },

  useCopiesInVariant(variantId, side) {
    const homes = useHomes();
    const homeId = useScopedHome();
    const raw = useQuery(
      api.collection.copiesInVariant,
      variantId ? { variantId, side, ...(homeId ? { homeId } : {}) } : "skip",
    );
    // The server answers one side; the optimistic rows are kept to it too.
    return useMemo(
      () => (homes && raw ? copiesOnSide(raw.map((r) => toCopy(r, homes)), side) : undefined),
      [raw, homes, side],
    );
  },

  useSummary() {
    const raw = useQuery(api.collection.summary, {});
    return useMemo(
      () =>
        raw
          ? {
              copies: raw.copies,
              cards: raw.distinctCards,
              exact: raw.exact,
              offBuild: raw.offBuildExact ? raw.offBuildCards : null,
            }
          : undefined,
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
        copiesByCard[id] = {
          quantity: held[i].quantity,
          lines: held[i].lines,
          ...(held[i].graded ? { graded: true } : {}),
        };
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

  /**
   * The Inventory list. Every box: `collectionInventory.inventoryCards`, which
   * reads at most the server's line budget (its `truncated` says so). One box
   * (`boxId`, only ever a box: anything else lists nothing): that box's
   * `copiesInContainer`, paged until it holds more than `limit` cards, so the
   * list can see past the budget one box at a time. Cards are hydrated
   * through `cards`; one already hydrated stands in while the list re-asks
   * (a quick count reorders it), so the list never blinks to a skeleton.
   */
  useInventoryCards(options) {
    const limit = limitOf(options?.limit, OWNED_CARDS_DEFAULT_LIMIT);
    const homes = useHomes();
    const boxId = options?.boxId ?? null;
    const boxKnown = boxId === null || homes !== undefined;
    const isBox = boxId !== null && homes?.get(boxId)?.kind === "box";
    const all = useQuery(api.collectionInventory.inventoryCards, boxId === null ? {} : "skip");
    const inBox = useBoxInventory(isBox ? boxId : null, limit);
    const raw: RawInventory | undefined =
      boxId === null ? all : !boxKnown ? undefined : isBox ? inBox : { items: [], goneCardIds: [], truncated: false };
    const listed = useMemo(() => raw?.items.slice(0, limit), [raw, limit]);
    const known = useCardCache(useMemo(() => listed?.map((i) => i.cardId as string) ?? null, [listed]));
    return useMemo((): InventoryCards | undefined => {
      if (!raw || !listed || !known) return undefined;
      const items: InventoryItem[] = [];
      const goneCardIds: string[] = [...raw.goneCardIds];
      for (const item of listed) {
        // Not hydrated yet: it joins the list when it lands.
        if (!known.has(item.cardId)) continue;
        const card = known.get(item.cardId);
        if (!card) {
          goneCardIds.push(item.cardId);
          continue;
        }
        items.push({
          card,
          quantity: item.quantity,
          lines: item.lines,
          graded: item.graded,
          gradedQuantity: item.gradedQuantity,
          upForTrade: item.upForTrade,
          lastUpdated: item.lastUpdated,
          boxes: item.boxes.map((b) => ({ boxId: b.boxId, quantity: b.quantity, gradedQuantity: b.gradedQuantity })),
        });
      }
      return { items, goneCardIds, truncated: raw.truncated || raw.items.length > limit };
    }, [raw, listed, known, limit]);
  },

  useContainers() {
    const raw = useQuery(api.collectionContainers.list, {});
    return useMemo(() => raw?.map(toContainer), [raw]);
  },

  /**
   * One container's copies, paged in until `limit`. Which read depends on
   * what the container is, so this waits for the shelf: the trade pile reads
   * `tradeCopies`, the Want List holds no copies, everything else
   * `copiesInContainer`.
   */
  useContainerCopies(containerId, options) {
    const raw = useQuery(api.collectionContainers.list, {});
    const homes = useHomes();
    const row = containerId && raw ? (raw.find((c) => c._id === containerId) ?? null) : undefined;
    const isTrade = row?.system === "trade";
    const listable = !!row && !isTrade && row.system !== "want";
    const limit = limitOf(options?.limit, CONTAINER_COPIES_DEFAULT_LIMIT);
    const inContainer = usePagedUpTo(
      api.collection.copiesInContainer,
      listable ? { containerId: row!._id } : "skip",
      limit,
    );
    const trade = usePagedUpTo(api.collection.tradeCopies, isTrade ? {} : "skip", limit);
    return useMemo((): ContainerCopies | undefined => {
      if (containerId === null || row === undefined || !homes) return undefined;
      if (row === null || row.system === "want") return { copies: [], truncated: false };
      const pages = isTrade ? trade : inContainer;
      if (pages === undefined) return undefined;
      const copies = pages.results.slice(0, limit).map((r) => toCopy(r, homes));
      return {
        // The trade pile spans collection and inventory: box copies stay (`inCollection` in `./store`).
        copies: bySlot(copies),
        truncated: pages.results.length > limit || !pages.exhausted,
      };
    }, [containerId, row, isTrade, trade, inContainer, limit, homes]);
  },

  useTradeCopies(options) {
    const homes = useHomes();
    const limit = limitOf(options?.limit, CONTAINER_COPIES_DEFAULT_LIMIT);
    const pages = usePagedUpTo(api.collection.tradeCopies, {}, limit);
    return useMemo((): ContainerCopies | undefined => {
      if (pages === undefined || !homes) return undefined;
      return {
        // Every flagged copy, a box's too: trade spans collection and inventory.
        copies: pages.results.slice(0, limit).map((r) => toCopy(r, homes)),
        truncated: pages.results.length > limit || !pages.exhausted,
      };
    }, [pages, limit, homes]);
  },

  useWants() {
    const raw = useQuery(api.collectionWants.list, {});
    return useMemo(() => raw?.map(toWant), [raw]);
  },

  useCopiesOfCards(cardIds) {
    const homes = useHomes();
    const key = cardIds ? [...new Set(cardIds)].join("\n") : null;
    const requests = useMemo(() => {
      const ids = key ? key.split("\n") : [];
      return Object.fromEntries(
        chunk(ids, COPIES_OF_MANY).map((part, i) => [
          String(i),
          { query: api.collection.copiesOfMany, args: { cardIds: part } },
        ]),
      );
    }, [key]);
    const results = useQueries(requests);
    return useMemo(() => {
      if (key === null) return undefined;
      const out: Record<string, Copy[]> = {};
      if (key === "") return out;
      // Every home, boxes too; waits for the shelf so a box copy is known as one.
      if (!homes) return undefined;
      for (const id of key.split("\n")) out[id] = [];
      for (let i = 0; i < Object.keys(requests).length; i++) {
        const part = results[String(i)] as RawCopiesOfMany | undefined | Error;
        if (part === undefined) return undefined;
        if (part instanceof Error) throw part;
        for (const row of part) out[row.cardId] = row.copies.map((c) => toCopy(c, homes));
      }
      return out;
    }, [key, requests, results, homes]);
  },

  /** Browse a set: `cardsInSet` pages (each inside one checklist, in set order) until `limit`. */
  useSetCards(setId, options) {
    const limit = limitOf(options?.limit, SET_CARDS_DEFAULT_LIMIT);
    const pages = usePagedUpTo(api.collection.cardsInSet, setId ? { setId } : "skip", limit);
    return useMemo(() => {
      if (setId === null || pages === undefined) return undefined;
      const cards = pages.results
        .slice(0, limit)
        .map((c) => toCardWithPath(c as CatalogCardWithPath))
        .filter((c): c is Card => c !== null);
      return { cards, truncated: pages.results.length > limit || !pages.exhausted };
    }, [setId, pages, limit]);
  },
};

function limitOf(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(limit ?? fallback));
}

/**
 * The shelf by id, for a copy's home name and kind. Stable while the shelf
 * is; `undefined` while it loads (a copy's home kind is unknown until then,
 * and the collection's reads wait for it: NEO-359).
 */
function useHomes(): Homes | undefined {
  const raw = useQuery(api.collectionContainers.list, {});
  return useMemo(
    () => (raw ? new Map(raw.map((c) => [c._id as string, { kind: c.kind, name: c.name }])) : undefined),
    [raw],
  );
}

/**
 * Cards by id, hydrated through `cards` (sorted, so a reorder asks nothing
 * new). Every card seen stays known for the mount: while a changed list is
 * re-asked, the ones already hydrated stand in. `undefined` until the first
 * answer (or for `null` ids).
 */
function useCardCache(ids: readonly string[] | null): ReadonlyMap<string, Card | null> | undefined {
  const key = ids ? [...new Set(ids)].sort().join("\n") : null;
  const sorted = useMemo(() => (key === null ? null : key === "" ? [] : key.split("\n")), [key]);
  const hydrated = CONVEX_DATA.useCards(sorted);
  const seen = useRef(new Map<string, Card | null>());
  return useMemo(() => {
    if (sorted === null) return undefined;
    if (hydrated) sorted.forEach((id, i) => seen.current.set(id, hydrated[i] ?? null));
    else if (sorted.length > 0 && seen.current.size === 0) return undefined;
    return new Map(seen.current);
  }, [sorted, hydrated]);
}

/**
 * One box's lines (`copiesInContainer`), card by card in the shape
 * `inventoryCards` answers, paged until it holds MORE than `limit` cards
 * (so `truncated` is honest) or `MAX_BOX_LIST_LINES` lines. Newest first.
 * `undefined` until the first page (and for `null`).
 */
function useBoxInventory(boxId: string | null, limit = OWNED_CARDS_DEFAULT_LIMIT): RawInventory | undefined {
  const pages = usePaginatedQuery(
    api.collection.copiesInContainer,
    boxId ? { containerId: boxId } : "skip",
    { initialNumItems: PAGE_SIZE },
  );
  const items = useMemo(() => (boxId ? boxItems(pages.results, boxId) : []), [pages.results, boxId]);
  const canLoadMore = pages.status === "CanLoadMore";
  const lines = pages.results.length;
  const { loadMore } = pages;
  useEffect(() => {
    if (canLoadMore && items.length <= limit && lines < MAX_BOX_LIST_LINES) loadMore(PAGE_SIZE);
  }, [canLoadMore, items.length, limit, lines, loadMore]);
  const loading = boxId === null || pages.status === "LoadingFirstPage";
  const exhausted = pages.status === "Exhausted";
  return useMemo(
    () => (loading ? undefined : { items, goneCardIds: [], truncated: !exhausted }),
    [loading, items, exhausted],
  );
}

/** One box's lines as Inventory items, one per card, newest first. */
function boxItems(rows: readonly RawCopy[], boxId: string): RawInventoryItem[] {
  const byCard = new Map<string, RawInventoryItem>();
  for (const row of rows) {
    if (row.homeId !== boxId || row.quantity <= 0) continue;
    const item = byCard.get(row.cardId) ?? {
      cardId: row.cardId,
      quantity: 0,
      lines: 0,
      graded: false,
      gradedQuantity: 0,
      upForTrade: false,
      lastUpdated: 0,
      boxes: [{ boxId: row.homeId, quantity: 0, gradedQuantity: 0 }],
    };
    const slabs = row.grading ? row.quantity : 0;
    item.quantity += row.quantity;
    item.lines += 1;
    item.boxes[0].quantity += row.quantity;
    item.boxes[0].gradedQuantity += slabs;
    item.gradedQuantity += slabs;
    if (row.grading) item.graded = true;
    if (row.upForTrade === true) item.upForTrade = true;
    if (row.lastUpdated > item.lastUpdated) item.lastUpdated = row.lastUpdated;
    byCard.set(row.cardId, item);
  }
  return [...byCard.values()].sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/** The scope as a `homeId` argument: the picked home, or undefined under All. */
function useScopedHome(): RawCopy["homeId"] | undefined {
  const scope = useScope();
  return scope === "all" ? undefined : (scope as RawCopy["homeId"]);
}

/**
 * A paginated read, loaded page by page until it holds `limit` rows or runs
 * out. `undefined` until the first page is in (and for `"skip"`).
 */
function usePagedUpTo<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  limit: number,
): { results: PaginatedQueryItem<Query>[]; exhausted: boolean } | undefined {
  const pages = usePaginatedQuery(query, args, { initialNumItems: Math.min(PAGE_SIZE, limit) });
  const canLoadMore = pages.status === "CanLoadMore";
  const count = pages.results.length;
  const { loadMore } = pages;
  useEffect(() => {
    if (canLoadMore && count < limit) loadMore(Math.min(PAGE_SIZE, limit - count));
  }, [canLoadMore, count, limit, loadMore]);
  const skipped = args === "skip";
  const loading = pages.status === "LoadingFirstPage";
  const exhausted = pages.status === "Exhausted";
  const results = pages.results;
  return useMemo(
    () => (skipped || loading ? undefined : { results, exhausted }),
    [skipped, loading, results, exhausted],
  );
}

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
        ...(t.primaryColor ? { primary: t.primaryColor } : {}),
        ...(t.secondaryColor ? { secondary: t.secondaryColor } : {}),
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
// Optimistic updates: one engine for every copy write
// ---------------------------------------------------------------------------

/** What an optimistic update needs to know about a card that its args do not say. */
interface CardPlace {
  variantId: string;
  setId: string;
  isVariation: boolean;
}

/** A copy the action handed over, for when no loaded list holds its row. */
interface KnownCopy extends CardPlace {
  cardId: string;
  row: RawCopy;
}

let optimisticSeq = 0;
function optimisticId(): RawCopy["_id"] {
  optimisticSeq += 1;
  // The prefix tells a list this line is ours until the server answers (`../lineKeys`).
  return `${OPTIMISTIC_ID_PREFIX}${optimisticSeq}` as RawCopy["_id"];
}

/** The ids each write's optimistic update drew, by the write's args object and the line's place in it. */
const drawnIds = new WeakMap<object, Map<number, RawCopy["_id"]>>();

/**
 * The placeholder id for line `n` of the write sent with `args`. Convex runs a
 * pending write's optimistic update again every time the server answers
 * anything, always with the same args object: the same line must come back
 * with the same id each time, and the action that sent it must be able to
 * find which ids it drew (`drawnBy`).
 */
function optimisticIdFor(args: object, n = 0): RawCopy["_id"] {
  let ids = drawnIds.get(args);
  if (!ids) {
    ids = new Map();
    drawnIds.set(args, ids);
  }
  let id = ids.get(n);
  if (!id) {
    id = optimisticId();
    ids.set(n, id);
  }
  return id;
}

/** The placeholder ids a write's optimistic update drew, by line. */
function drawnBy(args: object): ReadonlyMap<number, RawCopy["_id"]> {
  return drawnIds.get(args) ?? new Map();
}

/** What a write on a line that never got its real id says. */
export const UNSAVED_LINE_MESSAGE = "That line didn't save, so there's nothing to change. Give it another go.";

/**
 * Each placeholder id's real one, once the write that drew it answers (`null`
 * when it was refused: the line went with it). Ids are unique for the page's
 * life, so one map serves every store.
 */
const landing = new Map<string, Promise<RawCopy["_id"] | null>>();

/**
 * A write that may draw lines ahead of the server: sends it, then records,
 * for each placeholder its optimistic update drew, the server's id for that
 * line (`realId`, from the write's answer and the line's place in it).
 */
function landsAs<A extends object, R>(
  send: (args: A) => Promise<R>,
  realId: (result: R, n: number, args: A) => RawCopy["_id"] | undefined,
): (args: A) => Promise<R> {
  return (args) => {
    const call = send(args);
    for (const [n, id] of drawnBy(args)) {
      landing.set(
        id,
        call.then(
          (result) => {
            // An answer in a shape we cannot read leaves the line unsaved, never a stray rejection.
            try {
              return realId(result, n, args) ?? null;
            } catch {
              return null;
            }
          },
          () => null,
        ),
      );
    }
    return call;
  };
}

/**
 * The line as the server knows it. A line drawn ahead of the server (an add,
 * a split, an undo's re-split) has a placeholder id the server would refuse:
 * a write on it waits for the write that drew it, then goes to the real id.
 * Typically a few milliseconds; the collector sees the result as usual.
 * Callers await it only for a placeholder, so a write on a real line still
 * draws its optimistic update in the same tick it was asked for.
 */
async function landedCopy(copy: Copy): Promise<Copy> {
  if (!isOptimisticId(copy.id)) return copy;
  const real = await (landing.get(copy.id) ?? null);
  if (!real) throw new Error(UNSAVED_LINE_MESSAGE);
  return { ...copy, id: real };
}

/**
 * A write's effect on ONE card's rows: those it touches as they are now, and
 * as they will be. A row in `before` but not in `after` is gone; a row only
 * in `after` is new.
 */
interface Change {
  cardId: string;
  variantId: string;
  isVariation: boolean;
  before: RawCopy[];
  after: RawCopy[];
}

type RawPage = { page: RawCopy[]; isDone: boolean };

/**
 * One loaded list after the change: touched rows replaced in place (or
 * dropped when they no longer belong), untouched rows kept, and, when
 * `insert`, rows that now belong and were not there added at the end.
 */
function patchRows(
  rows: readonly RawCopy[],
  change: Change,
  belongs: (r: RawCopy) => boolean,
  insert: boolean,
  present: ReadonlySet<string> = new Set(),
): RawCopy[] {
  const after = new Map(change.after.map((r) => [r._id as string, r]));
  const gone = new Set(change.before.map((r) => r._id as string));
  const out: RawCopy[] = [];
  const seen = new Set(present);
  for (const r of rows) {
    const next = after.get(r._id);
    if (next) {
      seen.add(r._id);
      if (belongs(next)) out.push(next);
    } else if (!gone.has(r._id)) {
      out.push(r);
    }
  }
  if (insert) for (const r of change.after) if (!seen.has(r._id) && belongs(r)) out.push(r);
  return out;
}

/** Whether a card is held in a list, among the rows `keep` lets count. */
function heldIn(rows: readonly RawCopy[], cardId: string, keep: (r: RawCopy) => boolean = () => true): boolean {
  return rows.some((r) => r.cardId === cardId && r.quantity > 0 && keep(r));
}

/**
 * Which side a row is on, by the loaded shelf: a box home is the
 * inventory's, anything else (a binder, or a home the shelf does not hold
 * yet, read as a binder like `toCopy` does) the collection's.
 */
function sidesOf(local: OptimisticLocalStore): (r: Pick<RawCopy, "homeId">, side: Side) => boolean {
  const shelf = local.getQuery(api.collectionContainers.list, {});
  const boxes = new Set((shelf ?? []).filter((c) => c.kind === "box").map((c) => c._id as string));
  return (r, side) => boxes.has(r.homeId) === (side === "inventory");
}

/** A side-aware read's side (every one carries it since NEO-364; `collection` before). */
function sideArg(args: Record<string, unknown>): Side {
  return args.side === "inventory" ? "inventory" : "collection";
}

/** Every loaded page of a paginated read, grouped by its args without the cursor. */
function pageGroups<Q extends PaginatedQueryReference>(local: OptimisticLocalStore, query: Q) {
  const groups = new Map<string, { args: Record<string, unknown>; value: RawPage }[]>();
  for (const { args, value } of local.getAllQueries(query)) {
    if (!value) continue;
    const { paginationOpts: _p, ...rest } = args as Record<string, unknown>;
    const key = JSON.stringify(rest);
    const list = groups.get(key) ?? [];
    list.push({ args: args as Record<string, unknown>, value: value as unknown as RawPage });
    groups.set(key, list);
  }
  return groups;
}

/** A paginated read after the change; a new row joins the last page only (the one that is done). */
function patchPaged<Q extends PaginatedQueryReference>(
  local: OptimisticLocalStore,
  query: Q,
  change: Change,
  belongsFor: (args: Record<string, unknown>) => (r: RawCopy) => boolean,
) {
  for (const pages of pageGroups(local, query).values()) {
    const belongs = belongsFor(pages[0].args);
    const present = new Set(pages.flatMap((p) => p.value.page.map((r) => r._id as string)));
    for (const { args, value } of pages) {
      const page = patchRows(value.page, change, belongs, value.isDone, present);
      local.setQuery(query, args as never, { ...value, page } as never);
    }
  }
}

/**
 * Applies a change to every loaded list, checklist count, inventory item and
 * shelf count it can reach. NEO-364: a side-aware read keeps to its side, so
 * under the collection a box home never counts toward a checklist or lists
 * in `copiesInVariant`, and under the inventory a binder home never does.
 */
function applyChange(local: OptimisticLocalStore, change: Change) {
  const { cardId, variantId } = change;
  const onSide = sidesOf(local);
  /** What a side-aware read at these args lets in: its side, and its scoped home if any. */
  const keepFor = (args: Record<string, unknown>) => {
    const side = sideArg(args);
    const homeId = args.homeId as string | undefined;
    return (r: RawCopy) => onSide(r, side) && (!homeId || r.homeId === homeId);
  };
  const ofCard = local.getQuery(api.collection.copiesOf, { cardId: cardId as RawCopy["cardId"] });
  const inVariant = local
    .getAllQueries(api.collection.copiesInVariant)
    .filter((q) => q.args.variantId === variantId && q.value !== undefined);

  // Checklist counts first, from the lists as they were.
  for (const { args, value } of local.getAllQueries(api.collection.variantCompletion)) {
    if (args.variantId !== variantId || !value) continue;
    const homeId = args.homeId as string | undefined;
    const side = sideArg(args);
    const keep = keepFor(args);
    let before: boolean | undefined;
    let after: boolean | undefined;
    if (ofCard !== undefined) {
      before = heldIn(ofCard, cardId, keep);
      after = heldIn(patchRows(ofCard, change, () => true, true), cardId, keep);
    } else {
      const same = inVariant.find(
        (q) => (q.args.homeId as string | undefined) === homeId && sideArg(q.args) === side,
      );
      if (same?.value) {
        before = heldIn(same.value, cardId, keep);
        after = heldIn(patchRows(same.value, change, keep, true), cardId, keep);
      }
    }
    if (before === undefined || before === after) continue;
    const delta = after ? 1 : -1;
    local.setQuery(api.collection.variantCompletion, args, {
      ...value,
      owned: Math.max(0, value.owned + (change.isVariation ? 0 : delta)),
      ownedAll: Math.max(0, value.ownedAll + delta),
    });
  }

  if (ofCard !== undefined) {
    local.setQuery(api.collection.copiesOf, { cardId: cardId as RawCopy["cardId"] }, patchRows(ofCard, change, () => true, true));
  }
  for (const { args, value } of inVariant) {
    local.setQuery(api.collection.copiesInVariant, args, patchRows(value!, change, keepFor(args), true));
  }
  patchPaged(local, api.collection.copiesInContainer, change, (args) => (r) => r.homeId === args.containerId);
  patchPaged(local, api.collection.tradeCopies, change, () => (r) => r.upForTrade === true);
  patchInventory(local, change, ofCard === undefined ? undefined : patchRows(ofCard, change, () => true, true));

  // The shelf's counts: a home counts the copies it holds, the trade pile the flagged ones.
  const shelf = local.getQuery(api.collectionContainers.list, {});
  if (shelf) {
    const tally = (rows: RawCopy[], match: (r: RawCopy) => boolean) => {
      const mine = rows.filter(match);
      return { copies: mine.reduce((n, r) => n + r.quantity, 0), lines: mine.length };
    };
    local.setQuery(
      api.collectionContainers.list,
      {},
      shelf.map((c) => {
        if (!c.count || c.system === "want") return c;
        const match = c.system === "trade" ? (r: RawCopy) => r.upForTrade === true : (r: RawCopy) => r.homeId === c._id;
        const was = tally(change.before, match);
        const now = tally(change.after, match);
        if (was.copies === now.copies && was.lines === now.lines) return c;
        return {
          ...c,
          count: {
            copies: Math.max(0, c.count.copies + now.copies - was.copies),
            lines: Math.max(0, c.count.lines + now.lines - was.lines),
          },
        };
      }),
    );
  }
}

/**
 * The Inventory list (`collectionInventory.inventoryCards`, every loaded
 * answer) after the change: the card's item rebuilt from its box rows. With
 * `whole` (the card's every row after the change, from a loaded `copiesOf`)
 * the item is counted afresh; otherwise the change's box rows are added and
 * taken off the item as it was. On that path the graded and trade marks are
 * settled from the card's box rows the other loaded lists hold: exactly when
 * they account for every line, else a mark the change took off (a slab
 * removed, a copy unflagged) clears unless a row in hand still carries it.
 * The server's answer settles anything the client could not see. An item at
 * 0 leaves the list; the list stays newest first.
 */
function patchInventory(local: OptimisticLocalStore, change: Change, whole: readonly RawCopy[] | undefined) {
  const shelf = local.getQuery(api.collectionContainers.list, {});
  if (!shelf) return;
  const order = new Map(shelf.filter((c) => c.kind === "box").map((c, i) => [c._id as string, i]));
  const inBox = (r: RawCopy) => order.has(r.homeId);
  const was = change.before.filter(inBox);
  const now = change.after.filter(inBox);
  if (was.length === 0 && now.length === 0) return;
  const cardId = change.cardId as RawInventoryItem["cardId"];
  /** The card's box rows after the change, as far as the loaded lists know them. */
  let inHand: RawCopy[] | undefined;
  const known = () =>
    (inHand ??= patchRows(cardRows(local, cardId), change, () => true, true).filter((r) => inBox(r) && r.quantity > 0));
  for (const { args, value } of local.getAllQueries(api.collectionInventory.inventoryCards)) {
    if (!value) continue;
    const old = value.items.find((i) => i.cardId === cardId);
    const item: RawInventoryItem = whole
      ? { cardId, quantity: 0, lines: 0, graded: false, gradedQuantity: 0, upForTrade: false, lastUpdated: 0, boxes: [] }
      : old
        ? { ...old, boxes: old.boxes.map((b) => ({ ...b })) }
        : { cardId, quantity: 0, lines: 0, graded: false, gradedQuantity: 0, upForTrade: false, lastUpdated: 0, boxes: [] };
    const add = (r: RawCopy, sign: 1 | -1) => {
      // Slabs are counted, not marked: a delta keeps the count exact.
      const slabs = r.grading ? r.quantity : 0;
      item.quantity += sign * r.quantity;
      item.gradedQuantity += sign * slabs;
      item.lines += sign;
      const box = item.boxes.find((b) => b.boxId === r.homeId);
      if (box) {
        box.quantity += sign * r.quantity;
        box.gradedQuantity += sign * slabs;
      } else if (sign > 0) item.boxes.push({ boxId: r.homeId, quantity: r.quantity, gradedQuantity: slabs });
      if (sign > 0) {
        if (r.grading) item.graded = true;
        if (r.upForTrade === true) item.upForTrade = true;
        if (r.lastUpdated > item.lastUpdated) item.lastUpdated = r.lastUpdated;
      }
    };
    if (whole) {
      for (const r of whole) if (inBox(r) && r.quantity > 0) add(r, 1);
    } else {
      for (const r of was) add(r, -1);
      for (const r of now) add(r, 1);
      settleMarks(item, known(), was, now);
    }
    // The slab count is exact on both paths, so the mark follows it.
    item.gradedQuantity = Math.max(0, item.gradedQuantity);
    for (const b of item.boxes) b.gradedQuantity = Math.max(0, Math.min(b.gradedQuantity, b.quantity));
    item.graded = item.gradedQuantity > 0;
    item.boxes = item.boxes
      .filter((b) => b.quantity > 0)
      .sort((a, b) => (order.get(a.boxId) ?? 0) - (order.get(b.boxId) ?? 0));
    const rest = value.items.filter((i) => i.cardId !== cardId);
    const items =
      item.quantity > 0 && item.lines > 0 ? [...rest, item].sort((a, b) => b.lastUpdated - a.lastUpdated) : rest;
    local.setQuery(api.collectionInventory.inventoryCards, args, { ...value, items });
  }
}

const MARKS = {
  graded: (r: RawCopy) => r.grading !== undefined,
  upForTrade: (r: RawCopy) => r.upForTrade === true,
} as const;

/**
 * An Inventory item's graded and trade marks after a delta (`patchInventory`
 * without the card's whole rows). `known`: its box rows the loaded lists
 * hold. When they are every line the item has, the marks are read off them;
 * otherwise a mark the change took away (a `was` row carried it, no `now`
 * row does) clears unless a known row still carries it.
 */
function settleMarks(item: RawInventoryItem, known: readonly RawCopy[], was: readonly RawCopy[], now: readonly RawCopy[]) {
  const complete = known.length >= item.lines;
  for (const key of Object.keys(MARKS) as (keyof typeof MARKS)[]) {
    const has = MARKS[key];
    if (complete) item[key] = known.some(has);
    else if (was.some(has) && !now.some((r) => r.quantity > 0 && has(r)) && !known.some(has)) item[key] = false;
  }
}

/** Every loaded row of a card, each once: its `copiesOf` when loaded (the whole truth), else what the other lists hold. */
function cardRows(local: OptimisticLocalStore, cardId: string): RawCopy[] {
  const ofCard = local.getQuery(api.collection.copiesOf, { cardId: cardId as RawCopy["cardId"] });
  if (ofCard !== undefined) return ofCard;
  const out = new Map<string, RawCopy>();
  const take = (rows: readonly RawCopy[] | undefined) => {
    for (const r of rows ?? []) if (r.cardId === cardId && !out.has(r._id)) out.set(r._id, r);
  };
  for (const { value } of local.getAllQueries(api.collection.copiesInVariant)) take(value);
  for (const pages of pageGroups(local, api.collection.copiesInContainer).values()) for (const p of pages) take(p.value.page);
  for (const pages of pageGroups(local, api.collection.tradeCopies).values()) for (const p of pages) take(p.value.page);
  return [...out.values()];
}

/** A copy's row as the loaded lists hold it now, else as the action last saw it. */
function rowOf(local: OptimisticLocalStore, copyId: string, known: KnownCopy | undefined): RawCopy | undefined {
  if (!known) return undefined;
  return cardRows(local, known.cardId).find((r) => r._id === copyId) ?? known.row;
}

/** The collector's Main, when the shelf is loaded. */
function mainId(local: OptimisticLocalStore): RawCopy["homeId"] | undefined {
  return local.getQuery(api.collectionContainers.list, {})?.find((c) => c.system === "main")?._id;
}

/** The server's fold rule, as far as the client can see it: everything but quantity, never a cert or serial. */
function foldsInto(row: RawCopy, next: RawDetails): boolean {
  if (row.grading?.cert || row.serialNumber || next.grading?.cert || next.serialNumber) return false;
  return (
    (next.homeId === undefined || row.homeId === next.homeId) &&
    (row.slot ?? null) === (next.slot ?? null) &&
    (row.upForTrade === true) === (next.upForTrade === true) &&
    row.condition === next.condition &&
    row.grading?.grader === next.grading?.grader &&
    row.grading?.grade === next.grading?.grade &&
    row.costCents === next.costCents &&
    row.acquiredOn === next.acquiredOn &&
    row.location === next.location &&
    row.notes === next.notes
  );
}

/** A plain line (NEO-364, D9), the server's `isPlainLine`: raw, no detail recorded, not up for trade. */
function isPlainRow(r: RawCopy): boolean {
  return (
    r.condition === undefined &&
    r.grading === undefined &&
    r.serialNumber === undefined &&
    r.costCents === undefined &&
    r.location === undefined &&
    r.notes === undefined &&
    r.upForTrade !== true
  );
}

/**
 * `setBoxQuantity` drawn ahead of the server, from the card's loaded rows:
 * the plain lines in the box are set to `quantity`. Raising folds into
 * today's plain unplaced line or draws a new one; lowering takes from the
 * plain lines newest first (a line at 0 goes). The same number changes
 * nothing.
 */
function applyBoxQuantity(
  local: OptimisticLocalStore,
  cardId: string,
  boxId: string,
  quantity: number,
  acquiredOn: string,
  place: CardPlace | undefined,
  draw: () => RawCopy["_id"] = optimisticId,
) {
  if (!place) return;
  const now = Date.now();
  const rows = cardRows(local, cardId);
  const plain = rows.filter((r) => r.homeId === boxId && isPlainRow(r));
  const before = plain.reduce((n, r) => n + r.quantity, 0);
  if (quantity === before) return;
  const change: Change = { cardId, variantId: place.variantId, isVariation: place.isVariation, before: [], after: [] };
  if (quantity > before) {
    const adding = quantity - before;
    const next = { quantity: adding, acquiredOn, homeId: boxId } as RawDetails;
    const into = rows.find((r) => foldsInto(r, next) && r.quantity + adding <= MAX_LINE_QUANTITY);
    if (into) {
      change.before = [into];
      change.after = [{ ...into, quantity: into.quantity + adding, lastUpdated: now }];
    } else {
      change.after = [
        {
          _id: draw(),
          cardId: cardId as RawCopy["cardId"],
          variantId: place.variantId as RawCopy["variantId"],
          setId: place.setId as RawCopy["setId"],
          homeId: boxId as RawCopy["homeId"],
          quantity: adding,
          acquiredOn,
          lastUpdated: now,
        },
      ];
    }
  } else {
    let left = before - quantity;
    // Newest first, as the server's `newerLine`: the latest touched, then the later listed.
    const newest = plain
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.lastUpdated - a.r.lastUpdated || b.i - a.i)
      .map(({ r }) => r);
    for (const r of newest) {
      if (left === 0) break;
      const take = Math.min(left, r.quantity);
      left -= take;
      change.before.push(r);
      if (take < r.quantity) change.after.push({ ...r, quantity: r.quantity - take, lastUpdated: now });
    }
  }
  applyChange(local, change);
}

/**
 * `undoBoxQuantity` drawn ahead of the server: each step of the inverse, in
 * order, on the card's loaded rows. A `restore` folds into an identical
 * line as the server does, or draws line `n` (the step's place).
 */
function applyBoxSteps(
  local: OptimisticLocalStore,
  inverse: RawBoxInverse,
  place: CardPlace | undefined,
  draw: (n: number) => RawCopy["_id"],
) {
  if (!place) return;
  const now = Date.now();
  const cardId = inverse.cardId as string;
  inverse.steps.forEach((step, n) => {
    const rows = cardRows(local, cardId);
    const change: Change = { cardId, variantId: place.variantId, isVariation: place.isVariation, before: [], after: [] };
    if (step.op === "restore") {
      const next = {
        quantity: step.quantity,
        ...(step.acquiredOn ? { acquiredOn: step.acquiredOn } : {}),
        ...(step.slot !== undefined ? { slot: step.slot } : {}),
        homeId: inverse.boxId,
      } as RawDetails;
      const into = rows.find((r) => foldsInto(r, next) && r.quantity + step.quantity <= MAX_LINE_QUANTITY);
      if (into) {
        change.before = [into];
        change.after = [{ ...into, quantity: into.quantity + step.quantity, lastUpdated: now }];
      } else {
        change.after = [
          {
            ...(next as object),
            _id: draw(n),
            cardId: inverse.cardId,
            variantId: place.variantId as RawCopy["variantId"],
            setId: place.setId as RawCopy["setId"],
            homeId: inverse.boxId,
            lastUpdated: now,
          } as RawCopy,
        ];
      }
    } else {
      const row = rows.find((r) => r._id === step.copyId);
      if (!row) return;
      change.before = [row];
      if (step.op === "set") change.after = [{ ...row, quantity: step.to, lastUpdated: now }];
    }
    applyChange(local, change);
  });
}

/** An add (`fold: false` for a restore, which the server always inserts as its own row). */
function applyAdd(
  local: OptimisticLocalStore,
  cardId: string,
  place: CardPlace | undefined,
  details: RawDetails,
  fold = true,
  draw: () => RawCopy["_id"] = optimisticId,
) {
  if (!place) return;
  const homeId = (details.homeId ?? mainId(local)) as RawCopy["homeId"] | undefined;
  const next = { ...details, ...(homeId ? { homeId } : {}) };
  const into = fold ? cardRows(local, cardId).find((r) => foldsInto(r, next)) : undefined;
  const change: Change = { cardId, variantId: place.variantId, isVariation: place.isVariation, before: [], after: [] };
  if (into) {
    change.before = [into];
    change.after = [{ ...into, quantity: into.quantity + details.quantity }];
  } else {
    change.after = [
      {
        ...next,
        _id: draw(),
        cardId: cardId as RawCopy["cardId"],
        variantId: place.variantId as RawCopy["variantId"],
        setId: place.setId as RawCopy["setId"],
        homeId: homeId ?? ("" as RawCopy["homeId"]),
        lastUpdated: Date.now(),
      } as RawCopy,
    ];
  }
  applyChange(local, change);
}

function applyRemove(local: OptimisticLocalStore, copyId: string, known: KnownCopy | undefined) {
  const row = rowOf(local, copyId, known);
  if (!row || !known) return;
  applyChange(local, { cardId: known.cardId, variantId: known.variantId, isVariation: known.isVariation, before: [row], after: [] });
}

function applyRewrite(local: OptimisticLocalStore, copyId: string, known: KnownCopy | undefined, rewrite: (row: RawCopy) => RawCopy) {
  const row = rowOf(local, copyId, known);
  if (!row || !known) return;
  applyChange(local, {
    cardId: known.cardId,
    variantId: known.variantId,
    isVariation: known.isVariation,
    before: [row],
    after: [rewrite(row)],
  });
}

/** A move (or a placement: a move that stays home), splitting and folding as the server will. */
function applyMove(
  local: OptimisticLocalStore,
  copyId: string,
  known: KnownCopy | undefined,
  toHomeId: string | undefined,
  quantity: number | undefined,
  slot: number | undefined,
  draw: () => RawCopy["_id"] = optimisticId,
) {
  const source = rowOf(local, copyId, known);
  if (!source || !known) return;
  const moving = Math.min(source.quantity, Math.max(1, Math.floor(quantity ?? source.quantity)));
  const split = moving < source.quantity;
  const landed: RawCopy = { ...source, homeId: (toHomeId ?? source.homeId) as RawCopy["homeId"], quantity: moving };
  if (slot === undefined) delete landed.slot;
  else landed.slot = slot;
  const twin = cardRows(local, known.cardId).find((r) => r._id !== source._id && foldsInto(r, landed));
  const rest: RawCopy[] = split ? [{ ...source, quantity: source.quantity - moving }] : [];
  const change: Change = {
    cardId: known.cardId,
    variantId: known.variantId,
    isVariation: known.isVariation,
    before: twin ? [source, twin] : [source],
    after: twin
      ? [...rest, { ...twin, quantity: twin.quantity + moving }]
      : split
        ? [...rest, { ...landed, _id: draw() }]
        : [landed],
  };
  applyChange(local, change);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** What `create` hands back, read either way the server spells it. */
function createdId(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { containerId: string }).containerId;
}

function useConvexActions(): CollectionActions {
  // What each optimistic update needs beyond its args: the card's place
  // (adds) and the copy as the action saw it (everything else), recorded by
  // the action just before it calls the mutation.
  const cards = useRef(new Map<string, CardPlace>());
  const copies = useRef(new Map<string, KnownCopy>());
  // The Want List as the server last said, so an undo can put a moved want back.
  const wantsNow = useQuery(api.collectionWants.list, {});
  const wantsRef = useRef(wantsNow);
  useEffect(() => {
    wantsRef.current = wantsNow;
  }, [wantsNow]);

  const addHaveBase = useMutation(api.collection.addHave);
  const addHavesBase = useMutation(api.collection.addHaves);
  const addLineItemBase = useMutation(api.collection.addLineItem);
  const restoreCopyBase = useMutation(api.collection.restoreCopy);
  const updateCopyBase = useMutation(api.collection.updateCopy);
  const removeCopyBase = useMutation(api.collection.removeCopy);
  const removeCopiesBase = useMutation(api.collection.removeCopies);
  const moveCopyBase = useMutation(api.collection.moveCopy);
  const placeCopyBase = useMutation(api.collection.placeCopy);
  const setTradeBase = useMutation(api.collection.setTrade);
  const setWantBase = useMutation(api.collectionWants.set);
  const setBuilding = useMutation(api.collection.setBuilding);
  const createContainer = useMutation(api.collectionContainers.create);
  const updateContainerBase = useMutation(api.collectionContainers.update);
  const emptyContainer = useMutation(api.collectionContainers.empty);
  const removeContainerBase = useMutation(api.collectionContainers.remove);
  const setBoxQuantityBase = useMutation(api.collectionInventory.setBoxQuantity);
  const undoBoxQuantityBase = useMutation(api.collectionInventory.undoBoxQuantity);

  // `withOptimisticUpdate` hands back a new function each call: build them
  // once per mutation so the actions object stays put across renders.
  const m = useMemo(() => {
    const drawing = {
      addHave: addHaveBase.withOptimisticUpdate((local, args) =>
        applyAdd(
          local,
          args.cardId,
          cards.current.get(args.cardId),
          {
            quantity: 1,
            ...(args.acquiredOn ? { acquiredOn: args.acquiredOn } : {}),
            ...(args.homeId ? { homeId: args.homeId } : {}),
          },
          true,
          () => optimisticIdFor(args),
        ),
      ),
      addHaves: addHavesBase.withOptimisticUpdate((local, args) => {
        args.cardIds.forEach((cardId, i) =>
          applyAdd(
            local,
            cardId,
            cards.current.get(cardId),
            {
              quantity: 1,
              ...(args.acquiredOn ? { acquiredOn: args.acquiredOn } : {}),
              ...(args.homeId ? { homeId: args.homeId } : {}),
            },
            true,
            () => optimisticIdFor(args, i),
          ),
        );
      }),
      addLineItem: addLineItemBase.withOptimisticUpdate((local, args) =>
        applyAdd(local, args.cardId, cards.current.get(args.cardId), args.details, true, () => optimisticIdFor(args)),
      ),
      restoreCopy: restoreCopyBase.withOptimisticUpdate((local, args) =>
        applyAdd(local, args.cardId, cards.current.get(args.cardId), args.details, false, () => optimisticIdFor(args)),
      ),
      updateCopy: updateCopyBase.withOptimisticUpdate((local, args) =>
        applyRewrite(local, args.copyId, copies.current.get(args.copyId), (r) => ({
          _id: r._id,
          cardId: r.cardId,
          variantId: r.variantId,
          setId: r.setId,
          lastUpdated: Date.now(),
          ...args.details,
          homeId: args.details.homeId ?? r.homeId,
        }) as RawCopy),
      ),
      removeCopy: removeCopyBase.withOptimisticUpdate((local, args) =>
        applyRemove(local, args.copyId, copies.current.get(args.copyId)),
      ),
      removeCopies: removeCopiesBase.withOptimisticUpdate((local, args) => {
        for (const copyId of args.copyIds) applyRemove(local, copyId, copies.current.get(copyId));
      }),
      moveCopy: moveCopyBase.withOptimisticUpdate((local, args) =>
        applyMove(local, args.copyId, copies.current.get(args.copyId), args.toHomeId, args.quantity, args.slot, () =>
          optimisticIdFor(args),
        ),
      ),
      placeCopy: placeCopyBase.withOptimisticUpdate((local, args) =>
        applyMove(local, args.copyId, copies.current.get(args.copyId), undefined, undefined, args.slot ?? undefined, () =>
          optimisticIdFor(args),
        ),
      ),
      setTrade: setTradeBase.withOptimisticUpdate((local, args) =>
        applyRewrite(local, args.copyId, copies.current.get(args.copyId), (r) => {
          const next = { ...r };
          if (args.on) next.upForTrade = true;
          else delete next.upForTrade;
          return next;
        }),
      ),
      setWant: setWantBase.withOptimisticUpdate((local, args) => {
        const list = local.getQuery(api.collectionWants.list, {});
        if (!list) return;
        const had = list.find((w) => w.cardId === args.cardId);
        let next = list;
        if (!args.on) next = list.filter((w) => w.cardId !== args.cardId);
        else if (had) next = list.map((w) => (w.cardId === args.cardId ? { ...w, binderId: args.binderId } : w));
        else next = [...list, { cardId: args.cardId, ...(args.binderId ? { binderId: args.binderId } : {}) } as RawWant];
        local.setQuery(api.collectionWants.list, {}, next);
        const delta = next.length - list.length;
        const shelf = local.getQuery(api.collectionContainers.list, {});
        if (delta !== 0 && shelf) {
          local.setQuery(
            api.collectionContainers.list,
            {},
            shelf.map((c) =>
              c.system === "want" && c.count
                ? { ...c, count: { copies: Math.max(0, c.count.copies + delta), lines: Math.max(0, c.count.lines + delta) } }
                : c,
            ),
          );
        }
      }),
      updateContainer: updateContainerBase.withOptimisticUpdate((local, args) => {
        const shelf = local.getQuery(api.collectionContainers.list, {});
        if (!shelf) return;
        local.setQuery(
          api.collectionContainers.list,
          {},
          shelf.map((c) => {
            if (c._id !== args.containerId) return c;
            const next = { ...c };
            if (args.name !== undefined) next.name = args.name.trim();
            if (args.description !== undefined) {
              if (args.description.trim()) next.description = args.description.trim();
              else delete next.description;
            }
            if (args.label !== undefined) {
              if (args.label) next.label = args.label;
              else delete next.label;
            }
            return next;
          }),
        );
      }),
      removeContainer: removeContainerBase.withOptimisticUpdate((local, args) => {
        const shelf = local.getQuery(api.collectionContainers.list, {});
        if (shelf) local.setQuery(api.collectionContainers.list, {}, shelf.filter((c) => c._id !== args.containerId));
      }),
      setBoxQuantity: setBoxQuantityBase.withOptimisticUpdate((local, args) =>
        applyBoxQuantity(
          local,
          args.cardId,
          args.boxId,
          args.quantity,
          args.acquiredOn ?? todayIso(),
          cards.current.get(args.cardId),
          () => optimisticIdFor(args),
        ),
      ),
      undoBoxQuantity: undoBoxQuantityBase.withOptimisticUpdate((local, args) =>
        applyBoxSteps(local, args.inverse, cards.current.get(args.inverse.cardId), (n) => optimisticIdFor(args, n)),
      ),
    };
    // The writes whose optimistic update can draw a line: each placeholder
    // learns its real id from the answer (`landedCopy`).
    return {
      ...drawing,
      addHave: landsAs(drawing.addHave, (r) => r.copyId),
      addHaves: landsAs(drawing.addHaves, (r, n, args) =>
        r[n]?.cardId === args.cardIds[n] ? r[n].copyId : r.find((x) => x.cardId === args.cardIds[n])?.copyId,
      ),
      addLineItem: landsAs(drawing.addLineItem, (r) => r.copyId),
      restoreCopy: landsAs(drawing.restoreCopy, (r) => r.copyId),
      // A split's drawn line is the part that moved: the line the server says the cards are now.
      moveCopy: landsAs(drawing.moveCopy, (r) => r.copyId),
      placeCopy: landsAs(drawing.placeCopy, (r) => r.copyId),
      // A raise draws at most one line; its undo step names the line the server wrote.
      setBoxQuantity: landsAs(drawing.setBoxQuantity, (r) => {
        for (const step of r.inverse.steps) if (step.op !== "restore") return step.copyId;
        return undefined;
      }),
      // The redo is the undo's steps reversed: step n's line is named at the mirror place.
      undoBoxQuantity: landsAs(drawing.undoBoxQuantity, (r, n) => {
        const step = r.inverse.steps[r.inverse.steps.length - 1 - n];
        return step && step.op !== "restore" ? step.copyId : undefined;
      }),
    };
  }, [
    addHaveBase,
    addHavesBase,
    addLineItemBase,
    restoreCopyBase,
    updateCopyBase,
    removeCopyBase,
    removeCopiesBase,
    moveCopyBase,
    placeCopyBase,
    setTradeBase,
    setWantBase,
    updateContainerBase,
    removeContainerBase,
    setBoxQuantityBase,
    undoBoxQuantityBase,
  ]);

  return useMemo<CollectionActions>(() => {
    const placeCard = (card: Card) => {
      cards.current.set(card.id, { variantId: card.variant.id, setId: card.set.id, isVariation: card.isVariation });
    };
    /** Records a copy for the optimistic updates of the write about to run. */
    const know = (copy: Copy) => {
      copies.current.set(copy.id, {
        cardId: copy.cardId,
        variantId: copy.variantId,
        setId: copy.setId,
        isVariation: cards.current.get(copy.cardId)?.isVariation ?? false,
        row: toRawCopy(copy),
      });
    };
    /** Records a row the server just made or changed, from the copy it came from. */
    const knowAs = (copy: Copy, id: string, patch: Partial<Copy>) => know({ ...copy, ...patch, id });
    const asCard = (id: string) => id as RawCopy["cardId"];
    const asCopy = (id: string) => id as RawCopy["_id"];
    const asHome = (id: string) => id as RawCopy["homeId"];

    /** The undo of an add: back to the folded row's details, or gone. */
    const undoAdd =
      (card: Card, homeId: string | undefined, result: { copyId: RawCopy["_id"]; merged: boolean; previous?: RawDetails }) =>
      async () => {
        const seed: Copy = {
          ...emptyDetails(),
          id: result.copyId,
          cardId: card.id,
          variantId: card.variant.id,
          setId: card.set.id,
          homeId: homeId ?? "",
          homeKind: "binder",
          upForTrade: false,
        };
        know(seed);
        if (result.merged && result.previous) await m.updateCopy({ copyId: result.copyId, details: result.previous });
        else await m.removeCopy({ copyId: result.copyId });
      };

    /** The undo of a move or a placement: the same cards back where they were. */
    const undoMove = (copy: Copy, toHomeId: string, slot: number | undefined, r: RawMove) => async () => {
      knowAs(copy, r.copyId, { homeId: toHomeId, quantity: r.from.quantity, slot });
      await m.moveCopy({
        copyId: r.copyId,
        toHomeId: r.from.homeId,
        quantity: r.from.quantity,
        ...(r.from.slot !== undefined ? { slot: r.from.slot } : {}),
      });
    };

    return {
      async addHave(card, homeId) {
        placeCard(card);
        const result = await m.addHave({
          cardId: asCard(card.id),
          acquiredOn: todayIso(),
          ...(homeId ? { homeId: asHome(homeId) } : {}),
        });
        return { copyId: result.copyId, merged: result.merged, undo: undoAdd(card, homeId, result) };
      },

      async addMany(list, homeId) {
        list.forEach(placeCard);
        const byId = new Map(list.map((c) => [c.id, c]));
        const results = await m.addHaves({
          cardIds: list.map((c) => asCard(c.id)),
          acquiredOn: todayIso(),
          ...(homeId ? { homeId: asHome(homeId) } : {}),
        });
        return {
          copyIds: results.map((r) => r.copyId),
          undo: async () => {
            const inserted = results.filter((r) => !r.merged);
            for (const r of results) {
              const card = byId.get(r.cardId);
              if (card) {
                know({
                  ...emptyDetails(),
                  id: r.copyId,
                  cardId: card.id,
                  variantId: card.variant.id,
                  setId: card.set.id,
                  homeId: homeId ?? "",
                  homeKind: "binder",
                  upForTrade: false,
                });
              }
            }
            for (const part of chunk(inserted, REMOVE_BATCH)) {
              await m.removeCopies({ copyIds: part.map((r) => r.copyId) });
            }
            for (const r of results) {
              if (r.merged && r.previous) await m.updateCopy({ copyId: r.copyId, details: r.previous });
            }
          },
        };
      },

      async addLineItem(card, details) {
        placeCard(card);
        const result = await m.addLineItem({ cardId: asCard(card.id), details: toRawDetails(details) });
        return { copyId: result.copyId, merged: result.merged, undo: undoAdd(card, details.homeId, result) };
      },

      async updateCopy(drawn, patch) {
        if (patch.homeId !== undefined && patch.homeId !== drawn.homeId) {
          throw new Error("Move the card to change where it lives.");
        }
        const copy = isOptimisticId(drawn.id) ? await landedCopy(drawn) : drawn;
        know(copy);
        const merged: CopyDetails = { ...copy, ...patch };
        const { previous } = await m.updateCopy({ copyId: asCopy(copy.id), details: toRawDetails(merged, copy.homeId) });
        return {
          undo: async () => {
            know({ ...copy, ...patch });
            await m.updateCopy({ copyId: asCopy(copy.id), details: previous });
          },
        };
      },

      async removeCopy(drawn) {
        const copy = isOptimisticId(drawn.id) ? await landedCopy(drawn) : drawn;
        know(copy);
        const { removed } = await m.removeCopy({ copyId: asCopy(copy.id) });
        return {
          removed: copy,
          undo: async () => {
            cards.current.set(copy.cardId, {
              variantId: copy.variantId,
              setId: copy.setId,
              isVariation: cards.current.get(copy.cardId)?.isVariation ?? false,
            });
            await m.restoreCopy({ cardId: removed.cardId, details: removed.details });
          },
        };
      },

      async restoreCopy(copy) {
        cards.current.set(copy.cardId, {
          variantId: copy.variantId,
          setId: copy.setId,
          isVariation: cards.current.get(copy.cardId)?.isVariation ?? false,
        });
        const { copyId } = await m.restoreCopy({ cardId: asCard(copy.cardId), details: toRawDetails(copy, copy.homeId) });
        return {
          copyId,
          merged: false,
          undo: async () => {
            know({ ...copy, id: copyId });
            await m.removeCopy({ copyId });
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

      async moveCopy(drawn, toHomeId, options) {
        const copy = isOptimisticId(drawn.id) ? await landedCopy(drawn) : drawn;
        know(copy);
        const r = await m.moveCopy({
          copyId: asCopy(copy.id),
          toHomeId: asHome(toHomeId),
          ...(options?.quantity !== undefined ? { quantity: options.quantity } : {}),
          ...(options?.slot !== undefined ? { slot: options.slot } : {}),
        });
        return { copyId: r.copyId, folded: r.folded, split: r.split, undo: undoMove(copy, toHomeId, options?.slot, r) };
      },

      async placeCopy(drawn, slot) {
        const copy = isOptimisticId(drawn.id) ? await landedCopy(drawn) : drawn;
        know(copy);
        const r = await m.placeCopy({ copyId: asCopy(copy.id), slot });
        return {
          copyId: r.copyId,
          folded: r.folded,
          split: r.split,
          undo: undoMove(copy, copy.homeId, slot ?? undefined, r),
        };
      },

      async setTrade(drawn, on) {
        const copy = isOptimisticId(drawn.id) ? await landedCopy(drawn) : drawn;
        know(copy);
        const { previous } = await m.setTrade({ copyId: asCopy(copy.id), on });
        return {
          undo: async () => {
            know({ ...copy, upForTrade: on });
            await m.setTrade({ copyId: asCopy(copy.id), on: previous });
          },
        };
      },

      async setWant(cardId, binderId, on) {
        const before = wantsRef.current?.find((w) => w.cardId === cardId);
        const { changed } = await m.setWant({
          cardId: asCard(cardId),
          on,
          ...(binderId ? { binderId: asHome(binderId) } : {}),
        });
        return {
          changed,
          undo: async () => {
            if (!changed) return;
            if (before) {
              await m.setWant({ cardId: asCard(cardId), on: true, ...(before.binderId ? { binderId: before.binderId } : {}) });
            } else {
              await m.setWant({ cardId: asCard(cardId), on: false });
            }
          },
        };
      },

      async createContainer(input) {
        // The server refuses a rule until NEO-362; the view hides smart binders meanwhile.
        if (input.rule) throw new Error("Smart binders aren't here yet. Make a regular binder for now.");
        const result = await createContainer({
          kind: input.kind,
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          ...(input.label ? { label: input.label } : {}),
        });
        const containerId = createdId(result);
        return {
          containerId,
          undo: async () => {
            await m.removeContainer({ containerId: asHome(containerId) });
          },
        };
      },

      async updateContainer(container, patch) {
        const back: ContainerPatch = {};
        if (patch.name !== undefined) back.name = container.name;
        if (patch.description !== undefined) back.description = container.description ?? "";
        if (patch.label !== undefined) back.label = container.label ?? null;
        const send = (p: ContainerPatch) =>
          m.updateContainer({
            containerId: asHome(container.id),
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.description !== undefined ? { description: p.description } : {}),
            ...(p.label !== undefined ? { label: p.label } : {}),
          });
        await send(patch);
        return {
          undo: async () => {
            await send(back);
          },
        };
      },

      async deleteContainer(container) {
        // A binder's copies go back to Main, a box's into Unsorted (the server's `empty`).
        const to = container.kind === "box" ? "Unsorted" : "Main";
        let moved = 0;
        for (let round = 0; ; round++) {
          if (round >= MAX_EMPTY_ROUNDS) {
            throw new Error(`Moved ${moved.toLocaleString("en-US")} cards to ${to} so far. Press Delete again to finish.`);
          }
          const r = await emptyContainer({ containerId: asHome(container.id) });
          moved += r.moved;
          if (r.remaining === 0) break;
        }
        await m.removeContainer({ containerId: asHome(container.id) });
        return { moved };
      },

      async setBoxQuantity(card, box, quantity) {
        // The server's words, before anything is drawn.
        if (box.kind !== "box") throw new Error("Quick counts go in a box. Pick a box to count into.");
        if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_LINE_QUANTITY) {
          throw new Error(`Quantity is a whole number from 0 to ${MAX_LINE_QUANTITY}.`);
        }
        placeCard(card);
        const r = await m.setBoxQuantity({
          cardId: asCard(card.id),
          boxId: asHome(box.id),
          quantity,
          acquiredOn: todayIso(),
        });
        return {
          before: r.before,
          after: r.after,
          undo: async () => {
            // The same number wrote nothing, so there is nothing to put back.
            if (r.inverse.steps.length === 0) return;
            placeCard(card);
            await m.undoBoxQuantity({ inverse: r.inverse });
          },
        };
      },
    };
  }, [m, setBuilding, createContainer, emptyContainer]);
}

/** Blank details for a copy the undo only needs to name. */
function emptyDetails(): CopyDetails {
  return { quantity: 1, acquiredAt: "", notes: "" };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Mounts the Convex store. Inside the signed-in shell only (every read needs a collector). */
export function ConvexCollectionProvider({ children }: { children: ReactNode }) {
  const actions = useConvexActions();
  // Main, Unsorted, the Want List and Up for Trade exist for every collector
  // who has a shelf: make them once per mount (idempotent on the server). A refusal
  // here shows up again on the first real write, with its words.
  const ensureSystem = useMutation(api.collectionContainers.ensureSystem);
  const ensured = useRef(false);
  useEffect(() => {
    if (ensured.current || !REAL_CAPABILITIES.binders) return;
    ensured.current = true;
    void Promise.resolve(ensureSystem({})).catch(() => undefined);
  }, [ensureSystem]);
  const value = useMemo<CollectionStoreValue>(
    () => ({ kind: "convex", capabilities: REAL_CAPABILITIES, data: CONVEX_DATA, actions }),
    [actions],
  );
  return createElement(CollectionStoreContext.Provider, { value }, children);
}

/** Exported for unit tests. */
export const __test = {
  toVariantRef,
  toCard,
  toCopy,
  toContainer,
  toWant,
  toRawDetails,
  fromRawDetails,
  toDrillItem,
  foldsInto,
  patchRows,
  applyChange,
  applyMove,
  applyAdd,
  applyBoxQuantity,
  applyBoxSteps,
  isPlainRow,
  patchInventory,
  optimisticIdFor,
};
