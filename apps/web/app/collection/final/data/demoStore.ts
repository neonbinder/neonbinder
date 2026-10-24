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
 * The binder scope applies here as it always has: with a binder picked,
 * `useCopiesInVariant` and `useVariantCompletion` count only that binder,
 * while `useCopiesOf` lists every copy (the drawer shows each with its home).
 */

import { createContext, createElement, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  brands,
  cards as fixtureCards,
  cardsInSet,
  getBrand,
  getPlayer,
  getSport,
  getTeam,
  players as fixturePlayers,
  searchCards,
  sets as fixtureSets,
  teams as fixtureTeams,
  type Card as FixtureCard,
  type CardSet as FixtureSet,
  type Copy as FixtureCopy,
  type CopyDetails as FixtureCopyDetails,
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
  MAIN_BINDER_ID,
  PUBLIC_STORAGE_KEY,
  TRADE_BINDER_ID,
  useDemoCollectionState,
  type CollectionBinder,
  type CollectionStore as DemoState,
} from "../store";
import { compareCards, setLabel } from "./labels";
import {
  CollectionStoreContext,
  completionOf,
  OWNED_CARDS_DEFAULT_LIMIT,
  searchable,
  type CollectionActions,
  type CollectionData,
  type CollectionStoreValue,
} from "./store";
import {
  ALL_CAPABILITIES,
  type Card,
  type CardFeature,
  type CardId,
  type Completion,
  type Copy,
  type CopyDetails,
  type DrillItem,
  type HeldCount,
  type OwnedCards,
  type DrillLevel,
  type DrillParents,
  type SetPath,
  type SetRef,
  type SetSummary,
  type Suggestion,
  type Variant,
  type VariantId,
  type VariantKind,
  type VariantRef,
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

function homeOf(binderIds: string[]): string {
  return binderIds.find((id) => id !== TRADE_BINDER_ID) ?? binderIds[0] ?? MAIN_BINDER_ID;
}

/** View copies keyed on the reducer's (immutable) copy objects, per binder list. */
const copyCache = new WeakMap<CollectionBinder[], WeakMap<FixtureCopy, Copy | null>>();

function toViewCopy(copy: FixtureCopy, binders: CollectionBinder[]): Copy | null {
  let byCopy = copyCache.get(binders);
  if (!byCopy) {
    byCopy = new WeakMap();
    copyCache.set(binders, byCopy);
  }
  const cached = byCopy.get(copy);
  if (cached !== undefined) return cached;
  const card = demoCard(copy.cardId);
  const { binderIds, forSale, askPrice, id, cardId, ...details } = copy;
  const homeId = homeOf(binderIds);
  const view: Copy | null = card
    ? {
        ...details,
        id,
        cardId,
        variantId: card.variant.id,
        setId: card.set.id,
        homeId,
        homeName: binders.find((b) => b.id === homeId)?.name,
        demo: { binderIds, forSale, ...(askPrice === undefined ? {} : { askPrice }) },
      }
    : null;
  byCopy.set(copy, view);
  return view;
}

function toViewCopies(copies: FixtureCopy[], binders: CollectionBinder[]): Copy[] {
  return copies.map((c) => toViewCopy(c, binders)).filter((c): c is Copy => c !== null);
}

/** View details → the reducer's, filing into `binderIds` when the details do not say. */
function toFixtureDetails(details: CopyDetails, binderIds: string[]): FixtureCopyDetails {
  const { demo, ...rest } = details;
  return {
    ...rest,
    binderIds: demo?.binderIds ?? binderIds,
    forSale: demo?.forSale ?? false,
    ...(demo?.askPrice === undefined ? {} : { askPrice: demo.askPrice }),
  };
}

function toFixturePatch(patch: Partial<CopyDetails>): Partial<FixtureCopyDetails> {
  const { demo, ...rest } = patch;
  if (!demo) return rest;
  return { ...rest, binderIds: demo.binderIds, forSale: demo.forSale, askPrice: demo.askPrice };
}

/** The fields of a copy a patch touches, as they are now: the patch that undoes it. */
function inverseOf(copy: Copy, patch: Partial<CopyDetails>): Partial<CopyDetails> {
  const out: Partial<CopyDetails> = {};
  for (const key of Object.keys(patch) as (keyof CopyDetails)[]) {
    (out as Record<string, unknown>)[key] = copy[key];
  }
  return out;
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

function completionIn(variantId: VariantId, copies: FixtureCopy[]): Completion | undefined {
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

function drillItem(level: DrillLevel, item: ColumnItem, extra: Partial<DrillItem> = {}): DrillItem {
  return { id: item.id, level, name: item.name, description: item.description, hasChildren: true, ...extra };
}

function drillColumn(level: DrillLevel, parents: DrillParents, state: DemoState): DrillItem[] {
  // NEO-358: the drill's "300 base cards" / "have 2 of 30" read base cards
  // only, the same pair as the checklist's "Have 2 of 300"; the shared
  // prototype completion counts image variations in.
  const completion = (setId: string, variant?: VariantFilter) => {
    const c = state.completionInScope(setId, variant);
    const total = cardsInSet(setId, variant).filter((card) => card.variation === null).length;
    const missing = c.missing.filter((card) => card.variation === null);
    const owned = total - missing.length;
    return { ...c, total, owned, missing, percent: total ? Math.floor((owned / total) * 100) : 0 };
  };
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
      return setItems(parents.sport as FixtureSet["sportId"], Number(parents.year), parents.brand, completion).map((i) =>
        drillItem(level, i),
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
        // The prototype's "N cards" counts variations; the cascade reads the base count instead.
        return drillItem(level, { ...i, description: undefined }, { kind, variantId, hasChildren: false, ...countsOf(variantId) });
      });
    }
    case "variant": {
      const set = parents.set ? fixtureSet(parents.set) : undefined;
      const type = parents.variantType as VariantType | undefined;
      if (!set || (type !== "Inserts" && type !== "Parallels")) return [];
      return variantItems(set, type, completion).map((i) => {
        const variantId = demoVariantId(set.id, { type, name: i.id });
        return drillItem(level, i, { variantId, hasChildren: false, ...countsOf(variantId) });
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
    .map((t) => ({ kind: "team", id: t.id, name: t.name, location: t.location }));
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
    const state = useDemoState();
    const key = parentsKey(parents);
    return useMemo(
      () => (level ? drillColumn(level, JSON.parse(key) as DrillParents, state) : undefined),
      [level, key, state],
    );
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

  useVariantCompletion(variantId) {
    const state = useDemoState();
    return useMemo(
      () => (variantId === null ? undefined : (completionIn(variantId, state.scopedCopies) ?? completionOf({ owned: 0, total: 0 }))),
      [variantId, state.scopedCopies],
    );
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
    const state = useDemoState();
    const { copies, binders } = state.state;
    return useMemo(
      () => (cardId === null ? undefined : toViewCopies(copies.filter((c) => c.cardId === cardId), binders)),
      [cardId, copies, binders],
    );
  },

  useCopiesInVariant(variantId) {
    const state = useDemoState();
    const scoped = state.scopedCopies;
    const binders = state.state.binders;
    return useMemo(() => {
      if (variantId === null) return undefined;
      const inVariant = new Set((demoIndex().variantCards.get(variantId) ?? []).map((c) => c.id));
      return toViewCopies(scoped.filter((c) => inVariant.has(c.cardId)), binders);
    }, [variantId, scoped, binders]);
  },

  useOwnedCards(options) {
    const limit = Math.max(1, Math.floor(options?.limit ?? OWNED_CARDS_DEFAULT_LIMIT));
    const copies = useDemoState().state.copies;
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
        } else {
          held.set(copy.cardId, { quantity: copy.quantity, lines: 1 });
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

  useSummary() {
    const copies = useDemoState().state.copies;
    return useMemo(
      () => ({
        copies: copies.reduce((n, c) => n + c.quantity, 0),
        cards: new Set(copies.map((c) => c.cardId)).size,
        exact: true,
      }),
      [copies],
    );
  },
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function demoActions(stateRef: { current: DemoState }): CollectionActions {
  const live = () => stateRef.current;
  const viewCopy = (id: string): Copy | null => {
    const s = live();
    const raw = s.state.copies.find((c) => c.id === id);
    return raw ? toViewCopy(raw, s.state.binders) : null;
  };

  const actions: CollectionActions = {
    async addHave(card) {
      const copy = live().addHave(card.id);
      return {
        copyId: copy.id,
        merged: false,
        undo: async () => {
          live().removeCopy(copy.id);
        },
      };
    },

    async addMany(cards) {
      const added = cards.map((c) => live().addHave(c.id));
      return {
        copyIds: added.map((c) => c.id),
        undo: async () => {
          for (const c of added) live().removeCopy(c.id);
        },
      };
    },

    async addLineItem(card, details) {
      const s = live();
      const result = s.addLineItem(card.id, toFixtureDetails(details, [s.targetBinderId]));
      return {
        copyId: result.copy.id,
        merged: result.merged,
        undo: async () => result.undo(),
      };
    },

    async updateCopy(copy, patch) {
      const before = viewCopy(copy.id) ?? copy;
      live().updateCopy(copy.id, toFixturePatch(patch));
      const back = inverseOf(before, patch);
      return {
        undo: async () => {
          live().updateCopy(copy.id, toFixturePatch(back));
        },
      };
    },

    async removeCopy(copy) {
      const removed = live().removeCopy(copy.id);
      if (!removed) throw new Error("That copy is already gone.");
      const view = toViewCopy(removed, live().state.binders) ?? copy;
      return {
        removed: view,
        undo: async () => {
          live().restoreCopy(removed);
        },
      };
    },

    async restoreCopy(copy) {
      const { id, cardId, demo, variantId: _v, setId: _s, homeId, homeName: _h, ...details } = copy;
      const fixture: FixtureCopy = {
        ...details,
        id,
        cardId,
        binderIds: demo?.binderIds ?? [homeId],
        forSale: demo?.forSale ?? false,
        ...(demo?.askPrice === undefined ? {} : { askPrice: demo.askPrice }),
      };
      live().restoreCopy(fixture);
      return {
        copyId: id,
        merged: false,
        undo: async () => {
          live().removeCopy(id);
        },
      };
    },

    async setBuilding(set, building) {
      const toggle = () => live().toggleBuilding(set.id);
      if (live().isBuilding(set.id) !== building) toggle();
      return {
        building,
        undo: async () => {
          if (live().isBuilding(set.id) === building) toggle();
        },
      };
    },
  };
  return actions;
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
  const value = useMemo<CollectionStoreValue>(
    () => ({
      kind: "demo",
      capabilities: ALL_CAPABILITIES,
      data: DEMO_DATA,
      actions,
      demo: { state, reset: state.reset },
    }),
    [actions, state],
  );
  return createElement(
    CollectionStoreContext.Provider,
    { value },
    createElement(DemoStateContext.Provider, { value: state }, children),
  );
}

/** The fixture's set label for an id, or null (for page titles while views migrate). */
export function demoSetLabel(setId: string | null): string | null {
  const set = setId ? fixtureSet(setId) : undefined;
  return set ? setLabel(set) : null;
}
