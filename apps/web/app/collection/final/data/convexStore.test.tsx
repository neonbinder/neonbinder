import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConvexCollectionProvider, __test } from "./convexStore";
import {
  collectionCopiesIn,
  collectionCopiesOfCards,
  ScopeProvider,
  useCapabilities,
  useCollectionActions,
  useContainerCopies,
  useContainers,
  useCopiesInVariant,
  useCopiesOf,
  useCopiesOfCards,
  useDemoExtension,
  useOwnedCards,
  useSearch,
  useSetCards,
  useSuggestions,
  useSummary,
  useTradeCopies,
  useVariantCompletion,
  useWants,
} from "./store";
import { REAL_CAPABILITIES, type Card, type Copy } from "./types";

/**
 * NEO-358 — the Convex store: how the server's shapes become the view model,
 * and that every write's undo is the inverse write. The Convex client is a
 * mock: queries stay loading, each mutation is a spy keyed by function name.
 * No test here reaches a server.
 */
const calls = vi.hoisted(() => ({ list: [] as { name: string; args: unknown }[], answers: new Map<string, unknown>() }));
const queried = vi.hoisted(() => [] as { name: string; args: unknown }[]);
/** What a query answers once loaded, by function name: a value, or a function of the args. */
const loaded = vi.hoisted(() => new Map<string, unknown>());
/**
 * The paginated reads, by function name: the server's pages in order (absent
 * = the first page is still loading). The mock shows one page more per
 * `loadMore`, and records what each `loadMore` asked for.
 */
const paged = vi.hoisted(() => ({ pages: new Map<string, unknown[][]>(), loadMore: [] as number[] }));
/**
 * The client's optimistic layer, faithfully small: `withOptimisticUpdate`
 * runs the store's updater against `local.data` BEFORE the mutation is sent
 * and restores the snapshot if the mutation rejects (as Convex does). Seed
 * `local.data` through `local.set`, read it back through `local.get`.
 */
const local = vi.hoisted(() => ({
  data: new Map<string, { name: string; args: unknown; value: unknown }>(),
  failures: new Map<string, string>(),
  key(name: string, args: unknown) {
    return `${name}|${JSON.stringify(args)}`;
  },
  set(name: string, args: unknown, value: unknown) {
    this.data.set(this.key(name, args), { name, args, value });
  },
  get(name: string, args: unknown) {
    return this.data.get(this.key(name, args))?.value;
  },
  all(name: string) {
    return [...this.data.values()].filter((q) => q.name === name);
  },
  snapshot() {
    return new Map(this.data);
  },
  clear() {
    this.data.clear();
    this.failures.clear();
  },
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  const { useState } = await import("react");
  return {
    usePaginatedQuery: (ref: Parameters<typeof nameOf>[0], args: unknown) => {
      const name = nameOf(ref);
      queried.push({ name, args });
      const [shown, setShown] = useState(1);
      const pages = paged.pages.get(name);
      const loadMore = (n: number) => {
        paged.loadMore.push(n);
        setShown((k) => k + 1);
      };
      if (!pages) return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore };
      return {
        results: pages.slice(0, shown).flat(),
        status: shown < pages.length ? "CanLoadMore" : "Exhausted",
        isLoading: false,
        loadMore,
      };
    },
    useQuery: (ref: Parameters<typeof nameOf>[0], args: unknown) => {
      const name = nameOf(ref);
      queried.push({ name, args });
      if (args === "skip") return undefined;
      const answer = loaded.get(name);
      return typeof answer === "function" ? answer(args) : answer;
    },
    useQueries: (requests: Record<string, { query: Parameters<typeof nameOf>[0]; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(requests).map(([key, { query, args }]) => {
          const answer = loaded.get(nameOf(query));
          return [key, typeof answer === "function" ? answer(args) : answer];
        }),
      ),
    useMutation: (ref: Parameters<typeof nameOf>[0]) => {
      const name = nameOf(ref);
      const send = async (args: unknown) => {
        calls.list.push({ name, args });
        const failure = local.failures.get(name);
        if (failure) throw new Error(failure);
        const answer = calls.answers.get(name);
        return (typeof answer === "function" ? answer(args) : answer) ?? null;
      };
      const store = {
        getQuery: (query: Parameters<typeof nameOf>[0], args: unknown) => local.get(nameOf(query), args),
        getAllQueries: (query: Parameters<typeof nameOf>[0]) =>
          local.all(nameOf(query)).map(({ args, value }) => ({ args, value })),
        setQuery: (query: Parameters<typeof nameOf>[0], args: unknown, value: unknown) =>
          local.set(nameOf(query), args, value),
      };
      return Object.assign(send, {
        withOptimisticUpdate: (update: (s: typeof store, args: unknown) => void) => async (args: unknown) => {
          const before = local.snapshot();
          update(store, args);
          try {
            return await send(args);
          } catch (error) {
            local.data = before;
            throw error;
          }
        },
      });
    },
  };
});

const wrapper = ({ children }: { children: ReactNode }) => <ConvexCollectionProvider>{children}</ConvexCollectionProvider>;

const { toVariantRef, toCopy, toRawDetails, fromRawDetails, toDrillItem, foldsInto, toContainer, toWant } = __test;

const node = (id: string, name: string) => ({ _id: id, name }) as never;

const CARD: Card = {
  id: "card1",
  set: { id: "set1", name: "Topps Chrome", season: "2024", year: 2024, brand: { id: "b", name: "Topps" }, sport: { id: "s", name: "Baseball" } },
  variant: toVariantRef({ _id: "base1", level: "variantType", name: "Base", kind: "base", variantType: node("base1", "Base"), insert: null } as never),
  cardNumber: "12",
  players: [{ id: "p1", name: "Elly De La Cruz" }],
  teams: [{ id: "t1", name: "Reds", location: "Cincinnati" }],
  printRun: null,
  features: [],
  cardVariation: null,
  isVariation: false,
  sortOrder: 12,
  finish: { kind: "standard" },
};

const COPY: Copy = {
  id: "copy1",
  cardId: "card1",
  variantId: "base1",
  setId: "set1",
  homeId: "home1",
  homeKind: "binder",
  upForTrade: false,
  quantity: 2,
  condition: "Mint",
  costBasis: 1.25,
  acquiredAt: "2026-10-01",
  notes: "",
};

beforeEach(() => {
  calls.list.length = 0;
  calls.answers.clear();
  queried.length = 0;
  loaded.clear();
  paged.pages.clear();
  paged.loadMore.length = 0;
  local.clear();
});
afterEach(cleanup);

describe("the server's variant rows, in the view's terms", () => {
  it("reads Base from its variant type", () => {
    const v = toVariantRef({ _id: "vt", level: "variantType", name: "Base", kind: "base", variantType: node("vt", "Base"), insert: null } as never);
    expect(v).toMatchObject({ kind: "base", name: null, path: { typeId: "vt", variantId: null, subVariantId: null } });
    expect(v.finish).toEqual({ kind: "standard" });
  });

  it("reads an insert under an Inserts type", () => {
    const v = toVariantRef({ _id: "i", level: "insert", name: "Future Stars", kind: "insert", variantType: node("vt", "Inserts"), insert: node("i", "Future Stars") } as never);
    expect(v).toMatchObject({ kind: "insert", name: "Future Stars", insertName: null, path: { typeId: "vt", variantId: "i", subVariantId: null } });
  });

  it("reads an insert-level row under a Parallels type as a parallel", () => {
    const v = toVariantRef({ _id: "g", level: "insert", name: "Gold Refractor", kind: "parallel", variantType: node("vt", "Parallels"), insert: node("g", "Gold Refractor") } as never);
    expect(v).toMatchObject({ kind: "parallel", name: "Gold Refractor", path: { typeId: "vt", variantId: "g", subVariantId: null } });
    expect(v.finish).toEqual({ kind: "gold" });
  });

  it("reads a sub-parallel under an insert, naming its insert", () => {
    const v = toVariantRef({ _id: "sp", level: "parallel", name: "Refractor", kind: "insert", variantType: node("vt", "Inserts"), insert: node("i", "Future Stars") } as never);
    expect(v).toMatchObject({ kind: "parallel", name: "Refractor", insertName: "Future Stars", path: { typeId: "vt", variantId: "i", subVariantId: "sp" } });
  });

  it("gives a variant type of no kind its own title", () => {
    const v = toVariantRef({ _id: "p", level: "variantType", name: "Promo", kind: null, variantType: node("p", "Promo"), insert: null } as never);
    expect(v).toMatchObject({ kind: "other", name: "Promo" });
  });
});

describe("the drill", () => {
  const item = (over: object) =>
    ({ _id: "x", level: "variantType", name: "Base", kind: "base", childCount: 0, cardCount: 335, baseCardCount: 330, ...over }) as never;

  it("a card-bearing row with nothing beneath it is a checklist", () => {
    expect(toDrillItem("variantType", item({}))).toMatchObject({ variantId: "x", hasChildren: false, cardCount: 335, baseCardCount: 330 });
  });

  it("an Inserts type that only holds inserts is a step, not a checklist", () => {
    const d = toDrillItem("variantType", item({ kind: "insert", name: "Inserts", childCount: 12, cardCount: 0, baseCardCount: 0 }));
    expect(d.variantId).toBeUndefined();
    expect(d.hasChildren).toBe(true);
  });

  it("an insert with its own cards and sub-parallels is both", () => {
    const d = toDrillItem("variant", item({ level: "insert", kind: null, childCount: 3, cardCount: 25 }));
    expect(d).toMatchObject({ variantId: "x", hasChildren: true });
  });

  it("rows above a set carry no counts", () => {
    const d = toDrillItem("year", item({ level: "year", name: "2024", kind: null, childCount: 4, cardCount: null, baseCardCount: null }));
    expect(d).toEqual({ id: "x", level: "year", name: "2024", hasChildren: true });
  });
});

describe("copies between the view and the server", () => {
  it("reads cents as dollars, the acquired date and an absent note", () => {
    const raw = { _id: "c", cardId: "k", variantId: "v", setId: "s", homeId: "h", quantity: 3, costCents: 1999, acquiredOn: "2026-10-23", grading: { grader: "PSA", grade: "10" }, lastUpdated: 1 };
    expect(toCopy(raw as never)).toEqual({
      id: "c",
      cardId: "k",
      variantId: "v",
      setId: "s",
      homeId: "h",
      homeKind: "binder",
      upForTrade: false,
      quantity: 3,
      graded: { grader: "PSA", grade: "10" },
      costBasis: 19.99,
      acquiredAt: "2026-10-23",
      notes: "",
    });
  });

  it("names a copy's home and kind from the shelf, so a box reads as for sale", () => {
    const homes = new Map([
      ["box1", { kind: "box" as const, name: "Show box" }],
      ["home1", { kind: "binder" as const, name: "Main" }],
    ]);
    const raw = { _id: "c", cardId: "k", variantId: "v", setId: "s", homeId: "box1", quantity: 1, slot: 2, upForTrade: true, lastUpdated: 1 };
    expect(toCopy(raw as never, homes)).toMatchObject({ homeKind: "box", homeName: "Show box", slot: 2, upForTrade: true });
    expect(toCopy({ ...raw, homeId: "home1" } as never, homes)).toMatchObject({ homeKind: "binder", homeName: "Main" });
  });

  it("falls back to a binder with no name while the shelf is loading", () => {
    const raw = { _id: "c", cardId: "k", variantId: "v", setId: "s", homeId: "h", quantity: 1, lastUpdated: 1 };
    const copy = toCopy(raw as never);
    expect(copy.homeKind).toBe("binder");
    expect(copy).not.toHaveProperty("homeName");
  });

  it("writes dollars as whole cents and blank text as absent", () => {
    const out = toRawDetails(
      { quantity: 1, costBasis: 0.1 + 0.2, acquiredAt: "2026-10-23", notes: "   ", location: " ", serialNumber: "" },
      "home1",
    );
    expect(out).toEqual({ quantity: 1, costCents: 30, acquiredOn: "2026-10-23", homeId: "home1" });
    expect(fromRawDetails(out)).toEqual({ quantity: 1, costBasis: 0.3, acquiredAt: "2026-10-23", notes: "", homeId: "home1" });
  });

  it("carries the pocket or row and the trade flag out and back, and writes a cleared flag as absent", () => {
    const out = toRawDetails({ quantity: 1, acquiredAt: "2026-10-23", notes: "", slot: 4, upForTrade: true }, "home1");
    expect(out).toMatchObject({ slot: 4, upForTrade: true, homeId: "home1" });
    expect(fromRawDetails(out)).toMatchObject({ slot: 4, upForTrade: true });
    expect(toRawDetails({ quantity: 1, acquiredAt: "", notes: "", upForTrade: false }, "home1")).not.toHaveProperty("upForTrade");
  });

  it("reads a shelf row with its count, or null when the server has not counted it", () => {
    expect(toContainer({ _id: "b", kind: "box", name: "Show box", count: { copies: 7, lines: 3 } } as never)).toEqual({
      id: "b",
      kind: "box",
      name: "Show box",
      count: { copies: 7, lines: 3 },
    });
    expect(toContainer({ _id: "m", kind: "binder", system: "main", name: "Main" } as never)).toMatchObject({ system: "main", count: null });
  });

  it("reads a want with no binder as unscoped", () => {
    expect(toWant({ cardId: "k" } as never)).toEqual({ cardId: "k", binderId: null });
    expect(toWant({ cardId: "k", binderId: "b" } as never)).toEqual({ cardId: "k", binderId: "b" });
  });

  it("folds like the server: identical details only, never a cert or a serial", () => {
    const row = { quantity: 1, acquiredOn: "2026-10-23", homeId: "h" } as never;
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23" } as never)).toBe(true);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23", homeId: "other" } as never)).toBe(false);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23", slot: 3 } as never)).toBe(false);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23", upForTrade: true } as never)).toBe(false);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-22" } as never)).toBe(false);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23", serialNumber: "3/50" } as never)).toBe(false);
    expect(foldsInto({ ...(row as object), grading: { grader: "PSA", grade: "10", cert: "1" } } as never, row)).toBe(false);
  });
});

describe("the real store's capabilities and reads", () => {
  it("turns on binders, wants, trade and scope, and leaves the demo-only features and Inventory off", () => {
    const { result } = renderHook(() => ({ caps: useCapabilities(), demo: useDemoExtension() }), { wrapper });
    expect(result.current.caps).toEqual(REAL_CAPABILITIES);
    expect(result.current.caps).toMatchObject({
      binders: true,
      wants: true,
      trade: true,
      scope: true,
      smartBinders: false,
      share: false,
      cardRequests: false,
      demoChrome: false,
      inventory: false,
    });
    expect(result.current.demo).toBeUndefined();
  });

  it("never asks the server about text too short to search", () => {
    const { result } = renderHook(() => ({ s: useSearch(" o "), g: useSuggestions("o") }), { wrapper });
    expect(result.current).toEqual({ s: { cards: [], truncated: false }, g: [] });
    expect(queried.filter((q) => q.name.startsWith("collectionCatalog:") && q.args !== "skip")).toEqual([]);
  });

  it("trims what it searches, and asks for the server's page", () => {
    renderHook(() => useSearch('  "topps chrome" ohtani '), { wrapper });
    expect(queried).toContainEqual({ name: "collectionCatalog:search", args: { q: '"topps chrome" ohtani', limit: 50 } });
  });
});

describe("completion", () => {
  it("reads a total the server could not count as 0 (unknown), never as complete", () => {
    loaded.set("collection:variantCompletion", { owned: 3, total: null, ownedAll: 4, totalAll: null });
    const { result } = renderHook(() => useVariantCompletion("v1"), { wrapper });
    expect(result.current).toEqual({ owned: 3, total: 0, percent: 0, ownedAll: 4, totalAll: 0, percentAll: 0 });
  });

  it("keeps both counted pairs", () => {
    loaded.set("collection:variantCompletion", { owned: 3, total: 330, ownedAll: 4, totalAll: 335 });
    const { result } = renderHook(() => useVariantCompletion("v1"), { wrapper });
    expect(result.current).toMatchObject({ owned: 3, total: 330, ownedAll: 4, totalAll: 335 });
  });

  it("reads a row that is not a checklist as nothing owned of nothing", () => {
    loaded.set("collection:variantCompletion", null);
    const { result } = renderHook(() => useVariantCompletion("v1"), { wrapper });
    expect(result.current).toMatchObject({ owned: 0, total: 0, ownedAll: 0, totalAll: 0 });
  });
});

describe("everything I own", () => {
  const SET = { _id: "set1", name: "Topps Chrome", season: "2024", sport: node("sp", "Baseball"), year: node("y", "2024"), manufacturer: node("b", "Topps") };
  const VARIANT = { _id: "base1", level: "variantType", name: "Base", kind: "base", variantType: node("base1", "Base"), insert: null, parallel: null, cardCount: 335, baseCardCount: 330 };
  const catalogCard = (id: string, number: string) => ({
    _id: id,
    cardNumber: number,
    cardName: "",
    sortOrder: Number(number),
    variantId: "base1",
    features: [],
    players: [],
    teams: [],
    set: SET,
    variant: VARIANT,
  });
  const tally = (distinctCards: number, exact = true) => ({
    copies: distinctCards * 2,
    lines: distinctCards,
    distinctCards,
    buildingSets: 0,
    exact,
    offBuildCards: distinctCards,
    offBuildExact: exact,
  });
  /** One server page: each card once, newest first, two copies on one line. */
  const page = (ids: string[]) => ids.map((cardId, i) => ({ cardId, quantity: 2, lines: 1, lastUpdated: 100 - i }));
  const catalogAnswers = () =>
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) =>
      cardIds.map((id) => (id === "gone" ? null : catalogCard(id, id.slice(1)))),
    );

  it("hydrates the first page's cards, newest first, with how many of each, and the tally's total", () => {
    loaded.set("collection:summary", tally(2));
    paged.pages.set("collection:ownedCards", [page(["k3", "k1"])]);
    catalogAnswers();
    const { result } = renderHook(() => useOwnedCards(), { wrapper });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k3", "k1"]);
    expect(result.current!.copiesByCard).toEqual({ k3: { quantity: 2, lines: 1 }, k1: { quantity: 2, lines: 1 } });
    expect(result.current).toMatchObject({ total: 2, totalExact: true, goneCardIds: [], truncated: false });
    expect(paged.loadMore).toEqual([]);
  });

  it("pages the server until it has the cards the limit asks for, and no further", () => {
    loaded.set("collection:summary", tally(6));
    paged.pages.set("collection:ownedCards", [page(["k1", "k2"]), page(["k3", "k4"]), page(["k5", "k6"])]);
    catalogAnswers();
    const { result, rerender } = renderHook(({ limit }) => useOwnedCards({ limit }), {
      wrapper,
      initialProps: { limit: 3 },
    });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k1", "k2", "k3"]);
    expect(paged.loadMore).toEqual([60]);
    expect(result.current).toMatchObject({ total: 6, truncated: true });

    // "Show more": a higher limit pages on to the end, and says so.
    rerender({ limit: 6 });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k1", "k2", "k3", "k4", "k5", "k6"]);
    expect(paged.loadMore).toEqual([60, 60]);
    expect(result.current!.truncated).toBe(false);
  });

  it("lists a card once even when two pages both carry it (a Have between their answers)", () => {
    loaded.set("collection:summary", tally(3));
    paged.pages.set("collection:ownedCards", [page(["k2", "k1"]), page(["k1", "k3"])]);
    catalogAnswers();
    const { result } = renderHook(() => useOwnedCards({ limit: 10 }), { wrapper });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k2", "k1", "k3"]);
  });

  it("lists a held card that left the catalog apart, and stops at the limit", () => {
    loaded.set("collection:summary", tally(3));
    paged.pages.set("collection:ownedCards", [page(["k1", "gone", "k2"])]);
    catalogAnswers();
    const { result } = renderHook(() => useOwnedCards({ limit: 2 }), { wrapper });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k1"]);
    expect(result.current).toMatchObject({ goneCardIds: ["gone"], truncated: true, total: 3 });
  });

  it("asks the catalog in pages the server accepts", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `k${i}`);
    loaded.set("collection:summary", tally(450));
    paged.pages.set("collection:ownedCards", [page(ids)]);
    const asked: number[] = [];
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) => {
      asked.push(cardIds.length);
      return cardIds.map((id) => catalogCard(id, id.slice(1)));
    });
    const { result } = renderHook(() => useOwnedCards({ limit: 450 }), { wrapper });
    expect(asked).toEqual([200, 200, 50]);
    expect(result.current!.cards).toHaveLength(450);
  });

  it("passes on a tally the server could only count part of", () => {
    loaded.set("collection:summary", tally(5000, false));
    paged.pages.set("collection:ownedCards", [page(["k1"]), page(["k2"])]);
    catalogAnswers();
    const { result } = renderHook(() => useOwnedCards({ limit: 1 }), { wrapper });
    expect(result.current).toMatchObject({ total: 5000, totalExact: false, truncated: true });
  });

  it("passes on the server's off-build count, and none when it could not count it exactly", () => {
    loaded.set("collection:summary", { ...tally(9), offBuildCards: 4, offBuildExact: true });
    expect(renderHook(() => useSummary(), { wrapper }).result.current).toEqual({
      copies: 18,
      cards: 9,
      exact: true,
      offBuild: 4,
    });
    cleanup();
    loaded.set("collection:summary", { ...tally(9), offBuildCards: 4, offBuildExact: false });
    expect(renderHook(() => useSummary(), { wrapper }).result.current).toMatchObject({ offBuild: null });
  });

  it("waits while the first page or the tally loads", () => {
    loaded.set("collection:summary", tally(1));
    const { result } = renderHook(() => useOwnedCards(), { wrapper });
    expect(result.current).toBeUndefined();
    cleanup();
    loaded.delete("collection:summary");
    paged.pages.set("collection:ownedCards", [page(["k1"])]);
    catalogAnswers();
    expect(renderHook(() => useOwnedCards(), { wrapper }).result.current).toBeUndefined();
  });
});

describe("every write's undo is the inverse write", () => {
  const actions = () => renderHook(() => useCollectionActions(), { wrapper }).result.current;
  /** The mutations a write sent, without the shelf's one-time ensureSystem on mount. */
  const writes = () => calls.list.filter((c) => c.name !== "collectionContainers:ensureSystem");

  it("Have, inserted: the undo removes that copy", async () => {
    calls.answers.set("collection:addHave", { copyId: "new1", merged: false });
    const a = actions();
    const result = await a.addHave(CARD);
    expect(writes()[0]).toEqual({ name: "collection:addHave", args: { cardId: "card1", acquiredOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
    await act(result.undo);
    expect(writes()[1]).toEqual({ name: "collection:removeCopy", args: { copyId: "new1" } });
  });

  it("Have, folded into a stack: the undo puts the stack back as it was", async () => {
    const previous = { quantity: 1, acquiredOn: "2026-10-23", homeId: "home1" };
    calls.answers.set("collection:addHave", { copyId: "stack1", merged: true, previous });
    const result = await actions().addHave(CARD);
    expect(result.merged).toBe(true);
    await act(result.undo);
    expect(writes()[1]).toEqual({ name: "collection:updateCopy", args: { copyId: "stack1", details: previous } });
  });

  it("an edit sends the whole copy (the server replaces details) and undoes to the server's previous", async () => {
    const previous = { quantity: 2, condition: "Mint", costCents: 125, acquiredOn: "2026-10-01", homeId: "home1" };
    calls.answers.set("collection:updateCopy", { previous });
    const result = await actions().updateCopy(COPY, { notes: "From the card show" });
    expect(writes()[0]).toEqual({
      name: "collection:updateCopy",
      args: {
        copyId: "copy1",
        details: { quantity: 2, condition: "Mint", costCents: 125, acquiredOn: "2026-10-01", notes: "From the card show", homeId: "home1" },
      },
    });
    await act(result.undo);
    expect(writes()[1]).toEqual({ name: "collection:updateCopy", args: { copyId: "copy1", details: previous } });
  });

  it("a removal's undo restores what the server removed", async () => {
    const removed = { cardId: "card1", details: { quantity: 2, condition: "Mint", homeId: "home1" } };
    calls.answers.set("collection:removeCopy", { removed });
    const result = await actions().removeCopy(COPY);
    expect(result.removed).toBe(COPY);
    await act(result.undo);
    expect(writes()[1]).toEqual({ name: "collection:restoreCopy", args: removed });
  });

  it("a batch of haves: the undo removes the new copies and unstacks the folded ones", async () => {
    const other = { ...CARD, id: "card2" };
    const previous = { quantity: 1, homeId: "home1" };
    calls.answers.set("collection:addHaves", [
      { cardId: "card1", copyId: "n1", merged: false },
      { cardId: "card2", copyId: "s2", merged: true, previous },
    ]);
    const result = await actions().addMany([CARD, other]);
    expect(result.copyIds).toEqual(["n1", "s2"]);
    await act(result.undo);
    expect(writes().slice(1)).toEqual([
      { name: "collection:removeCopies", args: { copyIds: ["n1"] } },
      { name: "collection:updateCopy", args: { copyId: "s2", details: previous } },
    ]);
  });

  it("building: the undo flips it back only when it changed", async () => {
    calls.answers.set("collection:setBuilding", { changed: true });
    const result = await actions().setBuilding(CARD.set, true);
    await act(result.undo);
    expect(writes()).toEqual([
      { name: "collection:setBuilding", args: { setId: "set1", building: true } },
      { name: "collection:setBuilding", args: { setId: "set1", building: false } },
    ]);

    calls.list.length = 0;
    calls.answers.set("collection:setBuilding", { changed: false });
    const again = await actions().setBuilding(CARD.set, true);
    await act(again.undo);
    expect(writes()).toHaveLength(1);
  });
});

describe("the shelf is made once per mount", () => {
  it("asks the server to ensure the system containers, one time, however often it re-renders", () => {
    const { rerender } = renderHook(() => useCollectionActions(), { wrapper });
    rerender();
    rerender();
    expect(calls.list.filter((c) => c.name === "collectionContainers:ensureSystem")).toEqual([
      { name: "collectionContainers:ensureSystem", args: {} },
    ]);
  });

  it("carries on when ensureSystem is refused: the first real write shows the words", async () => {
    local.failures.set("collectionContainers:ensureSystem", "no thanks");
    const { result } = renderHook(() => useCollectionActions(), { wrapper });
    calls.answers.set("collection:addHave", { copyId: "n", merged: false });
    await expect(result.current.addHave(CARD)).resolves.toMatchObject({ copyId: "n" });
  });
});

describe("the scope narrows reads and files adds", () => {
  const scoped = (scope: string) =>
    ({ children }: { children: ReactNode }) => (
      <ConvexCollectionProvider>
        <ScopeProvider value={scope}>{children}</ScopeProvider>
      </ConvexCollectionProvider>
    );

  it("asks for the picked home's copies and counts, and for everything under All", () => {
    renderHook(() => ({ a: useCopiesInVariant("v1"), b: useVariantCompletion("v1") }), { wrapper: scoped("box1") });
    expect(queried).toContainEqual({ name: "collection:copiesInVariant", args: { variantId: "v1", homeId: "box1" } });
    expect(queried).toContainEqual({ name: "collection:variantCompletion", args: { variantId: "v1", homeId: "box1" } });
    queried.length = 0;
    renderHook(() => ({ a: useCopiesInVariant("v1"), b: useVariantCompletion("v1") }), { wrapper: scoped("all") });
    expect(queried).toContainEqual({ name: "collection:copiesInVariant", args: { variantId: "v1" } });
    expect(queried).toContainEqual({ name: "collection:variantCompletion", args: { variantId: "v1" } });
  });

  it("leaves the drawer's copies of one card unscoped: it lists every home", () => {
    renderHook(() => useCopiesOf("card1"), { wrapper: scoped("box1") });
    expect(queried).toContainEqual({ name: "collection:copiesOf", args: { cardId: "card1" } });
  });

  it("a Have with a home scoped sends that home; an explicit home wins", async () => {
    calls.answers.set("collection:addHave", { copyId: "n", merged: false });
    const { result } = renderHook(() => useCollectionActions(), { wrapper: scoped("box1") });
    await result.current.addHave(CARD);
    await result.current.addHave(CARD, "binder9");
    const adds = calls.list.filter((c) => c.name === "collection:addHave").map((c) => (c.args as { homeId?: string }).homeId);
    expect(adds).toEqual(["box1", "binder9"]);
  });

  it("a Have under All names no home, so the server files it in Main", async () => {
    calls.answers.set("collection:addHave", { copyId: "n", merged: false });
    const { result } = renderHook(() => useCollectionActions(), { wrapper: scoped("all") });
    await result.current.addHave(CARD);
    expect(calls.list.find((c) => c.name === "collection:addHave")?.args).not.toHaveProperty("homeId");
  });

  it("a batch of haves with a home scoped sends it once for the batch", async () => {
    calls.answers.set("collection:addHaves", []);
    const { result } = renderHook(() => useCollectionActions(), { wrapper: scoped("box1") });
    await result.current.addMany([CARD]);
    expect(calls.list.find((c) => c.name === "collection:addHaves")?.args).toMatchObject({ homeId: "box1" });
  });
});

describe("the shelf, wants and the new paged reads", () => {
  it("hydrates the shelf, system containers first as the server lists them, with counts", () => {
    loaded.set("collectionContainers:list", [
      { _id: "m", kind: "binder", system: "main", name: "Main", count: { copies: 5, lines: 2 } },
      { _id: "b", kind: "box", name: "Show box", count: { copies: 1, lines: 1 } },
    ]);
    const { result } = renderHook(() => useContainers(), { wrapper });
    expect(result.current!.map((c) => [c.id, c.kind, c.count])).toEqual([
      ["m", "binder", { copies: 5, lines: 2 }],
      ["b", "box", { copies: 1, lines: 1 }],
    ]);
  });

  it("names a container's copies' home and kind from the shelf", () => {
    loaded.set("collectionContainers:list", [{ _id: "b", kind: "box", name: "Show box", count: { copies: 1, lines: 1 } }]);
    loaded.set("collection:copiesOf", [{ _id: "c", cardId: "card1", variantId: "v", setId: "s", homeId: "b", quantity: 1, lastUpdated: 1 }]);
    const { result } = renderHook(() => useCopiesOf("card1"), { wrapper });
    expect(result.current![0]).toMatchObject({ homeKind: "box", homeName: "Show box" });
  });

  it("reads the trade pile through tradeCopies, not copiesInContainer", () => {
    loaded.set("collectionContainers:list", [{ _id: "t", kind: "binder", system: "trade", name: "Up for Trade", count: { copies: 1, lines: 1 } }]);
    paged.pages.set("collection:tradeCopies", [[{ _id: "c", cardId: "card1", variantId: "v", setId: "s", homeId: "m", quantity: 1, upForTrade: true, lastUpdated: 1 }]]);
    const { result } = renderHook(() => useContainerCopies("t"), { wrapper });
    expect(result.current!.copies.map((c) => c.id)).toEqual(["c"]);
    expect(queried.some((q) => q.name === "collection:copiesInContainer" && q.args !== "skip")).toBe(false);
  });

  it("gives the Want List no copies", () => {
    loaded.set("collectionContainers:list", [{ _id: "w", kind: "binder", system: "want", name: "Want List", count: { copies: 2, lines: 2 } }]);
    const { result } = renderHook(() => useContainerCopies("w"), { wrapper });
    expect(result.current).toEqual({ copies: [], truncated: false });
  });

  it("lists a binder's copies by pocket, the unslotted last", () => {
    loaded.set("collectionContainers:list", [{ _id: "bin", kind: "binder", name: "Contenders", count: { copies: 3, lines: 3 } }]);
    const row = (id: string, slot?: number) => ({ _id: id, cardId: id, variantId: "v", setId: "s", homeId: "bin", quantity: 1, lastUpdated: 1, ...(slot === undefined ? {} : { slot }) });
    paged.pages.set("collection:copiesInContainer", [[row("c", undefined), row("a", 4), row("b", 1)]]);
    const { result } = renderHook(() => useContainerCopies("bin", { limit: 3 }), { wrapper });
    expect(result.current!.copies.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(result.current!.truncated).toBe(false);
  });

  it("says there are more when the server holds more than the limit", () => {
    loaded.set("collectionContainers:list", [{ _id: "bin", kind: "binder", name: "Contenders", count: { copies: 3, lines: 3 } }]);
    const row = (id: string) => ({ _id: id, cardId: id, variantId: "v", setId: "s", homeId: "bin", quantity: 1, lastUpdated: 1 });
    paged.pages.set("collection:copiesInContainer", [[row("a"), row("b"), row("c")]]);
    const { result } = renderHook(() => useContainerCopies("bin", { limit: 2 }), { wrapper });
    expect(result.current!.copies).toHaveLength(2);
    expect(result.current!.truncated).toBe(true);
  });

  it("waits for the shelf before choosing a read", () => {
    const { result } = renderHook(() => useContainerCopies("bin"), { wrapper });
    expect(result.current).toBeUndefined();
  });

  it("hydrates wants", () => {
    loaded.set("collectionWants:list", [{ cardId: "k1" }, { cardId: "k2", binderId: "b" }]);
    const { result } = renderHook(() => useWants(), { wrapper });
    expect(result.current).toEqual([
      { cardId: "k1", binderId: null },
      { cardId: "k2", binderId: "b" },
    ]);
  });

  it("reads trade copies as a page", () => {
    loaded.set("collectionContainers:list", [{ _id: "m", kind: "binder", system: "main", name: "Main", count: { copies: 2, lines: 1 } }]);
    paged.pages.set("collection:tradeCopies", [[{ _id: "c", cardId: "k", variantId: "v", setId: "s", homeId: "m", quantity: 2, upForTrade: true, lastUpdated: 1 }]]);
    const { result } = renderHook(() => useTradeCopies(), { wrapper });
    expect(result.current).toMatchObject({ truncated: false, copies: [{ id: "c", upForTrade: true }] });
  });

  it("asks for many cards' copies in groups of 50 and keys the answer by card, empty for none held", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `k${i}`);
    const asked: number[] = [];
    loaded.set("collection:copiesOfMany", ({ cardIds }: { cardIds: string[] }) => {
      asked.push(cardIds.length);
      return cardIds
        .filter((id) => id === "k0")
        .map((id) => ({ cardId: id, copies: [{ _id: "c", cardId: id, variantId: "v", setId: "s", homeId: "m", quantity: 1, lastUpdated: 1 }] }));
    });
    loaded.set("collectionContainers:list", [{ _id: "m", kind: "binder", system: "main", name: "Main", count: { copies: 1, lines: 1 } }]);
    const { result } = renderHook(() => useCopiesOfCards(ids), { wrapper });
    expect(asked).toEqual([50, 50, 20]);
    expect(result.current!.k0).toHaveLength(1);
    expect(result.current!.k1).toEqual([]);
  });

  it("pages a whole set's cards from cardsInSet", () => {
    queried.length = 0;
    renderHook(() => useSetCards("set1"), { wrapper });
    expect(queried).toContainEqual(expect.objectContaining({ name: "collection:cardsInSet", args: { setId: "set1" } }));
  });
});

describe("a card for sale never reaches a collection screen (NEO-359)", () => {
  const SHELF = [
    { _id: "m", kind: "binder", system: "main", name: "Main", count: { copies: 1, lines: 1 } },
    { _id: "t", kind: "binder", system: "trade", name: "Up for Trade", count: { copies: 2, lines: 2 } },
    { _id: "box", kind: "box", name: "Show box", count: { copies: 1, lines: 1 } },
  ];
  const row = (id: string, homeId: string, extra: Record<string, unknown> = {}) => ({
    _id: id,
    cardId: "card1",
    variantId: "v1",
    setId: "s",
    homeId,
    quantity: 1,
    lastUpdated: 1,
    ...extra,
  });

  it("drops a box's copies from the checklist's copies, and keeps them in the card's own drawer", () => {
    loaded.set("collectionContainers:list", SHELF);
    loaded.set("collection:copiesInVariant", [row("inMain", "m"), row("inBox", "box")]);
    loaded.set("collection:copiesOf", [row("inMain", "m"), row("inBox", "box")]);
    const { result } = renderHook(() => ({ checklist: useCopiesInVariant("v1"), drawer: useCopiesOf("card1") }), { wrapper });
    expect(result.current.checklist!.map((c) => c.id)).toEqual(["inMain"]);
    expect(result.current.drawer!.map((c) => [c.id, c.homeKind])).toEqual([
      ["inMain", "binder"],
      ["inBox", "box"],
    ]);
  });

  it("keeps a box's flagged copies on the Up for Trade pile, both ways it is read, and its spine counts them (trade spans both)", () => {
    loaded.set("collectionContainers:list", SHELF);
    paged.pages.set("collection:tradeCopies", [[row("inMain", "m", { upForTrade: true }), row("inBox", "box", { upForTrade: true })]]);
    const { result } = renderHook(
      () => ({ trade: useTradeCopies(), pile: useContainerCopies("t"), shelf: useContainers() }),
      { wrapper },
    );
    expect(result.current.trade!.copies.map((c) => [c.id, c.homeKind])).toEqual([
      ["inMain", "binder"],
      ["inBox", "box"],
    ]);
    expect(result.current.pile!.copies.map((c) => c.id)).toEqual(["inMain", "inBox"]);
    expect(result.current.shelf!.find((c) => c.id === "t")!.count).toEqual({ copies: 2, lines: 2 });
  });

  it("a box copy up for trade still stays off the checklist and every collection read of its card", () => {
    loaded.set("collectionContainers:list", SHELF);
    loaded.set("collection:copiesInVariant", [row("inBox", "box", { upForTrade: true })]);
    loaded.set("collection:copiesOf", [row("inBox", "box", { upForTrade: true })]);
    loaded.set("collection:copiesOfMany", [{ cardId: "card1", copies: [row("inBox", "box", { upForTrade: true })] }]);
    const { result } = renderHook(
      () => ({ checklist: useCopiesInVariant("v1"), drawer: useCopiesOf("card1"), many: useCopiesOfCards(["card1"]) }),
      { wrapper },
    );
    expect(result.current.checklist).toEqual([]);
    // A row, a found card or a landed want reads it through the collection's filter: gone.
    expect(collectionCopiesIn(result.current.drawer, "all")).toEqual([]);
    expect(collectionCopiesOfCards(result.current.many)!.card1).toEqual([]);
    // The drawer itself still lists it, for sale and up for trade.
    expect(result.current.drawer!.map((c) => [c.homeKind, c.upForTrade])).toEqual([["box", true]]);
  });

  it("lists a box's own copies (Inventory) and every home for many cards", () => {
    loaded.set("collectionContainers:list", SHELF);
    paged.pages.set("collection:copiesInContainer", [[row("inBox", "box")]]);
    loaded.set("collection:copiesOfMany", [{ cardId: "card1", copies: [row("inMain", "m"), row("inBox", "box")] }]);
    const { result } = renderHook(() => ({ box: useContainerCopies("box"), many: useCopiesOfCards(["card1"]) }), { wrapper });
    expect(result.current.box!.copies.map((c) => c.id)).toEqual(["inBox"]);
    expect(result.current.many!.card1.map((c) => c.id)).toEqual(["inMain", "inBox"]);
  });

  it("waits for the shelf: until it is in, a copy's home could be a box, so nothing shows", () => {
    loaded.set("collection:copiesInVariant", [row("inBox", "box")]);
    loaded.set("collection:copiesOf", [row("inBox", "box")]);
    loaded.set("collection:copiesOfMany", [{ cardId: "card1", copies: [row("inBox", "box")] }]);
    paged.pages.set("collection:tradeCopies", [[row("inBox", "box", { upForTrade: true })]]);
    const { result } = renderHook(
      () => ({
        checklist: useCopiesInVariant("v1"),
        drawer: useCopiesOf("card1"),
        many: useCopiesOfCards(["card1"]),
        trade: useTradeCopies(),
      }),
      { wrapper },
    );
    expect(result.current).toEqual({ checklist: undefined, drawer: undefined, many: undefined, trade: undefined });
  });
});

describe("writes: moves, trade, wants and containers", () => {
  const writes = () => calls.list.filter((c) => c.name !== "collectionContainers:ensureSystem");
  const actions = () => renderHook(() => useCollectionActions(), { wrapper }).result.current;
  const MOVE_BACK = { copyId: "copy1", folded: false, split: false, from: { homeId: "home1", quantity: 2 } };

  it("moveCopy sends the destination, quantity and row, and its undo is the inverse move", async () => {
    calls.answers.set("collection:moveCopy", { ...MOVE_BACK, from: { homeId: "home1", slot: 4, quantity: 1 } });
    const result = await actions().moveCopy(COPY, "box1", { quantity: 1, slot: 2 });
    expect(writes()[0]).toEqual({ name: "collection:moveCopy", args: { copyId: "copy1", toHomeId: "box1", quantity: 1, slot: 2 } });
    await act(result.undo);
    expect(writes()[1]).toEqual({
      name: "collection:moveCopy",
      args: { copyId: "copy1", toHomeId: "home1", quantity: 1, slot: 4 },
    });
  });

  it("a move of the whole line names no quantity", async () => {
    calls.answers.set("collection:moveCopy", MOVE_BACK);
    await actions().moveCopy(COPY, "box1");
    expect(writes()[0].args).toEqual({ copyId: "copy1", toHomeId: "box1" });
  });

  it("reports the server's fold and split", async () => {
    calls.answers.set("collection:moveCopy", { ...MOVE_BACK, copyId: "twin", folded: true, split: true });
    const r = await actions().moveCopy(COPY, "box1", { quantity: 1 });
    expect(r).toMatchObject({ copyId: "twin", folded: true, split: true });
  });

  it("placeCopy sends the row, null to take it out, and its undo goes back to the previous row", async () => {
    calls.answers.set("collection:placeCopy", { ...MOVE_BACK, from: { homeId: "home1", slot: 1, quantity: 2 } });
    const r = await actions().placeCopy(COPY, null);
    expect(writes()[0]).toEqual({ name: "collection:placeCopy", args: { copyId: "copy1", slot: null } });
    await act(r.undo);
    expect(writes()[1]).toEqual({ name: "collection:moveCopy", args: { copyId: "copy1", toHomeId: "home1", quantity: 2, slot: 1 } });
  });

  it("setTrade's undo sets the flag the server said it had", async () => {
    calls.answers.set("collection:setTrade", { previous: false });
    const r = await actions().setTrade(COPY, true);
    await act(r.undo);
    expect(writes()).toEqual([
      { name: "collection:setTrade", args: { copyId: "copy1", on: true } },
      { name: "collection:setTrade", args: { copyId: "copy1", on: false } },
    ]);
  });

  it("an edit that tries to change the home is refused before it is sent", async () => {
    await expect(actions().updateCopy(COPY, { homeId: "elsewhere" })).rejects.toThrow(/Move the card/);
    expect(writes()).toEqual([]);
  });

  it("setWant undoes to the want it replaced, or to none", async () => {
    loaded.set("collectionWants:list", [{ cardId: "card1", binderId: "b1" }]);
    calls.answers.set("collectionWants:set", { changed: true });
    const a = actions();
    const moved = await a.setWant("card1", "b2", true);
    await act(moved.undo);
    expect(writes()[1]).toEqual({ name: "collectionWants:set", args: { cardId: "card1", on: true, binderId: "b1" } });

    calls.list.length = 0;
    const fresh = await a.setWant("card9", null, true);
    await act(fresh.undo);
    expect(writes()[1]).toEqual({ name: "collectionWants:set", args: { cardId: "card9", on: false } });
  });

  it("setWant's undo does nothing when nothing changed", async () => {
    calls.answers.set("collectionWants:set", { changed: false });
    const r = await actions().setWant("card1", null, true);
    await act(r.undo);
    expect(writes()).toHaveLength(1);
  });

  it("refuses a smart binder with words, until the server can store a rule", async () => {
    await expect(
      actions().createContainer({ kind: "binder", name: "Rainbow", rule: { all: [] } as never }),
    ).rejects.toThrow(/Smart binders aren't here yet/);
    expect(writes()).toEqual([]);
  });

  it("creates a box and the undo removes it again", async () => {
    calls.answers.set("collectionContainers:create", { containerId: "newbox" });
    const r = await actions().createContainer({ kind: "box", name: "Dime box" });
    expect(r.containerId).toBe("newbox");
    expect(writes()[0]).toEqual({ name: "collectionContainers:create", args: { kind: "box", name: "Dime box" } });
    await act(r.undo);
    expect(writes()[1]).toEqual({ name: "collectionContainers:remove", args: { containerId: "newbox" } });
  });

  it("an update's undo sends the old name, description and label back", async () => {
    const container = { id: "b1", kind: "binder" as const, name: "Old", description: "d", count: null };
    const r = await actions().updateContainer(container, { name: "New", label: null });
    await act(r.undo);
    expect(writes()[0].args).toEqual({ containerId: "b1", name: "New", label: null });
    expect(writes()[1].args).toEqual({ containerId: "b1", name: "Old", label: null });
  });

  it("delete empties the container in rounds until nothing remains, then removes it", async () => {
    const answers = [{ moved: 200, remaining: 30 }, { moved: 30, remaining: 0 }];
    let round = 0;
    calls.answers.set("collectionContainers:empty", () => answers[round++]);
    const { result } = renderHook(() => useCollectionActions(), { wrapper });
    const r = await result.current.deleteContainer({ id: "b1", kind: "binder", name: "Old", count: null });
    expect(r.moved).toBe(230);
    expect(writes().map((c) => c.name)).toEqual([
      "collectionContainers:empty",
      "collectionContainers:empty",
      "collectionContainers:remove",
    ]);
  });
});

describe("optimistic updates: a copy is never shown in two places", () => {
  const MAIN = "home1";
  const BOX = "box1";
  const base = (over: Record<string, unknown> = {}) => ({
    _id: "copy1",
    cardId: "card1",
    variantId: "base1",
    setId: "set1",
    homeId: MAIN,
    quantity: 3,
    acquiredOn: "2026-10-01",
    lastUpdated: 1,
    ...over,
  });
  const page = (rows: unknown[]) => ({ page: rows, isDone: true });
  const opts = { numItems: 100, cursor: null };

  /** Seeds every loaded list the move could reach: the card, the checklist at three scopes, both homes, the trade pile and the shelf. */
  function seed(rows: unknown[] = [base()], boxRows: unknown[] = []) {
    const inMain = rows.filter((r) => (r as { homeId: string }).homeId === MAIN);
    local.set("collection:copiesOf", { cardId: "card1" }, [...rows, ...boxRows]);
    local.set("collection:copiesInVariant", { variantId: "base1" }, [...rows, ...boxRows]);
    local.set("collection:copiesInVariant", { variantId: "base1", homeId: MAIN }, inMain);
    local.set("collection:copiesInVariant", { variantId: "base1", homeId: BOX }, boxRows);
    local.set("collection:variantCompletion", { variantId: "base1" }, { owned: 1, total: 330, ownedAll: 1, totalAll: 335 });
    local.set("collection:variantCompletion", { variantId: "base1", homeId: MAIN }, { owned: 1, total: 330, ownedAll: 1, totalAll: 335 });
    local.set("collection:variantCompletion", { variantId: "base1", homeId: BOX }, { owned: 0, total: 330, ownedAll: 0, totalAll: 335 });
    local.set("collection:copiesInContainer", { containerId: MAIN, paginationOpts: opts }, page(inMain));
    local.set("collection:copiesInContainer", { containerId: BOX, paginationOpts: opts }, page(boxRows));
    local.set("collection:tradeCopies", { paginationOpts: opts }, page([]));
    local.set("collectionContainers:list", {}, [
      { _id: MAIN, kind: "binder", system: "main", name: "Main", count: { copies: 3, lines: 1 } },
      { _id: BOX, kind: "box", name: "Show box", count: { copies: boxRows.length, lines: boxRows.length } },
      { _id: "trade", kind: "binder", system: "trade", name: "Up for Trade", count: { copies: 0, lines: 0 } },
      { _id: "want", kind: "binder", system: "want", name: "Want List", count: { copies: 1, lines: 1 } },
    ]);
  }
  const rowsIn = (name: string, containerId: string) =>
    (local.get(name, { containerId, paginationOpts: opts }) as { page: { _id: string; quantity: number }[] }).page;
  const copiesOf = () => local.get("collection:copiesOf", { cardId: "card1" }) as { _id: string; homeId: string; quantity: number; slot?: number; upForTrade?: boolean }[];
  const count = (id: string) =>
    (local.get("collectionContainers:list", {}) as { _id: string; count: { copies: number; lines: number } }[]).find((c) => c._id === id)!.count;
  const completion = (homeId?: string) =>
    local.get("collection:variantCompletion", { variantId: "base1", ...(homeId ? { homeId } : {}) }) as { owned: number; ownedAll: number };
  const move = COPY_AT(MAIN);

  function COPY_AT(homeId: string): Copy {
    return { ...COPY, id: "copy1", homeId, quantity: 3, acquiredAt: "2026-10-01", notes: "", condition: undefined, costBasis: undefined };
  }
  const actions = () => renderHook(() => useCollectionActions(), { wrapper }).result.current;
  const answer = (over: object = {}) =>
    calls.answers.set("collection:moveCopy", { copyId: "copy1", folded: false, split: false, from: { homeId: MAIN, quantity: 3 }, ...over });

  it("moves the whole line: it leaves Main's list and joins the box's in the same update", async () => {
    seed();
    answer();
    await actions().moveCopy(move, BOX);
    expect(rowsIn("collection:copiesInContainer", MAIN)).toEqual([]);
    expect(rowsIn("collection:copiesInContainer", BOX).map((r) => r._id)).toEqual(["copy1"]);
    expect(copiesOf().filter((r) => r._id === "copy1")).toHaveLength(1);
    expect(copiesOf()[0].homeId).toBe(BOX);
  });

  it("moves the checklist's scoped lists and counts with it, and leaves the All count alone", async () => {
    seed();
    answer();
    await actions().moveCopy(move, BOX);
    expect((local.get("collection:copiesInVariant", { variantId: "base1", homeId: MAIN }) as unknown[]).length).toBe(0);
    expect((local.get("collection:copiesInVariant", { variantId: "base1", homeId: BOX }) as unknown[]).length).toBe(1);
    expect(completion(MAIN).owned).toBe(0);
    expect(completion(BOX).owned).toBe(1);
    expect(completion()).toMatchObject({ owned: 1, ownedAll: 1 });
  });

  it("moves the shelf's counts: Main loses the copies and the line, the box gains them", async () => {
    seed();
    answer();
    await actions().moveCopy(move, BOX);
    expect(count(MAIN)).toEqual({ copies: 0, lines: 0 });
    expect(count(BOX)).toEqual({ copies: 3, lines: 1 });
    expect(count("want")).toEqual({ copies: 1, lines: 1 });
  });

  it("splits a quantity: the source keeps the rest in Main and a new line lands in the box", async () => {
    seed();
    answer({ copyId: "new", split: true, from: { homeId: MAIN, quantity: 2 } });
    await actions().moveCopy(move, BOX, { quantity: 2 });
    expect(rowsIn("collection:copiesInContainer", MAIN)).toEqual([expect.objectContaining({ _id: "copy1", quantity: 1 })]);
    const boxRows = rowsIn("collection:copiesInContainer", BOX);
    expect(boxRows).toHaveLength(1);
    expect(boxRows[0].quantity).toBe(2);
    expect(boxRows[0]._id).not.toBe("copy1");
    expect(count(MAIN)).toEqual({ copies: 1, lines: 1 });
    expect(count(BOX)).toEqual({ copies: 2, lines: 1 });
    // The card is still held in Main, so Main's checklist count does not drop.
    expect(completion(MAIN).owned).toBe(1);
  });

  it("folds into an identical line already in the box: one line, the quantities add", async () => {
    const twin = base({ _id: "twin", homeId: BOX, quantity: 1 });
    seed([base()], [twin]);
    answer({ copyId: "twin", folded: true });
    await actions().moveCopy(move, BOX);
    expect(copiesOf().map((r) => [r._id, r.quantity])).toEqual([["twin", 4]]);
    expect(rowsIn("collection:copiesInContainer", MAIN)).toEqual([]);
    expect(rowsIn("collection:copiesInContainer", BOX)).toEqual([expect.objectContaining({ _id: "twin", quantity: 4 })]);
    expect(count(BOX)).toEqual({ copies: 4, lines: 1 });
  });

  it("does not fold into a box line that differs only by its row", async () => {
    const other = base({ _id: "other", homeId: BOX, quantity: 1, slot: 2 });
    seed([base()], [other]);
    answer();
    await actions().moveCopy(move, BOX);
    expect(copiesOf().map((r) => r._id).sort()).toEqual(["copy1", "other"]);
  });

  it("lands at the row asked for", async () => {
    seed();
    answer();
    await actions().moveCopy(move, BOX, { slot: 3 });
    expect(copiesOf()[0]).toMatchObject({ homeId: BOX, slot: 3 });
  });

  it("placeCopy re-rows the line in its own home and clears the row with null", async () => {
    seed([base({ homeId: BOX, slot: 1 })]);
    calls.answers.set("collection:placeCopy", { copyId: "copy1", folded: false, split: false, from: { homeId: BOX, slot: 1, quantity: 3 } });
    await actions().placeCopy({ ...move, homeId: BOX, slot: 1 }, 4);
    expect(copiesOf()[0]).toMatchObject({ homeId: BOX, slot: 4 });
    await actions().placeCopy({ ...move, homeId: BOX, slot: 4 }, null);
    expect(copiesOf()[0]).not.toHaveProperty("slot");
  });

  it("rolls the whole move back when the server refuses it, restoring every list", async () => {
    seed();
    const before = local.snapshot();
    local.failures.set("collection:moveCopy", "That pocket already holds a card.");
    await expect(actions().moveCopy(move, BOX)).rejects.toThrow(/pocket already holds/);
    expect([...local.data.entries()]).toEqual([...before.entries()]);
    expect(rowsIn("collection:copiesInContainer", MAIN).map((r) => r._id)).toEqual(["copy1"]);
    expect(rowsIn("collection:copiesInContainer", BOX)).toEqual([]);
    expect(count(MAIN)).toEqual({ copies: 3, lines: 1 });
  });

  it("setTrade flags the line without moving it: it joins the trade pile and stays in its home", async () => {
    seed();
    calls.answers.set("collection:setTrade", { previous: false });
    await actions().setTrade(move, true);
    expect(rowsIn("collection:copiesInContainer", MAIN).map((r) => r._id)).toEqual(["copy1"]);
    expect((local.get("collection:tradeCopies", { paginationOpts: opts }) as { page: { _id: string }[] }).page.map((r) => r._id)).toEqual(["copy1"]);
    expect(copiesOf()[0]).toMatchObject({ homeId: MAIN, upForTrade: true });
    expect(count("trade")).toEqual({ copies: 3, lines: 1 });
    expect(count(MAIN)).toEqual({ copies: 3, lines: 1 });
  });

  it("flagging a box's line puts it on the trade pile and its spine count, and it stays in the box (trade spans both)", async () => {
    seed([], [base({ homeId: BOX, quantity: 1 })]);
    calls.answers.set("collection:setTrade", { previous: false });
    await actions().setTrade({ ...COPY_AT(BOX), quantity: 1, homeKind: "box" }, true);
    expect((local.get("collection:tradeCopies", { paginationOpts: opts }) as { page: { _id: string }[] }).page.map((r) => r._id)).toEqual(["copy1"]);
    expect(rowsIn("collection:copiesInContainer", BOX).map((r) => r._id)).toEqual(["copy1"]);
    expect(count("trade")).toEqual({ copies: 1, lines: 1 });
    expect(count(BOX)).toEqual({ copies: 1, lines: 1 });
  });

  it("unflagging takes the line off the trade pile", async () => {
    seed([base({ upForTrade: true })]);
    local.set("collection:tradeCopies", { paginationOpts: opts }, page([base({ upForTrade: true })]));
    calls.answers.set("collection:setTrade", { previous: true });
    await actions().setTrade({ ...move, upForTrade: true }, false);
    expect((local.get("collection:tradeCopies", { paginationOpts: opts }) as { page: unknown[] }).page).toEqual([]);
    expect(copiesOf()[0]).not.toHaveProperty("upForTrade");
  });

  it("rolls a trade flag back when the write fails", async () => {
    seed();
    const before = local.snapshot();
    local.failures.set("collection:setTrade", "Not now.");
    await expect(actions().setTrade(move, true)).rejects.toThrow("Not now.");
    expect([...local.data.entries()]).toEqual([...before.entries()]);
  });

  it("a new Have lands in the scoped box's list and the checklist count; a failed one is rolled back", async () => {
    seed([], []);
    local.set("collection:copiesOf", { cardId: "card1" }, []);
    local.set("collection:copiesInVariant", { variantId: "base1", homeId: BOX }, []);
    calls.answers.set("collection:addHave", { copyId: "n", merged: false });
    await actions().addHave(CARD, BOX);
    expect(rowsIn("collection:copiesInContainer", BOX)).toHaveLength(1);
    expect(completion(BOX).owned).toBe(1);
    expect(count(BOX)).toEqual({ copies: 1, lines: 1 });

    const after = local.snapshot();
    local.failures.set("collection:addHave", "Nope");
    await expect(actions().addHave({ ...CARD, id: "card1" }, BOX)).rejects.toThrow("Nope");
    expect([...local.data.entries()]).toEqual([...after.entries()]);
  });

  it("a removal drops the line from every list and the shelf count", async () => {
    seed();
    calls.answers.set("collection:removeCopy", { removed: { cardId: "card1", details: { quantity: 3, homeId: MAIN } } });
    await actions().removeCopy(move);
    expect(rowsIn("collection:copiesInContainer", MAIN)).toEqual([]);
    expect(count(MAIN)).toEqual({ copies: 0, lines: 0 });
    expect(completion().owned).toBe(0);
  });

  it("a want moves the Want List count, and a removed container leaves the shelf", async () => {
    local.set("collectionWants:list", {}, [{ cardId: "card1" }]);
    local.set("collectionContainers:list", {}, [
      { _id: "want", kind: "binder", system: "want", name: "Want List", count: { copies: 1, lines: 1 } },
      { _id: "b1", kind: "binder", name: "Old", count: { copies: 0, lines: 0 } },
    ]);
    calls.answers.set("collectionWants:set", { changed: true });
    await actions().setWant("card2", null, true);
    expect((local.get("collectionWants:list", {}) as unknown[]).length).toBe(2);
    expect(count("want")).toEqual({ copies: 2, lines: 2 });
    calls.answers.set("collectionContainers:empty", { moved: 0, remaining: 0 });
    await actions().deleteContainer({ id: "b1", kind: "binder", name: "Old", count: null });
    expect((local.get("collectionContainers:list", {}) as { _id: string }[]).map((c) => c._id)).toEqual(["want"]);
  });

  it("renames a container on the shelf at once", async () => {
    local.set("collectionContainers:list", {}, [{ _id: "b1", kind: "binder", name: "Old", count: { copies: 0, lines: 0 } }]);
    await actions().updateContainer({ id: "b1", kind: "binder", name: "Old", count: null }, { name: " New " });
    expect((local.get("collectionContainers:list", {}) as { name: string }[])[0].name).toBe("New");
  });
});
