/**
 * NEO-358 — the demo store: the collection contract (`./store`) over the
 * hard-coded fixture catalog and the demo reducer (`../store`,
 * `useDemoCollectionState`). Every capability is on.
 *
 * Fake data only: it never imports Convex or Clerk, so the public demo on
 * `/binder-tracking` runs with neither. Reads are synchronous (never
 * `undefined` once a valid input is passed). Writes resolve at once and hand
 * back the same undo the demo always had.
 *
 * Ids are the fixture's slugs. A checklist (variant) id is
 * `<setId>|<Base|Inserts|Parallels>|<name>` (see `demoVariantId`); the drill
 * ids keep the demo's URL scheme (`year=2024`, `type=Base`,
 * `variant=Gold+Refractor`), so a shared demo link from before NEO-358 still
 * opens the same view.
 *
 * The scope (`useScope`, from the page URL) applies here as on Convex: with
 * a binder picked, `useCopiesInVariant` and `useVariantCompletion` count
 * only that home, while `useCopiesOf` lists every copy (the drawer shows
 * each with its home). The drill counts nothing (NEO-364).
 *
 * NEO-359: every collection read sees only the copies whose home is not a
 * box (`collectionOf`, the store's `inCollection` rule); `useCopiesOf`,
 * `useCopiesOfCards` and a box's own `useContainerCopies` list them all, and
 * the Up for Trade pile (`tradeOf`) keeps every flagged copy, a box's too.
 *
 * NEO-364: the side-aware reads (`useCopiesInVariant`, `useVariantCompletion`,
 * `useSetCompletion`) read one
 * side: binder homes for the collection (`collectionOf`), box homes for the
 * inventory (`inventoryOf`). A scope on the other side reads as empty.
 * `useInventoryCards` lists the box copies card by card; `setBoxQuantity`
 * runs the reducer's `demoOps.setBoxQuantity` (plain lines only) and undoes
 * with `demoOps.restoreLines`.
 *
 * Writes go through the reducer's pure ops (`../store` `demoOps`), so a
 * refusal (a taken pocket, the Want List as a home) rejects with the same
 * kind of words the server sends.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resizeCopyPhoto } from "@/lib/collection/copy-photo-resize";
import { CardImagesProvider } from "./cardImages";
import {
  brands,
  cards as fixtureCards,
  cardsInSet,
  describeRule as describeFixtureRule,
  evaluateRule,
  getBrand,
  getPlayer,
  getSport,
  getTeam,
  players as fixturePlayers,
  searchCards,
  sets as fixtureSets,
  setsInOrder,
  teams as fixtureTeams,
  type Card as FixtureCard,
  type CardSet as FixtureSet,
  type VariantFilter,
  type VariantPath,
  type VariantType,
} from "../../prototypes/_shared/data";
import {
  brandItems,
  setItems,
  sportItems,
  variantItems,
  variantTypeItems,
  yearItems,
  type ColumnItem,
} from "../../prototypes/p1/drill";
import {
  demoOps,
  DemoRefusal,
  fixtureRule,
  PUBLIC_STORAGE_KEY,
  useDemoCollectionState,
  type CollectionState,
  type CollectionStore as DemoState,
  type DemoContainer,
  type DemoCopy,
} from "../store";
import { compareCards, setLabel } from "./labels";
import {
  bySlot,
  CollectionStoreContext,
  completionOf,
  CONTAINER_COPIES_DEFAULT_LIMIT,
  emptyCopyDetails,
  inCollection,
  inInventory,
  OWNED_CARDS_DEFAULT_LIMIT,
  searchable,
  SET_CARDS_DEFAULT_LIMIT,
  todayIso,
  useScope,
  useSide,
  type CollectionActions,
  type CollectionData,
  type CollectionStoreValue,
  type CopyPhotosExtension,
  type DemoExtension,
} from "./store";
import {
  ALL_CAPABILITIES,
  DEFAULT_CONDITION,
  isHome,
  type BinderNeeds,
  type Card,
  type CardFeature,
  type CardId,
  type CardTeam,
  type Completion,
  type Container,
  type ContainerCopies,
  type Copy,
  type CopyId,
  type CopyPhotos,
  type PhotoSide,
  type PhotoUrls,
  type DeclinedCard,
  type DrillItem,
  type FoundCards,
  type HeldCount,
  type InventoryBoxCount,
  type InventoryCards,
  type InventoryItem,
  type OwnedCards,
  type RuleBrand,
  type DrillLevel,
  type DrillParents,
  type SetCompletion,
  type SetPath,
  type SetRef,
  type SetSummary,
  type Suggestion,
  type Variant,
  type VariantId,
  type VariantKind,
  type VariantRef,
  type Scope,
  type Side,
} from "./types";

export { PUBLIC_STORAGE_KEY };

// ---------------------------------------------------------------------------
// Hydrating the fixture catalog (static, so built once and cached)
// ---------------------------------------------------------------------------

const KIND_OF: Record<VariantType, VariantKind> = { Base: "base", Inserts: "insert", Parallels: "parallel" };

/** The demo's checklist id: `<setId>|<type>|<name>` (name blank for Base). */
export function demoVariantId(setId: string, path: VariantPath): VariantId {
  return `${setId}|${path.type}|${path.type === "Base" ? "" : (path.name ?? "")}`;
}

/** The set and filter a demo checklist id names, or null for one that is not the demo's. */
export function parseDemoVariantId(id: string): { setId: string; filter: VariantFilter } | null {
  const [setId, type, ...rest] = id.split("|");
  if (!setId || !(type === "Base" || type === "Inserts" || type === "Parallels")) return null;
  const name = rest.join("|");
  return { setId, filter: type === "Base" ? { type, name: null } : { type, name } };
}

interface DemoIndex {
  setRefs: Map<string, SetRef>;
  variants: Map<VariantId, Variant>;
  /** Each checklist's cards, in checklist order. */
  variantCards: Map<VariantId, Card[]>;
  cards: Map<CardId, Card>;
}

let index: DemoIndex | null = null;

function featuresOf(card: FixtureCard): CardFeature[] {
  return [...card.features];
}

function buildIndex(): DemoIndex {
  const setRefs = new Map<string, SetRef>();
  const variants = new Map<VariantId, Variant>();
  const variantCards = new Map<VariantId, Card[]>();
  const cards = new Map<CardId, Card>();

  for (const set of fixtureSets) {
    const ref: SetRef = {
      id: set.id,
      name: set.name,
      season: set.season,
      year: set.year,
      brand: { id: set.brandId, name: getBrand(set.brandId).name },
      sport: { id: set.sportId, name: getSport(set.sportId).name },
    };
    setRefs.set(set.id, ref);
    set.variants.forEach((sv, order) => {
      const id = demoVariantId(set.id, sv.path);
      const kind = KIND_OF[sv.path.type];
      const vref: VariantRef = {
        id,
        kind,
        name: kind === "base" ? null : sv.path.name,
        insertName: null,
        printRun: sv.printRun,
        order,
        path: {
          typeId: sv.path.type,
          variantId: kind === "base" ? null : sv.path.name,
          subVariantId: null,
        },
        // The fixture draws its own finishes; keep them, so the demo looks as it always has.
        finish: sv.finish,
      };
      const list = cardsInSet(set.id, sv.path.type === "Base" ? { type: "Base" } : { type: sv.path.type, name: sv.path.name });
      const hydrated = list.map(
        (c, sortOrder): Card => ({
          id: c.id,
          set: ref,
          variant: vref,
          cardNumber: c.cardNumber,
          players: c.playerIds.map((pid) => {
            const p = getPlayer(pid);
            return { id: p.id, name: p.name };
          }),
          teams: c.teamIds.map((tid) => {
            const t = getTeam(tid);
            return { id: t.id, name: t.name, location: t.location, primary: t.primary, secondary: t.secondary };
          }),
          printRun: c.printRun,
          features: featuresOf(c),
          cardVariation: c.variation,
          isVariation: c.variation !== null,
          sortOrder,
          finish: c.finish,
        }),
      );
      for (const card of hydrated) cards.set(card.id, card);
      variantCards.set(id, hydrated);
      const baseCardCount = hydrated.filter((c) => !c.isVariation).length;
      variants.set(id, { ...vref, cardCount: hydrated.length, baseCardCount });
    });
  }
  return { setRefs, variants, variantCards, cards };
}

function demoIndex(): DemoIndex {
  index ??= buildIndex();
  return index;
}

/** A fixture card as the view model, or null for an id the fixture does not hold. */
export function demoCard(id: CardId): Card | null {
  return demoIndex().cards.get(id) ?? null;
}

function fixtureSet(id: string): FixtureSet | undefined {
  return fixtureSets.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Copies: the reducer's copy <-> the view model's
// ---------------------------------------------------------------------------

/** View copies keyed on the reducer's (immutable) copy objects, per container list. */
const copyCache = new WeakMap<DemoContainer[], WeakMap<DemoCopy, Copy | null>>();

function toViewCopy(copy: DemoCopy, containers: DemoContainer[]): Copy | null {
  let byCopy = copyCache.get(containers);
  if (!byCopy) {
    byCopy = new WeakMap();
    copyCache.set(containers, byCopy);
  }
  const cached = byCopy.get(copy);
  if (cached !== undefined) return cached;
  const card = demoCard(copy.cardId);
  const home = containers.find((c) => c.id === copy.homeId);
  const view: Copy | null = card
    ? {
        ...copy,
        variantId: card.variant.id,
        setId: card.set.id,
        homeKind: home?.kind ?? "binder",
        ...(home ? { homeName: home.name } : {}),
        upForTrade: !!copy.upForTrade,
      }
    : null;
  byCopy.set(copy, view);
  return view;
}

function toViewCopies(copies: readonly DemoCopy[], containers: DemoContainer[]): Copy[] {
  return copies.map((c) => toViewCopy(c, containers)).filter((c): c is Copy => c !== null);
}

/** A view copy as the reducer stores it. */
function toDemoCopy(copy: Copy): DemoCopy {
  const { variantId: _v, setId: _s, homeName: _n, homeKind: _k, ...stored } = copy;
  return stored;
}

/** The collection's copies, per reducer state (`inCollection`, NEO-359). */
const collectionCache = new WeakMap<CollectionState, DemoCopy[]>();

/**
 * The copies the collection's screens see: every one whose home is not a
 * box (a copy in a box is for sale, Inventory's; see `inCollection`).
 */
function collectionOf(state: CollectionState): DemoCopy[] {
  const cached = collectionCache.get(state);
  if (cached) return cached;
  const kinds = new Map(state.containers.map((c) => [c.id, c.kind]));
  const kept = state.copies.filter((c) => inCollection({ homeKind: kinds.get(c.homeId) ?? "binder" }));
  collectionCache.set(state, kept);
  return kept;
}

/** The inventory's copies, per reducer state (`inInventory`, NEO-364). */
const inventoryCache = new WeakMap<CollectionState, DemoCopy[]>();

/** The copies the inventory's screens see: every one whose home is a box (Unsorted included). */
function inventoryOf(state: CollectionState): DemoCopy[] {
  const cached = inventoryCache.get(state);
  if (cached) return cached;
  const kinds = new Map(state.containers.map((c) => [c.id, c.kind]));
  const kept = state.copies.filter((c) => inInventory({ homeKind: kinds.get(c.homeId) ?? "binder" }));
  inventoryCache.set(state, kept);
  return kept;
}

/** One side's copies: the collection's binders or the inventory's boxes. */
function sideOf(state: CollectionState, side: Side): DemoCopy[] {
  return side === "inventory" ? inventoryOf(state) : collectionOf(state);
}

/**
 * The Up for Trade pile: every flagged copy, wherever it lives. Trade spans
 * collection and inventory, so a box copy stays (the one collection view
 * that keeps it; see `inCollection`).
 */
function tradeOf(state: CollectionState): DemoCopy[] {
  return state.copies.filter((c) => c.upForTrade);
}

/**
 * One side's copies a scope looks through: one home's, or all of them. A
 * home on the other side reads as empty (NEO-364: a box scope never shows a
 * collection copy, nor a binder scope an inventory one).
 */
function inScope(state: CollectionState, scope: Scope, side: Side): DemoCopy[] {
  const copies = sideOf(state, side);
  if (scope === "all") return copies;
  const home = state.containers.find((c) => c.id === scope);
  if (!isHome(home)) return copies;
  if ((home!.kind === "box") !== (side === "inventory")) return [];
  return copies.filter((c) => c.homeId === scope);
}

/** The copies a container lists (see `useContainerCopies`), in slot order. */
function containerCopies(state: CollectionState, id: string): DemoCopy[] {
  const container = state.containers.find((c) => c.id === id);
  if (!container || container.system === "want") return [];
  // The trade pile spans collection and inventory: every flagged copy, a box's too.
  if (container.system === "trade") return tradeOf(state);
  // A smart binder is the collection's: never a copy in a box.
  if (container.rule) {
    const rule = fixtureRule(container.rule);
    return collectionOf(state).filter((c) => {
      const card = fixtureCards.find((f) => f.id === c.cardId);
      return !!card && evaluateRule(rule, card);
    });
  }
  return bySlot(state.copies.filter((c) => c.homeId === id));
}

/**
 * When a demo line was last touched, as `lastUpdated` ms: its date, plus its
 * place in the list as a tiebreak (the reducer appends each new line), so a
 * line added today sorts after one added earlier today.
 */
function touchedAt(copy: DemoCopy, index: number): number {
  const day = Date.parse(copy.acquiredAt);
  return (Number.isFinite(day) ? day : 0) + index;
}

/**
 * The Inventory list (`useInventoryCards`): every card held in a box, one
 * item per card (its box lines together), most recently touched first;
 * `boxId` narrows to one box. Never a binder copy.
 */
function inventoryCardsOf(state: CollectionState, limit: number, boxId: string | undefined): InventoryCards {
  const index = new Map(state.copies.map((c, i) => [c.id, i]));
  // The shelf is sorted system first, so Unsorted leads the collector's boxes.
  const order = new Map(state.containers.map((c, i) => [c.id, i]));
  const held = new Map<string, Omit<InventoryItem, "card">>();
  for (const copy of inventoryOf(state)) {
    if (copy.quantity <= 0 || (boxId !== undefined && copy.homeId !== boxId)) continue;
    const at = touchedAt(copy, index.get(copy.id) ?? 0);
    const item = held.get(copy.cardId) ?? {
      quantity: 0,
      lines: 0,
      graded: false,
      gradedQuantity: 0,
      upForTrade: false,
      lastUpdated: 0,
      boxes: [] as InventoryBoxCount[],
    };
    const slabs = copy.graded ? copy.quantity : 0;
    item.quantity += copy.quantity;
    item.lines += 1;
    item.gradedQuantity += slabs;
    if (copy.graded) item.graded = true;
    if (copy.upForTrade) item.upForTrade = true;
    item.lastUpdated = Math.max(item.lastUpdated, at);
    const box = item.boxes.find((b) => b.boxId === copy.homeId);
    if (box) {
      box.quantity += copy.quantity;
      box.gradedQuantity += slabs;
    } else item.boxes.push({ boxId: copy.homeId, quantity: copy.quantity, gradedQuantity: slabs });
    held.set(copy.cardId, item);
  }
  const ranked = [...held.entries()].sort(([, a], [, b]) => b.lastUpdated - a.lastUpdated);
  const items: InventoryItem[] = [];
  const goneCardIds: string[] = [];
  for (const [id, item] of ranked.slice(0, limit)) {
    const card = demoCard(id);
    if (!card) {
      goneCardIds.push(id);
      continue;
    }
    // Unsorted first, then the shelf's order.
    item.boxes.sort((a, b) => (order.get(a.boxId) ?? 0) - (order.get(b.boxId) ?? 0));
    items.push({ card, ...item });
  }
  return { items, goneCardIds, truncated: ranked.length > limit };
}

function countOf(copies: readonly DemoCopy[]) {
  return { copies: copies.reduce((n, c) => n + c.quantity, 0), lines: copies.length };
}

function containersOf(state: CollectionState): Container[] {
  return state.containers.map((c) => ({
    ...c,
    count:
      c.system === "want"
        ? { copies: state.wants.length, lines: state.wants.length }
        : countOf(containerCopies(state, c.id)),
  }));
}

function page(copies: DemoCopy[], containers: DemoContainer[], limit: number | undefined): ContainerCopies {
  const n = Math.max(1, Math.floor(limit ?? CONTAINER_COPIES_DEFAULT_LIMIT));
  return { copies: toViewCopies(copies.slice(0, n), containers), truncated: copies.length > n };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const DemoStateContext = createContext<DemoState | null>(null);

function useDemoState(): DemoState {
  const state = useContext(DemoStateContext);
  if (!state) throw new Error("demo collection store: outside DemoCollectionProvider");
  return state;
}

function completionIn(variantId: VariantId, copies: readonly DemoCopy[]): Completion | undefined {
  const list = demoIndex().variantCards.get(variantId);
  if (!list) return undefined;
  const owned = new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId));
  const base = list.filter((c) => !c.isVariation);
  return completionOf(
    { owned: base.filter((c) => owned.has(c.id)).length, total: base.length },
    { owned: list.filter((c) => owned.has(c.id)).length, total: list.length },
  );
}

function countsOf(variantId: VariantId): Pick<DrillItem, "cardCount" | "baseCardCount"> {
  const v = demoIndex().variants.get(variantId);
  return { cardCount: v?.cardCount ?? null, baseCardCount: v?.baseCardCount ?? null };
}

/**
 * NEO-364 (Jason, 2026-10-25): the drill shows names only, no counts and no
 * "has cards" marker, on every level, the same as the real catalog. The
 * prototype's lines ("Have 2 of 30 base", "300 cards", "3 inserts") are
 * dropped; a parallel keeps its print run ("/50"), which is not a count.
 */
function drillItem(level: DrillLevel, item: ColumnItem, extra: Partial<DrillItem> = {}): DrillItem {
  return { id: item.id, level, name: item.name, hasChildren: true, ...extra };
}

/** "/50", "1/1", or nothing: a parallel's print run, the one line the drill keeps. */
function printRunOf(set: FixtureSet, type: VariantType, name: string): string | undefined {
  const run = set.variants.find((v) => v.path.type === type && v.path.name === name)?.printRun ?? null;
  if (run === null) return undefined;
  return run === 1 ? "1/1" : `/${run}`;
}

/** The prototype's set rows want a completion; the drill shows none of it. */
const NO_COMPLETION = () => ({ total: 0, owned: 0, percent: 0, missing: [] as FixtureCard[] });

function drillColumn(level: DrillLevel, parents: DrillParents): DrillItem[] {
  switch (level) {
    case "sport":
      return sportItems().map((i) => drillItem(level, i));
    case "year":
      return parents.sport ? yearItems(parents.sport as FixtureSet["sportId"]).map((i) => drillItem(level, i)) : [];
    case "brand": {
      if (!parents.sport || !parents.year) return [];
      return brandItems(parents.sport as FixtureSet["sportId"], Number(parents.year)).map((i) => drillItem(level, i));
    }
    case "set": {
      if (!parents.sport || !parents.year || !parents.brand) return [];
      return setItems(parents.sport as FixtureSet["sportId"], Number(parents.year), parents.brand, NO_COMPLETION).map(
        (i) => drillItem(level, i),
      );
    }
    case "variantType": {
      const set = parents.set ? fixtureSet(parents.set) : undefined;
      if (!set) return [];
      return variantTypeItems(set).map((i) => {
        const type = i.id as VariantType;
        const kind = KIND_OF[type];
        if (type !== "Base") return drillItem(level, i, { kind });
        const variantId = demoVariantId(set.id, { type, name: null });
        return drillItem(level, i, { kind, variantId, hasChildren: false, ...countsOf(variantId) });
      });
    }
    case "variant": {
      const set = parents.set ? fixtureSet(parents.set) : undefined;
      const type = parents.variantType as VariantType | undefined;
      if (!set || (type !== "Inserts" && type !== "Parallels")) return [];
      return variantItems(set, type, NO_COMPLETION).map((i) => {
        const variantId = demoVariantId(set.id, { type, name: i.id });
        const run = printRunOf(set, type, i.id);
        return drillItem(level, i, {
          variantId,
          hasChildren: false,
          ...countsOf(variantId),
          ...(run ? { description: run } : {}),
        });
      });
    }
    case "subVariant":
      // The fixture has no parallels under an insert.
      return [];
  }
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const SUGGESTION_LIMIT = 5;

function suggestionsFor(text: string): Suggestion[] {
  const q = normalize(text);
  const out: Suggestion[] = [];
  for (const p of fixturePlayers) {
    if (normalize(p.name).includes(q)) out.push({ kind: "player", id: p.id, name: p.name, sport: getSport(p.sport).name });
  }
  const players = out.splice(0, SUGGESTION_LIMIT);
  const teams: Suggestion[] = fixtureTeams
    .filter((t) => normalize(`${t.location} ${t.name}`).includes(q))
    .slice(0, SUGGESTION_LIMIT)
    .map((t) => ({ kind: "team", id: t.id, name: t.name, location: t.location, primary: t.primary, secondary: t.secondary }));
  const sets: Suggestion[] = fixtureSets
    .filter((s) => normalize(`${setLabel(s)} ${getBrand(s.brandId).name}`).includes(q))
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => ({ kind: "set", id: s.id, label: setLabel(s), sport: getSport(s.sportId).name }));
  return [...players, ...teams, ...sets];
}

/** Stable key for a drill request, so the memo only reruns when the request changes. */
function parentsKey(parents: DrillParents): string {
  return JSON.stringify(parents);
}

export const DEMO_DATA: CollectionData = {
  useDrill(level, parents) {
    // NEO-364: the drill carries no counts, so it reads nothing of the copies.
    const key = parentsKey(parents);
    return useMemo(() => (level ? drillColumn(level, JSON.parse(key) as DrillParents) : undefined), [level, key]);
  },

  useSetSummary(setId) {
    return useMemo((): SetSummary | null | undefined => {
      if (setId === null) return undefined;
      const set = fixtureSet(setId);
      if (!set) return null;
      const idx = demoIndex();
      const variants = set.variants.map((sv) => idx.variants.get(demoVariantId(set.id, sv.path))!);
      return {
        set: idx.setRefs.get(set.id)!,
        variants,
        totalCards: variants.reduce((n, v) => n + v.baseCardCount, 0),
        totalCardsAll: variants.reduce((n, v) => n + v.cardCount, 0),
      };
    }, [setId]);
  },

  useSetPath(setId) {
    return useMemo((): SetPath | null | undefined => {
      if (setId === null) return undefined;
      const set = fixtureSet(setId);
      if (!set) return null;
      return {
        sport: { id: set.sportId, name: getSport(set.sportId).name },
        year: { id: String(set.year), name: set.season },
        brand: { id: set.brandId, name: brands.find((b) => b.id === set.brandId)?.name ?? set.brandId },
        set: { id: set.id, name: set.name },
      };
    }, [setId]);
  },

  useVariantCards(variantId) {
    return variantId === null ? undefined : (demoIndex().variantCards.get(variantId) ?? []);
  },

  useVariantCompletion(variantId, side) {
    const state = useDemoState().state;
    const scope = useScope();
    return useMemo(
      () =>
        variantId === null
          ? undefined
          : (completionIn(variantId, inScope(state, scope, side)) ?? completionOf({ owned: 0, total: 0 })),
      [variantId, state, scope, side],
    );
  },

  useSetCompletion(setId, side) {
    const state = useDemoState().state;
    const scope = useScope();
    return useMemo((): SetCompletion | undefined => {
      if (setId === null) return undefined;
      const set = fixtureSet(setId);
      const scoped = inScope(state, scope, side);
      const sum = { owned: 0, total: 0, ownedAll: 0, totalAll: 0 };
      for (const sv of set?.variants ?? []) {
        const c = completionIn(demoVariantId(set!.id, sv.path), scoped);
        if (!c) continue;
        sum.owned += c.owned;
        sum.total += c.total;
        sum.ownedAll += c.ownedAll;
        sum.totalAll += c.totalAll;
      }
      return {
        ...completionOf({ owned: sum.owned, total: sum.total }, { owned: sum.ownedAll, total: sum.totalAll }),
        exact: true,
      };
    }, [setId, state, scope, side]);
  },

  useCard(cardId) {
    return cardId === null ? undefined : demoCard(cardId);
  },

  useCards(cardIds) {
    const key = cardIds ? cardIds.join("\n") : null;
    return useMemo(() => (key === null ? undefined : key === "" ? [] : key.split("\n").map(demoCard)), [key]);
  },

  useSuggestions(text) {
    return useMemo(() => (searchable(text) ? suggestionsFor(text) : []), [text]);
  },

  useTeam(teamId) {
    return useMemo((): CardTeam | null | undefined => {
      if (teamId === null) return undefined;
      const t = fixtureTeams.find((team) => team.id === teamId);
      return t ? { id: t.id, name: t.name, location: t.location, primary: t.primary, secondary: t.secondary } : null;
    }, [teamId]);
  },

  useSearch(text, options) {
    const sportId = options?.sportId;
    return useMemo(() => {
      if (!searchable(text)) return { cards: [], truncated: false };
      const hits = searchCards(text)
        .map((h) => demoCard(h.card.id))
        .filter((c): c is Card => c !== null)
        .filter((c) => !sportId || c.set.sport.id === sportId);
      return { cards: hits, truncated: false };
    }, [text, sportId]);
  },

  useEntityCards(pick) {
    const key = pick ? `${pick.kind}|${pick.id}` : null;
    return useMemo(() => {
      if (!key) return undefined;
      const [kind, id] = key.split("|");
      // The fixture has no franchises: a team's franchise is the team.
      const cards = fixtureCards
        .filter((c) => (kind === "player" ? c.playerIds.includes(id) : c.teamIds.includes(id)))
        .map((c) => demoCard(c.id))
        .filter((c): c is Card => c !== null)
        .sort(compareCards);
      return { cards, truncated: false };
    }, [key]);
  },

  useBuildingSets() {
    const state = useDemoState();
    const ids = state.state.buildingSetIds;
    return useMemo(() => {
      const refs = demoIndex().setRefs;
      return ids.map((id) => refs.get(id)).filter((s): s is SetRef => s !== undefined);
    }, [ids]);
  },

  useCopiesOf(cardId) {
    const { copies, containers } = useDemoState().state;
    return useMemo(
      () => (cardId === null ? undefined : toViewCopies(copies.filter((c) => c.cardId === cardId), containers)),
      [cardId, copies, containers],
    );
  },

  useCopiesInVariant(variantId, side) {
    const state = useDemoState().state;
    const scope = useScope();
    return useMemo(() => {
      if (variantId === null) return undefined;
      const inVariant = new Set((demoIndex().variantCards.get(variantId) ?? []).map((c) => c.id));
      return toViewCopies(inScope(state, scope, side).filter((c) => inVariant.has(c.cardId)), state.containers);
    }, [variantId, state, scope, side]);
  },

  useOwnedCards(options) {
    const limit = Math.max(1, Math.floor(options?.limit ?? OWNED_CARDS_DEFAULT_LIMIT));
    const copies = collectionOf(useDemoState().state);
    return useMemo((): OwnedCards => {
      // The reducer appends each new copy, so the newest copies are last:
      // walking backwards lists the most recently added card first.
      const order: string[] = [];
      const held = new Map<string, HeldCount>();
      for (let i = copies.length - 1; i >= 0; i--) {
        const copy = copies[i];
        if (copy.quantity <= 0) continue;
        const count = held.get(copy.cardId);
        if (count) {
          count.quantity += copy.quantity;
          count.lines += 1;
          if (copy.graded) count.graded = true;
        } else {
          held.set(copy.cardId, { quantity: copy.quantity, lines: 1, ...(copy.graded ? { graded: true } : {}) });
          order.push(copy.cardId);
        }
      }
      const cards: Card[] = [];
      const goneCardIds: string[] = [];
      const copiesByCard: Record<string, HeldCount> = {};
      for (const id of order.slice(0, limit)) {
        const card = demoCard(id);
        if (!card) {
          goneCardIds.push(id);
          continue;
        }
        cards.push(card);
        copiesByCard[id] = held.get(id)!;
      }
      return {
        cards,
        copiesByCard,
        total: order.length,
        totalExact: true,
        goneCardIds,
        truncated: order.length > limit,
      };
    }, [copies, limit]);
  },

  useInventoryCards(options) {
    const limit = Math.max(1, Math.floor(options?.limit ?? OWNED_CARDS_DEFAULT_LIMIT));
    const boxId = options?.boxId;
    const state = useDemoState().state;
    return useMemo(() => inventoryCardsOf(state, limit, boxId), [state, limit, boxId]);
  },

  useSummary() {
    const state = useDemoState().state;
    const copies = collectionOf(state);
    const buildingSetIds = state.buildingSetIds;
    return useMemo(() => {
      const building = new Set<string>(buildingSetIds);
      const cards = new Set(copies.map((c) => c.cardId));
      let offBuild = 0;
      for (const id of cards) {
        const card = demoCard(id);
        // A card the fixture no longer holds is in no set build.
        if (!card || !building.has(card.set.id)) offBuild += 1;
      }
      return {
        copies: copies.reduce((n, c) => n + c.quantity, 0),
        cards: cards.size,
        exact: true,
        offBuild,
      };
    }, [copies, buildingSetIds]);
  },

  useContainers() {
    const state = useDemoState().state;
    return useMemo(() => containersOf(state), [state]);
  },

  useContainerCopies(containerId, options) {
    const state = useDemoState().state;
    const limit = options?.limit;
    return useMemo(
      () => (containerId === null ? undefined : page(containerCopies(state, containerId), state.containers, limit)),
      [containerId, state, limit],
    );
  },

  useTradeCopies(options) {
    const state = useDemoState().state;
    const limit = options?.limit;
    return useMemo(
      () => page(tradeOf(state), state.containers, limit),
      [state, limit],
    );
  },

  useWants() {
    return useDemoState().state.wants;
  },

  useDefaultCondition() {
    return DEFAULT_CONDITION;
  },

  useCopiesOfCards(cardIds) {
    const { copies, containers } = useDemoState().state;
    const key = cardIds ? cardIds.join("\n") : null;
    return useMemo(() => {
      if (key === null) return undefined;
      const out: Record<string, Copy[]> = {};
      for (const id of key === "" ? [] : key.split("\n")) out[id] = [];
      for (const copy of copies) {
        const list = out[copy.cardId];
        if (!list) continue;
        const view = toViewCopy(copy, containers);
        if (view) list.push(view);
      }
      return out;
    }, [key, copies, containers]);
  },

  useSetCards(setId, options) {
    const limit = Math.max(1, Math.floor(options?.limit ?? SET_CARDS_DEFAULT_LIMIT));
    return useMemo(() => {
      if (setId === null) return undefined;
      const set = fixtureSet(setId);
      if (!set) return { cards: [], truncated: false };
      const idx = demoIndex();
      const all = set.variants.flatMap((sv) => idx.variantCards.get(demoVariantId(set.id, sv.path)) ?? []);
      return { cards: all.slice(0, limit), truncated: all.length > limit };
    }, [setId, limit]);
  },

  /**
   * NEO-362 — a binder's needs, as the server's for a binder with no rule:
   * every regular card of the checklists it already holds a card from.
   */
  useBinderNeeds(containerId) {
    const { copies } = useDemoState().state;
    return useMemo((): BinderNeeds | undefined => {
      if (containerId === null) return undefined;
      const idx = demoIndex();
      const here = new Set<string>();
      const variants = new Set<string>();
      for (const c of copies) {
        if (c.homeId !== containerId) continue;
        here.add(c.cardId);
        const card = idx.cards.get(c.cardId);
        if (card) variants.add(card.variant.id);
      }
      const elsewhere = new Set(copies.filter((c) => c.homeId !== containerId).map((c) => c.cardId));
      const cards: Card[] = [];
      for (const v of [...variants].slice(0, MAX_NEED_CHECKLISTS)) {
        for (const card of idx.variantCards.get(v) ?? []) {
          if (!card.isVariation && !here.has(card.id)) cards.push(card);
        }
      }
      const kept = cards.slice(0, MAX_NEEDS);
      return {
        cards: kept,
        held: new Set(kept.filter((c) => elsewhere.has(c.id)).map((c) => c.id)),
        supported: true,
        truncated: cards.length > kept.length || variants.size > MAX_NEED_CHECKLISTS,
      };
    }, [containerId, copies]);
  },

  // The demo has no smart rules (capability `binderRules` is off): nothing
  // matches, there is nothing to find, nothing was declined.
  useRuleMatches(containerId, cardIds) {
    return useMemo(() => (containerId && cardIds ? new Set<string>() : undefined), [containerId, cardIds]);
  },

  useFindCards(containerId) {
    return useMemo(
      (): FoundCards | undefined => (containerId ? { copies: [], done: true, more: () => {} } : undefined),
      [containerId],
    );
  },

  useDeclined(containerId) {
    return useMemo((): DeclinedCard[] | undefined => (containerId ? [] : undefined), [containerId]);
  },

  useRuleBrands(sportId) {
    return sportId ? NO_BRANDS : undefined;
  },

  useCommonPrices(variantIds) {
    const prices = useDemoState().state.commonPrices;
    const key = variantIds ? variantIds.join("\n") : null;
    return useMemo(() => {
      if (key === null) return undefined;
      const out: Record<string, number> = {};
      for (const id of key.split("\n")) {
        const price = prices?.[id];
        if (price !== undefined) out[id] = price;
      }
      return out;
    }, [key, prices]);
  },
};

const NO_BRANDS: RuleBrand[] = [];

/** As the server's (`convex/binderRules.ts`). */
const MAX_NEEDS = 900;
const MAX_NEED_CHECKLISTS = 30;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function demoActions(stateRef: { current: DemoState }): CollectionActions {
  const run: DemoState["run"] = (op) => stateRef.current.run(op);

  /** The undo of an add: the folded row back to what it was, or the new row gone. */
  const undoAdd = (r: { copyId: string; merged: boolean; previous?: { quantity: number; acquiredAt: string } }) => async () => {
    if (r.merged && r.previous) {
      const previous = r.previous;
      run((s) => demoOps.updateCopy(s, r.copyId, previous));
    } else {
      run((s) => demoOps.removeCopy(s, r.copyId));
    }
  };

  /** The undo of a move or a placement: the same cards back where they were. */
  const undoMove = (r: { copyId: string; from: { homeId: string; slot?: number; quantity: number } }) => async () => {
    run((s) => demoOps.moveCopy(s, r.copyId, r.from.homeId, r.from.quantity, r.from.slot));
  };

  const noRules = async (): Promise<never> => {
    throw new DemoRefusal("Smart binder rules need an account. Sign up to build one.");
  };

  const actions: CollectionActions = {
    async setBinderSettings(container, patch) {
      const back = run((s) => demoOps.setBinderSettings(s, container.id, patch));
      return {
        undo: async () => {
          run((s) => demoOps.setBinderSettings(s, container.id, back));
        },
      };
    },

    async relayPockets(container, placements) {
      const previous = run((s) => demoOps.relayPockets(s, container.id, placements));
      return {
        undo: async () => {
          run((s) => demoOps.relayPockets(s, container.id, previous));
        },
      };
    },

    setSmartRule: noRules,
    declineCard: noRules,
    undeclineCard: noRules,

    async setCommonPrice(variantId, price) {
      const previous = run((s) => demoOps.setCommonPrice(s, variantId, price));
      return {
        undo: async () => {
          run((s) => demoOps.setCommonPrice(s, variantId, previous));
        },
      };
    },

    async addHave(card, homeId) {
      const r = run((s) => demoOps.addLine(s, card.id, { ...emptyCopyDetails(), ...(homeId ? { homeId } : {}) }));
      return { copyId: r.copyId, merged: r.merged, undo: undoAdd(r) };
    },

    async addMany(cards, homeId) {
      const results = cards.map((c) =>
        run((s) => demoOps.addLine(s, c.id, { ...emptyCopyDetails(), ...(homeId ? { homeId } : {}) })),
      );
      return {
        copyIds: results.map((r) => r.copyId),
        undo: async () => {
          for (const r of [...results].reverse()) await undoAdd(r)();
        },
      };
    },

    async addLineItem(card, details) {
      const r = run((s) => demoOps.addLine(s, card.id, details));
      return { copyId: r.copyId, merged: r.merged, undo: undoAdd(r) };
    },

    async updateCopy(copy, patch) {
      const previous = run((s) => demoOps.updateCopy(s, copy.id, patch));
      return {
        undo: async () => {
          run((s) => demoOps.updateCopy(s, copy.id, previous));
        },
      };
    },

    async removeCopy(copy) {
      const { removed, index } = run((s) => demoOps.removeCopy(s, copy.id));
      const view = toViewCopy(removed, stateRef.current.state.containers) ?? copy;
      return {
        removed: view,
        undo: async () => {
          run((s) => demoOps.restoreCopy(s, removed, index));
        },
      };
    },

    async restoreCopy(copy) {
      const stored = toDemoCopy(copy);
      const copyId = run((s) => demoOps.restoreCopy(s, stored));
      return {
        copyId,
        merged: false,
        undo: async () => {
          run((s) => demoOps.removeCopy(s, copyId));
        },
      };
    },

    async setBuilding(set, building) {
      const changed = run((s) => demoOps.setBuilding(s, set.id, building));
      return {
        building,
        undo: async () => {
          if (changed) run((s) => demoOps.setBuilding(s, set.id, !building));
        },
      };
    },

    async moveCopy(copy, toHomeId, options) {
      const r = run((s) => demoOps.moveCopy(s, copy.id, toHomeId, options?.quantity, options?.slot));
      return { copyId: r.copyId, folded: r.folded, split: r.split, undo: undoMove(r) };
    },

    async placeCopy(copy, slot) {
      const r = run((s) => demoOps.placeCopy(s, copy.id, slot));
      return { copyId: r.copyId, folded: r.folded, split: r.split, undo: undoMove(r) };
    },

    async setTrade(copy, on) {
      const previous = run((s) => demoOps.setTrade(s, copy.id, on));
      return {
        undo: async () => {
          run((s) => demoOps.setTrade(s, copy.id, previous));
        },
      };
    },

    async setWant(cardId, binderId, on) {
      const before = stateRef.current.state.wants.find((w) => w.cardId === cardId);
      const changed = run((s) => demoOps.setWant(s, cardId, binderId, on));
      return {
        changed,
        undo: async () => {
          if (!changed) return;
          run((s) =>
            before ? demoOps.setWant(s, cardId, before.binderId, true) : demoOps.setWant(s, cardId, null, false),
          );
        },
      };
    },

    async createContainer(input) {
      const containerId = run((s) => demoOps.createContainer(s, input));
      return {
        containerId,
        undo: async () => {
          if (stateRef.current.state.copies.some((c) => c.homeId === containerId)) {
            throw new Error("It has cards in it now. Delete it from its own menu.");
          }
          run((s) => demoOps.deleteContainer(s, containerId));
        },
      };
    },

    async updateContainer(container, patch) {
      const back = run((s) => demoOps.updateContainer(s, container.id, patch));
      return {
        undo: async () => {
          run((s) => demoOps.updateContainer(s, container.id, back));
        },
      };
    },

    async deleteContainer(container) {
      const moved = run((s) => demoOps.deleteContainer(s, container.id));
      return { moved };
    },

    async setBoxQuantity(card, box, quantity) {
      const r = run((s) => demoOps.setBoxQuantity(s, card.id, box.id, quantity, todayIso()));
      return {
        before: r.before,
        after: r.after,
        undo: async () => {
          run((s) => demoOps.restoreLines(s, r.undo));
        },
      };
    },
  };
  return actions;
}

let browseSetsCache: SetRef[] | null = null;
/** The Browse shelf's sets, in shelf order (sport, year, name). */
function browseSets(): SetRef[] {
  browseSetsCache ??= setsInOrder().map((s) => demoIndex().setRefs.get(s.id)!);
  return browseSetsCache;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Mounts the demo store. `storageKey`: where the demo persists (the public
 * demo passes `PUBLIC_STORAGE_KEY`; the default is the reducer's own key).
 */
export function DemoCollectionProvider({ storageKey, children }: { storageKey?: string; children: ReactNode }) {
  const state = useDemoCollectionState(storageKey);
  // Writes read the newest state through a ref, so the actions object (and
  // every view holding it) stays the same across renders.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const actions = useMemo(() => demoActions(stateRef), []);
  const demo = useMemo<DemoExtension>(
    () => ({
      cardRequests: state.cardRequests,
      requestCard: state.requestCard,
      browseSets: browseSets(),
      browseFilter: state.browseFilter,
      setBrowseFilter: state.setBrowseFilter,
      describeRule: (rule) => describeFixtureRule(fixtureRule(rule)),
      reset: state.reset,
    }),
    [state.cardRequests, state.requestCard, state.browseFilter, state.setBrowseFilter, state.reset],
  );
  const photos = useDemoCopyPhotos(state.state.copies);
  const value = useMemo<CollectionStoreValue>(
    () => ({ kind: "demo", capabilities: ALL_CAPABILITIES, data: DEMO_DATA, actions, demo, photos }),
    [actions, demo, photos],
  );
  return createElement(
    CollectionStoreContext.Provider,
    { value },
    createElement(
      DemoStateContext.Provider,
      { value: state },
      createElement(CardImagesProvider, { useImages: photos.useCardImages, children }),
    ),
  );
}

/**
 * NEO-377 — the demo's copy photos: resized in the browser exactly like the
 * real ones, then kept on this page only (object URLs, gone on reload). No
 * upload, no account.
 */
function useDemoCopyPhotos(copies: readonly { id: string; cardId: string }[]): CopyPhotosExtension {
  const [byCopy, setByCopy] = useState<ReadonlyMap<CopyId, CopyPhotos>>(new Map());
  const usePhotos = useCallback(
    (copies: readonly Copy[]) => {
      const out = new Map<CopyId, CopyPhotos>();
      for (const copy of copies) {
        const p = byCopy.get(copy.id);
        if (p) out.set(copy.id, p);
      }
      return out;
    },
    [byCopy],
  );
  const drop = (urls: PhotoUrls | undefined) => {
    if (!urls) return;
    URL.revokeObjectURL(urls.imageUrl);
    URL.revokeObjectURL(urls.thumbUrl);
  };
  const addPhoto = useCallback(async (copy: Copy, side: PhotoSide, file: File) => {
    const resized = await resizeCopyPhoto(file);
    const urls = { imageUrl: URL.createObjectURL(resized.image), thumbUrl: URL.createObjectURL(resized.thumb) };
    setByCopy((prev) => {
      const next = new Map(prev);
      drop(prev.get(copy.id)?.[side]);
      next.set(copy.id, { ...prev.get(copy.id), [side]: urls });
      return next;
    });
  }, []);
  const removePhoto = useCallback(async (copy: Copy, side: PhotoSide) => {
    setByCopy((prev) => {
      const had = prev.get(copy.id);
      if (!had?.[side]) return prev;
      drop(had[side]);
      const next = new Map(prev);
      const rest: CopyPhotos = { ...had };
      delete rest[side];
      if (rest.front || rest.back) next.set(copy.id, rest);
      else next.delete(copy.id);
      return next;
    });
  }, []);
  const swapPhotos = useCallback(async (copy: Copy) => {
    setByCopy((prev) => {
      const had = prev.get(copy.id);
      if (!had) return prev;
      const next = new Map(prev);
      next.set(copy.id, { ...(had.back ? { front: had.back } : {}), ...(had.front ? { back: had.front } : {}) });
      return next;
    });
  }, []);
  const useCardImages = useCallback(
    (cardIds: readonly string[]) => {
      // Only lines still in the collection count.
      const wanted = new Set(cardIds);
      const out = new Map<string, CopyPhotos>();
      for (const copy of copies) {
        const p = byCopy.get(copy.id as CopyId);
        if (!p || !wanted.has(copy.cardId)) continue;
        const had = out.get(copy.cardId);
        if (!had || (!had.front && p.front)) out.set(copy.cardId, p);
      }
      return out;
    },
    [byCopy, copies],
  );
  return useMemo(
    () => ({ usePhotos, addPhoto, removePhoto, swapPhotos, useCardImages }),
    [usePhotos, addPhoto, removePhoto, swapPhotos, useCardImages],
  );
}

/** The fixture's set label for an id, or null (for page titles while views migrate). */
export function demoSetLabel(setId: string | null): string | null {
  const set = setId ? fixtureSet(setId) : undefined;
  return set ? setLabel(set) : null;
}
