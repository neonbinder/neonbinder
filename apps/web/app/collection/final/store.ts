/**
 * NEO-350 — the consolidated collection page's store (`/collection`).
 *
 * Fake data only: seeded from the prototypes' shared catalog and collector
 * (`../prototypes/_shared/`), kept in sessionStorage under
 * `nb-collection-final`. Nothing reaches a server. Prototypes 1-5 keep their
 * own stores; nothing here changes theirs.
 *
 * ---------------------------------------------------------------------------
 * Props contract for the three tabs (My Cards, My Binders, Checklists)
 * ---------------------------------------------------------------------------
 *
 *   interface CollectionTabProps {
 *     store: CollectionStore;
 *     openCard: (cardId: CardId, opts?: OpenCardOptions) => void;
 *     goToTab: (tab: CollectionTab, params?: GoToTabParams) => void;
 *     notify: Notify;
 *   }
 *
 *   type CollectionTab = "cards" | "binders" | "checklists";   // ?tab=
 *
 * - `openCard(cardId)` opens the one right-side card drawer.
 *   `opts.mode: "add"` opens it straight on the "Add a copy" form;
 *   `opts.copyId` highlights that line item in "Your copies";
 *   `opts.list` (optional) is the card ids the drawer's ↑ ↓ step through;
 *   `opts.binderId` (optional) is the binder the add form ticks in place of
 *   the page's target (e.g. the binder a want is for). Ignored unless a copy
 *   can be filed there.
 * - `goToTab("checklists", { q })` opens Checklists with that search
 *   prefilled; `goToTab("checklists", { cardId })` opens that card's
 *   checklist and rings its row. Any tab may be passed without params.
 * - `notify(message, undo?)` shows the page's status line with an Undo.
 *
 * `CollectionStore` is a superset of the prototypes' `PrototypeStore`, so a
 * component written against `PrototypeStore` takes it unchanged. Its
 * `ownedCount`, `copiesOf` and `completion` stay collection-wide. On top:
 *
 * System binders (every user has them; `binder.system` marks them; they sort
 * first and cannot be renamed or deleted):
 *   "main" Main, "trade" Up for Trade, "want" Want List.
 *   `mainBinderId`, `tradeBinderId`, `wantBinderId`, `systemBinder(kind)`,
 *   `isSystem(id)`. `fileableBinders`: Main, Up for Trade, then the
 *   collector's own manual binders (where a copy can be filed).
 *   `ownBinders`: the collector's own binders, manual and smart.
 *   `renameBinder` / `deleteBinder` refuse system binders (return false).
 *
 * Every copy lives in at least one binder. Removing its last binder (or
 * saving it with none) files it back in Main.
 *
 * The selected binder (the "Binder: [All ▾]" picker) is a filter AND the add
 * target, sticky across tabs:
 *   `selectedBinderId: "all" | BinderId` (default "all"),
 *   `setSelectedBinder(id | "all")`.
 *   `targetBinderId`: where Have and ranges file a new copy: the selected
 *     binder when it holds copies, else Main (All, Want List).
 *   `setTargetBinder(id)` is the same as `setSelectedBinder(id)`.
 *   `addHave(cardId)`: a quantity-1 raw copy, filed in `targetBinderId`.
 *   Scoped reads, all of which equal the collection-wide ones under All or
 *   Want List: `scopedCopies` (every copy in scope), `copiesInScope(cardId)`,
 *   `ownedInScope(cardId)`, `completionInScope(setId, variant?)`.
 *
 * Wants are `{ cardId, binderId | null }`: "for my Ohtani rainbow" or just
 * "want it" (null). `wants`, `wantCardIds` (distinct cards),
 * `wantsByBinder()` (Want List, grouped: unscoped first, then per binder).
 *   `isWanted(cardId)` and `toggleWant(cardId)` follow the selection:
 *   a binder selected → that binder's want; All / Want List → any want
 *   reads as pressed, toggling on adds an unscoped want and toggling off
 *   clears every want of the card. `toggleWant` returns its undo.
 *   `setWant(cardId, binderId | null, on)` for an exact edit.
 *
 * Up for Trade holds copies: `isUpForTrade(copy)`, `setUpForTrade(copyId, on)`.
 *
 * Line items: a copy with `quantity` is one line item. `addLineItem(cardId,
 * details)` adds one, folding it into an identical existing line item (same
 * grade or condition, cost, location, binders, notes, sale; never a copy
 * with a cert or serial) as extra quantity; the result carries its undo.
 *
 * Card requests ("Can't find it? Ask us to add it"): `cardRequests`,
 * `requestCard(input)`. Local only, private to this collector.
 *
 * Spine labels (the Print Shop look on the shelf): `binder.label` is the
 * collector's own `{ background, text, fontId }`, or absent for the default
 * (`binders/label.ts` decides it). `setBinderLabel(id, label | null)`;
 * `createBinder(input, label?)` takes one up front.
 *
 * Moving a copy: `moveCopy(copyId, toBinderId, slot?)` files it in the
 * destination instead of where it was (and into that pocket, when given).
 * It leaves Up for Trade alone unless that is where it goes, or the only
 * other place it lives. Never into the Want List, never zero binders. Returns
 * the binders it left and its undo, or null when nothing moved.
 *
 * Browse a set's filters: `browseFilter` / `setBrowseFilter(patch)`, kept in
 * the store so leaving the tab keeps them.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  binderCards as binderCardsFor,
  binderCopies as binderCopiesFor,
  binders as seedBinders,
  buildingSetIds as seedBuilding,
  cards as catalogCards,
  compareCards,
  copiesOf as copiesOfFor,
  emptyCopyDetails,
  getCard,
  myCopies as seedCopies,
  ownedCountFor,
  setCompletion as setCompletionFor,
  type Binder,
  type BinderId,
  type Card,
  type CardId,
  type Completion,
  type Copy,
  type CopyDetails,
  type CopyId,
  type SetId,
  type SportId,
  type VariantFilter,
} from "../prototypes/_shared/data";
import type { BinderPage } from "../prototypes/_shared/types";
import type {
  NewBinder,
  PrototypeState,
  PrototypeStore,
} from "../prototypes/_shared/usePrototypeStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SystemKind = "main" | "want" | "trade";

/** A spine label in the Print Shop's look: `#rrggbb` pair and a spine font id. */
export interface BinderLabel {
  background: string;
  text: string;
  fontId: string;
}

export type CollectionBinder = Binder & { system?: SystemKind; label?: BinderLabel };

/** Browse a set's filters. `from` / `to` are years, inclusive; null is open. */
export interface BrowseFilter {
  sport: SportId | "all";
  from: number | null;
  to: number | null;
  q: string;
}

export const NO_BROWSE_FILTER: BrowseFilter = { sport: "all", from: null, to: null, q: "" };

/** Where a copy is put when it moves: a pocket of the destination's pages. */
export interface PocketRef {
  page: number;
  slot: number;
}

export interface MoveResult {
  /** The binders the copy left (empty when it was only somewhere else too). */
  from: BinderId[];
  undo: () => void;
}

/** A card on the Want List, for one binder or (null) for the collection. */
export interface Want {
  cardId: CardId;
  binderId: BinderId | null;
}

export interface CardRequest {
  id: string;
  set: string;
  cardNumber: string;
  player: string;
  notes: string;
  /** What the collector had typed in search when they asked, if anything. */
  searched?: string;
  /** ISO date, `YYYY-MM-DD`. */
  requestedAt: string;
}

export type NewCardRequest = Omit<CardRequest, "id" | "requestedAt">;

export type BinderSelection = "all" | BinderId;

export interface CollectionState extends PrototypeState {
  binders: CollectionBinder[];
  wants: Want[];
  selectedBinderId: BinderSelection;
  cardRequests: CardRequest[];
  browseFilter: BrowseFilter;
  /** Bumped when the stored shape changes; a mismatch reseeds. */
  version: number;
}

export type CollectionTab = "cards" | "binders" | "checklists";

export interface OpenCardOptions {
  mode?: "view" | "add";
  copyId?: CopyId;
  /** Card ids the drawer's ↑ ↓ step through; defaults to just this card. */
  list?: CardId[];
  /** The binder the add form ticks instead of the page's target. */
  binderId?: BinderId;
}

export interface GoToTabParams {
  /** Checklists: prefill the search box. */
  q?: string;
  /** Checklists: open this card's checklist and ring its row. */
  cardId?: CardId;
}

export type Notify = (message: string, undo?: () => void) => void;

export interface CollectionTabProps {
  store: CollectionStore;
  openCard: (cardId: CardId, opts?: OpenCardOptions) => void;
  goToTab: (tab: CollectionTab, params?: GoToTabParams) => void;
  notify: Notify;
}

export interface AddLineItemResult {
  /** The line item the card landed in (new, or the one it folded into). */
  copy: Copy;
  /** True when it folded into an identical line item as extra quantity. */
  merged: boolean;
  /** Takes exactly this add back. */
  undo: () => void;
}

export interface CollectionStore extends PrototypeStore {
  state: CollectionState;
  getBinder: (binderId: BinderId) => CollectionBinder | undefined;

  mainBinderId: BinderId;
  wantBinderId: BinderId;
  tradeBinderId: BinderId;
  systemBinder: (kind: SystemKind) => CollectionBinder;
  isSystem: (binderId: BinderId) => boolean;
  /** Main, Up for Trade, then the collector's own manual binders. */
  fileableBinders: CollectionBinder[];
  /** The collector's own binders, manual and smart (no system ones). */
  ownBinders: CollectionBinder[];
  renameBinder: (binderId: BinderId, name: string) => boolean;
  deleteBinder: (binderId: BinderId) => boolean;

  selectedBinderId: BinderSelection;
  setSelectedBinder: (selection: BinderSelection) => void;
  targetBinderId: BinderId;
  setTargetBinder: (binderId: BinderId) => void;
  scopedCopies: Copy[];
  copiesInScope: (cardId: CardId) => Copy[];
  ownedInScope: (cardId: CardId) => number;
  completionInScope: (setId: SetId, variant?: VariantFilter) => Completion;
  /** A quantity-1 raw copy, filed straight in the target binder. */
  addHave: (cardId: CardId) => Copy;
  addLineItem: (cardId: CardId, details: CopyDetails) => AddLineItemResult;

  wants: Want[];
  wantCardIds: CardId[];
  wantsByBinder: () => { binderId: BinderId | null; cards: Card[] }[];
  isWanted: (cardId: CardId) => boolean;
  /** Flip the want under the current selection; returns its undo. */
  toggleWant: (cardId: CardId) => () => void;
  setWant: (cardId: CardId, binderId: BinderId | null, on: boolean) => void;

  isUpForTrade: (copy: Copy) => boolean;
  setUpForTrade: (copyId: CopyId, on: boolean) => void;

  cardRequests: CardRequest[];
  requestCard: (input: NewCardRequest) => CardRequest;

  createBinder: (input: NewBinder, label?: BinderLabel) => CollectionBinder;
  setBinderLabel: (binderId: BinderId, label: BinderLabel | null) => void;
  moveCopy: (copyId: CopyId, toBinderId: BinderId, slot?: PocketRef) => MoveResult | null;

  browseFilter: BrowseFilter;
  setBrowseFilter: (patch: Partial<BrowseFilter>) => void;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const STATE_VERSION = 3;
const STORAGE_KEY = "nb-collection-final";

export const MAIN_BINDER_ID = "binder-main";
export const WANT_BINDER_ID = "binder-want";
/** The seed's "Trade bait" binder, renamed and made a system binder. */
export const TRADE_BINDER_ID = "binder-trade-bait";
const OHTANI_BINDER_ID = "binder-ohtani-rainbow";
const SLAB_BINDER_ID = "binder-slab-case";

/**
 * Labels the collector picked for two seed binders, so the shelf shows a
 * chosen label beside the defaults: the Ohtani binder in Dodger blue, and the
 * slab case lettered like an equipment crate.
 */
const SEED_LABELS: Record<BinderId, BinderLabel> = {
  [OHTANI_BINDER_ID]: { background: "#005A9C", text: "#FFFFFF", fontId: "anton" },
  [SLAB_BINDER_ID]: { background: "#101820", text: "#FFE600", fontId: "stardos-stencil" },
};

const SYSTEM_ORDER: Record<SystemKind, number> = { main: 0, trade: 1, want: 2 };

/** The one card at (set, variant name, number). Throws unless exactly one. */
function seedRef(setId: SetId, variantName: string | null, cardNumber: string): CardId {
  const matches = catalogCards.filter(
    (c) =>
      c.setId === setId &&
      c.variantPath.name === variantName &&
      c.cardNumber === cardNumber &&
      c.variation === null,
  );
  if (matches.length !== 1) {
    throw new Error(`final store: ${setId} ${variantName ?? "Base"} #${cardNumber} matched ${matches.length}`);
  }
  return matches[0].id;
}

function seedState(): CollectionState {
  const copies = structuredClone(seedCopies).map((c) =>
    c.binderIds.length === 0 ? { ...c, binderIds: [MAIN_BINDER_ID] } : c,
  );
  const own: CollectionBinder[] = structuredClone(seedBinders).map((b): CollectionBinder =>
    b.id === TRADE_BINDER_ID
      ? {
          ...b,
          name: "Up for Trade",
          description: "Copies you'd move at a show or a swap.",
          system: "trade",
        }
      : SEED_LABELS[b.id]
        ? { ...b, label: SEED_LABELS[b.id] }
        : b,
  );
  const system: CollectionBinder[] = [
    {
      id: MAIN_BINDER_ID,
      kind: "manual",
      name: "Main",
      description: "Every card lands here until you file it somewhere else.",
      system: "main",
    },
    {
      id: WANT_BINDER_ID,
      kind: "manual",
      name: "Want List",
      description: "Cards you're chasing.",
      system: "want",
    },
  ];
  const chrome = "2024-topps-chrome-baseball";
  return {
    copies,
    binders: sortBinders([...system, ...own]),
    buildingSetIds: [...seedBuilding],
    wants: [
      { cardId: seedRef(chrome, "Orange Refractor", "1"), binderId: OHTANI_BINDER_ID },
      { cardId: seedRef(chrome, "Red Refractor", "1"), binderId: OHTANI_BINDER_ID },
      { cardId: seedRef(chrome, null, "12"), binderId: null },
      { cardId: seedRef("1996-playoff-contenders", null, "13"), binderId: null },
    ],
    selectedBinderId: "all",
    cardRequests: [],
    browseFilter: NO_BROWSE_FILTER,
    version: STATE_VERSION,
  };
}

/** System binders first (Main, Up for Trade, Want List), the rest as made. */
function sortBinders(binders: CollectionBinder[]): CollectionBinder[] {
  const rank = (b: CollectionBinder) => (b.system ? SYSTEM_ORDER[b.system] : 10);
  return binders
    .map((b, i) => ({ b, i }))
    .sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i)
    .map(({ b }) => b);
}

// ---------------------------------------------------------------------------
// Reducer (pure; exported for tests)
// ---------------------------------------------------------------------------

export type CollectionAction =
  | { type: "addCopy"; copy: Copy }
  | { type: "updateCopy"; id: CopyId; patch: Partial<CopyDetails> }
  | { type: "removeCopy"; id: CopyId }
  | { type: "restoreCopy"; copy: Copy; index: number }
  | { type: "toggleBuilding"; setId: SetId }
  | { type: "addToBinder"; copyId: CopyId; binderId: BinderId }
  | { type: "removeFromBinder"; copyId: CopyId; binderId: BinderId }
  | { type: "createBinder"; binder: CollectionBinder }
  | { type: "renameBinder"; binderId: BinderId; name: string }
  | { type: "deleteBinder"; binderId: BinderId }
  | { type: "placeInSlot"; binderId: BinderId; page: number; slot: number; copyId: CopyId | null }
  | { type: "setWants"; wants: Want[] }
  | { type: "select"; selection: BinderSelection }
  | { type: "requestCard"; request: CardRequest }
  | { type: "setLabel"; binderId: BinderId; label: BinderLabel | null }
  | { type: "moveCopy"; copyId: CopyId; to: BinderId; slot?: PocketRef }
  | {
      type: "restorePlacement";
      copyId: CopyId;
      binderIds: BinderId[];
      layouts: [BinderId, BinderPage[] | undefined][];
    }
  | { type: "setBrowseFilter"; patch: Partial<BrowseFilter> }
  | { type: "reset" };

/** Binders a copy may be filed in: manual, and not the Want List. */
function isFileable(b: CollectionBinder | undefined): boolean {
  return !!b && b.kind === "manual" && b.system !== "want";
}

/** Keep only fileable binder ids, de-duplicated; never empty (falls back to Main). */
function fileIds(state: CollectionState, ids: BinderId[]): BinderId[] {
  const out: BinderId[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    if (isFileable(state.binders.find((b) => b.id === id))) out.push(id);
  }
  return out.length > 0 ? out : [MAIN_BINDER_ID];
}

/** Where a new copy goes under this selection: the binder, else Main. */
export function targetFor(state: CollectionState): BinderId {
  const sel = state.selectedBinderId;
  return sel !== "all" && isFileable(state.binders.find((b) => b.id === sel)) ? sel : MAIN_BINDER_ID;
}

/** The binder copies are filtered to, or null when every copy is in scope. */
export function copyScope(state: CollectionState): BinderId | null {
  const sel = state.selectedBinderId;
  return sel !== "all" && isFileable(state.binders.find((b) => b.id === sel)) ? sel : null;
}

function unslot(
  binders: CollectionBinder[],
  copyId: CopyId,
  onlyBinder?: BinderId,
): CollectionBinder[] {
  return binders.map((b) => {
    if (b.kind !== "manual" || !b.layout) return b;
    if (onlyBinder && b.id !== onlyBinder) return b;
    if (!b.layout.some((p) => p.slots.includes(copyId))) return b;
    return {
      ...b,
      layout: b.layout.map((p) => ({ slots: p.slots.map((id) => (id === copyId ? null : id)) })),
    };
  });
}

/**
 * The binders a copy leaves when it moves to `to`. Up for Trade is a status
 * as much as a place, so a move leaves it alone, unless the move IS into Up
 * for Trade, or Up for Trade is the only other place the copy lives. A copy
 * already filed in `to` leaves nothing (the move only pockets it).
 */
export function movedFrom(copy: Copy, to: BinderId): BinderId[] {
  // Already filed there: a move only puts it in a pocket.
  if (copy.binderIds.includes(to)) return [];
  const others = copy.binderIds.filter((id) => id !== to);
  if (to === TRADE_BINDER_ID) return others;
  const homes = others.filter((id) => id !== TRADE_BINDER_ID);
  return homes.length > 0 ? homes : others;
}

export function collectionReducer(
  state: CollectionState,
  action: CollectionAction,
): CollectionState {
  switch (action.type) {
    case "addCopy":
      return {
        ...state,
        copies: [
          ...state.copies,
          { ...action.copy, binderIds: fileIds(state, action.copy.binderIds) },
        ],
      };
    case "updateCopy": {
      const patch = action.patch.binderIds
        ? { ...action.patch, binderIds: fileIds(state, action.patch.binderIds) }
        : action.patch;
      // Unfiling a copy from a binder also empties its pocket there.
      const before = state.copies.find((c) => c.id === action.id);
      let binders = state.binders;
      if (before && patch.binderIds) {
        for (const id of before.binderIds) {
          if (!patch.binderIds.includes(id)) binders = unslot(binders, action.id, id);
        }
      }
      return {
        ...state,
        binders,
        copies: state.copies.map((c) => (c.id === action.id ? { ...c, ...patch } : c)),
      };
    }
    case "removeCopy":
      return {
        ...state,
        copies: state.copies.filter((c) => c.id !== action.id),
        binders: unslot(state.binders, action.id),
      };
    case "restoreCopy": {
      if (state.copies.some((c) => c.id === action.copy.id)) return state;
      const copies = [...state.copies];
      copies.splice(Math.min(action.index, copies.length), 0, {
        ...action.copy,
        binderIds: fileIds(state, action.copy.binderIds),
      });
      return { ...state, copies };
    }
    case "toggleBuilding":
      return {
        ...state,
        buildingSetIds: state.buildingSetIds.includes(action.setId)
          ? state.buildingSetIds.filter((id) => id !== action.setId)
          : [...state.buildingSetIds, action.setId],
      };
    case "addToBinder": {
      if (!isFileable(state.binders.find((b) => b.id === action.binderId))) return state;
      return {
        ...state,
        copies: state.copies.map((c) =>
          c.id === action.copyId && !c.binderIds.includes(action.binderId)
            ? { ...c, binderIds: [...c.binderIds, action.binderId] }
            : c,
        ),
      };
    }
    case "removeFromBinder":
      return {
        ...state,
        copies: state.copies.map((c) => {
          if (c.id !== action.copyId) return c;
          const rest = c.binderIds.filter((id) => id !== action.binderId);
          // Never zero binders: the last one out sends it home to Main.
          return { ...c, binderIds: rest.length > 0 ? rest : [MAIN_BINDER_ID] };
        }),
        binders: unslot(state.binders, action.copyId, action.binderId),
      };
    case "createBinder":
      return { ...state, binders: sortBinders([...state.binders, action.binder]) };
    case "renameBinder": {
      const name = action.name.trim();
      const target = state.binders.find((b) => b.id === action.binderId);
      if (!target || target.system || !name) return state;
      return {
        ...state,
        binders: state.binders.map((b) => (b.id === action.binderId ? { ...b, name } : b)),
      };
    }
    case "deleteBinder": {
      const target = state.binders.find((b) => b.id === action.binderId);
      if (!target || target.system) return state;
      return {
        ...state,
        binders: state.binders.filter((b) => b.id !== action.binderId),
        copies: state.copies.map((c) => {
          if (!c.binderIds.includes(action.binderId)) return c;
          const rest = c.binderIds.filter((id) => id !== action.binderId);
          return { ...c, binderIds: rest.length > 0 ? rest : [MAIN_BINDER_ID] };
        }),
        // A want for a binder that is gone is still a want: it goes unscoped.
        wants: dedupeWants(
          state.wants.map((w) => (w.binderId === action.binderId ? { ...w, binderId: null } : w)),
        ),
        selectedBinderId:
          state.selectedBinderId === action.binderId ? "all" : state.selectedBinderId,
      };
    }
    case "placeInSlot": {
      const { binderId, page, slot, copyId } = action;
      if (!isFileable(state.binders.find((b) => b.id === binderId))) return state;
      const binders = copyId ? unslot(state.binders, copyId, binderId) : state.binders;
      return {
        ...state,
        binders: binders.map((b) => {
          if (b.id !== binderId || b.kind !== "manual") return b;
          const layout = (b.layout ?? []).map((p) => ({ slots: [...p.slots] }));
          while (layout.length <= page) layout.push({ slots: Array(9).fill(null) });
          layout[page].slots[slot] = copyId;
          return { ...b, layout };
        }),
        copies: copyId
          ? state.copies.map((c) =>
              c.id === copyId && !c.binderIds.includes(binderId)
                ? { ...c, binderIds: [...c.binderIds, binderId] }
                : c,
            )
          : state.copies,
      };
    }
    case "setWants":
      return { ...state, wants: dedupeWants(action.wants) };
    case "select": {
      const sel = action.selection;
      if (sel !== "all" && !state.binders.some((b) => b.id === sel && b.kind === "manual")) {
        return state;
      }
      return { ...state, selectedBinderId: sel };
    }
    case "requestCard":
      return { ...state, cardRequests: [action.request, ...state.cardRequests] };
    case "setLabel":
      return {
        ...state,
        binders: state.binders.map((b) => {
          if (b.id !== action.binderId) return b;
          if (action.label) return { ...b, label: action.label };
          const plain = { ...b };
          delete plain.label;
          return plain;
        }),
      };
    case "moveCopy": {
      const { copyId, to, slot } = action;
      const copy = state.copies.find((c) => c.id === copyId);
      if (!copy || !isFileable(state.binders.find((b) => b.id === to))) return state;
      const from = movedFrom(copy, to);
      let binders = state.binders;
      for (const id of from) binders = unslot(binders, copyId, id);
      const binderIds = [...copy.binderIds.filter((id) => id !== to && !from.includes(id)), to];
      const moved: CollectionState = {
        ...state,
        binders,
        copies: state.copies.map((c) => (c.id === copyId ? { ...c, binderIds } : c)),
      };
      return slot
        ? collectionReducer(moved, { type: "placeInSlot", binderId: to, page: slot.page, slot: slot.slot, copyId })
        : moved;
    }
    case "restorePlacement": {
      const layouts = new Map(action.layouts);
      return {
        ...state,
        copies: state.copies.map((c) => (c.id === action.copyId ? { ...c, binderIds: action.binderIds } : c)),
        binders: state.binders.map((b) =>
          b.kind === "manual" && layouts.has(b.id) ? { ...b, layout: layouts.get(b.id) } : b,
        ),
      };
    }
    case "setBrowseFilter":
      return { ...state, browseFilter: { ...state.browseFilter, ...action.patch } };
    case "reset":
      return seedState();
  }
}

function dedupeWants(wants: Want[]): Want[] {
  const seen = new Set<string>();
  return wants.filter((w) => {
    const key = `${w.cardId}|${w.binderId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function initialCollectionState(): CollectionState {
  return seedState();
}

function loadState(): CollectionState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CollectionState;
      if (parsed.version === STATE_VERSION) return parsed;
    }
  } catch {
    // Unavailable or corrupt storage: start from the seed.
  }
  return seedState();
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/** Two line items are the same stack when everything but quantity and date match. */
export function sameLineItem(a: CopyDetails, b: CopyDetails): boolean {
  const sameBinders =
    a.binderIds.length === b.binderIds.length && a.binderIds.every((id) => b.binderIds.includes(id));
  return (
    sameBinders &&
    (a.condition ?? null) === (b.condition ?? null) &&
    (a.graded?.grader ?? null) === (b.graded?.grader ?? null) &&
    (a.graded?.grade ?? null) === (b.graded?.grade ?? null) &&
    // A cert or a serial makes a copy one of a kind: never folded.
    !a.graded?.cert &&
    !b.graded?.cert &&
    !a.serialNumber &&
    !b.serialNumber &&
    (a.costBasis ?? null) === (b.costBasis ?? null) &&
    (a.location ?? "") === (b.location ?? "") &&
    a.notes.trim() === b.notes.trim() &&
    a.forSale === b.forSale &&
    (a.askPrice ?? null) === (b.askPrice ?? null)
  );
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCollectionStore(): CollectionStore {
  const [state, dispatch] = useReducer(collectionReducer, undefined, loadState);

  // Callbacks read the latest state through a ref so removeCopy can hand back
  // what it removed without re-creating every action on each change.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the page keeps working in memory.
    }
  }, [state]);

  const removedAt = useRef(
    new Map<CopyId, { index: number; pockets: [BinderId, number, number][] }>(),
  );

  const addCopy = useCallback((cardId: CardId, details?: Partial<CopyDetails>) => {
    const binderIds = fileIds(
      stateRef.current,
      details?.binderIds ?? [targetFor(stateRef.current)],
    );
    const copy: Copy = { ...emptyCopyDetails(), ...details, binderIds, id: newId("copy"), cardId };
    stateRef.current = { ...stateRef.current, copies: [...stateRef.current.copies, copy] };
    dispatch({ type: "addCopy", copy });
    return copy;
  }, []);

  const updateCopy = useCallback(
    (id: CopyId, patch: Partial<CopyDetails>) => dispatch({ type: "updateCopy", id, patch }),
    [],
  );

  const removeCopy = useCallback((id: CopyId) => {
    const copies = stateRef.current.copies;
    const index = copies.findIndex((c) => c.id === id);
    if (index === -1) return undefined;
    const pockets: [BinderId, number, number][] = [];
    for (const b of stateRef.current.binders) {
      if (b.kind !== "manual" || !b.layout) continue;
      b.layout.forEach((p, page) =>
        p.slots.forEach((slotId, slot) => {
          if (slotId === id) pockets.push([b.id, page, slot]);
        }),
      );
    }
    removedAt.current.set(id, { index, pockets });
    stateRef.current = { ...stateRef.current, copies: copies.filter((c) => c.id !== id) };
    dispatch({ type: "removeCopy", id });
    return copies[index];
  }, []);

  const restoreCopy = useCallback((copy: Copy) => {
    const memo = removedAt.current.get(copy.id);
    removedAt.current.delete(copy.id);
    dispatch({ type: "restoreCopy", copy, index: memo?.index ?? Number.MAX_SAFE_INTEGER });
    for (const [binderId, page, slot] of memo?.pockets ?? []) {
      dispatch({ type: "placeInSlot", binderId, page, slot, copyId: copy.id });
    }
  }, []);

  const toggleBuilding = useCallback(
    (setId: SetId) => dispatch({ type: "toggleBuilding", setId }),
    [],
  );
  const addToBinder = useCallback(
    (copyId: CopyId, binderId: BinderId) => dispatch({ type: "addToBinder", copyId, binderId }),
    [],
  );
  const removeFromBinder = useCallback(
    (copyId: CopyId, binderId: BinderId) =>
      dispatch({ type: "removeFromBinder", copyId, binderId }),
    [],
  );

  const createBinder = useCallback((input: NewBinder, label?: BinderLabel) => {
    const id = newId("binder");
    const made: CollectionBinder =
      input.kind === "smart"
        ? { id, kind: "smart", name: input.name, description: input.description, rule: input.rule }
        : {
            id,
            kind: "manual",
            name: input.name,
            description: input.description,
            layout: input.pages
              ? Array.from({ length: input.pages }, () => ({ slots: Array(9).fill(null) }))
              : undefined,
          };
    const binder = label ? { ...made, label } : made;
    dispatch({ type: "createBinder", binder });
    return binder;
  }, []);

  const setBinderLabel = useCallback(
    (binderId: BinderId, label: BinderLabel | null) => dispatch({ type: "setLabel", binderId, label }),
    [],
  );

  const moveCopy = useCallback((copyId: CopyId, to: BinderId, slot?: PocketRef): MoveResult | null => {
    const before = stateRef.current;
    const copy = before.copies.find((c) => c.id === copyId);
    if (!copy || !isFileable(before.binders.find((b) => b.id === to))) return null;
    if (copy.binderIds.includes(to) && !slot) return null;
    const from = movedFrom(copy, to);
    // Everything the move can touch, as it was: the copy's binders and every
    // layout it leaves or lands in.
    const touched = new Set([...from, to]);
    const layouts = before.binders
      .filter((b) => touched.has(b.id))
      .map((b): [BinderId, BinderPage[] | undefined] => [b.id, b.kind === "manual" ? b.layout : undefined]);
    const binderIds = [...copy.binderIds];
    const next = collectionReducer(before, { type: "moveCopy", copyId, to, slot });
    stateRef.current = next;
    dispatch({ type: "moveCopy", copyId, to, slot });
    return {
      from,
      undo: () => {
        dispatch({ type: "restorePlacement", copyId, binderIds, layouts });
      },
    };
  }, []);

  const setBrowseFilter = useCallback(
    (patch: Partial<BrowseFilter>) => dispatch({ type: "setBrowseFilter", patch }),
    [],
  );

  const renameBinder = useCallback((binderId: BinderId, name: string) => {
    const b = stateRef.current.binders.find((x) => x.id === binderId);
    if (!b || b.system || !name.trim()) return false;
    dispatch({ type: "renameBinder", binderId, name });
    return true;
  }, []);

  const deleteBinder = useCallback((binderId: BinderId) => {
    const b = stateRef.current.binders.find((x) => x.id === binderId);
    if (!b || b.system) return false;
    dispatch({ type: "deleteBinder", binderId });
    return true;
  }, []);

  const placeInSlot = useCallback(
    (binderId: BinderId, page: number, slot: number, copyId: CopyId | null) =>
      dispatch({ type: "placeInSlot", binderId, page, slot, copyId }),
    [],
  );

  const setWant = useCallback((cardId: CardId, binderId: BinderId | null, on: boolean) => {
    const wants = stateRef.current.wants;
    const has = wants.some((w) => w.cardId === cardId && w.binderId === binderId);
    if (has === on) return;
    const next = on
      ? [...wants, { cardId, binderId }]
      : wants.filter((w) => !(w.cardId === cardId && w.binderId === binderId));
    stateRef.current = { ...stateRef.current, wants: next };
    dispatch({ type: "setWants", wants: next });
  }, []);

  const toggleWant = useCallback((cardId: CardId) => {
    const before = stateRef.current.wants;
    const scope = copyScope(stateRef.current);
    let next: Want[];
    if (scope) {
      const has = before.some((w) => w.cardId === cardId && w.binderId === scope);
      next = has
        ? before.filter((w) => !(w.cardId === cardId && w.binderId === scope))
        : [...before, { cardId, binderId: scope }];
    } else {
      const any = before.some((w) => w.cardId === cardId);
      next = any ? before.filter((w) => w.cardId !== cardId) : [...before, { cardId, binderId: null }];
    }
    stateRef.current = { ...stateRef.current, wants: next };
    dispatch({ type: "setWants", wants: next });
    return () => {
      stateRef.current = { ...stateRef.current, wants: before };
      dispatch({ type: "setWants", wants: before });
    };
  }, []);

  const setUpForTrade = useCallback((copyId: CopyId, on: boolean) => {
    dispatch(
      on
        ? { type: "addToBinder", copyId, binderId: TRADE_BINDER_ID }
        : { type: "removeFromBinder", copyId, binderId: TRADE_BINDER_ID },
    );
  }, []);

  const setSelectedBinder = useCallback((selection: BinderSelection) => {
    stateRef.current = { ...stateRef.current, selectedBinderId: selection };
    dispatch({ type: "select", selection });
  }, []);

  const addHave = useCallback(
    (cardId: CardId) => addCopy(cardId, { quantity: 1, binderIds: [targetFor(stateRef.current)] }),
    [addCopy],
  );

  const addLineItem = useCallback(
    (cardId: CardId, details: CopyDetails): AddLineItemResult => {
      const normalized: CopyDetails = {
        ...details,
        binderIds: fileIds(stateRef.current, details.binderIds),
      };
      const twin = stateRef.current.copies.find(
        (c) => c.cardId === cardId && sameLineItem(c, normalized),
      );
      if (twin) {
        const before = twin.quantity;
        const prevDate = twin.acquiredAt;
        const quantity = before + normalized.quantity;
        const acquiredAt = prevDate <= normalized.acquiredAt ? prevDate : normalized.acquiredAt;
        dispatch({ type: "updateCopy", id: twin.id, patch: { quantity, acquiredAt } });
        return {
          copy: { ...twin, quantity, acquiredAt },
          merged: true,
          undo: () =>
            dispatch({
              type: "updateCopy",
              id: twin.id,
              patch: { quantity: before, acquiredAt: prevDate },
            }),
        };
      }
      const copy = addCopy(cardId, normalized);
      return { copy, merged: false, undo: () => void removeCopy(copy.id) };
    },
    [addCopy, removeCopy],
  );

  const requestCard = useCallback((input: NewCardRequest) => {
    const request: CardRequest = {
      ...input,
      id: newId("request"),
      requestedAt: emptyCopyDetails().acquiredAt,
    };
    dispatch({ type: "requestCard", request });
    return request;
  }, []);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return useMemo<CollectionStore>(() => {
    const getBinder = (binderId: BinderId) => state.binders.find((b) => b.id === binderId);
    const systemBinder = (kind: SystemKind) => {
      const b = state.binders.find((x) => x.system === kind);
      if (!b) throw new Error(`final store: no ${kind} binder`);
      return b;
    };
    const scope = copyScope(state);
    const scopedCopies = scope ? state.copies.filter((c) => c.binderIds.includes(scope)) : state.copies;
    const wantCardIds = [...new Set(state.wants.map((w) => w.cardId))];
    return {
      state,
      addCopy,
      updateCopy,
      removeCopy,
      restoreCopy,
      toggleBuilding,
      addToBinder,
      removeFromBinder,
      createBinder,
      placeInSlot,
      reset,
      ownedCount: (cardId) => ownedCountFor(cardId, state.copies),
      copiesOf: (cardId) => copiesOfFor(cardId, state.copies),
      isBuilding: (setId) => state.buildingSetIds.includes(setId),
      completion: (setId, variant) => setCompletionFor(setId, variant, state.copies),
      binderCards: (binder): Card[] =>
        binder.id === WANT_BINDER_ID
          ? wantCardIds.map(getCard).sort(compareCards)
          : binderCardsFor(binder, state.copies),
      binderCopies: (binder) =>
        binder.id === WANT_BINDER_ID ? [] : binderCopiesFor(binder, state.copies),
      getBinder,

      mainBinderId: MAIN_BINDER_ID,
      wantBinderId: WANT_BINDER_ID,
      tradeBinderId: TRADE_BINDER_ID,
      systemBinder,
      isSystem: (binderId) => !!getBinder(binderId)?.system,
      fileableBinders: state.binders.filter(isFileable),
      ownBinders: state.binders.filter((b) => !b.system),
      renameBinder,
      deleteBinder,

      selectedBinderId: state.selectedBinderId,
      setSelectedBinder,
      targetBinderId: targetFor(state),
      setTargetBinder: setSelectedBinder,
      scopedCopies,
      copiesInScope: (cardId) => copiesOfFor(cardId, scopedCopies),
      ownedInScope: (cardId) => ownedCountFor(cardId, scopedCopies),
      completionInScope: (setId, variant) => setCompletionFor(setId, variant, scopedCopies),
      addHave,
      addLineItem,

      wants: state.wants,
      wantCardIds,
      wantsByBinder: () => {
        const groups = new Map<BinderId | null, Card[]>();
        groups.set(null, []);
        for (const b of state.binders) if (isFileable(b)) groups.set(b.id, []);
        for (const w of state.wants) {
          const key = groups.has(w.binderId) ? w.binderId : null;
          groups.get(key)!.push(getCard(w.cardId));
        }
        return [...groups]
          .filter(([, list]) => list.length > 0)
          .map(([binderId, list]) => ({ binderId, cards: list.sort(compareCards) }));
      },
      isWanted: (cardId) =>
        scope
          ? state.wants.some((w) => w.cardId === cardId && w.binderId === scope)
          : state.wants.some((w) => w.cardId === cardId),
      toggleWant,
      setWant,

      isUpForTrade: (copy) => copy.binderIds.includes(TRADE_BINDER_ID),
      setUpForTrade,

      cardRequests: state.cardRequests,
      requestCard,

      setBinderLabel,
      moveCopy,
      browseFilter: state.browseFilter,
      setBrowseFilter,
    };
  }, [
    state,
    addCopy,
    updateCopy,
    removeCopy,
    restoreCopy,
    toggleBuilding,
    addToBinder,
    removeFromBinder,
    createBinder,
    placeInSlot,
    reset,
    renameBinder,
    deleteBinder,
    setWant,
    toggleWant,
    setUpForTrade,
    setSelectedBinder,
    addHave,
    addLineItem,
    requestCard,
    setBinderLabel,
    moveCopy,
    setBrowseFilter,
  ]);
}
