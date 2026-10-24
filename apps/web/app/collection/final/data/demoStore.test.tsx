import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { initialCollectionState } from "../store";
import { DemoCollectionProvider, demoCard, demoVariantId, parseDemoVariantId } from "./demoStore";
import { cardLabel, compareCards, variantLabel } from "./labels";
import {
  useCard,
  useCapabilities,
  useCollectionActions,
  useCopiesInVariant,
  useCopiesOf,
  useDemoExtension,
  useDrill,
  useOwnedCards,
  useSearch,
  useSetPath,
  useSetSummary,
  useVariantCards,
  useVariantCompletion,
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
  it("turns every capability on and exposes the demo's own store", () => {
    const { result } = renderHook(() => ({ caps: useCapabilities(), demo: useDemoExtension() }), { wrapper });
    expect(Object.values(result.current.caps).every(Boolean)).toBe(true);
    expect(result.current.demo?.state.state.binders.length).toBeGreaterThan(0);
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
    expect(copy.demo?.binderIds.length).toBeGreaterThan(0);

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

describe("everything I own", () => {
  it("lists every held card once, the newest Have first, with its count", async () => {
    const { result } = renderHook(
      () => ({ actions: useCollectionActions(), owned: useOwnedCards(), demo: useDemoExtension(), cards: useVariantCards(GOLD) }),
      { wrapper },
    );
    const seed = result.current.demo!.state.state.copies;
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
