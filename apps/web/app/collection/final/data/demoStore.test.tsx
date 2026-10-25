import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { initialCollectionState, MAIN_BINDER_ID, SHOW_BOX_ID, TRADE_BINDER_ID, UNSORTED_BOX_ID } from "../store";
import { DemoCollectionProvider, demoCard, demoVariantId, parseDemoVariantId } from "./demoStore";
import { cardLabel, compareCards, variantLabel } from "./labels";
import {
  useCard,
  emptyCopyDetails,
  useCapabilities,
  useCollectionActions,
  useContainerCopies,
  useContainers,
  useCopiesInVariant,
  useCopiesOf,
  useCopiesOfCards,
  useBuildingSets,
  useDemoExtension,
  useDrill,
  useOwnedCards,
  useSearch,
  useSetPath,
  useSetSummary,
  useSummary,
  useVariantCards,
  useTradeCopies,
  useVariantCompletion,
  useWants,
  ScopeProvider,
  SideProvider,
  useInventoryCards,
  useSetCompletion,
  collectionCopiesIn,
  collectionCopiesOfCards,
} from "./store";

/**
 * NEO-358 — the demo store behind the shared contract: the fixture catalog
 * hydrated into the view model, the reducer's copies read and written through
 * the same hooks and actions the Convex store answers, every capability on.
 * The Convex client module is mocked EMPTY: touching it would throw.
 */
vi.mock("convex/react", () => ({}));

const CHROME = "2024-topps-chrome-baseball";
const CHROME_BASE = demoVariantId(CHROME, { type: "Base", name: null });
const GOLD = demoVariantId(CHROME, { type: "Parallels", name: "Gold Refractor" });

const wrapper = ({ children }: { children: ReactNode }) => (
  <DemoCollectionProvider storageKey="nb-collection-demo-store-test">{children}</DemoCollectionProvider>
);

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("reading the fixture through the contract", () => {
  it("turns every capability on and exposes the demo's own extension", () => {
    const { result } = renderHook(() => ({ caps: useCapabilities(), demo: useDemoExtension() }), { wrapper });
    expect(Object.values(result.current.caps).every(Boolean)).toBe(true);
    expect(result.current.demo?.browseSets.length).toBeGreaterThan(0);
    expect(result.current.demo).not.toHaveProperty("state");
  });

  it("round-trips a variant id", () => {
    expect(parseDemoVariantId(GOLD)).toEqual({ setId: CHROME, filter: { type: "Parallels", name: "Gold Refractor" } });
    expect(parseDemoVariantId("nope")).toBeNull();
  });

  it("hydrates a checklist's cards in order, with their set and variant", () => {
    const { result } = renderHook(() => useVariantCards(GOLD), { wrapper });
    const cards = result.current!;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.set.id === CHROME && c.variant.id === GOLD)).toBe(true);
    expect([...cards].sort(compareCards).map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect(variantLabel(cards[0].variant)).toBe("Gold Refractor");
    expect(cards[0].variant.kind).toBe("parallel");
    expect(cardLabel(cards[0])).toMatch(/^2024 Topps Chrome #\S+ .+, Gold Refractor \/50$/);
  });

  it("counts a checklist with and without its image variations", () => {
    const { result } = renderHook(() => useSetSummary(CHROME), { wrapper });
    const base = result.current!.variants.find((v) => v.id === CHROME_BASE)!;
    // 2024 Topps Chrome Base carries one image variation (#13 Sliding).
    expect(base.cardCount).toBe(base.baseCardCount + 1);
    expect(result.current!.totalCardsAll - result.current!.totalCards).toBeGreaterThanOrEqual(1);
    expect(result.current!.variants[0].kind).toBe("base");
  });

  it("answers null for a set or card the fixture does not hold", () => {
    const { result } = renderHook(
      () => ({ set: useSetSummary("1888-nope"), path: useSetPath("1888-nope"), card: useCard("card-nope") }),
      { wrapper },
    );
    expect(result.current).toEqual({ set: null, path: null, card: null });
  });

  it("skips a null input with undefined", () => {
    const { result } = renderHook(() => ({ cards: useVariantCards(null), card: useCard(null), drill: useDrill(null, {}) }), {
      wrapper,
    });
    expect(result.current).toEqual({ cards: undefined, card: undefined, drill: undefined });
  });

  it("drills with the demo's URL ids, down to a checklist", () => {
    const { result } = renderHook(
      () => ({
        sports: useDrill("sport", {}),
        types: useDrill("variantType", { set: CHROME }),
        parallels: useDrill("variant", { set: CHROME, variantType: "Parallels" }),
        path: useSetPath(CHROME),
      }),
      { wrapper },
    );
    expect(result.current.sports!.map((s) => s.id)).toContain("baseball");
    const base = result.current.types!.find((t) => t.id === "Base")!;
    expect(base).toMatchObject({ kind: "base", variantId: CHROME_BASE, hasChildren: false });
    expect(result.current.types!.find((t) => t.id === "Parallels")).toMatchObject({ hasChildren: true });
    expect(result.current.types!.find((t) => t.id === "Parallels")?.variantId).toBeUndefined();
    expect(result.current.parallels!.find((p) => p.id === "Gold Refractor")?.variantId).toBe(GOLD);
    expect(result.current.path).toEqual({
      sport: { id: "baseball", name: "Baseball" },
      year: { id: "2024", name: "2024" },
      brand: { id: "brand-topps", name: "Topps" },
      set: { id: CHROME, name: "Topps Chrome" },
    });
  });

  it("searches only once there is something to search", () => {
    const { result } = renderHook(() => ({ short: useSearch("o"), hits: useSearch("ohtani gold refractor") }), { wrapper });
    expect(result.current.short).toEqual({ cards: [], truncated: false });
    expect(result.current.hits!.cards[0].variant.id).toBe(GOLD);
  });
});

describe("writing through the contract", () => {
  it("Have adds a copy that lights the checklist, and its undo takes it back", async () => {
    const { result } = renderHook(
      () => ({
        actions: useCollectionActions(),
        cards: useVariantCards(GOLD),
        completion: useVariantCompletion(GOLD),
        inVariant: useCopiesInVariant(GOLD),
      }),
      { wrapper },
    );
    const need = result.current.cards!.find((c) => !result.current.inVariant!.some((copy) => copy.cardId === c.id))!;
    const before = result.current.completion!;

    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      const added = await result.current.actions.addHave(need);
      expect(added.merged).toBe(false);
      undo = added.undo;
    });
    expect(result.current.completion!.owned).toBe(before.owned + 1);
    expect(result.current.completion!.ownedAll).toBe(before.ownedAll + 1);
    const copy = result.current.inVariant!.find((c) => c.cardId === need.id)!;
    expect(copy).toMatchObject({ quantity: 1, variantId: GOLD, setId: CHROME, notes: "" });
    // A new copy lands in one home (Main when nothing is scoped), not on the trade pile.
    expect(copy).toMatchObject({ homeKind: "binder", homeName: "Main", upForTrade: false });
    expect(copy).not.toHaveProperty("demo");

    await act(undo);
    expect(result.current.completion).toEqual(before);
  });

  it("an image variation counts toward the All pair only", async () => {
    const { result } = renderHook(
      () => {
        const cards = useVariantCards(CHROME_BASE);
        const variation = cards?.find((c) => c.isVariation) ?? null;
        return {
          actions: useCollectionActions(),
          completion: useVariantCompletion(CHROME_BASE),
          variation,
          held: useCopiesOf(variation?.id ?? null),
        };
      },
      { wrapper },
    );
    const variation = result.current.variation!;
    expect(variation.cardVariation).toBe("Sliding");
    // Start from not holding it.
    for (const copy of result.current.held!) {
      await act(async () => {
        await result.current.actions.removeCopy(copy);
      });
    }
    const before = result.current.completion!;
    await act(async () => {
      await result.current.actions.addHave(variation);
    });
    expect(result.current.completion!.owned).toBe(before.owned);
    expect(result.current.completion!.ownedAll).toBe(before.ownedAll + 1);
  });

  it("an edit's undo puts back exactly the fields it changed", async () => {
    const card = demoCard(firstSeedCardId())!;
    const { result } = renderHook(() => ({ actions: useCollectionActions(), copies: useCopiesOf(card.id) }), { wrapper });
    const copy = result.current.copies![0];
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      undo = (await result.current.actions.updateCopy(copy, { notes: "Pulled at the card show", location: "Box 9" })).undo;
    });
    expect(result.current.copies![0]).toMatchObject({ notes: "Pulled at the card show", location: "Box 9" });
    await act(undo);
    expect(result.current.copies![0].notes).toBe(copy.notes);
    expect(result.current.copies![0].location).toBe(copy.location);
  });

  it("a removal's undo restores the same copy", async () => {
    const card = demoCard(firstSeedCardId())!;
    const { result } = renderHook(() => ({ actions: useCollectionActions(), copies: useCopiesOf(card.id) }), { wrapper });
    const copy = result.current.copies![0];
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      const removed = await result.current.actions.removeCopy(copy);
      expect(removed.removed.id).toBe(copy.id);
      undo = removed.undo;
    });
    expect(result.current.copies!.some((c) => c.id === copy.id)).toBe(false);
    await act(undo);
    expect(result.current.copies!.find((c) => c.id === copy.id)).toEqual(copy);
  });
});

/** The seed's copies the collection shows: every one not in the Show box (NEO-359). */
const collectionSeed = () => initialCollectionState().copies.filter((c) => c.homeId !== SHOW_BOX_ID);

describe("everything I own", () => {
  it("lists every held card once, the newest Have first, with its count", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), owned: useOwnedCards(), cards: useVariantCards(GOLD) }),
      { wrapper },
    );
    const seed = collectionSeed();
    const distinct = new Set(seed.filter((c) => c.quantity > 0).map((c) => c.cardId));
    expect(result.current.owned!.total).toBe(distinct.size);
    expect(new Set(result.current.owned!.cards.map((c) => c.id)).size).toBe(result.current.owned!.cards.length);

    const fresh = result.current.cards!.find((c) => !distinct.has(c.id))!;
    await act(async () => {
      await result.current.actions.addHave(fresh);
    });
    expect(result.current.owned!.cards[0].id).toBe(fresh.id);
    expect(result.current.owned!.copiesByCard[fresh.id]).toEqual({ quantity: 1, lines: 1 });
  });

  it("counts the cards off every set build exactly, and moves with a set marked or dropped", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), summary: useSummary(), building: useBuildingSets() }),
      { wrapper },
    );
    const offBuild = (buildingIds: ReadonlySet<string>) => {
      const held = new Set(collectionSeed().filter((c) => c.quantity > 0).map((c) => c.cardId));
      return [...held].filter((id) => {
        const card = demoCard(id);
        return !card || !buildingIds.has(card.set.id);
      }).length;
    };
    const ids = () => new Set(result.current.building!.map((s) => s.id));
    expect(result.current.summary!.offBuild).toBe(offBuild(ids()));
    const held = demoCard(firstSeedCardId())!;
    const was = ids().has(held.set.id);
    await act(async () => {
      await result.current.actions.setBuilding(held.set, !was);
    });
    expect(ids().has(held.set.id)).toBe(!was);
    expect(result.current.summary!.offBuild).toBe(offBuild(ids()));
  });

  it("stops at the limit and says there is more", () => {
    const { result } = renderHook(() => useOwnedCards({ limit: 2 }), { wrapper });
    expect(result.current!.cards).toHaveLength(2);
    expect(result.current!.truncated).toBe(true);
  });
});

/** The card of the seed's first copy. */
function firstSeedCardId(): string {
  return initialCollectionState().copies[0].cardId;
}

const SLAB = "binder-slab-case";
const CONTENDERS = "binder-contenders-96";

/** Hooks the move tests share: every copy of one card, the containers, the trade pile and wants. */
function useMoveRig(cardId: string) {
  return {
    actions: useCollectionActions(),
    copies: useCopiesOf(cardId),
    containers: useContainers(),
    trade: useTradeCopies(),
    wants: useWants(),
  };
}

describe("moving a copy through the contract", () => {
  const cardId = () => initialCollectionState().copies[0].cardId;

  it("moves the whole line to a box: one row, one home, for sale", async () => {
    const { result } = renderHook(() => useMoveRig(cardId()), { wrapper });
    const copy = result.current.copies![0];
    await act(async () => {
      const moved = await result.current.actions.moveCopy(copy, SHOW_BOX_ID);
      expect(moved).toMatchObject({ folded: false, split: false });
    });
    const after = result.current.copies!.filter((c) => c.id === copy.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ homeId: SHOW_BOX_ID, homeKind: "box" });
  });

  it("splits a quantity: the source keeps the rest and the part lands as a new line", async () => {
    const { result } = renderHook(() => useMoveRig(cardId()), { wrapper });
    const seeded = result.current.copies!;
    const copy = seeded[0];
    // Make a stack of four to split from.
    await act(async () => {
      await result.current.actions.updateCopy(seeded[0], { quantity: 4 });
    });
    const stack = result.current.copies!.find((c) => c.id === copy.id)!;
    await act(async () => {
      const moved = await result.current.actions.moveCopy(stack, SLAB, { quantity: 3 });
      expect(moved.split).toBe(true);
    });
    expect(result.current.copies!.find((c) => c.id === copy.id)).toMatchObject({ quantity: 1, homeId: stack.homeId });
    expect(result.current.copies!.find((c) => c.homeId === SLAB && c.id !== copy.id)).toMatchObject({ quantity: 3 });
  });

  it("undoing a split puts the quantity back into one line", async () => {
    const { result } = renderHook(() => useMoveRig(cardId()), { wrapper });
    await act(async () => {
      await result.current.actions.updateCopy(result.current.copies![0], { quantity: 4 });
    });
    const stack = result.current.copies![0];
    const before = result.current.copies!.length;
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      undo = (await result.current.actions.moveCopy(stack, SLAB, { quantity: 3 })).undo;
    });
    expect(result.current.copies!.length).toBe(before + 1);
    await act(undo);
    expect(result.current.copies!.length).toBe(before);
    expect(result.current.copies!.find((c) => c.id === stack.id)?.quantity).toBe(4);
  });

  it("folds into an identical line in the destination and the undo splits it back out", async () => {
    const { result } = renderHook(() => useMoveRig(cardId()), { wrapper });
    const copy = result.current.copies![0];
    // Park a twin in the slab case, then move the original in.
    let twinId = "";
    await act(async () => {
      const r = await result.current.actions.addLineItem(demoCard(copy.cardId)!, {
        ...emptyCopyDetails(),
        condition: copy.condition,
        graded: copy.graded,
        serialNumber: copy.serialNumber,
        costBasis: copy.costBasis,
        location: copy.location,
        notes: copy.notes,
        quantity: 1,
        homeId: SLAB,
      });
      twinId = r.copyId;
    });
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      const moved = await result.current.actions.moveCopy(copy, SLAB);
      expect(moved).toMatchObject({ folded: true, copyId: twinId });
      undo = moved.undo;
    });
    expect(result.current.copies!.some((c) => c.id === copy.id)).toBe(false);
    await act(undo);
    expect(result.current.copies!.some((c) => c.homeId === SLAB && c.quantity === 1)).toBe(true);
    expect(result.current.copies!.reduce((n, c) => n + c.quantity, 0)).toBe(
      initialCollectionState().copies.filter((c) => c.cardId === copy.cardId).reduce((n, c) => n + c.quantity, 0) + 1,
    );
  });

  it("rejects a move into the Want List with words to show", async () => {
    const { result } = renderHook(() => useMoveRig(cardId()), { wrapper });
    await expect(result.current.actions.moveCopy(result.current.copies![0], "binder-want")).rejects.toThrow(/Want List/);
  });

  it("placeCopy puts a box line in a row and its undo sends it back unsorted", async () => {
    const unsorted = initialCollectionState().copies.find((c) => c.homeId === SHOW_BOX_ID && c.slot === undefined)!;
    const { result: boxRes } = renderHook(() => ({ actions: useCollectionActions(), box: useContainerCopies(SHOW_BOX_ID) }), {
      wrapper,
    });
    const line = boxRes.current.box!.copies.find((c) => c.id === unsorted.id)!;
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      undo = (await boxRes.current.actions.placeCopy(line, 2)).undo;
    });
    expect(boxRes.current.box!.copies.find((c) => c.id === unsorted.id)?.slot).toBe(2);
    await act(undo);
    expect(boxRes.current.box!.copies.find((c) => c.id === unsorted.id)?.slot).toBeUndefined();
  });
});

describe("a card for sale is out of the collection (NEO-359)", () => {
  // Jason, 2026-10-24: "Binders are your collection and For Sale are your
  // inventory." A copy whose home is a box leaves every collection read and
  // shows on Inventory and in its own drawer; taking it off sale brings it back.
  /** A seed card held exactly once, in a binder, with nothing in a box. */
  const loneBinderCopy = () => {
    const seed = initialCollectionState().copies;
    return seed.find(
      (c) => c.homeId !== SHOW_BOX_ID && c.quantity === 1 && !c.upForTrade && seed.filter((o) => o.cardId === c.cardId).length === 1,
    )!;
  };

  function useCollectionRig(cardId: string) {
    const variantId = demoCard(cardId)!.variant.id;
    const ids = [cardId];
    return {
      actions: useCollectionActions(),
      copiesOf: useCopiesOf(cardId),
      copiesOfCards: useCopiesOfCards(ids),
      inVariant: useCopiesInVariant(variantId),
      completion: useVariantCompletion(variantId),
      owned: useOwnedCards({ limit: 1000 }),
      summary: useSummary(),
      trade: useTradeCopies(),
      box: useContainerCopies(SHOW_BOX_ID),
    };
  }

  it("selling one takes it off All my cards, My Cards and the checklist, onto Inventory; Take off sale brings it back", async () => {
    const seedCopy = loneBinderCopy();
    const { result } = renderHook(() => useCollectionRig(seedCopy.cardId), { wrapper });
    const r = () => result.current;
    const copy = r().copiesOf!.find((c) => c.id === seedCopy.id)!;
    const before = { completion: r().completion!, summary: r().summary!, owned: r().owned!.total };
    expect(r().inVariant!.map((c) => c.id)).toContain(copy.id);
    expect(r().owned!.cards.map((c) => c.id)).toContain(copy.cardId);
    expect(r().box!.copies.map((c) => c.id)).not.toContain(copy.id);

    let sold = copy.id;
    await act(async () => {
      sold = (await r().actions.moveCopy(copy, SHOW_BOX_ID)).copyId;
    });
    // Out of the collection: the checklist, its counts, All my cards, the shelf's tally.
    expect(r().inVariant!.some((c) => c.cardId === copy.cardId)).toBe(false);
    expect(r().completion!.ownedAll).toBe(before.completion.ownedAll - 1);
    expect(r().owned!.cards.map((c) => c.id)).not.toContain(copy.cardId);
    expect(r().owned!.total).toBe(before.owned - 1);
    expect(r().summary!.copies).toBe(before.summary.copies - 1);
    expect(r().summary!.cards).toBe(before.summary.cards - 1);
    // On Inventory, and still in its own drawer, for sale.
    expect(r().box!.copies.map((c) => c.id)).toContain(sold);
    expect(r().copiesOf!.find((c) => c.id === sold)).toMatchObject({ homeId: SHOW_BOX_ID, homeKind: "box" });
    // Every home's read keeps it; the collection's filter drops it.
    expect(r().copiesOfCards![copy.cardId].map((c) => c.id)).toEqual([sold]);
    expect(collectionCopiesOfCards(r().copiesOfCards)![copy.cardId]).toEqual([]);
    expect(collectionCopiesIn(r().copiesOf, "all")).toEqual([]);

    // Take off sale: back into a binder, back in every count.
    const inBox = r().copiesOf!.find((c) => c.id === sold)!;
    await act(async () => {
      await r().actions.moveCopy(inBox, MAIN_BINDER_ID);
    });
    expect(r().inVariant!.some((c) => c.cardId === copy.cardId)).toBe(true);
    expect(r().completion!.ownedAll).toBe(before.completion.ownedAll);
    expect(r().owned!.cards.map((c) => c.id)).toContain(copy.cardId);
    expect(r().owned!.total).toBe(before.owned);
    expect(r().summary!.copies).toBe(before.summary.copies);
    expect(r().box!.copies.some((c) => c.cardId === copy.cardId)).toBe(false);
  });

  it("a copy up for trade stays on the Up for Trade pile when it goes up for sale, and the spine still counts it (trade spans both)", async () => {
    const seedCopy = loneBinderCopy();
    const { result } = renderHook(
      () => ({ ...useCollectionRig(seedCopy.cardId), containers: useContainers(), pile: useContainerCopies(TRADE_BINDER_ID) }),
      { wrapper },
    );
    const r = () => result.current;
    await act(async () => {
      await r().actions.setTrade(r().copiesOf!.find((c) => c.id === seedCopy.id)!, true);
    });
    const traded = r().copiesOf!.find((c) => c.id === seedCopy.id)!;
    expect(r().trade!.copies.map((c) => c.id)).toContain(traded.id);
    const spine = () => r().containers!.find((c) => c.id === TRADE_BINDER_ID)!.count!;
    const before = { spine: spine(), completion: r().completion!, summary: r().summary!, owned: r().owned!.total };

    let sold = traded.id;
    await act(async () => {
      sold = (await r().actions.moveCopy(traded, SHOW_BOX_ID)).copyId;
    });
    // On the trade pile, both ways it is read, as a box copy; the spine still counts it.
    expect(r().trade!.copies.find((c) => c.id === sold)).toMatchObject({ homeKind: "box", upForTrade: true });
    expect(r().pile!.copies.find((c) => c.id === sold)).toMatchObject({ homeKind: "box", upForTrade: true });
    expect(spine()).toEqual(before.spine);
    // Everywhere else it is Inventory's: off the checklist, its Have counts, All my cards and My Cards.
    expect(r().inVariant!.some((c) => c.cardId === traded.cardId)).toBe(false);
    expect(r().completion!.ownedAll).toBe(before.completion.ownedAll - 1);
    expect(r().owned!.cards.map((c) => c.id)).not.toContain(traded.cardId);
    expect(r().owned!.total).toBe(before.owned - 1);
    expect(r().summary!.copies).toBe(before.summary.copies - 1);
    expect(collectionCopiesIn(r().copiesOf, "all")).toEqual([]);
    expect(collectionCopiesOfCards(r().copiesOfCards)![traded.cardId]).toEqual([]);
    expect(r().box!.copies.map((c) => c.id)).toContain(sold);
  });

  it("a box copy flagged up for trade joins the pile and its count, and stays out of every binder and the binders' shelf counts", async () => {
    const boxCopy = initialCollectionState().copies.find((c) => c.homeId === SHOW_BOX_ID && !c.upForTrade)!;
    const { result } = renderHook(
      () => ({ ...useCollectionRig(boxCopy.cardId), containers: useContainers(), pile: useContainerCopies(TRADE_BINDER_ID), main: useContainerCopies(MAIN_BINDER_ID) }),
      { wrapper },
    );
    const r = () => result.current;
    const count = (id: string) => r().containers!.find((c) => c.id === id)!.count!;
    const before = { trade: count(TRADE_BINDER_ID), main: count(MAIN_BINDER_ID), completion: r().completion!.ownedAll, owned: r().owned!.total };
    const copy = r().copiesOf!.find((c) => c.id === boxCopy.id)!;
    await act(async () => {
      await r().actions.setTrade(copy, true);
    });
    expect(r().trade!.copies.map((c) => c.id)).toContain(copy.id);
    expect(r().pile!.copies.map((c) => c.id)).toContain(copy.id);
    expect(count(TRADE_BINDER_ID)).toEqual({ copies: before.trade.copies + copy.quantity, lines: before.trade.lines + 1 });
    // Still in its box, still nowhere on the collection's screens.
    expect(r().box!.copies.map((c) => c.id)).toContain(copy.id);
    expect(r().main!.copies.map((c) => c.id)).not.toContain(copy.id);
    expect(count(MAIN_BINDER_ID)).toEqual(before.main);
    expect(r().inVariant!.map((c) => c.id)).not.toContain(copy.id);
    expect(r().completion!.ownedAll).toBe(before.completion);
    expect(r().owned!.total).toBe(before.owned);
  });

  it("the seed's collection screens hold nothing from the Show box, and its trade pile is not empty", () => {
    const { result } = renderHook(() => ({ owned: useOwnedCards({ limit: 1000 }), trade: useTradeCopies() }), { wrapper });
    const boxed = new Set(initialCollectionState().copies.filter((c) => c.homeId === SHOW_BOX_ID).map((c) => c.cardId));
    const binders = new Set(collectionSeed().map((c) => c.cardId));
    const onlyBoxed = [...boxed].filter((id) => !binders.has(id));
    expect(onlyBoxed.length).toBeGreaterThan(0);
    expect(result.current.owned!.cards.some((c) => onlyBoxed.includes(c.id))).toBe(false);
    expect(result.current.trade!.copies.length).toBeGreaterThan(0);
  });
});

describe("Up for Trade is a flag, not a home", () => {
  it("setTrade lists the copy on the trade pile without moving it, and the undo clears it", async () => {
    const seed = initialCollectionState().copies.find((c) => !c.upForTrade && c.homeId === SLAB) ?? initialCollectionState().copies.find((c) => !c.upForTrade)!;
    const { result } = renderHook(() => useMoveRig(seed.cardId), { wrapper });
    const copy = result.current.copies!.find((c) => c.id === seed.id)!;
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      undo = (await result.current.actions.setTrade(copy, true)).undo;
    });
    expect(result.current.trade!.copies.map((c) => c.id)).toContain(copy.id);
    expect(result.current.copies!.find((c) => c.id === copy.id)).toMatchObject({ upForTrade: true, homeId: copy.homeId });
    await act(undo);
    expect(result.current.trade!.copies.map((c) => c.id)).not.toContain(copy.id);
  });

  it("the trade container's contents are exactly the flagged copies", () => {
    const { result } = renderHook(() => ({ containers: useContainers(), trade: useTradeCopies(), pile: useContainerCopies(TRADE_BINDER_ID) }), {
      wrapper,
    });
    const flagged = initialCollectionState().copies.filter((c) => c.upForTrade).map((c) => c.id).sort();
    expect(result.current.trade!.copies.map((c) => c.id).sort()).toEqual(flagged);
    expect(result.current.pile!.copies.map((c) => c.id).sort()).toEqual(flagged);
    expect(result.current.containers!.find((c) => c.id === TRADE_BINDER_ID)?.count?.lines).toBe(flagged.length);
  });
});

describe("wants are one per card", () => {
  it("wanting a card for another binder moves its want, and the undo puts the old one back", async () => {
    const { result } = renderHook(() => useMoveRig("x"), { wrapper });
    const before = result.current.wants![0];
    let undo: () => Promise<void> = async () => {};
    await act(async () => {
      const r = await result.current.actions.setWant(before.cardId, SLAB, true);
      expect(r.changed).toBe(true);
      undo = r.undo;
    });
    expect(result.current.wants!.filter((w) => w.cardId === before.cardId)).toEqual([{ cardId: before.cardId, binderId: SLAB }]);
    await act(undo);
    expect(result.current.wants!.filter((w) => w.cardId === before.cardId)).toEqual([before]);
  });

  it("reports no change when asked for the want it already is", async () => {
    const { result } = renderHook(() => useMoveRig("x"), { wrapper });
    const w = result.current.wants![0];
    await act(async () => {
      expect((await result.current.actions.setWant(w.cardId, w.binderId, true)).changed).toBe(false);
    });
  });
});

describe("scope files into the scoped home", () => {
  const scoped = (scope: string) =>
    ({ children }: { children: ReactNode }) => (
      <DemoCollectionProvider storageKey="nb-collection-demo-store-test">
        <ScopeProvider value={scope}>{children}</ScopeProvider>
      </DemoCollectionProvider>
    );

  it("a Have with a binder scoped lands in that binder", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), cards: useVariantCards(GOLD), inVariant: useCopiesInVariant(GOLD) }),
      { wrapper: scoped(SLAB) },
    );
    const need = result.current.cards![0];
    await act(async () => {
      await result.current.actions.addHave(need, SLAB);
    });
    expect(result.current.inVariant!.find((c) => c.cardId === need.id)).toMatchObject({ homeId: SLAB });
  });

  it("a scoped read lists only that home's copies and counts only them", () => {
    const { result } = renderHook(
      () => ({ inVariant: useCopiesInVariant(demoVariantId("1996-playoff-contenders", { type: "Base", name: null })) }),
      { wrapper: scoped(MAIN_BINDER_ID) },
    );
    expect(result.current.inVariant!.every((c) => c.homeId === MAIN_BINDER_ID)).toBe(true);
  });
});

describe("containers through the contract", () => {
  it("creates a box, lists it with a zero count, and deleting it re-homes its copies to Main", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), containers: useContainers(), box: useContainerCopies(SHOW_BOX_ID) }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions.createContainer({ kind: "box", name: "Dime box" });
    });
    const dime = result.current.containers!.find((c) => c.name === "Dime box")!;
    expect(dime).toMatchObject({ kind: "box", count: { copies: 0, lines: 0 } });

    const show = result.current.containers!.find((c) => c.id === SHOW_BOX_ID)!;
    let moved = -1;
    await act(async () => {
      moved = (await result.current.actions.deleteContainer(show)).moved;
    });
    expect(moved).toBe(show.count!.lines);
    expect(result.current.containers!.some((c) => c.id === SHOW_BOX_ID)).toBe(false);
    const main = result.current.containers!.find((c) => c.id === MAIN_BINDER_ID)!;
    expect(main.count!.lines).toBeGreaterThanOrEqual(moved);
  });

  it("counts a binder's copies and lines", () => {
    const { result } = renderHook(() => ({ containers: useContainers(), pockets: useContainerCopies(CONTENDERS) }), { wrapper });
    const c = result.current.containers!.find((x) => x.id === CONTENDERS)!;
    expect(c.count!.lines).toBe(result.current.pockets!.copies.length);
  });

  it("reads many cards' copies in one call, an empty list for a card nobody holds", () => {
    const held = initialCollectionState().copies[0].cardId;
    const { result } = renderHook(() => useCopiesOfCards([held, "card-nope"]), { wrapper });
    expect(result.current![held].length).toBeGreaterThan(0);
    expect(result.current!["card-nope"]).toEqual([]);
  });
});

describe("the inventory side (NEO-364)", () => {
  const seed = initialCollectionState();
  const inShow = seed.copies.filter((c) => c.homeId === SHOW_BOX_ID);
  const boxCardId = inShow[0].cardId;
  const boxCard = demoCard(boxCardId)!;
  const unsorted = () => ({ id: UNSORTED_BOX_ID, kind: "box" as const, name: "Unsorted", count: null });
  const binder = () => ({ id: MAIN_BINDER_ID, kind: "binder" as const, name: "Main", count: null, system: "main" as const });
  const plainCard = () => demoCard(seed.copies.find((c) => c.homeId === MAIN_BINDER_ID)!.cardId)!;

  it("lists the box copies card by card, never a binder copy, with the boxes each sits in", () => {
    const { result } = renderHook(() => useInventoryCards(), { wrapper });
    const items = result.current!.items;
    const heldInBoxes = new Set(seed.copies.filter((c) => c.homeId === SHOW_BOX_ID).map((c) => c.cardId));
    expect(items.map((i) => i.card.id).sort()).toEqual([...heldInBoxes].sort());
    const entry = items.find((i) => i.card.id === boxCardId)!;
    expect(entry.quantity).toBe(inShow.filter((c) => c.cardId === boxCardId).reduce((n, c) => n + c.quantity, 0));
    expect(entry.boxes).toEqual([{ boxId: SHOW_BOX_ID, quantity: entry.quantity }]);
    expect(result.current).toMatchObject({ goneCardIds: [], truncated: false });
  });

  it("narrows to one box, lists nothing for an empty one, and truncates at the limit", () => {
    const { result } = renderHook(
      () => ({ show: useInventoryCards({ boxId: SHOW_BOX_ID }), none: useInventoryCards({ boxId: UNSORTED_BOX_ID }), one: useInventoryCards({ limit: 1 }) }),
      { wrapper },
    );
    expect(result.current.show!.items.length).toBeGreaterThan(0);
    expect(result.current.none!.items).toEqual([]);
    expect(result.current.one!.items).toHaveLength(1);
    expect(result.current.one!.truncated).toBe(result.current.show!.items.length > 1);
  });

  it("setBoxQuantity counts into Unsorted: the card shows on the list, and the undo takes it back out", async () => {
    const card = plainCard();
    const { result } = renderHook(() => ({ actions: useCollectionActions(), list: useInventoryCards({ boxId: UNSORTED_BOX_ID }) }), { wrapper });
    let r!: Awaited<ReturnType<typeof result.current.actions.setBoxQuantity>>;
    await act(async () => {
      r = await result.current.actions.setBoxQuantity(card, unsorted(), 3);
    });
    expect(r).toMatchObject({ before: 0, after: 3 });
    expect(result.current.list!.items.map((i) => [i.card.id, i.quantity])).toEqual([[card.id, 3]]);
    await act(async () => {
      await result.current.actions.setBoxQuantity(card, unsorted(), 1);
    });
    expect(result.current.list!.items[0].quantity).toBe(1);
    await act(r.undo);
    expect(result.current.list!.items).toEqual([]);
  });

  it("the same number writes nothing and its undo is a no-op", async () => {
    const { result } = renderHook(() => ({ actions: useCollectionActions(), list: useInventoryCards() }), { wrapper });
    const before = result.current.list!;
    let r!: Awaited<ReturnType<typeof result.current.actions.setBoxQuantity>>;
    await act(async () => {
      r = await result.current.actions.setBoxQuantity(boxCard, { id: SHOW_BOX_ID, kind: "box", name: "Show box", count: null }, 0);
    });
    expect(r).toMatchObject({ before: 0, after: 0 });
    await act(r.undo);
    expect(result.current.list!.items).toEqual(before.items);
  });

  it("refuses a binder in the words the real store uses", async () => {
    const { result } = renderHook(() => useCollectionActions(), { wrapper });
    await expect(result.current.setBoxQuantity(boxCard, binder(), 1)).rejects.toThrow(/box/i);
  });

  it("a selling-side count never lights a collection checklist", async () => {
    const card = plainCard();
    const variantId = card.variant.id;
    const { result } = renderHook(
      () => ({
        actions: useCollectionActions(),
        col: useVariantCompletion(variantId, "collection"),
        inv: useVariantCompletion(variantId, "inventory"),
        invSet: useSetCompletion(card.set.id, "inventory"),
        colSet: useSetCompletion(card.set.id, "collection"),
      }),
      { wrapper },
    );
    const col0 = result.current.col!;
    const inv0 = result.current.inv!;
    const colSet0 = result.current.colSet!;
    await act(async () => {
      await result.current.actions.setBoxQuantity(card, unsorted(), 2);
    });
    expect(result.current.col).toEqual(col0);
    expect(result.current.colSet).toEqual(colSet0);
    expect(result.current.inv!.owned).toBe(inv0.owned + 1);
    expect(result.current.inv!.ownedAll).toBe(inv0.ownedAll + 1);
    expect(result.current.invSet!.owned).toBeGreaterThan(0);
  });

  it("reads the page's side by default, and a scope on the other side reads empty", () => {
    const variantId = boxCard.variant.id;
    const side = (s: "collection" | "inventory", scope = "all") =>
      ({ children }: { children: ReactNode }) => (
        <DemoCollectionProvider storageKey="nb-collection-demo-store-test">
          <SideProvider value={s}>
            <ScopeProvider value={scope}>{children}</ScopeProvider>
          </SideProvider>
        </DemoCollectionProvider>
      );
    const inv = renderHook(() => ({ rows: useCopiesInVariant(variantId), done: useVariantCompletion(variantId) }), { wrapper: side("inventory") });
    expect(inv.result.current.rows!.length).toBeGreaterThan(0);
    expect(inv.result.current.rows!.every((c) => c.homeKind === "box")).toBe(true);
    expect(inv.result.current.done!.owned).toBeGreaterThan(0);

    const col = renderHook(() => useCopiesInVariant(variantId), { wrapper: side("collection") });
    expect(col.result.current!.every((c) => c.homeKind === "binder")).toBe(true);

    // The Show box's id as the scope, read from the collection side: nothing, never the box's copies.
    const wrongSide = renderHook(
      () => ({ rows: useCopiesInVariant(variantId), done: useVariantCompletion(variantId) }),
      { wrapper: side("collection", SHOW_BOX_ID) },
    );
    expect(wrongSide.result.current.rows).toEqual([]);
    expect(wrongSide.result.current.done).toMatchObject({ owned: 0, ownedAll: 0 });
    // A binder's id as the scope on the inventory side: nothing, too.
    const binderOnInventory = renderHook(() => useCopiesInVariant(variantId), { wrapper: side("inventory", MAIN_BINDER_ID) });
    expect(binderOnInventory.result.current).toEqual([]);
  });

  it("deleting a box through the store sends its copies to Unsorted, where the list finds them", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), shelf: useContainers(), list: useInventoryCards({ boxId: UNSORTED_BOX_ID }) }),
      { wrapper },
    );
    const show = result.current.shelf!.find((c) => c.id === SHOW_BOX_ID)!;
    await act(async () => {
      await result.current.actions.deleteContainer(show);
    });
    expect(result.current.shelf!.some((c) => c.id === SHOW_BOX_ID)).toBe(false);
    expect(result.current.list!.items.map((i) => i.card.id)).toContain(boxCardId);
  });
});
