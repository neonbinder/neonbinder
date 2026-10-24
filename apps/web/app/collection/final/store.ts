/**
 * NEO-350 / NEO-358 / NEO-359 — the collection DEMO's reducer store.
 *
 * Hard-coded fake data only, seeded from the shared catalog and collector
 * (`../prototypes/_shared/`) and kept in sessionStorage: under
 * `nb-collection-final` by default and `PUBLIC_STORAGE_KEY` in the public
 * demo on `/binder-tracking`, so the two never mix. Nothing reaches a server.
 *
 * Views never read this. `./data/demoStore` wraps it behind the shared store
 * contract (`./data/store`), the same contract the Convex store answers, and
 * that is all a view sees.
 *
 * ## The model (NEO-359, the same as the real collection's)
 *
 * - A copy (line item) has ONE home: `homeId`, a binder or a box. It is for
 *   sale exactly when its home is a box. `slot` is where inside its home: a
 *   binder pocket (`page * 9 + pocket`, one line item per pocket) or a box
 *   row (0-4, many per row). `upForTrade` flags it for the Up for Trade pile
 *   without moving it.
 * - Containers: three system ones every collector has (`main`, `trade`,
 *   `want`), then the collector's own binders and boxes. A binder with a
 *   `rule` is a smart binder: it fills itself, and is never a home. Neither
 *   is the Want List (it holds wants) nor the Up for Trade pile.
 * - Wants are `{ cardId, binderId | null }`: "for my Ohtani rainbow", or
 *   just "want it". One per card.
 *
 * Every write is a pure op (`demoOps`) over the whole state that returns the
 * next state and what it did, or throws a `DemoRefusal` with the words to
 * show. `useDemoCollectionState().run(op)` applies one.
 *
 * Writes that a collector would call "the same stack" fold: two line items
 * are one when everything but quantity and date matches (home, pocket or
 * row, trade flag included), and never when either has a cert or a serial.
 * `updateCopy` never folds and never changes a home (that is `moveCopy`).
 *
 * ---------------------------------------------------------------------------
 * Props contract for the three tabs (My Cards, My Binders, Checklists)
 * ---------------------------------------------------------------------------
 *
 *   type CollectionTab = "cards" | "binders" | "checklists";   // ?tab=
 *
 * - `goToTab("checklists", { q })` opens Checklists with that search
 *   prefilled; `goToTab("checklists", { cardId })` opens that card's
 *   checklist and rings its row. Any tab may be passed without params.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  binders as seedBinders,
  buildingSetIds as seedBuilding,
  cards as catalogCards,
  myCopies as seedCopies,
  type BinderRule,
  type CardId,
  type Copy as FixtureCopy,
  type CopyId,
  type SetId,
} from "../prototypes/_shared/data";
import {
  BOX_ROWS,
  isHome,
  MAX_BINDER_PAGES,
  MAX_CONTAINERS,
  MAX_WANTS,
  POCKETS_PER_PAGE,
  type Container,
  type ContainerId,
  type ContainerLabel,
  type ContainerPatch,
  type ContainerRule,
  type CopyDetails,
  type NewContainer,
  type Scope,
  type Want,
} from "./data/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A copy as the demo stores it. */
export type DemoCopy = Omit<CopyDetails, "homeId"> & {
  id: CopyId;
  cardId: CardId;
  homeId: ContainerId;
};

/** A container as the demo stores it (counts are derived, never stored). */
export type DemoContainer = Omit<Container, "count">;

/** @deprecated NEO-359: a binder is a `Container` now (`./data/types`). */
export type CollectionBinder = Container;
/** @deprecated NEO-359: `ContainerLabel` (`./data/types`). */
export type BinderLabel = ContainerLabel;
/** @deprecated NEO-359: `Scope` (`./data/types`). */
export type BinderSelection = Scope;
export type { Want };

/** Browse a set's filters. `from` / `to` are years, inclusive; null is open. `sport` is a sport id. */
export interface BrowseFilter {
  sport: string | "all";
  from: number | null;
  to: number | null;
  q: string;
}

export const NO_BROWSE_FILTER: BrowseFilter = { sport: "all", from: null, to: null, q: "" };

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

export interface CollectionState {
  copies: DemoCopy[];
  containers: DemoContainer[];
  wants: Want[];
  buildingSetIds: SetId[];
  cardRequests: CardRequest[];
  browseFilter: BrowseFilter;
  /** Bumped when the stored shape changes; a mismatch reseeds. */
  version: number;
}

export type CollectionTab = "cards" | "binders" | "checklists";

export interface GoToTabParams {
  /** Checklists: prefill the search box. */
  q?: string;
  /** Checklists: open this card's checklist and ring its row. */
  cardId?: CardId;
}

export type Notify = (message: string, undo?: () => void) => void;

/** A write the demo refuses, with the words to show on the status line. */
export class DemoRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoRefusal";
  }
}

/** One write: the next state and what it did. */
export interface OpResult<T> {
  state: CollectionState;
  result: T;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** v4 (NEO-359): one home per copy, slots, trade flag, the Show box. */
const STATE_VERSION = 4;
const STORAGE_KEY = "nb-collection-final";
/** The public demo's own sessionStorage key (never the app's). */
export const PUBLIC_STORAGE_KEY = "nb-collection-demo-public";

export const MAIN_BINDER_ID = "binder-main";
export const WANT_BINDER_ID = "binder-want";
/** The seed's "Trade bait" binder, now the system Up for Trade pile. */
export const TRADE_BINDER_ID = "binder-trade-bait";
/** The seed's box: the cards for sale at the next show. */
export const SHOW_BOX_ID = "box-show";
const CONTENDERS_BINDER_ID = "binder-contenders-96";
const OHTANI_BINDER_ID = "binder-ohtani-rainbow";
const SLAB_BINDER_ID = "binder-slab-case";

/**
 * Labels the collector picked for two seed binders, so the shelf shows a
 * chosen label beside the defaults: the Ohtani binder in Dodger blue, and the
 * slab case lettered like an equipment crate.
 */
const SEED_LABELS: Record<ContainerId, ContainerLabel> = {
  [OHTANI_BINDER_ID]: { background: "#005A9C", text: "#FFFFFF", fontId: "anton" },
  [SLAB_BINDER_ID]: { background: "#101820", text: "#FFE600", fontId: "stardos-stencil" },
};

const SYSTEM_ORDER: Record<NonNullable<Container["system"]>, number> = { main: 0, trade: 1, want: 2 };

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

/**
 * The Show box's rows for the seed's for-sale copies, by copy: football up
 * front, the hockey stack behind it. One is left unsorted, so the box shows
 * its "not sorted into a row yet" strip.
 */
function showBoxRow(copy: FixtureCopy): number | undefined {
  const card = catalogCards.find((c) => c.id === copy.cardId);
  if (!card) return undefined;
  if (card.setId === "2024-topps-chrome-baseball") return undefined;
  return card.setId === "1996-97-upper-deck-hockey" ? 1 : 0;
}

/** The prototype seed's copy as the demo's: one home, a slot, the trade flag. */
function seedCopy(copy: FixtureCopy, pockets: Map<CopyId, [ContainerId, number]>): DemoCopy {
  const { binderIds, forSale, askPrice: _askPrice, ...details } = copy;
  const wasTradeBait = binderIds.includes(TRADE_BINDER_ID);
  const binder = binderIds.find((id) => id !== TRADE_BINDER_ID);
  const pocket = pockets.get(copy.id);
  let homeId: ContainerId;
  let slot: number | undefined;
  if (forSale) {
    homeId = SHOW_BOX_ID;
    slot = showBoxRow(copy);
  } else {
    homeId = binder ?? MAIN_BINDER_ID;
    slot = pocket && pocket[0] === homeId ? pocket[1] : undefined;
  }
  // The dupes in Trade bait are what the collector would swap; the big
  // singles there are for sale only.
  const upForTrade = wasTradeBait && (copy.quantity > 1 || !copy.serialNumber) && copy.costBasis === undefined;
  return {
    ...details,
    id: copy.id,
    cardId: copy.cardId,
    homeId,
    upForTrade,
    ...(slot === undefined ? {} : { slot }),
  };
}

function seedState(): CollectionState {
  const pockets = new Map<CopyId, [ContainerId, number]>();
  for (const b of seedBinders) {
    if (b.kind !== "manual" || !b.layout) continue;
    b.layout.forEach((page, p) =>
      page.slots.forEach((id, s) => {
        if (id) pockets.set(id, [b.id, p * POCKETS_PER_PAGE + s]);
      }),
    );
  }
  const copies = structuredClone(seedCopies).map((c) => seedCopy(c, pockets));

  const own: DemoContainer[] = [];
  for (const b of structuredClone(seedBinders)) {
    if (b.id === TRADE_BINDER_ID) continue;
    const label = SEED_LABELS[b.id];
    own.push({
      id: b.id,
      kind: "binder",
      name: b.name,
      ...(b.description ? { description: b.description } : {}),
      ...(label ? { label } : {}),
      ...(b.kind === "smart" ? { rule: b.rule as ContainerRule } : {}),
    });
  }
  // The box sits right after the set-build binder, as if made second.
  const at = Math.max(0, own.findIndex((b) => b.id === CONTENDERS_BINDER_ID) + 1);
  own.splice(at, 0, {
    id: SHOW_BOX_ID,
    kind: "box",
    name: "Show box",
    description: "Priced and sorted for the next card show.",
  });

  const system: DemoContainer[] = [
    {
      id: MAIN_BINDER_ID,
      kind: "binder",
      name: "Main",
      description: "Every card lands here until you file it somewhere else.",
      system: "main",
    },
    {
      id: TRADE_BINDER_ID,
      kind: "binder",
      name: "Up for Trade",
      description: "Copies you'd move at a show or a swap.",
      system: "trade",
    },
    {
      id: WANT_BINDER_ID,
      kind: "binder",
      name: "Want List",
      description: "Cards you're chasing.",
      system: "want",
    },
  ];
  const chrome = "2024-topps-chrome-baseball";
  return {
    copies,
    containers: sortContainers([...system, ...own]),
    buildingSetIds: [...seedBuilding],
    wants: [
      { cardId: seedRef(chrome, "Orange Refractor", "1"), binderId: OHTANI_BINDER_ID },
      { cardId: seedRef(chrome, "Red Refractor", "1"), binderId: OHTANI_BINDER_ID },
      { cardId: seedRef(chrome, null, "12"), binderId: null },
      { cardId: seedRef("1996-playoff-contenders", null, "13"), binderId: null },
    ],
    cardRequests: [],
    browseFilter: NO_BROWSE_FILTER,
    version: STATE_VERSION,
  };
}

/** System containers first (Main, Up for Trade, Want List), the rest as made. */
function sortContainers(containers: DemoContainer[]): DemoContainer[] {
  const rank = (c: DemoContainer) => (c.system ? SYSTEM_ORDER[c.system] : 10);
  return containers
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
    .map(({ c }) => c);
}

export function initialCollectionState(): CollectionState {
  return seedState();
}

function loadState(storageKey: string): CollectionState {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
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
// Reading the state (pure; exported for the demo store and tests)
// ---------------------------------------------------------------------------

export function containerIn(state: CollectionState, id: ContainerId): DemoContainer | undefined {
  return state.containers.find((c) => c.id === id);
}

/** Where a new copy goes: `homeId` when it is a home, else Main. */
export function homeFor(state: CollectionState, homeId: ContainerId | undefined): ContainerId {
  return homeId && isHome(containerIn(state, homeId)) ? homeId : MAIN_BINDER_ID;
}

/** A copy's id → its index, or throws the refusal a view shows. */
function indexOfCopy(state: CollectionState, id: CopyId): number {
  const i = state.copies.findIndex((c) => c.id === id);
  if (i === -1) throw new DemoRefusal("That copy is already gone.");
  return i;
}

/** Two line items are the same stack when everything but quantity and date match. */
export function sameLineItem(a: Omit<DemoCopy, "id" | "cardId">, b: Omit<DemoCopy, "id" | "cardId">): boolean {
  return (
    a.homeId === b.homeId &&
    (a.slot ?? null) === (b.slot ?? null) &&
    !!a.upForTrade === !!b.upForTrade &&
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
    a.notes.trim() === b.notes.trim()
  );
}

/** The line item already holding a binder pocket, other than `except`. */
function pocketHolder(state: CollectionState, homeId: ContainerId, slot: number, except: ReadonlySet<CopyId>) {
  const home = containerIn(state, homeId);
  if (!home || home.kind !== "binder") return undefined;
  return state.copies.find((c) => c.homeId === homeId && c.slot === slot && !except.has(c.id));
}

function checkSlot(state: CollectionState, homeId: ContainerId, slot: number | undefined) {
  if (slot === undefined) return;
  if (!Number.isInteger(slot) || slot < 0) throw new DemoRefusal("That isn't a pocket or a row.");
  const home = containerIn(state, homeId);
  if (home?.kind === "box" && slot >= BOX_ROWS) throw new DemoRefusal(`A box has ${BOX_ROWS} rows.`);
  if (home?.kind === "binder" && slot >= POCKETS_PER_PAGE * MAX_BINDER_PAGES) {
    throw new DemoRefusal(`A binder runs to ${MAX_BINDER_PAGES.toLocaleString("en-US")} pages.`);
  }
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Copy fields as stored: blanks dropped, so a fold compares like with like. */
function clean<T extends Omit<DemoCopy, "id" | "cardId">>(copy: T): T {
  const out = { ...copy };
  if (out.slot === undefined) delete out.slot;
  if (!out.upForTrade) out.upForTrade = false;
  return out;
}

// ---------------------------------------------------------------------------
// Writes (pure; each returns the next state and what it did, or throws)
// ---------------------------------------------------------------------------

export interface AddLineResult {
  copyId: CopyId;
  merged: boolean;
  /** The folded row's quantity and date before the add (for the undo). */
  previous?: { quantity: number; acquiredAt: string };
}

export interface MoveOpResult {
  copyId: CopyId;
  folded: boolean;
  split: boolean;
  from: { homeId: ContainerId; slot?: number; quantity: number };
}

export interface RemoveOpResult {
  removed: DemoCopy;
  index: number;
}

export const demoOps = {
  /** A copy (folding into an identical one unless `fold` is false), in `details.homeId` or Main. */
  addLine(
    state: CollectionState,
    cardId: CardId,
    details: CopyDetails,
    fold = true,
  ): OpResult<AddLineResult> {
    const homeId = homeFor(state, details.homeId);
    checkSlot(state, homeId, details.slot);
    const quantity = Math.max(1, Math.floor(details.quantity));
    const line = clean({ ...details, quantity, homeId });
    const twin = fold ? state.copies.find((c) => c.cardId === cardId && sameLineItem(c, line)) : undefined;
    if (twin) {
      const acquiredAt = twin.acquiredAt <= line.acquiredAt ? twin.acquiredAt : line.acquiredAt;
      return {
        state: {
          ...state,
          copies: state.copies.map((c) =>
            c.id === twin.id ? { ...c, quantity: c.quantity + quantity, acquiredAt } : c,
          ),
        },
        result: { copyId: twin.id, merged: true, previous: { quantity: twin.quantity, acquiredAt: twin.acquiredAt } },
      };
    }
    if (line.slot !== undefined && pocketHolder(state, homeId, line.slot, new Set())) {
      throw new DemoRefusal("That pocket already holds a card.");
    }
    const copy: DemoCopy = { ...line, id: newId("copy"), cardId };
    return { state: { ...state, copies: [...state.copies, copy] }, result: { copyId: copy.id, merged: false } };
  },

  /** Edits a copy in place. Never folds; refuses a change of home. */
  updateCopy(state: CollectionState, id: CopyId, patch: Partial<CopyDetails>): OpResult<Partial<CopyDetails>> {
    const i = indexOfCopy(state, id);
    const before = state.copies[i];
    if (patch.homeId !== undefined && patch.homeId !== before.homeId) {
      throw new DemoRefusal("Move the card to change where it lives.");
    }
    const { homeId: _homeId, ...rest } = patch;
    if ("slot" in rest) {
      checkSlot(state, before.homeId, rest.slot);
      if (rest.slot !== undefined && pocketHolder(state, before.homeId, rest.slot, new Set([id]))) {
        throw new DemoRefusal("That pocket already holds a card.");
      }
    }
    if (rest.quantity !== undefined) rest.quantity = Math.max(1, Math.floor(rest.quantity));
    const previous: Partial<CopyDetails> = {};
    for (const key of Object.keys(rest) as (keyof typeof rest)[]) {
      (previous as Record<string, unknown>)[key] = before[key];
    }
    const next = clean({ ...before, ...rest }) as DemoCopy;
    const copies = [...state.copies];
    copies[i] = next;
    return { state: { ...state, copies }, result: previous };
  },

  removeCopy(state: CollectionState, id: CopyId): OpResult<RemoveOpResult> {
    const index = indexOfCopy(state, id);
    return {
      state: { ...state, copies: state.copies.filter((c) => c.id !== id) },
      result: { removed: state.copies[index], index },
    };
  },

  /** Puts a removed copy back as its own row (never folded), where it was in the list. */
  restoreCopy(state: CollectionState, copy: DemoCopy, index = Number.MAX_SAFE_INTEGER): OpResult<CopyId> {
    if (state.copies.some((c) => c.id === copy.id)) return { state, result: copy.id };
    const homeId = homeFor(state, copy.homeId);
    const taken = copy.slot !== undefined && pocketHolder(state, homeId, copy.slot, new Set());
    const back = clean({ ...copy, homeId, ...(homeId !== copy.homeId || taken ? { slot: undefined } : {}) }) as DemoCopy;
    const copies = [...state.copies];
    copies.splice(Math.min(index, copies.length), 0, back);
    return { state: { ...state, copies }, result: copy.id };
  },

  setBuilding(state: CollectionState, setId: SetId, building: boolean): OpResult<boolean> {
    const has = state.buildingSetIds.includes(setId);
    if (has === building) return { state, result: false };
    return {
      state: {
        ...state,
        buildingSetIds: building
          ? [...state.buildingSetIds, setId]
          : state.buildingSetIds.filter((id) => id !== setId),
      },
      result: true,
    };
  },

  /**
   * Moves `quantity` (default all) of a copy into `to`, at `slot` when
   * given. Folds into an identical line there; part of a stack splits off.
   */
  moveCopy(
    state: CollectionState,
    id: CopyId,
    to: ContainerId,
    quantity?: number,
    slot?: number,
  ): OpResult<MoveOpResult> {
    const i = indexOfCopy(state, id);
    const source = state.copies[i];
    const dest = containerIn(state, to);
    if (!dest) throw new DemoRefusal("That binder is gone.");
    if (dest.system === "want") throw new DemoRefusal("The Want List holds wants, not cards. Want the card instead.");
    if (dest.system === "trade") throw new DemoRefusal("Flag the card Up for Trade instead: it stays where it lives.");
    if (dest.rule) throw new DemoRefusal(`${dest.name} fills itself. Move the card somewhere else.`);
    checkSlot(state, to, slot);
    const moving = Math.min(source.quantity, Math.max(1, Math.floor(quantity ?? source.quantity)));
    const split = moving < source.quantity;
    const from = { homeId: source.homeId, ...(source.slot === undefined ? {} : { slot: source.slot }), quantity: moving };
    const landed = clean({ ...source, homeId: to, slot, quantity: moving });
    const twin = state.copies.find((c) => c.id !== id && c.cardId === source.cardId && sameLineItem(c, landed));
    if (!twin && slot !== undefined && pocketHolder(state, to, slot, new Set([id]))) {
      throw new DemoRefusal("That pocket already holds a card.");
    }
    let copies = [...state.copies];
    let copyId: CopyId;
    if (twin) {
      copies = copies.map((c) => (c.id === twin.id ? { ...c, quantity: c.quantity + moving } : c));
      copies = split
        ? copies.map((c) => (c.id === id ? { ...c, quantity: c.quantity - moving } : c))
        : copies.filter((c) => c.id !== id);
      copyId = twin.id;
    } else if (split) {
      copies = copies.map((c) => (c.id === id ? { ...c, quantity: c.quantity - moving } : c));
      const part: DemoCopy = { ...landed, id: newId("copy"), cardId: source.cardId };
      copies.splice(i + 1, 0, part);
      copyId = part.id;
    } else {
      copies[i] = { ...landed, id, cardId: source.cardId } as DemoCopy;
      copyId = id;
    }
    return { state: { ...state, copies }, result: { copyId, folded: !!twin, split, from } };
  },

  /**
   * A pocket or row in the copy's own home (null: out of it): a move that
   * stays home, so it folds into an identical line in that row the same way.
   */
  placeCopy(state: CollectionState, id: CopyId, slot: number | null): OpResult<MoveOpResult> {
    const copy = state.copies[indexOfCopy(state, id)];
    return demoOps.moveCopy(state, id, copy.homeId, undefined, slot ?? undefined);
  },

  /** Returns the flag it had. */
  setTrade(state: CollectionState, id: CopyId, on: boolean): OpResult<boolean> {
    const i = indexOfCopy(state, id);
    const previous = !!state.copies[i].upForTrade;
    if (previous === on) return { state, result: previous };
    const copies = [...state.copies];
    copies[i] = { ...copies[i], upForTrade: on };
    return { state: { ...state, copies }, result: previous };
  },

  /**
   * One want per card: on wants it for `binderId` (moving a want it had for
   * another); off clears the card's want. Returns whether anything changed.
   */
  setWant(state: CollectionState, cardId: CardId, binderId: ContainerId | null, on: boolean): OpResult<boolean> {
    const had = state.wants.find((w) => w.cardId === cardId);
    if (!on) {
      if (!had) return { state, result: false };
      return { state: { ...state, wants: state.wants.filter((w) => w.cardId !== cardId) }, result: true };
    }
    if (had && had.binderId === binderId) return { state, result: false };
    if (binderId !== null && !isHome(containerIn(state, binderId))) {
      throw new DemoRefusal("Want it for one of your binders or boxes, or just want it.");
    }
    if (!had && state.wants.length >= MAX_WANTS) {
      throw new DemoRefusal(
        `Your Want List is full at ${MAX_WANTS.toLocaleString("en-US")} cards. Land a few or clear some to make room.`,
      );
    }
    const wants = had
      ? state.wants.map((w) => (w.cardId === cardId ? { cardId, binderId } : w))
      : [...state.wants, { cardId, binderId }];
    return { state: { ...state, wants }, result: true };
  },

  createContainer(state: CollectionState, input: NewContainer): OpResult<ContainerId> {
    const name = input.name.trim();
    if (!name) throw new DemoRefusal("Give it a name first.");
    if (state.containers.length >= MAX_CONTAINERS) {
      throw new DemoRefusal(`That's ${MAX_CONTAINERS} binders and boxes already. Delete one you're done with to make room.`);
    }
    const description = input.description?.trim();
    const made: DemoContainer = {
      id: newId(input.kind),
      kind: input.kind,
      name,
      ...(description ? { description } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.rule && input.kind === "binder" ? { rule: input.rule } : {}),
    };
    return { state: { ...state, containers: sortContainers([...state.containers, made]) }, result: made.id };
  },

  /** Returns the patch that puts it back. */
  updateContainer(state: CollectionState, id: ContainerId, patch: ContainerPatch): OpResult<ContainerPatch> {
    const target = containerIn(state, id);
    if (!target) throw new DemoRefusal("That binder is gone.");
    if (target.system && (patch.name !== undefined || patch.description !== undefined)) {
      throw new DemoRefusal(`${target.name} keeps its name. You can still change its label.`);
    }
    const name = patch.name?.trim();
    if (patch.name !== undefined && !name) throw new DemoRefusal("Give it a name first.");
    const back: ContainerPatch = {};
    const next: DemoContainer = { ...target };
    if (name !== undefined) {
      back.name = target.name;
      next.name = name;
    }
    if (patch.description !== undefined) {
      back.description = target.description ?? "";
      const d = patch.description.trim();
      if (d) next.description = d;
      else delete next.description;
    }
    if (patch.label !== undefined) {
      back.label = target.label ?? null;
      if (patch.label) next.label = patch.label;
      else delete next.label;
    }
    return {
      state: { ...state, containers: state.containers.map((c) => (c.id === id ? next : c)) },
      result: back,
    };
  },

  /** Sends its copies to Main (slots cleared), un-scopes its wants, and takes it off the shelf. */
  deleteContainer(state: CollectionState, id: ContainerId): OpResult<number> {
    const target = containerIn(state, id);
    if (!target) throw new DemoRefusal("That binder is gone.");
    if (target.system) throw new DemoRefusal(`${target.name} can't be deleted.`);
    let moved = 0;
    const copies = state.copies.map((c) => {
      if (c.homeId !== id) return c;
      moved += 1;
      return clean({ ...c, homeId: MAIN_BINDER_ID, slot: undefined }) as DemoCopy;
    });
    const wants = state.wants.map((w) => (w.binderId === id ? { ...w, binderId: null } : w));
    return {
      state: { ...state, copies, wants, containers: state.containers.filter((c) => c.id !== id) },
      result: moved,
    };
  },

  requestCard(state: CollectionState, input: NewCardRequest, requestedAt: string): OpResult<CardRequest> {
    const request: CardRequest = { ...input, id: newId("request"), requestedAt };
    return { state: { ...state, cardRequests: [request, ...state.cardRequests] }, result: request };
  },

  setBrowseFilter(state: CollectionState, patch: Partial<BrowseFilter>): OpResult<null> {
    return { state: { ...state, browseFilter: { ...state.browseFilter, ...patch } }, result: null };
  },
};

/** The rule as the fixture's rule engine takes it (the shared rule is a strict subset). */
export function fixtureRule(rule: ContainerRule): BinderRule {
  return rule as BinderRule;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type CollectionAction = { type: "replace"; state: CollectionState } | { type: "reset" };

export function collectionReducer(state: CollectionState, action: CollectionAction): CollectionState {
  switch (action.type) {
    case "replace":
      return action.state;
    case "reset":
      return seedState();
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface CollectionStore {
  state: CollectionState;
  /**
   * Applies one write (`demoOps.*`, bound to its arguments) to the newest
   * state and returns what it did. Throws the op's `DemoRefusal`, leaving
   * the state as it was.
   */
  run: <T>(op: (state: CollectionState) => OpResult<T>) => T;
  cardRequests: CardRequest[];
  requestCard: (input: NewCardRequest) => CardRequest;
  browseFilter: BrowseFilter;
  setBrowseFilter: (patch: Partial<BrowseFilter>) => void;
  /** Back to the starting stack. */
  reset: () => void;
}

/** Today in the viewer's calendar, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `storageKey`: where the state persists; the public demo passes its own. */
export function useDemoCollectionState(storageKey: string = STORAGE_KEY): CollectionStore {
  const [state, dispatch] = useReducer(collectionReducer, storageKey, loadState);

  // Writes build on the newest state through a ref, so two writes in one
  // tick (a batch, an undo right after its write) never lose each other.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the page keeps working in memory.
    }
  }, [state, storageKey]);

  const run = useCallback(<T,>(op: (s: CollectionState) => OpResult<T>): T => {
    const { state: next, result } = op(stateRef.current);
    if (next !== stateRef.current) {
      stateRef.current = next;
      dispatch({ type: "replace", state: next });
    }
    return result;
  }, []);

  const requestCard = useCallback(
    (input: NewCardRequest) => run((s) => demoOps.requestCard(s, input, today())),
    [run],
  );
  const setBrowseFilter = useCallback(
    (patch: Partial<BrowseFilter>) => run((s) => demoOps.setBrowseFilter(s, patch)),
    [run],
  );
  const reset = useCallback(() => {
    const fresh = seedState();
    stateRef.current = fresh;
    dispatch({ type: "replace", state: fresh });
  }, []);

  return useMemo<CollectionStore>(
    () => ({
      state,
      run,
      cardRequests: state.cardRequests,
      requestCard,
      browseFilter: state.browseFilter,
      setBrowseFilter,
      reset,
    }),
    [state, run, requestCard, setBrowseFilter, reset],
  );
}
