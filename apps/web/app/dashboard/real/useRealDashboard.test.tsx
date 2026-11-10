import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cards as fixtureCards } from "@/app/collection/prototypes/_shared/data";
import { binderPages } from "@/app/collection/final/binders/model";
import { demoCard } from "@/app/collection/final/data/demoStore";
import type { Card, CollectionSummary, Container, ContainerCopies, Copy, SetRef, Want } from "@/app/collection/final/data/types";
import { RUN_PARAM } from "@/app/collection/final/intake/RealAddCardsTab";
import { toDash } from "../dash-card";
import { bindersOf as demoBindersOf, getDashboard } from "../fake-data";
import DashboardScreen from "../screen/DashboardScreen";
import { HOUSE_VINYL, pageCount, POCKETS_PER_PAGE, shelfOrder } from "../screen/shelf-model";
import { SHELF_CAP } from "../screen/Shelf";
import { NEED_NAMED } from "../screen/Boards";
import type { CompletionRaw, CouldFitRaw, IntakeRaw, NewSinceRaw, SalesRaw, SetBoardRaw } from "./useDashboardServer";
import {
  ADD_CARDS_RUN_PARAM,
  BOARD_SETS,
  buildingSetOf,
  CHASE_CAP,
  chaseOf,
  completedChecklistOf,
  completionWindowStart,
  couldFitByBinder,
  couldFitPreviewIds,
  daysSinceSold,
  intakeOf,
  lastScanLabel,
  JUST_COMPLETED_DAYS,
  justCompletedOf,
  localDay,
  namedNeedsOf,
  newCardsByHome,
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
    expect(b.newCards).toEqual([]);
    expect(b.pockets).toEqual([]);
  });

  it("falls back to the house vinyl, and reads a not-yet-counted binder as 0", () => {
    const b = shelfBinderOf(container({ id: "main", system: "main", name: "Main" }));
    expect(b).toMatchObject({ cardCount: 0, vinyl: HOUSE_VINYL.vinyl, stripe: HOUSE_VINYL.stripe });
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
      container({ id: "unsorted", system: "unsorted", kind: "box", name: "Unsorted" }),
      container({ id: "box", kind: "box", name: "Show box" }),
      container({ id: "binder-1", name: "Packers" }),
    ];
    store.summary = SUMMARY;
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.binders?.map((b) => b.id)).toEqual(["main", "binder-1"]);
    expect(data.totals).toEqual({ cards: 2, binders: 2, exact: true });
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

describe("the empty shelf", () => {
  const main = shelfBinderOf(container({ id: "main", system: "main", name: "Main" }));

  it("says how to fill it when the collection holds no card, linking to Collection", () => {
    const data = realDashboardData({ binders: [main], summary: { copies: 0, cards: 0, exact: true, offBuild: 0 } });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "Your binders" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a card on Collection" }).getAttribute("href")).toBe("/collection");
    expect(screen.getByRole("button", { name: /^Main, 0 cards/ })).toBeTruthy();
  });

  it("says nothing of the kind once a card is in", () => {
    const data = realDashboardData({ binders: [main], summary: SUMMARY });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.queryByRole("link", { name: "Add a card on Collection" })).toBeNull();
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
  it("still stands its nine binders, every one laid out, within the shelf's cap", () => {
    const binders = demoBindersOf(getDashboard());
    expect(binders.length).toBe(9);
    expect(binders.length).toBeLessThanOrEqual(SHELF_CAP);
    expect(binders.every((b) => b.pockets.length > 0)).toBe(true);
    // The demo hands the screen no shelf of its own: it is derived.
    expect(getDashboard().binders).toBeUndefined();
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

describe("the hopper: intakeOf", () => {
  const NOW = new Date(2026, 10, 9, 15, 0).getTime();
  const raw = (over: Partial<IntakeRaw> = {}): IntakeRaw => ({
    needsYou: 2,
    unidentified: 3,
    runs: [{ runId: "run-1" as never, homeName: "Main", side: "collection", scans: 9, done: 4, lastActivityAt: NOW - 86_400_000 }],
    guesses: [
      { id: "m1" as never, cardId: cardA.id as never },
      { id: "m2" as never, cardId: "gone" as never },
    ],
    unknown: ["m3" as never],
    truncated: false,
    ...over,
  });

  it("counts every open scan: guesses waiting on a yes, the rest not identified; the preview leads with hydrated guesses", () => {
    const intake = intakeOf(raw(), cardsAB(), NOW);
    expect(intake).toMatchObject({
      total: 5,
      needsYou: 2,
      waiting: 3,
      uploads: [
        { id: "run-1", name: "Main", scans: 9, done: 4, side: "collection", href: "/collection?tab=add&run=run-1", lastScan: "Last scan yesterday" },
      ],
    });
    expect(intake.preview.map((p) => [p.id, p.guess?.id ?? null])).toEqual([
      ["m1", cardA.id],
      ["m3", null],
    ]);
  });

  it("a run finishes where its cards go: a binder's on Collection, a box's on Inventory, on the Add cards tab's own run param", () => {
    expect(ADD_CARDS_RUN_PARAM).toBe(RUN_PARAM);
    expect(runHrefOf("collection", "abc")).toBe("/collection?tab=add&run=abc");
    expect(runHrefOf("inventory", "abc")).toBe("/inventory?tab=add&run=abc");
    const intake = intakeOf(
      raw({ runs: [{ runId: "run-2" as never, homeName: "Show box", side: "inventory", scans: 3, done: 0, lastActivityAt: NOW }] }),
      cardsAB(),
      NOW,
    );
    expect(intake.uploads.map((u) => [u.side, u.href])).toEqual([["inventory", "/inventory?tab=add&run=run-2"]]);
  });

  it("nothing open, or not read yet: empty, so the hopper stays hidden", () => {
    const empty = { total: 0, waiting: 0, needsYou: 0, uploads: [], preview: [] };
    expect(intakeOf(undefined, cardsAB(), NOW)).toEqual(empty);
    expect(intakeOf(raw({ needsYou: 0, unidentified: 0, guesses: [], unknown: [] }), cardsAB(), NOW)).toEqual(empty);
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
      runs: [{ runId: "run-1" as never, homeName: "Show box", side: "inventory", scans: 5, done: 2, lastActivityAt: Date.now() - 3 * 86_400_000 }],
      guesses: [{ id: "m1" as never, cardId: cardA.id as never }],
      unknown: ["m2" as never, "m3" as never],
      truncated: false,
    };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.intake).toMatchObject({ total: 3, needsYou: 1, waiting: 2 });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "In the Hopper" })).toBeTruthy();
    expect(screen.getByText("1 scan needs your yes")).toBeTruthy();
    expect(screen.getByText("2 scans processing")).toBeTruthy();
    expect(screen.queryByText(/still being identified/)).toBeNull();
    const run = screen.getByRole("link", { name: /^Show box 2 of 5 scans done Finish on Inventory Last scan \d+ days ago$/ });
    expect(run.getAttribute("href")).toBe("/inventory?tab=add&run=run-1");
  });

  it("an account that sells with nothing to ship: the sales section says All shipped", () => {
    store.containers = smartShelf();
    store.summary = SUMMARY;
    server.sales = { dealer: true, orders: [], more: false };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.sales).toEqual({ unshipped: [] });
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByText("All shipped. Nice.")).toBeTruthy();
    expect(screen.getByText(/Nothing to ship\./)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Needs a Look" })).toBeNull();
  });

  it("orders to ship: Out the Door oldest first, and an unmatched order in Needs a Look", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 12));
    store.containers = smartShelf();
    store.summary = SUMMARY;
    server.sales = {
      dealer: true,
      orders: [
        saleRaw({ id: "s-new" as never, orderNo: "BSC-NEW", orderDate: new Date(2026, 10, 9, 8).getTime() }),
        saleRaw({
          id: "s-old" as never,
          platform: "ebay",
          orderNo: "EB-OLD",
          status: "PAID",
          orderDate: new Date(2026, 10, 6, 8).getTime(),
          lines: [{ quantity: 1, problem: "unmatched" }],
        }),
      ],
      more: false,
    };
    const { result } = renderHook(() => useRealDashboard(), { wrapper: wrapper("/dashboard") });
    const data = result.current!;
    expect(data.sales!.unshipped.map((o) => o.orderNumber)).toEqual(["EB-OLD", "BSC-NEW"]);
    render(<DashboardScreen data={data} />, { wrapper: wrapper("/dashboard") });
    expect(screen.getByRole("heading", { name: "Out the Door" })).toBeTruthy();
    expect(screen.getByText(/2 orders to ship\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs a Look" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Jump to order #EB-OLD" })).toBeTruthy();
    expect(screen.getAllByText("A line isn't matched to a card of yours yet.").length).toBeGreaterThan(0);
    expect(screen.getByText("Not matched to a card yet")).toBeTruthy();
  });

  it("with no sales, no scans and nothing that could fit: no Out the Door, no hopper, no could-fit strip", () => {
    store.containers = [container({ id: "main", system: "main", name: "Main", count: { copies: 3, lines: 3 } })];
    store.summary = SUMMARY;
    server.since = null;
    server.intake = { needsYou: 0, unidentified: 0, runs: [], guesses: [], unknown: [], truncated: false };
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
