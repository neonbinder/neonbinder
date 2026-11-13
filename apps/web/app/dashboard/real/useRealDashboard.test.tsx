import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cards as fixtureCards } from "@/app/collection/prototypes/_shared/data";
import { binderPages } from "@/app/collection/final/binders/model";
import { demoCard } from "@/app/collection/final/data/demoStore";
import type { Card, CollectionSummary, Container, ContainerCopies, Copy, SetRef, Want } from "@/app/collection/final/data/types";
import { RUN_PARAM } from "@/app/collection/final/intake/RealAddCardsTab";
import { toDash } from "../dash-card";
import { bindersOf as demoBindersOf, getDashboard } from "../fake-data";
import DashboardScreen from "../screen/DashboardScreen";
import { pageCount, POCKETS_PER_PAGE, shelfOrder } from "../screen/shelf-model";
import { labelOf, PLAIN_LABEL } from "@/app/collection/final/binders/label";
import { SHELF_CAP } from "../screen/Shelf";
import { NEED_NAMED } from "../screen/Boards";
import type {
  CompletionRaw,
  CouldFitRaw,
  FreshPullsRaw,
  IntakeRaw,
  NewListingsRaw,
  NewSetRaw,
  NewSinceRaw,
  SalesRaw,
  SetBoardRaw,
  SyncAlertsRaw,
} from "./useDashboardServer";
import {
  ADD_CARDS_RUN_PARAM,
  boxesInUseOf,
  BOARD_SETS,
  buildingSetOf,
  CHASE_CAP,
  chaseOf,
  completedChecklistOf,
  completionWindowStart,
  couldFitByBinder,
  couldFitPreviewIds,
  daysSinceSold,
  FRESH_PULLS_CARDS,
  freshPullIds,
  freshPullsOf,
  freshPullsWindowStart,
  heldBackReason,
  NEW_LISTINGS_CARDS,
  newListingIds,
  newListingsOf,
  shelfBoxesOf,
  syncCardIdsOf,
  syncStatusOf,
  intakeOf,
  lastScanLabel,
  JUST_COMPLETED_DAYS,
  justCompletedOf,
  localDay,
  namedNeedsOf,
  newCardsByHome,
  newSetsOf,
  pullDayLabel,
  smartBindersOf,
  pocketsOfPages,
  realDashboardData,
  recentCompletions,
  runHrefOf,
  saleCardIdsOf,
  saleLineOf,
  salesDataOf,
  shelfBinderOf,
  statusWordsOf,
  TRADE_PREVIEW,
  tradePileOf,
  unlistedBoxesOf,
  unshippedSaleOf,
  useRealDashboard,
  wantCardsOf,
  type CompletedChecklist,
} from "./useRealDashboard";

// The store's hooks, answered by the test: the real ones need a mounted Convex store.
const store = vi.hoisted(() => ({
  containers: undefined as Container[] | undefined,
  summary: undefined as CollectionSummary | undefined,
  copies: new Map<string, ContainerCopies>(),
  copiesAsked: [] as (string | null)[],
  wants: undefined as Want[] | undefined,
  trade: undefined as ContainerCopies | undefined,
  tradeLimits: [] as (number | undefined)[],
  building: [] as SetRef[] | undefined,
}));

// The dashboard's own Convex reads (`./useDashboardServer`), answered by the test.
const server = vi.hoisted(() => ({
  since: undefined as number | null | undefined,
  fresh: undefined as NewSinceRaw | undefined,
  completions: [] as CompletionRaw[] | undefined,
  boards: undefined as Map<string, SetBoardRaw | null> | undefined,
  smart: undefined as Map<string, { have: number; total: number } | null> | undefined,
  boardsAsked: [] as (readonly string[] | null)[],
  smartAsked: [] as (readonly string[] | null)[],
  couldFit: undefined as Map<string, CouldFitRaw | null> | undefined,
  couldFitAsked: [] as (readonly string[] | null)[],
  intake: undefined as IntakeRaw | undefined,
  sales: undefined as SalesRaw | undefined,
  pulls: undefined as FreshPullsRaw | undefined,
  pullsAsked: [] as number[],
  newSets: undefined as NewSetRaw[] | undefined,
  listings: undefined as NewListingsRaw | undefined,
  listingsAsked: [] as number[],
  sync: undefined as SyncAlertsRaw | undefined,
}));

vi.mock("./useDashboardServer", () => ({
  useVisitSince: () => server.since,
  useNewSince: (sinceMs: number | null | undefined) => (typeof sinceMs === "number" ? server.fresh : undefined),
  useJustCompletedRaw: () => server.completions,
  useSetBoards: (ids: readonly string[] | null) => {
    server.boardsAsked.push(ids);
    return server.boards;
  },
  useSmartChecklists: (ids: readonly string[] | null) => {
    server.smartAsked.push(ids);
    return server.smart;
  },
  useCouldFit: (ids: readonly string[] | null) => {
    server.couldFitAsked.push(ids);
    return server.couldFit;
  },
  useIntakeRaw: () => server.intake,
  useSalesRaw: () => server.sales,
  useFreshPullLines: (sinceMs: number) => {
    server.pullsAsked.push(sinceMs);
    return server.pulls;
  },
  useNewSets: () => server.newSets,
  useNewListingLines: (sinceMs: number) => {
    server.listingsAsked.push(sinceMs);
    return server.listings;
  },
  useSyncAlertsRaw: () => server.sync,
}));

vi.mock("@/app/collection/final/data/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/collection/final/data/store")>();
  return {
    ...actual,
    useContainers: () => store.containers,
    useSummary: () => store.summary,
    useContainerCopies: (id: string | null) => {
      store.copiesAsked.push(id);
      return id === null ? undefined : store.copies.get(id);
    },
    useWants: () => store.wants,
    useBuildingSets: () => store.building,
    useTradeCopies: (options?: { limit?: number }) => {
      store.tradeLimits.push(options?.limit);
      return store.trade;
    },
  };
});

vi.mock("@/app/collection/final/binders/hooks", () => ({
  useCardMap: (ids: readonly string[] | null) => {
    if (ids === null) return undefined;
    const map = new Map<string, Card>();
    for (const id of ids) {
      const card = demoCard(id);
      if (card) map.set(id, card);
    }
    return map;
  },
}));

/** Two real catalog cards, as the store would hand them over. */
const [cardA, cardB] = fixtureCards
  .filter((c) => c.setId === "1996-playoff-contenders" && c.variantPath.type === "Base" && c.variation === null)
  .slice(0, 2)
  .map((c) => demoCard(c.id)!);

let seq = 0;
const copy = (card: Card, over: Partial<Copy> = {}): Copy => ({
  id: `copy-${++seq}`,
  cardId: card.id,
  variantId: card.variant.id,
  setId: card.set.id,
  homeId: "binder-1",
  homeKind: "binder",
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-01-01",
  notes: "",
  ...over,
});

const container = (over: Partial<Container> & Pick<Container, "id">): Container => ({
  kind: "binder",
  name: over.id,
  count: null,
  ...over,
});

const SUMMARY: CollectionSummary = { copies: 3, cards: 2, exact: true, offBuild: 0 };

const NOT_A_DEALER: SalesRaw = { dealer: false, orders: [], more: false };

const NOTHING_TO_SYNC: SyncAlertsRaw = { pending: [], sets: [], more: false };

function wrapper(url: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  };
}

beforeEach(() => {
  store.containers = undefined;
  store.summary = undefined;
  store.copies = new Map();
  store.copiesAsked = [];
  store.wants = [];
  store.trade = undefined;
  store.tradeLimits = [];
  store.building = [];
  server.since = undefined;
  server.fresh = undefined;
  server.completions = [];
  server.boards = undefined;
  server.smart = undefined;
  server.boardsAsked = [];
  server.smartAsked = [];
  server.couldFit = undefined;
  server.couldFitAsked = [];
  server.intake = undefined;
  server.sales = NOT_A_DEALER;
  server.pulls = undefined;
  server.pullsAsked = [];
  server.newSets = undefined;
  server.listings = undefined;
  server.listingsAsked = [];
  server.sync = NOTHING_TO_SYNC;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pocketsOfPages: a binder's slots become the screen's pockets", () => {
  it("puts a copy at slot 0 in the first pocket and an unslotted copy in the next, nine to a page", () => {
    const copies = [copy(cardB), copy(cardA, { slot: 0 })];
    const cards = new Map([
      [cardA.id, cardA],
      [cardB.id, cardB],
    ]);
    const pages = binderPages({ binderId: "binder-1", copies, cards, followed: null });
    const pockets = pocketsOfPages(pages);

    expect(pockets.length).toBe(pages.length * POCKETS_PER_PAGE);
    expect(pockets[0]).toMatchObject({ kind: "card", isNew: false, key: "p0-s0" });
    expect(pockets[0].card?.id).toBe(cardA.id);
    expect(pockets[0].card?.title).toContain(cardA.players[0].name);
    // The copy with no slot takes the first pocket after the last slotted one.
    expect(pockets[1]).toMatchObject({ kind: "card", key: "p0-s1" });
    expect(pockets[1].card?.id).toBe(cardB.id);
    expect(pockets.slice(2).every((p) => p.kind === "empty" && p.card === null)).toBe(true);
    // The page count is the pages binderPages laid out (with its fresh page at the back).
    expect(pageCount(shelfBinderOf(container({ id: "binder-1" }), pockets))).toBe(pages.length);
  });
});

describe("shelfBinderOf: a container as a spine", () => {
  it("wears the binder's own label, its copies count and no news", () => {
    const b = shelfBinderOf(
      container({ id: "b1", name: "Packers", label: { background: "#203731", text: "#ffb612", fontId: "x" }, count: { copies: 7, lines: 5 } }),
    );
    expect(b).toMatchObject({ kind: "manual", ruleText: null, cardCount: 7, vinyl: "#203731", stripe: "#ffb612" });
    expect(b.label).toEqual({ background: "#203731", text: "#ffb612", fontId: "x" });
    expect(b.newCards).toEqual([]);
    expect(b.pockets).toEqual([]);
  });

  it("wears My Binders' default label when it has none (Main its green, any other the plain one), and reads a not-yet-counted binder as 0", () => {
    const main = shelfBinderOf(container({ id: "main", system: "main", name: "Main" }));
    expect(main.cardCount).toBe(0);
    expect(main.label).toEqual(labelOf({ kind: "binder", system: "main" }));
    expect(main.vinyl).toBe(main.label.background);
    expect(shelfBinderOf(container({ id: "b2", name: "Plain" })).label).toEqual(PLAIN_LABEL);
  });

  it("is a smart spine, its rule in words, when the binder has a rule", () => {
    const b = shelfBinderOf(
      container({
        id: "smart",
        smartRule: { version: 1, match: "all", terms: [{ test: { kind: "player", playerIds: ["p1"] } }] },
        ruleNames: { p1: "Reggie White" },
      }),
    );
    expect(b.kind).toBe("smart");
    expect(b.ruleText).toBe("Reggie White");
  });
});

describe("shelfOrder on real binders", () => {
  it("stands the fullest first (no binder has news yet), ties in the store's order", () => {
    const ordered = shelfOrder([
      shelfBinderOf(container({ id: "main", system: "main", name: "Main", count: { copies: 2, lines: 2 } })),
      shelfBinderOf(container({ id: "a", count: { copies: 10, lines: 4 } })),
      shelfBinderOf(container({ id: "b", count: null })),
      shelfBinderOf(container({ id: "c", count: { copies: 2, lines: 1 } })),
    ]);
    expect(ordered.map((b) => b.id)).toEqual(["a", "main", "c", "b"]);
  });
});

describe("useRealDashboard", () => {
  it("is undefined while the shelf or the summary loads", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main" })];
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    expect(result.current).toBeUndefined();
  });

  it("shelves Main and the collector's binders, never a box, the Want List or the trade pile", () => {
    store.containers = [
      container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } }),
      container({ id: "want", system: "want", name: "Want List" }),
      container({ id: "trade", system: "trade", name: "Up for Trade" }),
      container({ id: "unsorted", system: "unsorted", kind: "box", name: "Unsorted", count: { copies: 0, lines: 0 } }),
      container({ id: "box", kind: "box", name: "Show box" }),
      container({ id: "binder-1", name: "Packers" }),
    ];
    store.summary = SUMMARY;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.binders?.map((b) => b.id)).toEqual(["main", "binder-1"]);
    // The Show box is in use (Unsorted, empty, is not): the third shelf carries no starter.
    expect(data.totals).toEqual({ cards: 2, binders: 2, boxes: 1, exact: true });
    expect(data.sales).toBeNull();
    // Nothing open: no copies read.
    expect(store.copiesAsked.every((id) => id === null)).toBe(true);
  });

  it("lays out the open binder's pockets, and only that binder's", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main" }), container({ id: "binder-1", name: "Packers" })];
    store.summary = SUMMARY;
    store.copies.set("binder-1", { copies: [copy(cardA, { slot: 0 }), copy(cardB)], truncated: false });
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard?binder=binder-1") });
    const [main, open] = result.current!.binders!;
    expect(main.pockets).toEqual([]);
    expect(open.pockets[0].card?.id).toBe(cardA.id);
    expect(open.pockets[1].card?.id).toBe(cardB.id);
  });

  it("reads nothing for a binder id that is not on the shelf", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main" })];
    store.summary = SUMMARY;
    renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard?binder=someone-elses") });
    expect(store.copiesAsked.every((id) => id === null)).toBe(true);
  });
});

describe("tradePileOf: the copies flagged up for trade", () => {
  const cards = new Map([
    [cardA.id, cardA],
    [cardB.id, cardB],
  ]);
  const pile = (copies: number | null) =>
    container({ id: "trade", system: "trade", name: "Up for Trade", count: copies === null ? null : { copies, lines: copies } });

  it("counts the pile's own physical cards, not the copies listed, and draws each card once", () => {
    const listed = { copies: [copy(cardA, { upForTrade: true }), copy(cardA, { upForTrade: true }), copy(cardB, { upForTrade: true })], truncated: true };
    const result = tradePileOf(pile(40), listed, cards);
    expect(result.count).toBe(40);
    expect(result.cards.map((c) => c.id)).toEqual([cardA.id, cardB.id]);
  });

  it("reads an uncounted or empty pile as nothing, whatever is listed", () => {
    const listed = { copies: [copy(cardA)], truncated: false };
    expect(tradePileOf(pile(null), listed, cards)).toEqual({ count: 0, cards: [] });
    expect(tradePileOf(pile(0), listed, cards)).toEqual({ count: 0, cards: [] });
    expect(tradePileOf(undefined, listed, cards)).toEqual({ count: 0, cards: [] });
  });

  it("keeps the count while the cards load, and skips a card gone from the catalog", () => {
    expect(tradePileOf(pile(2), undefined, undefined)).toEqual({ count: 2, cards: [] });
    const gone = { copies: [copy(cardA, { cardId: "gone" }), copy(cardB)], truncated: false };
    expect(tradePileOf(pile(2), gone, cards).cards.map((c) => c.id)).toEqual([cardB.id]);
  });
});

describe("unlistedBoxesOf: boxes held off the marketplaces", () => {
  it("lists only in-person boxes holding cards, Unsorted first, with the box's own count", () => {
    const boxes = unlistedBoxesOf([
      container({ id: "main", system: "main", name: "Main", listedOnMarketplaces: false, count: { copies: 9, lines: 9 } }),
      container({ id: "show", kind: "box", name: "Show box", listedOnMarketplaces: false, count: { copies: 3, lines: 2 } }),
      container({ id: "listed", kind: "box", name: "eBay box", count: { copies: 50, lines: 50 } }),
      container({ id: "empty", kind: "box", name: "Empty box", listedOnMarketplaces: false, count: { copies: 0, lines: 0 } }),
      container({ id: "uncounted", kind: "box", name: "New box", listedOnMarketplaces: false, count: null }),
      container({ id: "unsorted", system: "unsorted", kind: "box", name: "Unsorted", listedOnMarketplaces: false, count: { copies: 12, lines: 10 } }),
    ]);
    expect(boxes).toEqual([
      { id: "unsorted", name: "Unsorted", unlisted: 12 },
      { id: "show", name: "Show box", unlisted: 3 },
    ]);
  });

  it("is empty when every box lists", () => {
    expect(unlistedBoxesOf([container({ id: "box", kind: "box", count: { copies: 5, lines: 5 } })])).toEqual([]);
  });
});

describe("the chase: the Want List's newest wants", () => {
  it("takes the newest first, at most CHASE_CAP, a just-set want (no stamp) on top", () => {
    const wants: Want[] = Array.from({ length: 20 }, (_, i) => ({ cardId: `c${i}`, binderId: null, lastUpdated: i }));
    wants.push({ cardId: "fresh", binderId: null });
    const chase = chaseOf(wants);
    expect(chase).toHaveLength(CHASE_CAP);
    expect(chase.map((w) => w.cardId).slice(0, 3)).toEqual(["fresh", "c19", "c18"]);
  });

  it("names the binder each want is for, null when just wanted or that binder is gone, and skips a gone card", () => {
    const containers = [container({ id: "binder-1", name: "Packers" })];
    const cards = new Map([
      [cardA.id, cardA],
      [cardB.id, cardB],
    ]);
    const result = wantCardsOf(
      [
        { cardId: cardA.id, binderId: "binder-1" },
        { cardId: "gone", binderId: null },
        { cardId: cardB.id, binderId: "deleted-binder" },
      ],
      containers,
      cards,
    );
    expect(result.map((w) => [w.id, w.forBinder])).toEqual([
      [cardA.id, "Packers"],
      [cardB.id, null],
    ]);
    expect(result[0].title).toBe(toDash(cardA).title);
  });
});

describe("just completed: the last 10 days", () => {
  const done = (id: string, completedOn: string): CompletedChecklist => ({
    id,
    label: `1996 Playoff Contenders ${id}`,
    setLabel: "1996 Playoff Contenders",
    checklistName: null,
    cards: [toDash(cardA), toDash(cardB)],
    lastCard: toDash(cardB),
    completedOn,
  });

  it("keeps day 0 through day 10, newest first, at most three; never a later day or a future date", () => {
    const list = [
      done("eleven", "2026-10-29"),
      done("ten", "2026-10-30"),
      done("today", "2026-11-09"),
      done("future", "2026-11-10"),
      done("three", "2026-11-06"),
      done("one", "2026-11-08"),
    ];
    expect(recentCompletions(list, "2026-11-09").map((c) => c.id)).toEqual(["today", "one", "three"]);
    expect(recentCompletions([done("ten", "2026-10-30"), done("eleven", "2026-10-29")], "2026-11-09").map((c) => c.id)).toEqual([
      "ten",
    ]);
  });

  it("cheers the newest, says when, and counts the checklist", () => {
    const cheer = justCompletedOf([done("three", "2026-11-06"), done("one", "2026-11-08")], "2026-11-09");
    expect(cheer).toMatchObject({ id: "one", total: 2, whenLabel: "Yesterday" });
    expect(cheer?.lastCard.id).toBe(cardB.id);
    expect(justCompletedOf([done("x", "2026-10-01")], "2026-11-09")).toBeNull();
    expect(justCompletedOf([], "2026-11-09")).toBeNull();
  });

  it("counts calendar days across a month end", () => {
    expect(justCompletedOf([done("x", "2026-10-31")], "2026-11-02")?.whenLabel).toBe("2 days ago");
  });
});

describe("useRealDashboard: the Want List chase, the trade pile and boxes held off the marketplaces", () => {
  const shelf = () => [
    container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } }),
    container({ id: "want", system: "want", name: "Want List", count: { copies: 2, lines: 2 } }),
    container({ id: "trade", system: "trade", name: "Up for Trade", count: { copies: 7, lines: 4 } }),
    container({ id: "show", kind: "box", name: "Show box", listedOnMarketplaces: false, count: { copies: 3, lines: 3 } }),
    container({ id: "binder-1", name: "Packers" }),
  ];

  it("waits for the wants, so the Want List never reads as empty while it loads", () => {
    store.containers = shelf();
    store.summary = SUMMARY;
    store.wants = undefined;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    expect(result.current).toBeUndefined();
  });

  it("fills the chase, the trade pile and the in-person boxes from the store", () => {
    store.containers = shelf();
    store.summary = SUMMARY;
    store.wants = [
      { cardId: cardA.id, binderId: "binder-1", lastUpdated: 1 },
      { cardId: cardB.id, binderId: null, lastUpdated: 2 },
    ];
    store.trade = { copies: [copy(cardB, { upForTrade: true })], truncated: true };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.wantList.map((w) => [w.id, w.forBinder])).toEqual([
      [cardB.id, null],
      [cardA.id, "Packers"],
    ]);
    expect(data.tradePile.count).toBe(7);
    expect(data.tradePile.cards.map((c) => c.id)).toEqual([cardB.id]);
    expect(data.unlistedBoxes).toEqual([{ id: "show", name: "Show box", unlisted: 3 }]);
    expect(data.justCompleted).toBeNull();
    // Only the first few trade copies are asked for.
    expect(store.tradeLimits.every((l) => l === TRADE_PREVIEW)).toBe(true);
  });

  it("draws the chase, the pile and the box on the screen", () => {
    store.containers = shelf();
    store.summary = SUMMARY;
    store.wants = [{ cardId: cardA.id, binderId: "binder-1", lastUpdated: 1 }];
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    render(<DashboardScreen data={result.current!} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "The Chase" })).toBeTruthy();
    expect(screen.getByText("For Packers")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Odds and Ends" })).toBeTruthy();
    expect(screen.getByText("7 cards up for trade")).toBeTruthy();
    expect(screen.getAllByText("Show box").length).toBeGreaterThan(0);
  });
});

describe("boxesInUseOf: the boxes that end the Inventory starter", () => {
  it("counts a box the collector made, and Unsorted only once a card is in it (or its count is unknown)", () => {
    const unsorted = (count: Container["count"]) => container({ id: "u", system: "unsorted", kind: "box", name: "Unsorted", count });
    expect(boxesInUseOf([container({ id: "main", system: "main", name: "Main" }), unsorted({ copies: 0, lines: 0 })])).toBe(0);
    expect(boxesInUseOf([unsorted({ copies: 2, lines: 1 })])).toBe(1);
    expect(boxesInUseOf([unsorted(null)])).toBe(1);
    expect(boxesInUseOf([unsorted({ copies: 0, lines: 0 }), container({ id: "b", kind: "box", name: "Show box", count: { copies: 0, lines: 0 } })])).toBe(1);
  });
});

describe("the empty shelf", () => {
  const COLLECTION_STARTER = "We all have a shoebox. Sort it into binders";
  const INVENTORY_STARTER = "That to-list pile won't list itself. Add cards to sell";
  const main = shelfBinderOf(container({ id: "main", system: "main", name: "Main" }));

  it("with only Main and no box: shelf 2 leads into Collection's Add cards, shelf 3 into Inventory's", () => {
    const data = realDashboardData({ binders: [main], summary: { copies: 0, cards: 0, exact: true, offBuild: 0 } });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "Your binders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Main, 0 cards/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: COLLECTION_STARTER }).getAttribute("href")).toBe("/collection?tab=add");
    expect(screen.getByRole("link", { name: INVENTORY_STARTER }).getAttribute("href")).toBe("/inventory?tab=add");
    // The starters say it now; the old line is gone.
    expect(screen.queryByRole("link", { name: "Add a card on Collection" })).toBeNull();
    // Each stands on its own shelf, read out (not the aria-hidden room left in the case).
    const shelves = screen.getByRole("list", { name: "Binders on the shelf" });
    expect(shelves.querySelectorAll(":scope > li").length).toBe(3);
  });

  it("draws Jason's pick: the shoebox on Collection's shelf, the to-list pile on Inventory's, each named by its words", () => {
    const data = realDashboardData({ binders: [main], summary: SUMMARY });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    // WCAG 2.5.3: the name is the visible copy (the arrow is not read).
    expect(screen.getByRole("link", { name: COLLECTION_STARTER }).textContent).toContain("We all have a shoebox.");
    expect(screen.getByRole("link", { name: INVENTORY_STARTER }).textContent).toContain("That to-list pile won't list itself.");
    // The losing designs are gone, and no `?starter=` brings them back.
    expect(screen.queryByText("Fresh pages. Zero cards.")).toBeNull();
    expect(screen.queryByText("Every dealer starts with a dollar box.")).toBeNull();
  });

  it("once there is a box, shelf 3 carries the boxes instead", () => {
    const boxes = shelfBoxesOf([container({ id: "box-1", kind: "box", name: "Show box", count: { copies: 48, lines: 30 } })]);
    render(<DashboardScreen data={realDashboardData({ binders: [main], summary: SUMMARY, boxes: 1, shelfBoxes: boxes })} />, {
      wrapper: wrapper("/dashboard"),
    });
    expect(screen.getByRole("link", { name: COLLECTION_STARTER })).toBeTruthy();
    expect(screen.queryByRole("link", { name: INVENTORY_STARTER })).toBeNull();
    expect(screen.getByRole("heading", { name: "Your binders and boxes" })).toBeTruthy();
    // A name that already says box is not told so twice (WCAG 2.5.3: the name leads with what the end shows).
    expect(screen.getByRole("link", { name: "Show box, 48 cards for sale" }).getAttribute("href")).toBe(
      "/inventory?tab=boxes&b=box-1",
    );
  });

  it("a box counted but not passed to the shelf still puts the starter away", () => {
    render(<DashboardScreen data={{ ...realDashboardData({ binders: [main], summary: SUMMARY, boxes: 1 }), shelfBoxes: undefined }} />, {
      wrapper: wrapper("/dashboard"),
    });
    expect(screen.queryByRole("link", { name: INVENTORY_STARTER })).toBeNull();
  });

  it("a full first shelf leaves shelf 2 holding binders, so no Collection starter", () => {
    const nine = [main, ...Array.from({ length: 8 }, (_, i) => shelfBinderOf(container({ id: `b${i}`, name: `Binder ${i}` })))];
    render(<DashboardScreen data={realDashboardData({ binders: nine, summary: SUMMARY })} />, { wrapper: wrapper("/dashboard") });
    expect(screen.queryByRole("link", { name: COLLECTION_STARTER })).toBeNull();
    expect(screen.getByRole("link", { name: INVENTORY_STARTER })).toBeTruthy();
  });

  it("with no binder open, the first one stands shut beside the shelf, and opening it pushes `?binder=`", async () => {
    const seen: string[] = [];
    function Probe() {
      const { search } = useLocation();
      seen.push(search);
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardScreen data={realDashboardData({ binders: [main], summary: SUMMARY })} />
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Crack open Main" }));
    expect(seen.at(-1)).toBe("?binder=main");
  });

  it("an open binder with no card in it stays shut, with the way to fill it", () => {
    render(<DashboardScreen data={realDashboardData({ binders: [main], summary: SUMMARY })} />, {
      wrapper: wrapper("/dashboard?binder=main"),
    });
    expect(screen.getByRole("heading", { level: 3, name: "Main" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fill this binder" }).getAttribute("href")).toBe("/collection?tab=add");
    expect(screen.queryByRole("list", { name: /^Main, page/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Crack open Main" })).toBeNull();
  });

  it("with no wants, no trade pile and no in-person box: the empty chase, no Odds and Ends, no Needs a Look", () => {
    const data = realDashboardData({ binders: [main], summary: SUMMARY, wantList: [], tradePile: { count: 0, cards: [] }, unlistedBoxes: [] });
    expect(data).toEqual(realDashboardData({ binders: [main], summary: SUMMARY }));
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByText(/Your Want List is empty/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Odds and Ends" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Needs a Look" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "On the Bubble" })).toBeNull();
  });
});

describe("the demo's shelf", () => {
  it("still stands its ten binders, every one laid out, within the shelf's cap", () => {
    const binders = demoBindersOf(getDashboard());
    // The seed's nine, and the sample's '89 Score binder.
    expect(binders.length).toBe(10);
    expect(binders.some((b) => b.name === "'89 Score")).toBe(true);
    expect(binders.length).toBeLessThanOrEqual(SHELF_CAP);
    expect(binders.every((b) => b.pockets.length > 0)).toBe(true);
    // The demo hands the screen its shelf, laid out by `bindersOf`: the screen
    // derives none (so the signed-in page never loads the demo's data).
    expect(getDashboard().binders).toEqual(binders);
  });
});

// ---------------------------------------------------------------------------
// Slice 3: the set boards, just completed, smart binders, since the last visit
// ---------------------------------------------------------------------------

/** Eight base cards of one real catalog set, in checklist order. */
const base8 = fixtureCards
  .filter((c) => c.setId === "1996-playoff-contenders" && c.variantPath.type === "Base" && c.variation === null)
  .slice(0, 8)
  .map((c) => demoCard(c.id)!);
const contenders = cardA.set;
const cardsById = new Map(base8.map((c) => [c.id, c]));

/** A set board: the first `have` cards held. */
function board(have: number, cards: Card[] = base8): SetBoardRaw {
  return {
    cards: cards.map((c, i) => ({ cardId: c.id as SetBoardRaw["cards"][number]["cardId"], cardNumber: c.cardNumber, owned: i < have })),
    truncated: false,
  };
}

function completion(over: Partial<CompletionRaw> = {}): CompletionRaw {
  return {
    setId: contenders.id as CompletionRaw["setId"],
    setLabel: "1996 Playoff Contenders",
    checklistName: null,
    total: 120,
    whenMs: Date.UTC(2026, 10, 7, 12),
    whenDay: "2026-11-07",
    lastCardId: cardB.id as CompletionRaw["lastCardId"],
    cardIds: [cardB.id, cardA.id] as CompletionRaw["cardIds"],
    ...over,
  };
}

describe("buildingSetOf: a set on the board from its base checklist", () => {
  it("counts the base checklist, floors the percent and lets every bulb know its card", () => {
    const set = buildingSetOf(contenders, board(5), cardsById, new Set())!;
    expect(set).toMatchObject({ setId: contenders.id, setLabel: "1996 Playoff Contenders", have: 5, total: 8, need: 3, percent: 62 });
    expect(set.neededNumbers).toEqual(base8.slice(5).map((c) => c.cardNumber));
    expect(set.baseBulbs.map((b) => b.cardId)).toEqual(base8.map((c) => c.id));
    expect(set.baseBulbs.filter((b) => b.owned)).toHaveLength(5);
    expect(set.checklists).toEqual([{ name: "Base", kind: "base", have: 5, total: 8 }]);
  });

  it("names only the needs the board shows: Want List cards first, then checklist order, at most NEED_NAMED", () => {
    const wanted = new Set([base8[7].id]);
    const named = namedNeedsOf(board(0), wanted);
    expect(named).toHaveLength(NEED_NAMED);
    expect(named[0]).toBe(base8[7].id);
    expect(named.slice(1)).toEqual(base8.slice(0, NEED_NAMED - 1).map((c) => c.id));
    const set = buildingSetOf(contenders, board(0), cardsById, wanted)!;
    expect(set.neededCards.map((c) => c.id)).toEqual(named);
    expect(set.need).toBe(8);
  });

  it("is no board for a set with no base cards, or none at all", () => {
    expect(buildingSetOf(contenders, null, cardsById, new Set())).toBeNull();
    expect(buildingSetOf(contenders, { cards: [], truncated: false }, cardsById, new Set())).toBeNull();
  });

  it("never reads 100% while a card is needed", () => {
    const many = Array.from({ length: 300 }, (_, i) => base8[i % 8]);
    expect(buildingSetOf(contenders, board(299, many), cardsById, new Set())?.percent).toBe(99);
  });
});

describe("just completed, from the server's completions", () => {
  it("cheers a base checklist finished within the 10 days with the server's count, labelled by when", () => {
    const done = completedChecklistOf(completion(), cardsById)!;
    expect(done).toMatchObject({ checklistName: null, total: 120, completedOn: "2026-11-07" });
    expect(done.cards.map((c) => c.id)).toEqual([cardB.id, cardA.id]);
    const cheer = justCompletedOf([done], "2026-11-09");
    expect(cheer).toMatchObject({ label: "1996 Playoff Contenders", total: 120, whenLabel: "2 days ago" });
    expect(cheer?.lastCard.id).toBe(cardB.id);
  });

  it("keeps day 10 and drops day 11, by calendar day", () => {
    const at = (day: string) => completedChecklistOf(completion({ whenDay: day }), cardsById)!;
    expect(justCompletedOf([at("2026-10-30")], "2026-11-09")?.whenLabel).toBe(`${JUST_COMPLETED_DAYS} days ago`);
    expect(justCompletedOf([at("2026-10-29")], "2026-11-09")).toBeNull();
  });

  it("waits for its last card; with no acquired day it reads the instant on this device's calendar", () => {
    expect(completedChecklistOf(completion({ lastCardId: "gone" as CompletionRaw["lastCardId"] }), cardsById)).toBeNull();
    const ms = new Date(2026, 10, 8, 23, 30).getTime();
    expect(completedChecklistOf(completion({ whenDay: null, whenMs: ms }), cardsById)?.completedOn).toBe("2026-11-08");
  });

  it("asks the server from the start of the oldest day kept, a day early", () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime();
    expect(localDay(now)).toBe("2026-11-09");
    expect(completionWindowStart(now)).toBe(new Date(2026, 9, 29, 0, 0).getTime());
  });
});

describe("since the last visit", () => {
  it("groups the lines by binder, newest first, each card once", () => {
    const lines = [
      { homeId: "b1", cardId: cardB.id, filedAt: 3 },
      { homeId: "b2", cardId: cardA.id, filedAt: 2 },
      { homeId: "b1", cardId: cardB.id, filedAt: 2 },
      { homeId: "b1", cardId: cardA.id, filedAt: 1 },
    ] as unknown as NewSinceRaw["lines"];
    const byHome = newCardsByHome(lines, cardsById);
    expect(byHome.get("b1")?.map((c) => c.id)).toEqual([cardB.id, cardA.id]);
    expect(byHome.get("b2")?.map((c) => c.id)).toEqual([cardA.id]);
    expect(newCardsByHome(lines, undefined).size).toBe(0);
  });
});

describe("smart binders", () => {
  const rule = { version: 1 as const, match: "all" as const, terms: [{ test: { kind: "set" as const, setIds: ["s"] } }] };

  it("a smart spine wears its checklist percent; a manual binder never does", () => {
    const smart = shelfBinderOf(container({ id: "smart", smartRule: rule, ruleNames: { s: "1996 Playoff Contenders" } }), [], {
      checklist: { have: 24, total: 40 },
    });
    expect(smart.checklist).toEqual({ have: 24, total: 40, percent: 60 });
    expect(shelfBinderOf(container({ id: "plain" }), [], { checklist: { have: 1, total: 2 } }).checklist).toBeNull();
    expect(shelfBinderOf(container({ id: "smart", smartRule: rule }), [], { checklist: null }).checklist).toBeNull();
  });

  it("summarises only the smart binders, with no percent where there is no checklist, and no candidates", () => {
    const withList = shelfBinderOf(container({ id: "a", name: "Contenders", smartRule: rule, count: { copies: 5, lines: 5 } }), [], {
      checklist: { have: 5, total: 10 },
      newCards: [toDash(cardA)],
    });
    const player = shelfBinderOf(container({ id: "b", name: "Reggie", smartRule: rule }));
    const plain = shelfBinderOf(container({ id: "c" }));
    const summaries = smartBindersOf([withList, player, plain]);
    expect(summaries.map((s) => s.id)).toEqual(["a", "b"]);
    expect(summaries[0]).toMatchObject({ cardCount: 5, newCount: 1, checklist: { have: 5, total: 10, percent: 50 } });
    expect(summaries[1].checklist).toBeUndefined();
    expect(withList.couldFit).toEqual([]);
  });
});

describe("useRealDashboard: set boards, the finished-set cheer, smart binders and what is new", () => {
  const shelf = () => [
    container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } }),
    container({
      id: "smart",
      name: "Contenders, every card",
      smartRule: { version: 1, match: "all", terms: [{ test: { kind: "set", setIds: [contenders.id] } }] },
      ruleNames: { [contenders.id]: "1996 Playoff Contenders" },
    }),
  ];

  it("asks for at most BOARD_SETS boards, and builds the board, the cheer, the smart percent and the news", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 12));
    store.containers = shelf();
    store.summary = SUMMARY;
    store.building = Array.from({ length: BOARD_SETS + 2 }, (_, i) => (i === 0 ? contenders : { ...contenders, id: `other-${i}` }));
    server.boards = new Map([[contenders.id, board(6)]]);
    server.smart = new Map([["smart", { have: 3, total: 4 }]]);
    server.completions = [completion()];
    server.since = 1;
    server.fresh = { lines: [{ homeId: "main", cardId: cardA.id, filedAt: 2 }], truncated: false } as unknown as NewSinceRaw;

    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(server.boardsAsked.at(-1)).toHaveLength(BOARD_SETS);
    expect(server.smartAsked.at(-1)).toEqual(["smart"]);
    expect(data.building.map((b) => [b.setId, b.have, b.total])).toEqual([[contenders.id, 6, 8]]);
    expect(data.justCompleted).toMatchObject({ label: "1996 Playoff Contenders", whenLabel: "2 days ago", total: 120 });
    const smart = data.binders!.find((b) => b.id === "smart")!;
    expect(smart).toMatchObject({ kind: "smart", ruleText: "1996 Playoff Contenders", checklist: { have: 3, total: 4, percent: 75 } });
    expect(data.smartBinders.map((s) => s.id)).toEqual(["smart"]);
    expect(data.binders!.find((b) => b.id === "main")!.newCards.map((c) => c.id)).toEqual([cardA.id]);
  });

  it("marks the open binder's new cards new in their pockets", () => {
    store.containers = shelf();
    store.summary = SUMMARY;
    store.copies.set("main", { copies: [copy(cardA, { homeId: "main", slot: 0 }), copy(cardB, { homeId: "main", slot: 1 })], truncated: false });
    server.since = 1;
    server.fresh = { lines: [{ homeId: "main", cardId: cardA.id, filedAt: 2 }], truncated: false } as unknown as NewSinceRaw;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard?binder=main") });
    const main = result.current!.binders!.find((b) => b.id === "main")!;
    expect(main.pockets.slice(0, 2).map((p) => (p.kind === "card" ? p.isNew : null))).toEqual([true, false]);
  });

  it("with nothing built, finished, smart or new: no board, no cheer, no smart binder, no news", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } })];
    store.summary = SUMMARY;
    server.since = null;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.building).toEqual([]);
    expect(data.justCompleted).toBeNull();
    expect(data.smartBinders).toEqual([]);
    expect(data.binders!.every((b) => b.newCards.length === 0)).toBe(true);
    expect(data).toEqual(realDashboardData({ binders: data.binders!, summary: SUMMARY, wantList: [], unlistedBoxes: [] }));
  });

  it("draws the board with the full need count, the set's own wall and the cheer", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 12));
    store.containers = shelf();
    store.summary = SUMMARY;
    store.building = [contenders];
    server.boards = new Map([[contenders.id, board(1)]]);
    server.completions = [completion()];
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    render(<DashboardScreen data={result.current!} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "On the Bubble" })).toBeTruthy();
    expect(screen.getByText("7 cards to go.")).toBeTruthy();
    // Seven needed, five named: the other two are "+2 more".
    expect(screen.getByText("+2 more")).toBeTruthy();
    expect(screen.getByRole("link", { name: "1996 Playoff Contenders" }).getAttribute("href")).toBe(
      `/collection?tab=cards&set=${encodeURIComponent(contenders.id)}`,
    );
    expect(screen.getByRole("heading", { name: /Every bulb lit! 1996 Playoff Contenders is done\./ })).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Slice 4: could fit, the hopper, the dealer layout
// ───────────────────────────────────────────────────────────────────────────

type SaleRaw = SalesRaw["orders"][number];
const DAY_MS = 86_400_000;

function saleRaw(over: Partial<SaleRaw> = {}): SaleRaw {
  return {
    id: "sale-1" as SaleRaw["id"],
    platform: "bsc",
    orderNo: "BSC-1",
    orderDate: new Date(2026, 10, 9, 9).getTime(),
    status: "READY_TO_SHIP",
    lines: [{ cardId: cardA.id as never, quantity: 1 }],
    cardCount: 1,
    problemPastCut: false,
    ...over,
  };
}

const cardsAB = () =>
  new Map<string, Card>([
    [cardA.id, cardA],
    [cardB.id, cardB],
  ]);

describe("statusWordsOf and daysSinceSold", () => {
  it("reads the platform's word in plain case, never changing the word", () => {
    expect(statusWordsOf("READY_TO_SHIP")).toBe("Ready to ship");
    expect(statusWordsOf("PAID")).toBe("Paid");
    expect(statusWordsOf("IN_PROGRESS")).toBe("In progress");
    expect(statusWordsOf("")).toBe("");
  });

  it("counts calendar days since the order date, never below 0", () => {
    const now = new Date(2026, 10, 9, 8).getTime();
    expect(daysSinceSold(new Date(2026, 10, 9, 1).getTime(), now)).toBe(0);
    expect(daysSinceSold(new Date(2026, 10, 8, 23).getTime(), now)).toBe(1);
    expect(daysSinceSold(new Date(2026, 10, 6, 12).getTime(), now)).toBe(3);
    expect(daysSinceSold(now + DAY_MS, now)).toBe(0);
  });
});

describe("sales: shipped vs still to ship, and the lines", () => {
  const now = new Date(2026, 10, 9, 12).getTime();

  it("a line with no card, or a card gone from the catalog, is unmatched with no card: never a guess", () => {
    expect(saleLineOf({ quantity: 2, problem: "unmatched" }, cardsAB())).toEqual({ card: null, quantity: 2, problem: { kind: "unmatched" } });
    expect(saleLineOf({ cardId: "gone" as never, quantity: 1 }, cardsAB())).toEqual({ card: null, quantity: 1, problem: { kind: "unmatched" } });
  });

  it("an oversold line says how many sold and how many the boxes held", () => {
    const line = saleLineOf({ cardId: cardA.id as never, quantity: 3, problem: "oversold", shortBy: 2 }, cardsAB());
    expect(line.card?.id).toBe(cardA.id);
    expect(line.problem).toEqual({ kind: "oversold", sold: 3, inBoxes: 1 });
  });

  it("an order leads with its first tied card, counts every line and flags a problem past the cut", () => {
    const order = unshippedSaleOf(
      saleRaw({
        platform: "ebay",
        orderNo: "14-1",
        status: "PAID",
        lines: [{ quantity: 1, problem: "unmatched" }, { cardId: cardB.id as never, quantity: 1 }],
        cardCount: 5,
        problemPastCut: false,
        orderDate: new Date(2026, 10, 7, 12).getTime(),
      }),
      cardsAB(),
      now,
    );
    expect(order).toMatchObject({ marketplace: "ebay", orderNumber: "14-1", statusText: "Paid", daysSinceSold: 2, cardCount: 5, hasProblem: true });
    expect(order.firstCard?.id).toBe(cardB.id);
    expect(unshippedSaleOf(saleRaw({ problemPastCut: true }), cardsAB(), now).hasProblem).toBe(true);
    expect(unshippedSaleOf(saleRaw(), cardsAB(), now).hasProblem).toBe(false);
    // No line tied to a card: no first card, nothing guessed.
    expect(unshippedSaleOf(saleRaw({ lines: [{ quantity: 1, problem: "unmatched" }] }), cardsAB(), now).firstCard).toBeNull();
  });

  it("not a dealer: no sales panel; a dealer: the orders oldest first", () => {
    expect(salesDataOf(NOT_A_DEALER, cardsAB(), now)).toBeNull();
    expect(salesDataOf({ dealer: true, orders: [], more: false }, cardsAB(), now)).toEqual({ unshipped: [] });
    const data = salesDataOf(
      {
        dealer: true,
        orders: [
          saleRaw({ id: "new" as never, orderDate: now - DAY_MS }),
          saleRaw({ id: "old" as never, orderDate: now - 4 * DAY_MS }),
        ],
        more: false,
      },
      cardsAB(),
      now,
    )!;
    expect(data.unshipped.map((o) => o.id)).toEqual(["old", "new"]);
  });

  it("names the cards its orders hold, or nothing", () => {
    expect(saleCardIdsOf(undefined)).toBeNull();
    expect(saleCardIdsOf(NOT_A_DEALER)).toBeNull();
    expect(saleCardIdsOf({ dealer: true, orders: [saleRaw({ lines: [{ quantity: 1 }, { cardId: cardB.id as never, quantity: 1 }] })], more: false })).toEqual([
      cardB.id,
    ]);
  });
});

describe("Fresh Pulls: freshPullsOf", () => {
  // Wednesday 2026-11-11, 3 PM local.
  const NOW = new Date(2026, 10, 11, 15).getTime();
  const at = (daysBack: number, hour = 10) => new Date(2026, 10, 11 - daysBack, hour).getTime();
  const cards = new Map([
    [cardA.id, cardA],
    [cardB.id, cardB],
  ]) as never;
  const homes = new Map([
    ["main", "Main"],
    ["var", "Variations"],
  ]);
  const line = (homeId: string, cardId: string, addedAt: number) => ({ homeId, cardId, addedAt }) as never;

  it("looks back two weeks from local midnight, today included", () => {
    expect(freshPullsWindowStart(NOW)).toBe(new Date(2026, 10, 11 - 13).getTime());
  });

  it("names a day the way a collector says it: Today, Yesterday, the weekday, then Last <weekday>", () => {
    expect(pullDayLabel(at(0), NOW)).toBe("Today");
    expect(pullDayLabel(at(1), NOW)).toBe("Yesterday");
    expect(pullDayLabel(at(2), NOW)).toBe("Monday");
    expect(pullDayLabel(at(8), NOW)).toBe("Last Tuesday");
  });

  it("one batch a day, newest first, each card once per binder, every way it was added; a home off the shelf is left out", () => {
    const batches = freshPullsOf(
      [
        line("var", cardB.id, at(0, 14)),
        line("main", cardA.id, at(0, 13)),
        line("main", cardA.id, at(0, 12)),
        line("gone", cardB.id, at(0, 11)),
        line("main", cardB.id, at(3)),
      ],
      cards,
      homes,
      at(2),
      NOW,
    );
    expect(batches.map((b) => [b.whenLabel, b.cards.map((c) => `${c.id}@${c.binderName}`), b.sinceLastVisit])).toEqual([
      ["Today", [`${cardB.id}@Variations`, `${cardA.id}@Main`], true],
      ["Sunday", [`${cardB.id}@Main`], false],
    ]);
    expect(batches[0].binders).toEqual([
      { name: "Variations", count: 1 },
      { name: "Main", count: 1 },
    ]);
  });

  it("nothing added, or cards not hydrated yet: no batches, so no section", () => {
    expect(freshPullsOf([], cards, homes, null, NOW)).toEqual([]);
    expect(freshPullsOf([line("main", cardA.id, at(0))], undefined, homes, null, NOW)).toEqual([]);
    expect(freshPullIds([])).toBeNull();
    expect(freshPullIds(Array.from({ length: FRESH_PULLS_CARDS + 5 }, () => line("main", cardA.id, at(0))))).toHaveLength(
      FRESH_PULLS_CARDS,
    );
  });

  it("the first visit ever: every batch is new", () => {
    expect(freshPullsOf([line("main", cardA.id, at(4))], cards, homes, null, NOW)[0].sinceLastVisit).toBe(true);
    expect(freshPullsOf([line("main", cardA.id, at(4))], cards, homes, undefined, NOW)[0].sinceLastVisit).toBe(false);
  });
});

describe("New on NeonBinder: newSetsOf", () => {
  const SET1 = { _id: "s1", name: "Topps Chrome", season: "2024", sport: { _id: "sp", name: "Baseball" }, year: null, manufacturer: null };
  const ref = (over: Record<string, unknown>) => ({
    kind: null,
    variantType: null,
    insert: null,
    parallel: null,
    cardCount: null,
    baseCardCount: null,
    ...over,
  });

  it("a whole set's load is named for the set and opens on its Base; its sport and count; the cover once hydrated", () => {
    const raw = [
      {
        set: SET1,
        opens: ref({ _id: "base", level: "variantType", name: "Base", kind: "base", variantType: { _id: "base", name: "Base" } }),
        wholeSet: true,
        cardCount: 220,
        coverCardId: cardA.id,
        addedAt: 2,
      },
    ] as never;
    const [entry] = newSetsOf(raw, new Map([[cardA.id, cardA]]) as never);
    expect([entry.id, entry.label, entry.variant, entry.sport, entry.cardCount, entry.cover?.id]).toEqual([
      "s1",
      "2024 Topps Chrome",
      null,
      "Baseball",
      220,
      cardA.id,
    ]);
    expect(entry.checklist).toEqual({ tab: "checklists", set: "s1", type: "base" });
    expect(newSetsOf(raw, undefined)[0].cover).toBeNull();
    expect(newSetsOf(undefined, undefined)).toEqual([]);
  });

  it("a lone variant is named for the set and itself, and opens on its own checklist, however deep it sits", () => {
    const parallels = { _id: "pt", name: "Parallels" };
    const raw = [
      // A parallel under the Parallels type: type, then the parallel.
      {
        set: SET1,
        opens: ref({ _id: "gold", level: "insert", name: "Gold Refractor", kind: "parallel", variantType: parallels }),
        wholeSet: false,
        cardCount: 50,
        coverCardId: null,
        addedAt: 3,
      },
      // A parallel of an insert: type, then the insert, then the parallel.
      {
        set: SET1,
        opens: ref({
          _id: "fs-gold",
          level: "parallel",
          name: "Gold",
          kind: "insert",
          variantType: { _id: "it", name: "Inserts" },
          insert: { _id: "fs", name: "Future Stars" },
        }),
        wholeSet: false,
        cardCount: null,
        coverCardId: null,
        addedAt: 2,
      },
    ] as never;
    const out = newSetsOf(raw, undefined);
    expect(out.map((n) => [n.id, n.label, n.variant])).toEqual([
      ["s1:gold", "2024 Topps Chrome", "Gold Refractor"],
      ["s1:fs-gold", "2024 Topps Chrome", "Future Stars Gold"],
    ]);
    expect(out[0].checklist).toEqual({ tab: "checklists", set: "s1", type: "pt", variant: "gold" });
    expect(out[1].checklist).toEqual({ tab: "checklists", set: "s1", type: "it", variant: "fs", sub: "fs-gold" });
  });
});

describe("the hopper: intakeOf", () => {
  const NOW = new Date(2026, 10, 9, 15, 0).getTime();
  const run1 = {
    runId: "run-1" as never,
    homeName: "Main",
    side: "collection" as const,
    needsYou: 2,
    unidentified: 3,
    lastActivityAt: NOW - 86_400_000,
    guesses: [cardA.id as never, "gone" as never],
  };
  const raw = (over: Partial<IntakeRaw> = {}): IntakeRaw => ({
    needsYou: 2,
    unidentified: 3,
    runs: [run1],
    sortedThisWeek: 2,
    truncated: false,
    ...over,
  });

  it("counts every open scan, per run too; a run's thumbnails are its hydrated guesses; the week's sorted count passes through", () => {
    const intake = intakeOf(raw(), cardsAB(), NOW);
    expect(intake).toMatchObject({
      total: 5,
      needsYou: 2,
      unidentified: 3,
      sortedThisWeek: 2,
      uploads: [
        {
          id: "run-1",
          name: "Main",
          needsYou: 2,
          unidentified: 3,
          side: "collection",
          href: "/collection?tab=add&run=run-1",
          lastScan: "Last scan yesterday",
        },
      ],
    });
    expect(intake.uploads[0].guesses.map((g) => g.id)).toEqual([cardA.id]);
  });

  it("a run finishes where its cards go: a binder's on Collection, a box's on Inventory, on the Add cards tab's own run param", () => {
    expect(ADD_CARDS_RUN_PARAM).toBe(RUN_PARAM);
    expect(runHrefOf("collection", "abc")).toBe("/collection?tab=add&run=abc");
    expect(runHrefOf("inventory", "abc")).toBe("/inventory?tab=add&run=abc");
    const intake = intakeOf(raw({ runs: [{ ...run1, runId: "run-2" as never, homeName: "Show box", side: "inventory" }] }), cardsAB(), NOW);
    expect(intake.uploads.map((u) => [u.side, u.href])).toEqual([["inventory", "/inventory?tab=add&run=run-2"]]);
  });

  it("nothing open but runs sorted: the stats alone; nothing at all, or not read yet: empty, so the hopper stays hidden", () => {
    const empty = { total: 0, needsYou: 0, unidentified: 0, uploads: [], sortedThisWeek: 0 };
    expect(intakeOf(undefined, cardsAB(), NOW)).toEqual(empty);
    expect(intakeOf(raw({ needsYou: 0, unidentified: 0, runs: [], sortedThisWeek: 0 }), cardsAB(), NOW)).toEqual(empty);
    expect(intakeOf(raw({ needsYou: 0, unidentified: 0, runs: [], sortedThisWeek: 1 }), cardsAB(), NOW)).toEqual({
      ...empty,
      sortedThisWeek: 1,
    });
  });

  it("each run reads apart by its last scan: a time today, yesterday, then days ago, by the local calendar day", () => {
    expect(lastScanLabel(NOW - 60_000, NOW)).toMatch(/^Last scan \d{1,2}:\d{2}/);
    expect(lastScanLabel(new Date(2026, 10, 9, 0, 5).getTime(), NOW)).toMatch(/^Last scan (12|00?):05/);
    expect(lastScanLabel(new Date(2026, 10, 8, 23, 59).getTime(), NOW)).toBe("Last scan yesterday");
    expect(lastScanLabel(new Date(2026, 10, 6, 9).getTime(), NOW)).toBe("Last scan 3 days ago");
  });
});

describe("could fit: couldFitByBinder", () => {
  it("hydrates only each strip's preview, in the server's order, and counts every card; a binder with no answer gets none", () => {
    const raw = new Map<string, CouldFitRaw | null>([
      ["smart", { cardIds: [cardB.id, "gone", cardA.id, "fourth", "fifth"] as never, more: true }],
      ["other", null],
      ["empty", { cardIds: [], more: false }],
    ]);
    expect(couldFitPreviewIds(raw)).toEqual([cardB.id, "gone", cardA.id]);
    const out = couldFitByBinder(raw, cardsAB());
    expect(out.get("smart")?.cards.map((c) => c.id)).toEqual([cardB.id, cardA.id]);
    expect(out.get("smart")).toMatchObject({ count: 4, more: true });
    expect(out.has("other")).toBe(false);
    expect(out.has("empty")).toBe(false);
    expect(couldFitByBinder(raw, undefined).size).toBe(0);
  });

  it("only a smart spine carries could-fit cards", () => {
    const fit = { cards: [toDash(cardA)], count: 7, more: false };
    const plain = shelfBinderOf(container({ id: "plain" }), [], { couldFit: fit });
    expect(plain.couldFit).toEqual([]);
    expect(plain.couldFitTotal).toBeUndefined();
    const smart = shelfBinderOf(
      container({ id: "smart", smartRule: { version: 1, match: "all", terms: [{ test: { kind: "player", playerIds: ["p1"] } }] } }),
      [],
      { couldFit: fit },
    );
    expect(smart.couldFit).toEqual(fit.cards);
    expect(smart.couldFitTotal).toEqual({ count: 7, more: false });
  });
});

describe("useRealDashboard: sales to ship, the hopper and what could fit", () => {
  const smartShelf = () => [
    container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } }),
    container({
      id: "smart",
      name: "Contenders, every card",
      smartRule: { version: 1, match: "all", terms: [{ test: { kind: "set", setIds: [contenders.id] } }] },
      ruleNames: { [contenders.id]: "1996 Playoff Contenders" },
    }),
  ];

  it("waits for the sales read, so the layout never jumps", () => {
    store.containers = smartShelf();
    store.summary = SUMMARY;
    server.sales = undefined;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    expect(result.current).toBeUndefined();
  });

  it("asks could-fit for the smart binders only, and draws the strip", () => {
    store.containers = smartShelf();
    store.summary = SUMMARY;
    server.couldFit = new Map([["smart", { cardIds: [cardA.id, cardB.id, "c3", "c4", "c5"] as never, more: true }]]);
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    expect(server.couldFitAsked.at(-1)).toEqual(["smart"]);
    const data = result.current!;
    // "c3" is not in the catalog: left out of the preview and the count.
    expect(data.binders!.find((b) => b.id === "smart")!.couldFit.map((c) => c.id)).toEqual([cardA.id, cardB.id]);
    expect(data.binders!.find((b) => b.id === "main")!.couldFit).toEqual([]);
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "Could fit your smart binders" })).toBeTruthy();
    expect(screen.getByText("4+ could fit")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("fills the hopper from the intake read, and draws it", () => {
    store.containers = smartShelf();
    store.summary = SUMMARY;
    server.intake = {
      needsYou: 1,
      unidentified: 2,
      runs: [
        {
          runId: "run-1" as never,
          homeName: "Show box",
          side: "inventory",
          needsYou: 1,
          unidentified: 2,
          lastActivityAt: Date.now() - 3 * 86_400_000,
          guesses: [cardA.id as never],
        },
      ],
      sortedThisWeek: 1,
      truncated: false,
    };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.intake).toMatchObject({ total: 3, needsYou: 1, unidentified: 2 });
    expect(data.intake.uploads[0].guesses.map((g) => g.id)).toEqual([cardA.id]);
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "In the Hopper" })).toBeTruthy();
    expect(screen.getByText(/^1 scan needs your yes/).textContent).toBe("1 scan needs your yes · , 2 to identify");
    expect(screen.queryByText(/processing/)).toBeNull();
    const run = screen.getByRole("link", { name: "Finish this run into Show box on Inventory" });
    expect(run.getAttribute("href")).toBe("/inventory?tab=add&run=run-1");
    const stat = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "1 run sorted this week");
    expect(stat.querySelector(".cb-numeral")?.textContent).toBe("1");
    expect(screen.queryByText(/all-time/)).toBeNull();
  });

  it("with no sales, no scans and nothing that could fit: no Out the Door, no hopper, no could-fit strip", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } })];
    store.summary = SUMMARY;
    server.since = null;
    server.intake = {
      needsYou: 0,
      unidentified: 0,
      runs: [],
      sortedThisWeek: 0,
      truncated: false,
    };
    server.couldFit = new Map();
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.sales).toBeNull();
    expect(data.intake.total).toBe(0);
    expect(data).toEqual(realDashboardData({ binders: data.binders!, summary: SUMMARY, wantList: [], unlistedBoxes: [] }));
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.queryByRole("heading", { name: "In the Hopper" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Could fit your smart binders" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Out the Door" })).toBeNull();
  });
});

describe("the third shelf's boxes: shelfBoxesOf", () => {
  it("stands the boxes in use, Unsorted first and only with a card in it (or not counted yet), each in its label", () => {
    const unsorted = (count: Container["count"]) => container({ id: "u", kind: "box", system: "unsorted", name: "Unsorted", count });
    const show = container({ id: "show", kind: "box", name: "Show box", count: { copies: 48, lines: 30 } });
    const main = container({ id: "main", system: "main", name: "Main" });
    expect(shelfBoxesOf([main, show, unsorted({ copies: 0, lines: 0 })]).map((b) => b.id)).toEqual(["show"]);
    const boxes = shelfBoxesOf([show, unsorted({ copies: 2, lines: 1 })]);
    expect(boxes.map((b) => [b.id, b.cardCount, b.unsorted])).toEqual([
      ["u", 2, true],
      ["show", 48, false],
    ]);
    expect(boxes[1].label).toEqual(labelOf(show));
    expect(shelfBoxesOf([unsorted(null)]).map((b) => b.cardCount)).toEqual([0]);
  });
});

describe("New Listings: newListingsOf", () => {
  const NOW = new Date(2026, 10, 11, 15).getTime();
  const at = (daysBack: number) => new Date(2026, 10, 11 - daysBack, 10).getTime();
  const cards = new Map([
    [cardA.id, cardA],
    [cardB.id, cardB],
  ]) as never;
  const boxNames = new Map([["box-1", "Show box"]]);
  const line = (id: string, cardId: string, listedAt: number, priceCents: number | null, homeId = "box-1", quantity = 1) =>
    ({ id, homeId, cardId, listedAt, quantity, priceCents }) as NewListingsRaw["lines"][number];

  it("each line once, in its box, with the quantity, the price and how long ago; a box not on the list is left out", () => {
    const listings = newListingsOf(
      [line("l1", cardA.id, at(0), 4500), line("l2", cardB.id, at(3), null, "box-1", 3), line("l3", cardA.id, at(1), 75, "gone")],
      cards,
      boxNames,
      NOW,
    );
    expect(listings.map((l) => [l.lineId, l.id, l.boxId, l.boxName, l.quantity, l.priceCents, l.daysAgo])).toEqual([
      ["l1", cardA.id, "box-1", "Show box", 1, 4500, 0],
      ["l2", cardB.id, "box-1", "Show box", 3, null, 3],
    ]);
    expect(listings[0].title).toBe(toDash(cardA).title);
  });

  it("nothing new, or cards not hydrated yet: nothing, so no section; at most NEW_LISTINGS_CARDS asked for", () => {
    expect(newListingsOf([], cards, boxNames, NOW)).toEqual([]);
    expect(newListingsOf([line("l1", cardA.id, at(0), 1)], undefined, boxNames, NOW)).toEqual([]);
    expect(newListingIds([])).toBeNull();
    expect(newListingIds(undefined)).toBeNull();
    const lots = Array.from({ length: NEW_LISTINGS_CARDS + 4 }, (_, i) => line(`l${i}`, cardA.id, at(0), 1));
    expect(newListingIds(lots)).toHaveLength(NEW_LISTINGS_CARDS);
  });
});

describe("the sync status: syncStatusOf", () => {
  const cards = new Map([[cardA.id, cardA]]) as never;
  const raw = {
    pending: [{ platform: "bsc", cards: 4, more: false }],
    sets: [
      {
        platform: "ebay",
        variantId: "v1",
        setLabel: "1996 Playoff Contenders Base",
        failed: true,
        message: "The marketplace didn't answer.",
        lastRunAt: 1,
        heldBack: 3,
        cards: [
          { cardId: cardA.id, reason: "noPrice" },
          { cardId: cardB.id, reason: "noPrice" },
        ],
      },
      { platform: "bsc", variantId: "v2", setLabel: "Other set", failed: false, heldBack: 0, cards: [] },
    ],
    more: false,
  } as unknown as SyncAlertsRaw;

  it("nothing waiting and nothing wrong (or not read yet): null, so no section", () => {
    expect(syncStatusOf(undefined, undefined)).toBeNull();
    expect(syncStatusOf(NOTHING_TO_SYNC, undefined)).toBeNull();
    expect(syncCardIdsOf(NOTHING_TO_SYNC)).toBeNull();
  });

  it("maps the read: the marketplaces, the failure sentence, the held-back cards in NB's words; a card not hydrated is counted, not named", () => {
    const status = syncStatusOf(raw, cards)!;
    expect(status.pending).toEqual([{ marketplace: "bsc", cards: 4, more: false }]);
    expect(status.problems.map((p) => [p.id, p.marketplace, p.setLabel, p.failure, p.heldBack])).toEqual([
      ["sync-ebay-v1", "ebay", "1996 Playoff Contenders Base", "The marketplace didn't answer.", 3],
      ["sync-bsc-v2", "bsc", "Other set", null, 0],
    ]);
    expect(status.problems[0].cards.map((c) => [c.card.id, c.reason])).toEqual([
      [cardA.id, "No price yet. Set one on the card, or a common price for the set."],
    ]);
    expect(syncCardIdsOf(raw)).toEqual([cardA.id, cardB.id]);
  });

  it("a failed run with no message still says so", () => {
    const quiet = { ...raw, sets: [{ ...raw.sets[0], message: undefined }] };
    expect(syncStatusOf(quiet, cards)!.problems[0].failure).toBe("The last sync didn't go through.");
  });

  it("a held-back reason other than a price reads as the Sync status tab says it", () => {
    expect(heldBackReason({ reason: "noPrice" }, "bsc")).toMatch(/^No price yet/);
    expect(heldBackReason({ reason: "noLink" }, "bsc").length).toBeGreaterThan(0);
  });
});

describe("useRealDashboard: the sync status and New Listings", () => {
  const boxes = [
    container({ id: "main", system: "main", name: "Main" }),
    container({ id: "box-1", kind: "box", name: "Show box", count: { copies: 2, lines: 1 } }),
  ];

  it("waits for the sync read, so the status never pops in above everything", () => {
    store.containers = boxes;
    store.summary = SUMMARY;
    server.sync = undefined;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    expect(result.current).toBeUndefined();
  });

  it("asks New Listings for Fresh Pulls' two weeks, and fills it, the sync status and the boxes' shelf", () => {
    store.containers = boxes;
    store.summary = SUMMARY;
    server.listings = {
      lines: [{ id: "l1", homeId: "box-1", cardId: cardA.id, listedAt: Date.now(), quantity: 2, priceCents: 150 }],
      truncated: false,
    } as unknown as NewListingsRaw;
    server.sync = { pending: [{ platform: "ebay", cards: 1, more: false }], sets: [], more: false };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(server.listingsAsked.at(-1)).toBe(freshPullsWindowStart(Date.now()));
    expect(data.newListings.map((l) => [l.id, l.boxName, l.quantity, l.priceCents])).toEqual([[cardA.id, "Show box", 2, 150]]);
    expect(data.syncStatus?.pending).toEqual([{ marketplace: "ebay", cards: 1, more: false }]);
    expect(data.shelfBoxes?.map((b) => b.id)).toEqual(["box-1"]);
  });
});
