import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConvexCollectionProvider, __test } from "./convexStore";
import {
  useCapabilities,
  useCollectionActions,
  useDemoExtension,
  useOwnedCards,
  useSearch,
  useSuggestions,
  useVariantCompletion,
} from "./store";
import type { Card, Copy } from "./types";

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

vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  return {
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
      const fn = Object.assign(
        async (args: unknown) => {
          calls.list.push({ name, args });
          return calls.answers.get(name) ?? null;
        },
        { withOptimisticUpdate: () => fn },
      );
      return fn;
    },
  };
});

const wrapper = ({ children }: { children: ReactNode }) => <ConvexCollectionProvider>{children}</ConvexCollectionProvider>;

const { toVariantRef, toCopy, toRawDetails, fromRawDetails, toDrillItem, foldsInto } = __test;

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
      quantity: 3,
      graded: { grader: "PSA", grade: "10" },
      costBasis: 19.99,
      acquiredAt: "2026-10-23",
      notes: "",
    });
  });

  it("writes dollars as whole cents, blank text as absent, and never the demo's extras", () => {
    const out = toRawDetails(
      { quantity: 1, costBasis: 0.1 + 0.2, acquiredAt: "2026-10-23", notes: "   ", location: " ", serialNumber: "", demo: { binderIds: ["b"], forSale: true } },
      "home1",
    );
    expect(out).toEqual({ quantity: 1, costCents: 30, acquiredOn: "2026-10-23", homeId: "home1" });
    expect(fromRawDetails(out)).toEqual({ quantity: 1, costBasis: 0.3, acquiredAt: "2026-10-23", notes: "" });
  });

  it("folds like the server: identical details only, never a cert or a serial", () => {
    const row = { quantity: 1, acquiredOn: "2026-10-23", homeId: "h" } as never;
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23" } as never)).toBe(true);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-22" } as never)).toBe(false);
    expect(foldsInto(row, { quantity: 1, acquiredOn: "2026-10-23", serialNumber: "3/50" } as never)).toBe(false);
    expect(foldsInto({ ...(row as object), grading: { grader: "PSA", grade: "10", cert: "1" } } as never, row)).toBe(false);
  });
});

describe("the real store's capabilities and reads", () => {
  it("is all off, with no demo extension", () => {
    const { result } = renderHook(() => ({ caps: useCapabilities(), demo: useDemoExtension() }), { wrapper });
    expect(Object.values(result.current.caps).some(Boolean)).toBe(false);
    expect(result.current.demo).toBeUndefined();
  });

  it("never asks the server about text too short to search", () => {
    const { result } = renderHook(() => ({ s: useSearch(" o "), g: useSuggestions("o") }), { wrapper });
    expect(result.current).toEqual({ s: { cards: [], truncated: false }, g: [] });
    expect(queried.filter((q) => q.args !== "skip")).toEqual([]);
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
  const summary = (ids: string[], truncated = false) => ({
    copies: ids.length * 2,
    lines: ids.length,
    distinctCards: ids.length,
    buildingSets: 0,
    cards: ids.map((cardId, i) => ({ cardId, quantity: 2, lines: 1, lastUpdated: 100 - i })),
    truncated,
  });

  it("hydrates the summary's cards, newest first, with how many of each", () => {
    loaded.set("collection:summary", summary(["k3", "k1"]));
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) =>
      cardIds.map((id) => catalogCard(id, id.slice(1))),
    );
    const { result } = renderHook(() => useOwnedCards(), { wrapper });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k3", "k1"]);
    expect(result.current!.copiesByCard).toEqual({ k3: { quantity: 2, lines: 1 }, k1: { quantity: 2, lines: 1 } });
    expect(result.current).toMatchObject({ total: 2, goneCardIds: [], truncated: false });
  });

  it("lists a held card that left the catalog apart, and stops at the limit", () => {
    loaded.set("collection:summary", summary(["k1", "gone", "k2"]));
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) =>
      cardIds.map((id) => (id === "gone" ? null : catalogCard(id, id.slice(1)))),
    );
    const { result } = renderHook(() => useOwnedCards({ limit: 2 }), { wrapper });
    expect(result.current!.cards.map((c) => c.id)).toEqual(["k1"]);
    expect(result.current).toMatchObject({ goneCardIds: ["gone"], truncated: true, total: 3 });
  });

  it("asks the catalog in pages the server accepts", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `k${i}`);
    loaded.set("collection:summary", summary(ids));
    const asked: number[] = [];
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) => {
      asked.push(cardIds.length);
      return cardIds.map((id) => catalogCard(id, id.slice(1)));
    });
    const { result } = renderHook(() => useOwnedCards({ limit: 450 }), { wrapper });
    expect(asked).toEqual([200, 200, 50]);
    expect(result.current!.cards).toHaveLength(450);
  });

  it("says when the summary itself stopped short", () => {
    loaded.set("collection:summary", summary(["k1"], true));
    loaded.set("collectionCatalog:cards", ({ cardIds }: { cardIds: string[] }) => cardIds.map((id) => catalogCard(id, "1")));
    const { result } = renderHook(() => useOwnedCards(), { wrapper });
    expect(result.current!.truncated).toBe(true);
  });

  it("waits while the summary loads", () => {
    const { result } = renderHook(() => useOwnedCards(), { wrapper });
    expect(result.current).toBeUndefined();
  });
});

describe("every write's undo is the inverse write", () => {
  const actions = () => renderHook(() => useCollectionActions(), { wrapper }).result.current;

  it("Have, inserted: the undo removes that copy", async () => {
    calls.answers.set("collection:addHave", { copyId: "new1", merged: false });
    const a = actions();
    const result = await a.addHave(CARD);
    expect(calls.list[0]).toEqual({ name: "collection:addHave", args: { cardId: "card1", acquiredOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
    await act(result.undo);
    expect(calls.list[1]).toEqual({ name: "collection:removeCopy", args: { copyId: "new1" } });
  });

  it("Have, folded into a stack: the undo puts the stack back as it was", async () => {
    const previous = { quantity: 1, acquiredOn: "2026-10-23", homeId: "home1" };
    calls.answers.set("collection:addHave", { copyId: "stack1", merged: true, previous });
    const result = await actions().addHave(CARD);
    expect(result.merged).toBe(true);
    await act(result.undo);
    expect(calls.list[1]).toEqual({ name: "collection:updateCopy", args: { copyId: "stack1", details: previous } });
  });

  it("an edit sends the whole copy (the server replaces details) and undoes to the server's previous", async () => {
    const previous = { quantity: 2, condition: "Mint", costCents: 125, acquiredOn: "2026-10-01", homeId: "home1" };
    calls.answers.set("collection:updateCopy", { previous });
    const result = await actions().updateCopy(COPY, { notes: "From the card show" });
    expect(calls.list[0]).toEqual({
      name: "collection:updateCopy",
      args: {
        copyId: "copy1",
        details: { quantity: 2, condition: "Mint", costCents: 125, acquiredOn: "2026-10-01", notes: "From the card show", homeId: "home1" },
      },
    });
    await act(result.undo);
    expect(calls.list[1]).toEqual({ name: "collection:updateCopy", args: { copyId: "copy1", details: previous } });
  });

  it("a removal's undo restores what the server removed", async () => {
    const removed = { cardId: "card1", details: { quantity: 2, condition: "Mint", homeId: "home1" } };
    calls.answers.set("collection:removeCopy", { removed });
    const result = await actions().removeCopy(COPY);
    expect(result.removed).toBe(COPY);
    await act(result.undo);
    expect(calls.list[1]).toEqual({ name: "collection:restoreCopy", args: removed });
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
    expect(calls.list.slice(1)).toEqual([
      { name: "collection:removeCopies", args: { copyIds: ["n1"] } },
      { name: "collection:updateCopy", args: { copyId: "s2", details: previous } },
    ]);
  });

  it("building: the undo flips it back only when it changed", async () => {
    calls.answers.set("collection:setBuilding", { changed: true });
    const result = await actions().setBuilding(CARD.set, true);
    await act(result.undo);
    expect(calls.list).toEqual([
      { name: "collection:setBuilding", args: { setId: "set1", building: true } },
      { name: "collection:setBuilding", args: { setId: "set1", building: false } },
    ]);

    calls.list.length = 0;
    calls.answers.set("collection:setBuilding", { changed: false });
    const again = await actions().setBuilding(CARD.set, true);
    await act(again.undo);
    expect(calls.list).toHaveLength(1);
  });
});
