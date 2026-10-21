/**
 * NEO-350 — a tiny client store for one prototype, seeded from data.ts.
 *
 * Each prototype page calls `usePrototypeStore()` itself, so prototypes never
 * share state. Nothing reaches a server. Pass a `persistKey` to keep the
 * state in sessionStorage across reloads and prototype switches (wrapped in
 * try/catch: private windows and blocked storage just start from the seed).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  binderCards as binderCardsFor,
  binderCopies as binderCopiesFor,
  binders as seedBinders,
  buildingSetIds as seedBuilding,
  copiesOf as copiesOfFor,
  emptyCopyDetails,
  myCopies as seedCopies,
  ownedCountFor,
  setCompletion as setCompletionFor,
  type Binder,
  type BinderId,
  type BinderRule,
  type Card,
  type CardId,
  type Completion,
  type Copy,
  type CopyDetails,
  type CopyId,
  type SetId,
  type VariantFilter,
} from "./data";

export interface PrototypeState {
  copies: Copy[];
  binders: Binder[];
  buildingSetIds: SetId[];
}

export type NewBinder =
  | { kind: "manual"; name: string; description?: string; pages?: number }
  | { kind: "smart"; name: string; description?: string; rule: BinderRule };

type Action =
  | { type: "addCopy"; copy: Copy }
  | { type: "updateCopy"; id: CopyId; patch: Partial<CopyDetails> }
  | { type: "removeCopy"; id: CopyId }
  | { type: "restoreCopy"; copy: Copy; index: number }
  | { type: "toggleBuilding"; setId: SetId }
  | { type: "addToBinder"; copyId: CopyId; binderId: BinderId }
  | { type: "removeFromBinder"; copyId: CopyId; binderId: BinderId }
  | { type: "createBinder"; binder: Binder }
  | {
      type: "placeInSlot";
      binderId: BinderId;
      page: number;
      slot: number;
      copyId: CopyId | null;
    }
  | { type: "reset" };

function seedState(): PrototypeState {
  // structuredClone: the seed arrays are module singletons and must never be
  // mutated through a prototype's state.
  return structuredClone({
    copies: seedCopies,
    binders: seedBinders,
    buildingSetIds: seedBuilding,
  });
}

/** Remove a copy id from every page slot of every binder that has a layout. */
function unslot(binders: Binder[], copyId: CopyId, onlyBinder?: BinderId): Binder[] {
  return binders.map((b) => {
    if (b.kind !== "manual" || !b.layout) return b;
    if (onlyBinder && b.id !== onlyBinder) return b;
    if (!b.layout.some((p) => p.slots.includes(copyId))) return b;
    return {
      ...b,
      layout: b.layout.map((p) => ({
        slots: p.slots.map((id) => (id === copyId ? null : id)),
      })),
    };
  });
}

function reducer(state: PrototypeState, action: Action): PrototypeState {
  switch (action.type) {
    case "addCopy":
      return { ...state, copies: [...state.copies, action.copy] };
    case "updateCopy":
      return {
        ...state,
        copies: state.copies.map((c) =>
          c.id === action.id ? { ...c, ...action.patch } : c,
        ),
      };
    case "removeCopy":
      return {
        ...state,
        copies: state.copies.filter((c) => c.id !== action.id),
        binders: unslot(state.binders, action.id),
      };
    case "restoreCopy": {
      if (state.copies.some((c) => c.id === action.copy.id)) return state;
      const copies = [...state.copies];
      copies.splice(Math.min(action.index, copies.length), 0, action.copy);
      return { ...state, copies };
    }
    case "toggleBuilding":
      return {
        ...state,
        buildingSetIds: state.buildingSetIds.includes(action.setId)
          ? state.buildingSetIds.filter((id) => id !== action.setId)
          : [...state.buildingSetIds, action.setId],
      };
    case "addToBinder":
      return {
        ...state,
        copies: state.copies.map((c) =>
          c.id === action.copyId && !c.binderIds.includes(action.binderId)
            ? { ...c, binderIds: [...c.binderIds, action.binderId] }
            : c,
        ),
      };
    case "removeFromBinder":
      return {
        ...state,
        copies: state.copies.map((c) =>
          c.id === action.copyId
            ? { ...c, binderIds: c.binderIds.filter((id) => id !== action.binderId) }
            : c,
        ),
        binders: unslot(state.binders, action.copyId, action.binderId),
      };
    case "createBinder":
      return { ...state, binders: [...state.binders, action.binder] };
    case "placeInSlot": {
      const { binderId, page, slot, copyId } = action;
      // One pocket per copy: placing it here empties wherever it was.
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
        // Filing a copy in a pocket also files it in the binder.
        copies: copyId
          ? state.copies.map((c) =>
              c.id === copyId && !c.binderIds.includes(binderId)
                ? { ...c, binderIds: [...c.binderIds, binderId] }
                : c,
            )
          : state.copies,
      };
    }
    case "reset":
      return seedState();
  }
}

const STORAGE_PREFIX = "nb-collection-prototype:";

function loadState(persistKey: string | undefined): PrototypeState {
  if (!persistKey) return seedState();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + persistKey);
    if (raw) return JSON.parse(raw) as PrototypeState;
  } catch {
    // Unavailable or corrupt storage: start from the seed.
  }
  return seedState();
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export interface PrototypeStore {
  state: PrototypeState;

  /** Add a copy (defaults: quantity 1, acquired today). Returns the new copy. */
  addCopy: (cardId: CardId, details?: Partial<CopyDetails>) => Copy;
  updateCopy: (copyId: CopyId, patch: Partial<CopyDetails>) => void;
  /**
   * Remove a copy and return it (undefined if it was not there). Hand the
   * result to `restoreCopy` for Undo: it goes back where it was, same id.
   */
  removeCopy: (copyId: CopyId) => Copy | undefined;
  restoreCopy: (copy: Copy) => void;
  toggleBuilding: (setId: SetId) => void;
  addToBinder: (copyId: CopyId, binderId: BinderId) => void;
  /** Unfiles the copy and empties any pocket it held in that binder. */
  removeFromBinder: (copyId: CopyId, binderId: BinderId) => void;
  /** Returns the new binder. A manual binder with `pages` gets empty 9-pocket pages. */
  createBinder: (input: NewBinder) => Binder;
  /** Put a copy in a pocket (or `null` to empty it). Pages grow as needed. */
  placeInSlot: (binderId: BinderId, page: number, slot: number, copyId: CopyId | null) => void;
  /** Back to the seed data. */
  reset: () => void;

  // Reads bound to this store's live state.
  ownedCount: (cardId: CardId) => number;
  copiesOf: (cardId: CardId) => Copy[];
  isBuilding: (setId: SetId) => boolean;
  completion: (setId: SetId, variant?: VariantFilter) => Completion;
  binderCards: (binder: Binder) => Card[];
  binderCopies: (binder: Binder) => Copy[];
  getBinder: (binderId: BinderId) => Binder | undefined;
}

export function usePrototypeStore(persistKey?: string): PrototypeStore {
  const [state, dispatch] = useReducer(reducer, persistKey, loadState);

  // Callbacks read the latest state through a ref so removeCopy can hand back
  // what it removed without re-creating every action on each change.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!persistKey) return;
    try {
      window.sessionStorage.setItem(STORAGE_PREFIX + persistKey, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the prototype keeps working in memory.
    }
  }, [persistKey, state]);

  // Undo needs the copy's old list position and the pockets it sat in;
  // removeCopy remembers both here.
  const removedAt = useRef(
    new Map<CopyId, { index: number; pockets: [BinderId, number, number][] }>(),
  );

  const addCopy = useCallback((cardId: CardId, details?: Partial<CopyDetails>) => {
    const copy: Copy = { ...emptyCopyDetails(), ...details, id: newId("copy"), cardId };
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
    // Keep the live ref honest for a second call in the same tick.
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

  const createBinder = useCallback((input: NewBinder) => {
    const id = newId("binder");
    const binder: Binder =
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
    dispatch({ type: "createBinder", binder });
    return binder;
  }, []);

  const placeInSlot = useCallback(
    (binderId: BinderId, page: number, slot: number, copyId: CopyId | null) =>
      dispatch({ type: "placeInSlot", binderId, page, slot, copyId }),
    [],
  );

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return useMemo<PrototypeStore>(
    () => ({
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
      binderCards: (binder) => binderCardsFor(binder, state.copies),
      binderCopies: (binder) => binderCopiesFor(binder, state.copies),
      getBinder: (binderId) => state.binders.find((b) => b.id === binderId),
    }),
    [
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
    ],
  );
}
