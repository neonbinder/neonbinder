import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";
import { cardLabel } from "./data/labels";
import {
  CollectionStoreContext,
  completionOf,
  type BinderMemoryExtension,
  type CollectionActions,
  type CollectionData,
  type CollectionStoreValue,
  type CopyPhotosExtension,
  type ListingExtension,
} from "./data/store";
import {
  REAL_CAPABILITIES,
  type Capabilities,
  type Card,
  type Container,
  type Copy,
  type DrillItem,
  type EntityPick,
  type SetRef,
  type Suggestion,
  type Variant,
  type Want,
} from "./data/types";

/**
 * NEO-358 — signed-in `/collection` on a store shaped like the real one:
 * `kind: "convex"`, `REAL_CAPABILITIES` (binders, wants, trade and
 * scope on; smart binders, share and card requests off), reads that can be
 * `undefined`, and writes that resolve with an undo. The store here is hand-built over a tiny
 * catalog, so these tests pin what the views do with the contract
 * (`./data/store`), not how Convex answers. No test reaches a server.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true }) }));
vi.mock("convex/react", () => ({}));

const SET: SetRef = {
  id: "set-chrome",
  name: "Topps Chrome",
  season: "2024",
  year: 2024,
  brand: { id: "br-topps", name: "Topps" },
  sport: { id: "sp-baseball", name: "Baseball" },
};

const BASE: Variant = {
  id: "vt-base",
  kind: "base",
  name: null,
  insertName: null,
  printRun: null,
  order: 0,
  path: { typeId: "vt-base", variantId: null, subVariantId: null },
  finish: { kind: "standard" },
  cardCount: 3,
  baseCardCount: 3,
};
const GOLD: Variant = {
  id: "v-gold",
  kind: "parallel",
  name: "Gold Refractor",
  insertName: null,
  printRun: 50,
  order: 1,
  path: { typeId: "vt-par", variantId: "v-gold", subVariantId: null },
  finish: { kind: "gold" },
  cardCount: 1,
  baseCardCount: 1,
};

function card(id: string, n: string, player: [string, string], team: [string, string, string], variant = BASE): Card {
  return {
    id,
    set: SET,
    variant,
    cardNumber: n,
    players: [{ id: player[0], name: player[1] }],
    teams: [{ id: team[0], location: team[1], name: team[2] }],
    printRun: variant.printRun,
    features: [],
    cardVariation: null,
    isVariation: false,
    sortOrder: Number(n),
    finish: variant.finish,
  };
}

const OHTANI = card("c-1", "1", ["pl-ohtani", "Shohei Ohtani"], ["tm-dodgers", "Los Angeles", "Dodgers"]);
const JUDGE = card("c-2", "2", ["pl-judge", "Aaron Judge"], ["tm-yankees", "New York", "Yankees"]);
const GOODEN = card("c-3", "3", ["pl-gooden", "Dwight Gooden"], ["tm-mets", "New York", "Mets"]);
const OHTANI_GOLD = card("c-1g", "1", ["pl-ohtani", "Shohei Ohtani"], ["tm-dodgers", "Los Angeles", "Dodgers"], GOLD);
const CARDS = [OHTANI, JUDGE, GOODEN, OHTANI_GOLD];

const COPY_OHTANI: Copy = {
  id: "copy-1",
  cardId: OHTANI.id,
  variantId: BASE.id,
  setId: SET.id,
  homeId: "main",
  homeKind: "binder",
  homeName: "Main",
  upForTrade: false,
  quantity: 1,
  acquiredAt: "2026-10-01",
  notes: "",
};
const COPY_GOLD: Copy = { ...COPY_OHTANI, id: "copy-2", cardId: OHTANI_GOLD.id, variantId: GOLD.id };

const CONTAINERS: Container[] = [
  { id: "main", kind: "binder", system: "main", name: "Main", count: { copies: 2, lines: 2 } },
  { id: "trade", kind: "binder", system: "trade", name: "Up for Trade", count: { copies: 0, lines: 0 } },
  { id: "want", kind: "binder", system: "want", name: "Want List", count: { copies: 0, lines: 0 } },
  { id: "binder-rainbow", kind: "binder", name: "Ohtani rainbow", count: { copies: 0, lines: 0 } },
  { id: "box-unsorted", kind: "box", system: "unsorted", name: "Unsorted", count: { copies: 0, lines: 0 } },
  { id: "box-show", kind: "box", name: "Show box", count: { copies: 0, lines: 0 } },
];

const item = (id: string, level: DrillItem["level"], name: string, extra: Partial<DrillItem> = {}): DrillItem => ({
  id,
  level,
  name,
  hasChildren: true,
  ...extra,
});

const DRILL: Record<string, DrillItem[]> = {
  "sport|": [item("sp-baseball", "sport", "Baseball")],
  "year|sp-baseball": [item("yr-2024", "year", "2024")],
  "brand|yr-2024": [item("br-topps", "brand", "Topps")],
  "set|br-topps": [item("set-chrome", "set", "Topps Chrome")],
  "variantType|set-chrome": [
    item("vt-base", "variantType", "Base", { kind: "base", variantId: "vt-base", hasChildren: false, cardCount: 3, baseCardCount: 3 }),
    item("vt-par", "variantType", "Parallels", { kind: "parallel" }),
  ],
  "variant|vt-par": [item("v-gold", "variant", "Gold Refractor", { variantId: "v-gold", hasChildren: false, cardCount: 1, baseCardCount: 1 })],
};

const PARENT_OF: Record<string, string> = {
  year: "sport",
  brand: "year",
  set: "brand",
  variantType: "set",
  variant: "variantType",
  subVariant: "variant",
};

const SUGGESTIONS: Record<string, Suggestion[]> = {
  "doc gooden": [{ kind: "player", id: "pl-gooden", name: "Dwight Gooden", matchedAlias: "Doc Gooden", sport: "Baseball" }],
  mets: [{ kind: "team", id: "tm-mets", name: "Mets", location: "New York", franchise: { id: "fr-mets", name: "Mets franchise" } }],
  yankees: [{ kind: "team", id: "tm-yankees", name: "Yankees", location: "New York" }],
  chrome: [{ kind: "set", id: "set-chrome", label: "2024 Topps Chrome", sport: "Baseball" }],
};

interface Log {
  variantCards: string[];
  search: string[];
  entity: EntityPick[];
}

/** The store under test. `loading`: every read stays `undefined`. */
function makeStore({
  loading = false,
  capabilities = REAL_CAPABILITIES,
  boxCopies = [],
  extraCopies = [],
  binderMemory,
  listing,
  photos,
}: {
  /** NEO-377 — the store's copy-photo half; absent in a store with none. */
  photos?: CopyPhotosExtension;
  loading?: boolean;
  /** NEO-370 — the store's marketplace-listing half; absent in a store with none. */
  listing?: ListingExtension;
  capabilities?: Capabilities;
  /** Copies in a box: only the every-home read (`useCopiesOfCards`) lists them, as on Convex. */
  boxCopies?: Copy[];
  /** More lines the card drawer lists, as a line just added would be. */
  extraCopies?: Copy[];
  /** NEO-374 — Profile → Settings' where-it-opens, as the Convex store hands it over. */
  binderMemory?: BinderMemoryExtension;
} = {}) {
  const log: Log = { variantCards: [], search: [], entity: [] };
  const undo = vi.fn(async () => {});
  const actions = {
    addHave: vi.fn(async (c: Card) => ({ copyId: `new-${c.id}`, merged: false, undo })),
    addMany: vi.fn(async () => ({ copyIds: [], undo })),
    addLineItem: vi.fn(async () => ({ copyId: "new-line", merged: false, undo })),
    updateCopy: vi.fn(async () => ({ undo })),
    removeCopy: vi.fn(async (copy: Copy) => ({ removed: copy, undo })),
    restoreCopy: vi.fn(async (copy: Copy) => ({ copyId: copy.id, merged: false, undo })),
    setBuilding: vi.fn(async (_s: SetRef, building: boolean) => ({ building, undo })),
    moveCopy: vi.fn(async (c: Copy) => ({ copyId: c.id, folded: false, split: false, undo })),
    placeCopy: vi.fn(async (c: Copy) => ({ copyId: c.id, folded: false, split: false, undo })),
    setTrade: vi.fn(async () => ({ undo })),
    setWant: vi.fn(async (_cardId: string, _binderId: string | null, _on: boolean) => ({ changed: true, undo })),
    createContainer: vi.fn(async () => ({ containerId: "new-container", undo })),
    updateContainer: vi.fn(async () => ({ undo })),
    deleteContainer: vi.fn(async () => ({ moved: 0 })),
    setBoxQuantity: vi.fn(async (_c: Card, _b: Container, quantity: number) => ({ before: 0, after: quantity, undo })),
    setBinderSettings: vi.fn(async () => ({ undo })),
    relayPockets: vi.fn(async () => ({ undo })),
    setSmartRule: vi.fn(async () => ({ undo })),
    declineCard: vi.fn(async () => ({ undo })),
    undeclineCard: vi.fn(async () => ({ undo })),
    retryBinderFits: vi.fn(async () => {}),
    setCommonPrice: vi.fn(async () => ({ undo })),
  } satisfies CollectionActions;
  const wants: Want[] = [];
  const L = <T,>(value: T): T | undefined => (loading ? undefined : value);
  const data: CollectionData = {
    useDrill: (level, parents) => {
      if (!level) return undefined;
      const parent = PARENT_OF[level] ? parents[PARENT_OF[level] as keyof typeof parents] : "";
      return L(DRILL[`${level}|${parent ?? ""}`] ?? []);
    },
    useSetSummary: (id) =>
      id === null ? undefined : L(id === SET.id ? { set: SET, variants: [BASE, GOLD], totalCards: 4, totalCardsAll: 4 } : null),
    useSetPath: (id) =>
      id === null
        ? undefined
        : L(
            id === SET.id
              ? {
                  sport: { id: "sp-baseball", name: "Baseball" },
                  year: { id: "yr-2024", name: "2024" },
                  brand: { id: "br-topps", name: "Topps" },
                  set: { id: SET.id, name: SET.name },
                }
              : null,
          ),
    useVariantCards: (id) => {
      if (id === null) return undefined;
      log.variantCards.push(id);
      return L(CARDS.filter((c) => c.variant.id === id));
    },
    // Gold's size has not been counted yet: its total comes through as 0.
    useVariantCompletion: (id) =>
      id === null ? undefined : L(id === BASE.id ? completionOf({ owned: 1, total: 3 }) : completionOf({ owned: 1, total: 0 })),
    useSetCompletion: (id) =>
      id === null ? undefined : L({ ...completionOf({ owned: 1, total: 4 }, { owned: 2, total: 4 }), exact: true }),
    useTeam: () => undefined,
    useCard: (id) => (id === null ? undefined : L(CARDS.find((c) => c.id === id) ?? null)),
    useCards: (ids) => (ids === null ? undefined : L(ids.map((id) => CARDS.find((c) => c.id === id) ?? null))),
    useSuggestions: (text) => (text.trim().length < 2 ? [] : L(SUGGESTIONS[text.trim().toLowerCase()] ?? [])),
    useSearch: (text) => {
      log.search.push(text);
      if (text.trim().length < 2) return { cards: [], truncated: false };
      const words = text.toLowerCase().split(/\s+/);
      return L({
        cards: CARDS.filter((c) => words.every((w) => cardLabel(c).toLowerCase().includes(w))),
        truncated: false,
      });
    },
    useEntityCards: (pick) => {
      if (!pick) return undefined;
      log.entity.push(pick);
      const cards = CARDS.filter((c) =>
        pick.kind === "player" ? c.players.some((p) => p.id === pick.id) : c.teams.some((t) => t.id === pick.id),
      );
      return L({ cards, truncated: false });
    },
    useBuildingSets: () => L([SET]),
    useCopiesOf: (id) => (id === null ? undefined : L([COPY_OHTANI, COPY_GOLD, ...extraCopies].filter((c) => c.cardId === id))),
    useCopiesInVariant: (id) => (id === null ? undefined : L([COPY_OHTANI, COPY_GOLD].filter((c) => c.variantId === id))),
    useSummary: () => L({ copies: 2, cards: 2, exact: true, offBuild: 0 }),
    useContainers: () => L(CONTAINERS),
    useContainerCopies: (id) =>
      id === null ? undefined : L({ copies: id === "main" ? [COPY_OHTANI, COPY_GOLD] : [], truncated: false }),
    useTradeCopies: () => L({ copies: [], truncated: false }),
    useWants: () => L(wants),
    useDefaultCondition: () => "Excellent",
    useCopiesOfCards: (ids) =>
      ids === null
        ? undefined
        : L(Object.fromEntries(ids.map((id) => [id, [COPY_OHTANI, COPY_GOLD, ...boxCopies].filter((c) => c.cardId === id)]))),
    // The Inventory list: one item per card held in a box.
    useInventoryCards: (options) => {
      const held = boxCopies.filter((c) => !options?.boxId || c.homeId === options.boxId);
      const items = [...new Set(held.map((c) => c.cardId))].map((cardId) => {
        const mine = held.filter((c) => c.cardId === cardId);
        return {
          card: CARDS.find((c) => c.id === cardId)!,
          quantity: mine.reduce((n, c) => n + c.quantity, 0),
          lines: mine.length,
          graded: mine.some((c) => !!c.graded),
          gradedQuantity: mine.reduce((n, c) => n + (c.graded ? c.quantity : 0), 0),
          upForTrade: mine.some((c) => c.upForTrade),
          lastUpdated: 1,
          boxes: [...new Set(mine.map((c) => c.homeId))].map((boxId) => ({
            boxId,
            quantity: mine.filter((c) => c.homeId === boxId).reduce((n, c) => n + c.quantity, 0),
            gradedQuantity: mine.filter((c) => c.homeId === boxId).reduce((n, c) => n + (c.graded ? c.quantity : 0), 0),
          })),
        };
      });
      return L({ items, goneCardIds: [], truncated: false });
    },
    useSetCards: (id) => (id === null ? undefined : L({ cards: CARDS.filter((c) => c.set.id === id), truncated: false })),
    // Newest first: the Gold Refractor was the last Have.
    useOwnedCards: () =>
      L({
        cards: [OHTANI_GOLD, CARDS.find((c) => c.id === COPY_OHTANI.cardId)!],
        copiesByCard: { [OHTANI_GOLD.id]: { quantity: 1, lines: 1 }, [COPY_OHTANI.cardId]: { quantity: 1, lines: 1 } },
        total: 2,
        totalExact: true,
        goneCardIds: [],
        truncated: false,
      }),
    useBinderNeeds: (id) => (id === null ? undefined : L({ cards: [], held: new Set<string>(), supported: true, truncated: false })),
    useRuleMatches: (id, ids) => (id === null || ids === null ? undefined : L(new Set<string>())),
    useFindCards: (id) => (id === null ? undefined : L({ copies: [], done: true, more: () => {} })),
    useDeclined: (id) => (id === null ? undefined : L([])),
    useRuleBrands: (id) => (id === null ? undefined : L([])),
    useCommonPrices: (ids) => (ids === null ? undefined : L({})),
  };
  const value: CollectionStoreValue = { kind: "convex", capabilities, data, actions, binderMemory, listing, photos };
  return { value, actions, undo, log };
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output aria-label="Page URL">{pathname + search}</output>;
}

function renderAt(start: string, store = makeStore()) {
  render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <CollectionStoreContext.Provider value={store.value}>
          <Routes>
            <Route
              path="/collection"
              element={
                <>
                  <FinalCollectionPage />
                  <LocationProbe />
                </>
              }
            />
            <Route
              path="/inventory"
              element={
                <>
                  <FinalCollectionPage surface="inventory" />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>,
  );
  return store;
}

const pageUrl = () => screen.getByRole("status", { name: "Page URL" }).textContent ?? "";
const searchBox = () => screen.getByRole("searchbox", { name: "Search every card" });
/** The listing gate's refusal text (`convex/listingGate.ts`), as a ConvexError hands it over. */
const GATE_WORDS =
  "Show box sells on your marketplaces, so cards going in need a price first. Set a common price for the checklist, or give the card a price of its own.";

const statuses = () => screen.getAllByRole("status").map((s) => s.textContent);

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A real collection with My Binders off: My Cards ends in the plain tally, no shelf. */
const NO_BINDERS: Capabilities = { ...REAL_CAPABILITIES, binders: false };

describe("My Cards on the real collection", () => {
  it("opens Base on the board and loads another checklist's cards only when asked", () => {
    const { log } = renderAt("/collection");
    expect(screen.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeTruthy();
    expect(log.variantCards).toContain(BASE.id);
    expect(log.variantCards).not.toContain(GOLD.id);

    fireEvent.click(screen.getByRole("button", { name: "Show the cards, Gold Refractor of 2024 Topps Chrome" }));
    expect(log.variantCards).toContain(GOLD.id);
  });

  it("shows the shelf of binders, My Binders and the Binder picker (the real capabilities), never a box", () => {
    renderAt("/collection");
    expect(screen.getByRole("heading", { level: 2, name: "Everything else I own" })).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    expect(within(rail).getByRole("button", { name: /^Main/ })).toBeTruthy();
    // A box is the sale table: Inventory's, not the collection's.
    expect(within(rail).queryByRole("button", { name: /Show box/ })).toBeNull();
    const tabs = within(screen.getByRole("navigation", { name: "Collection sections" }));
    expect(tabs.getByRole("link", { name: "My Binders" })).toBeTruthy();
  });

  it("counts Everything else exactly from the store, not from the page that has loaded", () => {
    // 130 cards off every set build; the store has loaded only what was asked.
    const OFF = { ...SET, id: "set-off", name: "Topps Heritage" };
    const many = Array.from({ length: 130 }, (_, i) => ({ ...OHTANI, id: `c-off-${i}`, cardNumber: String(i + 1), set: OFF }));
    const store = makeStore();
    store.value.data.useSummary = () => ({ copies: 140, cards: 132, exact: true, offBuild: 130 });
    store.value.data.useOwnedCards = (options) => {
      const cards = many.slice(0, options?.limit ?? 200);
      return {
        cards,
        copiesByCard: Object.fromEntries(cards.map((c) => [c.id, { quantity: 1, lines: 1 }])),
        total: 132,
        totalExact: true,
        goneCardIds: [],
        truncated: cards.length < 130,
      };
    };
    renderAt("/collection", store);
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    expect(within(rail).getByRole("button", { name: /^Everything else/ }).textContent).toContain("130 cards off your set builds");
    expect(statuses()).toContain("130 cards");
    expect(screen.getByRole("list", { name: "Off the board, 130 cards" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 36 more of 130" })).toBeTruthy();

    // A filter narrows what has loaded: the count is then the loaded one.
    fireEvent.click(screen.getByRole("button", { name: "Dupes only" }));
    expect(statuses()).not.toContain("130 cards");
  });

  it("falls back to what has loaded when the store could not count Everything else", () => {
    const OFF = { ...SET, id: "set-off", name: "Topps Heritage" };
    const store = makeStore();
    store.value.data.useSummary = () => ({ copies: 9_000, cards: 5_000, exact: false, offBuild: null });
    store.value.data.useOwnedCards = () => ({
      cards: [{ ...OHTANI, set: OFF }],
      copiesByCard: { [OHTANI.id]: { quantity: 1, lines: 1 } },
      total: 5_000,
      totalExact: false,
      goneCardIds: [],
      truncated: true,
    });
    renderAt("/collection", store);
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    expect(within(rail).getByRole("button", { name: /^Everything else/ }).textContent).toContain("Cards off your set builds");
    expect(statuses()).toContain("1+ cards");
  });

  it("names one card as one card, in the status line and the grid alike", () => {
    const OFF = { ...SET, id: "set-off", name: "Topps Heritage" };
    const store = makeStore();
    store.value.data.useSummary = () => ({ copies: 3, cards: 3, exact: true, offBuild: 1 });
    store.value.data.useOwnedCards = () => ({
      cards: [{ ...OHTANI, set: OFF }],
      copiesByCard: { [OHTANI.id]: { quantity: 1, lines: 1 } },
      total: 3,
      totalExact: true,
      goneCardIds: [],
      truncated: false,
    });
    renderAt("/collection", store);
    expect(statuses()).toContain("1 card");
    expect(screen.getByRole("list", { name: "Off the board, 1 card" })).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Shelves and binders" });
    expect(within(rail).getByRole("button", { name: /^Everything else/ }).textContent).toContain("1 card off your set builds");
  });

  it("says every card is on a set build only when there are cards and all of them are", () => {
    // The default store: both cards owned are in the set being built.
    renderAt("/collection");
    expect(screen.getByText("Every card here is on a set build. Gnarly.")).toBeTruthy();
  });

  it("with nothing owned, the shelf says how to add a first card instead", () => {
    const store = makeStore();
    store.value.data.useSummary = () => ({ copies: 0, cards: 0, exact: true, offBuild: 0 });
    store.value.data.useOwnedCards = () => ({
      cards: [],
      copiesByCard: {},
      total: 0,
      totalExact: true,
      goneCardIds: [],
      truncated: false,
    });
    renderAt("/collection", store);
    expect(statuses()).toContain("0 cards");
    expect(screen.queryByText(/on a set build/)).toBeNull();
    expect(screen.getByText("Bare shelf, dude. Look one up in Find a card above and hit Add 1 to stock it.")).toBeTruthy();
    // The same on Every card I own.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Shelves and binders" })).getByRole("button", { name: /^Every card I own/ }));
    expect(screen.getByText("Bare shelf, dude. Look one up in Find a card above and hit Add 1 to stock it.")).toBeTruthy();
  });

  it("offers only binders to the Binder picker: never the Want List, Up for Trade or a box", () => {
    renderAt("/collection");
    const picker = screen.getByRole("combobox", { name: "Binder" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["All", "Main", "Ohtani rainbow"]);
  });

  it("with binders off there is no shelf and no tab, only a tally of the collection", () => {
    renderAt("/collection", makeStore({ capabilities: NO_BINDERS }));
    expect(screen.getByRole("heading", { level: 2, name: "Everything I own" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Shelves and binders" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Collection sections" })).queryByRole("link", { name: "My Binders" })).toBeNull();
  });

  it("lists every card I own under the tally, newest first, each opening the drawer", () => {
    renderAt("/collection", makeStore({ capabilities: NO_BINDERS }));
    const list = screen.getByRole("list", { name: "Everything I own, 2 cards" });
    const cards = within(list).getAllByRole("button");
    expect(cards.map((b) => b.getAttribute("aria-label"))).toEqual([
      `${cardLabel(OHTANI_GOLD)}, have`,
      `${cardLabel(CARDS.find((c) => c.id === COPY_OHTANI.cardId)!)}, have`,
    ]);
    fireEvent.click(cards[0]);
    expect(within(screen.getByRole("dialog")).getByRole("img", { name: new RegExp(`^${escapeRe(cardLabel(OHTANI_GOLD))}`) })).toBeTruthy();
  });

  it("pages a big collection: Show more counts the whole tally and hands the keyboard to the first card it adds", async () => {
    // 130 cards, far past one page; the store answers up to the limit asked.
    const many = Array.from({ length: 130 }, (_, i) => ({ ...OHTANI, id: `c-many-${i}`, cardNumber: String(i + 1) }));
    const store = makeStore({ capabilities: NO_BINDERS });
    const limits: number[] = [];
    store.value.data.useSummary = () => ({ copies: 12_345, cards: 130, exact: true, offBuild: 130 });
    store.value.data.useOwnedCards = (options) => {
      const limit = options?.limit ?? 200;
      limits.push(limit);
      const cards = many.slice(0, limit);
      return {
        cards,
        copiesByCard: Object.fromEntries(cards.map((c) => [c.id, { quantity: 1, lines: 1 }])),
        total: 130,
        totalExact: true,
        goneCardIds: [],
        truncated: limit < 130,
      };
    };
    renderAt("/collection", store);
    expect(screen.getByText("12,345")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Everything I own, 130 cards" });
    expect(within(list).getAllByRole("button")).toHaveLength(60);
    fireEvent.click(screen.getByRole("button", { name: "Show 60 more of 130" }));
    await waitFor(() => expect(document.activeElement).toBe(within(list).getAllByRole("button")[60]));
    expect(within(list).getAllByRole("button")).toHaveLength(120);
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more of 130" }));
    await waitFor(() => expect(document.activeElement).toBe(within(list).getAllByRole("button")[120]));
    expect(screen.queryByRole("button", { name: /^Show \d+ more of/ })).toBeNull();
    expect(Math.max(...limits)).toBe(180);
  });

  it("reads a count the store could only take part of as a floor, never as the answer", () => {
    const store = makeStore({ capabilities: NO_BINDERS });
    store.value.data.useSummary = () => ({ copies: 9_000, cards: 5_000, exact: false, offBuild: null });
    store.value.data.useOwnedCards = () => ({
      cards: [OHTANI],
      copiesByCard: { [OHTANI.id]: { quantity: 1, lines: 1 } },
      total: 5_000,
      totalExact: false,
      goneCardIds: [],
      truncated: true,
    });
    renderAt("/collection", store);
    expect(screen.getByText("5,000+ cards")).toBeTruthy();
    expect(screen.getByText("9,000+")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Everything I own, 5,000+ cards" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 60 more of 5,000+" })).toBeTruthy();
  });

  it("shows skeletons, never an empty board, while the reads are in flight", () => {
    renderAt("/collection", makeStore({ loading: true }));
    expect(statuses()).toContain("Firing up the scoreboard…");
    expect(screen.queryByText("Nothing on the board yet. Pick a set and light it up.")).toBeNull();
  });

  it("a set on the board with no cards yet settles: no skeleton, no empty row list, and its wall offers no Build", () => {
    const EMPTY: SetRef = { ...SET, id: "set-empty", name: "Topps Bare" };
    const store = makeStore();
    const summaryOf = store.value.data.useSetSummary;
    store.value.data.useSetSummary = (id) =>
      id === EMPTY.id ? { set: EMPTY, variants: [], totalCards: 0, totalCardsAll: 0 } : summaryOf(id);
    store.value.data.useBuildingSets = () => [SET, EMPTY];
    renderAt("/collection", store);
    const board = screen.getByRole("link", { name: "2024 Topps Bare" }).closest("article")!;
    expect(within(board).getByText("No cards in this set yet. It's still in the shrink-wrap!")).toBeTruthy();
    expect(board.querySelector('[class*="animate-pulse"]')).toBeNull();
    expect(within(board).queryByRole("list")).toBeNull();
    // The neighbouring board still counts its base.
    expect(screen.getByRole("list", { name: "2024 Topps Chrome by row" })).toBeTruthy();
    cleanup();

    // On the board already: it can still come off.
    renderAt(`/collection?tab=cards&set=${EMPTY.id}`, store);
    expect(screen.getByRole("button", { name: "Stop building this set" })).toBeTruthy();
    cleanup();

    // Not on the board: nothing to build, so no Build.
    store.value.data.useBuildingSets = () => [SET];
    renderAt(`/collection?tab=cards&set=${EMPTY.id}`, store);
    expect(screen.getByRole("heading", { level: 2, name: "2024 Topps Bare" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build this set" })).toBeNull();
  });

  it("a wall's checklists fold until opened, Base first", () => {
    const { log } = renderAt(`/collection?tab=cards&set=${SET.id}`);
    expect(screen.getByRole("group", { name: "2024 Topps Chrome checklist wall" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gold Refractor /50 tiles" }).getAttribute("aria-expanded")).toBe("false");
    expect(log.variantCards).not.toContain(GOLD.id);
    // The tile's name is stable; have or need is its pressed state.
    expect(screen.getByRole("button", { name: "Base #2 Aaron Judge" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Checklists on the real collection", () => {
  it("reads a deep link's set path, and an uncounted checklist says what is owned, never 'of 0'", () => {
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-par&variant=v-gold`);
    expect(screen.getByRole("heading", { level: 3, name: "2024 Topps Chrome Gold Refractor" })).toBeTruthy();
    expect(screen.getByText("1 owned")).toBeTruthy();
    expect(screen.queryByText(/of 0/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sports: Baseball, change" })).toBeTruthy();
    expect(document.title).toBe("Checklists · 2024 Topps Chrome Gold Refractor · Collection");
  });

  it("under All (NEO-374: a view, not a binder) Have is locked and the picker says to choose a binder", () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    expect(screen.getByText("Choose a binder to add cards.")).toBeTruthy();
    const have = screen.getByRole("button", { name: "Have #2 Aaron Judge" });
    expect(have.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(have);
    expect(actions.addHave).not.toHaveBeenCalled();
  });

  it("'remember the last binder' opens on that binder when the URL names none, and a pick is kept", () => {
    const remember = vi.fn();
    renderAt(
      `/collection?tab=checklists&set=${SET.id}&type=vt-base`,
      makeStore({ binderMemory: { opening: { open: "last", lastBinder: "binder-rainbow" }, remember } }),
    );
    expect(pageUrl()).toBe(`/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=binder-rainbow`);
    const picker = screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement;
    expect(picker.value).toBe("binder-rainbow");
    expect(screen.queryByText("Choose a binder to add cards.")).toBeNull();

    // Picking All stays All (once per visit), and the pick is kept.
    fireEvent.change(picker, { target: { value: "all" } });
    expect(remember).toHaveBeenCalledWith("all");
    expect(picker.value).toBe("all");
    expect(pageUrl()).toBe(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
  });

  it("opens on All under 'open on All', and a scope in the URL wins over a remembered binder", () => {
    renderAt(
      `/collection?tab=checklists&set=${SET.id}&type=vt-base`,
      makeStore({ binderMemory: { opening: { open: "all", lastBinder: null }, remember: vi.fn() } }),
    );
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("all");
    cleanup();

    renderAt(
      `/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=main`,
      makeStore({ binderMemory: { opening: { open: "last", lastBinder: "binder-rainbow" }, remember: vi.fn() } }),
    );
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("main");
  });

  it("a remembered binder that is gone opens on All", () => {
    renderAt(
      `/collection?tab=checklists&set=${SET.id}&type=vt-base`,
      makeStore({ binderMemory: { opening: { open: "last", lastBinder: "binder-deleted" }, remember: vi.fn() } }),
    );
    expect((screen.getByRole("combobox", { name: "Binder" }) as HTMLSelectElement).value).toBe("all");
  });

  it("Have adds through the store and offers Undo", async () => {
    const { actions, undo } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=main`);
    expect(screen.getByText(/Have/, { selector: "p" }).textContent).toContain("Have 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    expect(actions.addHave).toHaveBeenCalledWith(JUDGE, "main");
    await waitFor(() => expect(statuses()).toContain("Added #2 Aaron Judge to Main"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("Undo says Undone. only once its write lands, and does nothing pressed again while it runs", async () => {
    const store = makeStore();
    let land!: () => void;
    store.undo.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=main`, store);
    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    await waitFor(() => expect(statuses()).toContain("Added #2 Aaron Judge to Main"));

    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    expect(store.undo).toHaveBeenCalledTimes(1);
    // Still running: the line still says what it said, and Undo stays, inert.
    expect(statuses()).not.toContain("Undone.");
    expect(statuses()).toContain("Added #2 Aaron Judge to Main");
    expect(screen.getByRole("button", { name: "Undo" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(store.undo).toHaveBeenCalledTimes(1);

    await act(async () => land());
    await waitFor(() => expect(statuses()).toContain("Undone."));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("an undo the server refuses says so, never Undone.", async () => {
    const store = makeStore();
    store.undo.mockImplementationOnce(async () => {
      throw new Error("nope");
    });
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=main`, store);
    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    await waitFor(() => expect(statuses()).toContain("Added #2 Aaron Judge to Main"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(statuses().some((t) => t?.startsWith("That undo didn't go through."))).toBe(true));
    expect(statuses()).not.toContain("Undone.");
  });

  it("rows carry Want for every card and Trade only for a copy you hold", () => {
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    expect(screen.getByRole("button", { name: "Want #2 Aaron Judge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Trade #2 / })).toBeNull();
    expect(screen.getByRole("button", { name: "Trade #1 Shohei Ohtani, Raw" })).toBeTruthy();
  });

  it("with wants and trade off the rows carry neither", () => {
    renderAt(
      `/collection?tab=checklists&set=${SET.id}&type=vt-base`,
      makeStore({ capabilities: { ...REAL_CAPABILITIES, wants: false, trade: false } }),
    );
    expect(screen.queryByRole("button", { name: /^Want / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Trade / })).toBeNull();
  });

  it("Want files a plain want", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Want #2 Aaron Judge" }));
    expect(actions.setWant).toHaveBeenCalledWith(JUDGE.id, null, true);
    await waitFor(() => expect(statuses().some((s) => s?.includes("is on your Want List"))).toBe(true));
  });

  it("Trade flags the line without moving it", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Trade #1 Shohei Ohtani, Raw" }));
    expect(actions.setTrade).toHaveBeenCalledWith(COPY_OHTANI, true);
    expect(actions.moveCopy).not.toHaveBeenCalled();
  });

  it("says why a write was refused", async () => {
    const store = makeStore();
    store.actions.addHave.mockRejectedValueOnce(Object.assign(new Error("x"), { data: { message: "That card is gone." } }));
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base&scope=main`, store);
    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    await waitFor(() => expect(statuses()).toContain("That card is gone."));
  });

  it("waits for a pause in typing, then offers a player by his nickname and lists all his cards", async () => {
    const { log, actions } = renderAt("/collection?tab=checklists&scope=main");
    fireEvent.change(searchBox(), { target: { value: "doc gooden" } });
    // Not asked yet: the box waits 300ms for a pause.
    expect(log.search.at(-1)).toBe("");
    const offer = await screen.findByRole("button", { name: "Every Dwight Gooden card, as Doc Gooden" });
    fireEvent.click(offer);
    // The binder rides along (NEO-374: under All nothing is added).
    expect(pageUrl()).toBe("/collection?tab=checklists&player=pl-gooden&scope=main");
    const results = screen.getByRole("region", { name: "Every Dwight Gooden card" });
    fireEvent.click(within(results).getByRole("button", { name: `Have ${cardLabel(GOODEN)}` }));
    expect(actions.addHave).toHaveBeenCalledWith(GOODEN, "main");
  });

  it("a team lists just that team by default, and the whole franchise only when it has one", async () => {
    const { log } = renderAt("/collection?tab=checklists");
    fireEvent.change(searchBox(), { target: { value: "mets" } });
    fireEvent.click(await screen.findByRole("button", { name: "Every New York Mets card" }));
    expect(pageUrl()).toBe("/collection?tab=checklists&team=tm-mets&franchise=fr-mets");
    expect(log.entity.at(-1)).toEqual({ kind: "team", id: "tm-mets", wholeFranchise: false });
    const which = screen.getByRole("radiogroup", { name: "Which teams" });
    expect(within(which).getByRole("radio", { name: "Just this team" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(which).getByRole("radio", { name: "Include the whole franchise" }));
    await waitFor(() => expect(pageUrl()).toBe("/collection?tab=checklists&team=tm-mets&franchise=fr-mets&whole=1"));
    expect(log.entity.at(-1)).toEqual({ kind: "team", id: "tm-mets", wholeFranchise: true });
    cleanup();

    renderAt("/collection?tab=checklists&team=tm-yankees");
    expect(screen.getByRole("region", { name: "Every New York Yankees card" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Which teams" })).toBeNull();
  });

  it("a set suggestion opens its checklist's set", async () => {
    renderAt("/collection?tab=checklists");
    fireEvent.change(searchBox(), { target: { value: "chrome" } });
    fireEvent.click(await screen.findByRole("button", { name: "Open the 2024 Topps Chrome checklist" }));
    expect(pageUrl()).toBe(`/collection?tab=checklists&set=${SET.id}`);
    expect(screen.getByRole("listbox", { name: "Variant Types" })).toBeTruthy();
  });

  it("no hits says the card is not in the catalog yet, with no request to send", async () => {
    renderAt("/collection?tab=checklists");
    fireEvent.change(searchBox(), { target: { value: "zzzz nothing" } });
    expect(await screen.findByText("Not in the catalog yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask us to add it/ })).toBeNull();
  });

  it("a search hit jumps to its checklist with the row ringed", async () => {
    renderAt("/collection?tab=checklists");
    fireEvent.change(searchBox(), { target: { value: "judge" } });
    fireEvent.click(await screen.findByRole("button", { name: `Open the checklist for ${cardLabel(JUDGE)}` }));
    expect(pageUrl()).toBe(`/collection?tab=checklists&set=${SET.id}&type=vt-base&card=${JUDGE.id}`);
    expect(screen.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeTruthy();
  });

  it("a jump to a card the catalog dropped says so and never crashes", () => {
    renderAt("/collection?tab=checklists&card=card-gone");
    expect(screen.getByText("That card is no longer in the catalog. Your copies of it are safe.")).toBeTruthy();
  });

  it("a jump to a card by id finds its checklist", async () => {
    renderAt(`/collection?tab=checklists&card=${GOODEN.id}`);
    await waitFor(() => expect(pageUrl()).toBe(`/collection?tab=checklists&card=${GOODEN.id}&set=${SET.id}&type=vt-base`));
  });

  it("shows a skeleton cascade while the catalog loads", () => {
    renderAt("/collection?tab=checklists", makeStore({ loading: true }));
    expect(statuses()).toContain("Loading sports…");
  });
});

describe("the card drawer on the real collection", () => {
  it("adds a copy with no sale fields, acquired today, and draws the card from the view model", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Details for #2 Aaron Judge" }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("img", { name: `${cardLabel(JUDGE)}, need` })).toBeTruthy();
    expect(within(drawer).queryByRole("switch", { name: "For sale" })).toBeNull();
    expect(within(drawer).queryByRole("group", { name: "Binders" })).toBeNull();
    // NEO-380: a raw copy always has a condition; the form starts on the default and offers no "Not set".
    const condition = within(drawer).getByRole("combobox", { name: "Condition" }) as HTMLSelectElement;
    expect(condition.value).toBe("Excellent");
    expect(Array.from(condition.options).map((o) => o.textContent)).not.toContain("Not set");
    fireEvent.click(within(drawer).getByRole("button", { name: "Add to collection" }));
    expect(actions.addLineItem).toHaveBeenCalledTimes(1);
    const [, details] = actions.addLineItem.mock.calls[0] as unknown as [Card, Copy & { homeId?: string }];
    expect(details.quantity).toBe(1);
    expect(details.condition).toBe("Excellent");
    expect(details.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(details).not.toHaveProperty("demo");
    expect(details.homeId).toBe("main");
    await waitFor(() => expect(within(drawer).getAllByRole("status").some((s) => s.textContent?.startsWith("Added #2 Aaron Judge"))).toBe(true));
  });

  describe("an add with held photos (NEO-431)", () => {
    const photosExt = () =>
      ({
        usePhotos: () => new Map(),
        useCardImages: () => new Map(),
        addPhoto: vi.fn(async () => {}),
        removePhoto: vi.fn(async () => {}),
        swapPhotos: vi.fn(async () => {}),
      }) satisfies CopyPhotosExtension;
    const jpeg = () => new File(["x"], "card.jpg", { type: "image/jpeg" });
    function openAddForm(photos: CopyPhotosExtension) {
      const store = makeStore({ photos });
      renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
      fireEvent.click(screen.getByRole("button", { name: "Details for #2 Aaron Judge" }));
      const drawer = screen.getByRole("dialog");
      const form = within(drawer).getByRole("form", { name: "Add a copy" });
      const box = within(form).getByRole("region", { name: /^Photos of / });
      const pick = (side: "front" | "back") =>
        act(async () => {
          fireEvent.change(box.querySelector(`[data-copy-photo-input="${side}"]`)!, { target: { files: [jpeg()] } });
        });
      return { ...store, drawer, form, box, pick };
    }
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => "blob:held");
      URL.revokeObjectURL = vi.fn();
    });

    it("a plain add from the same form stays a plain add", async () => {
      const photos = photosExt();
      const { actions, form, drawer } = openAddForm(photos);
      fireEvent.click(within(form).getByRole("button", { name: "Add to collection" }));
      expect(actions.addLineItem.mock.calls[0]).toHaveLength(2);
      await waitFor(() => expect(within(drawer).getAllByRole("status").some((s) => s.textContent?.startsWith("Added #2"))).toBe(true));
      expect(photos.addPhoto).not.toHaveBeenCalled();
    });

    it("keeps its own line, uploads against the id the write answered, and Add is busy until they land", async () => {
      const photos = photosExt();
      let finish = () => {};
      photos.addPhoto.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
      const { actions, form, box, pick, drawer } = openAddForm(photos);
      await pick("front");
      await pick("back");
      expect(photos.addPhoto).not.toHaveBeenCalled();

      fireEvent.click(within(form).getByRole("button", { name: "Add to collection" }));
      const busy = await within(form).findByRole("button", { name: "Adding…" });
      expect(busy.getAttribute("aria-disabled")).toBe("true");
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(1));
      expect(actions.addLineItem.mock.calls[0]).toEqual([JUDGE, expect.objectContaining({ quantity: 1 }), { keepsOwnLine: true }]);
      const [copy, side] = photos.addPhoto.mock.calls[0] as unknown as [Copy, string, File];
      expect(copy.id).toBe("new-line");
      expect(side).toBe("front");
      expect(within(box).getByRole("status").textContent).toBe("Saving your photos…");

      // A second press and Cancel both wait; nothing is sent twice.
      fireEvent.click(busy);
      fireEvent.submit(form);
      fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
      fireEvent.keyDown(form, { key: "Escape" });
      expect(actions.addLineItem).toHaveBeenCalledTimes(1);
      expect(within(drawer).getByRole("form", { name: "Add a copy" })).toBe(form);

      await act(async () => finish());
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(2));
      expect((photos.addPhoto.mock.calls[1] as unknown as [Copy, string, File])[1]).toBe("back");
      await waitFor(() =>
        expect(within(drawer).getAllByRole("status").some((s) => /^Added #2 Aaron Judge, .*, with its front and back photos\.$/.test(s.textContent ?? ""))).toBe(true),
      );
      expect(actions.addLineItem).toHaveBeenCalledTimes(1);
    });

    it("refused (a card at its line limit): the existing refusal shows and the photos stay in the form", async () => {
      const photos = photosExt();
      const { actions, form, box, pick, drawer } = openAddForm(photos);
      actions.addLineItem.mockRejectedValueOnce(new Error("You already have 200 lines of this card. Stack some together first."));
      await pick("front");
      fireEvent.click(within(form).getByRole("button", { name: "Add to collection" }));
      await waitFor(() =>
        expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "You already have 200 lines of this card. Stack some together first.")).toBe(true),
      );
      expect(photos.addPhoto).not.toHaveBeenCalled();
      expect(within(box).getByRole("img", { name: /^Front of your new copy/ })).toBeTruthy();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      // Add is ready for another go.
      expect(within(form).getByRole("button", { name: "Add to collection" }).getAttribute("aria-disabled")).toBeNull();
    });

    it("a store without photos shows no photo box in the Add form", () => {
      renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
      fireEvent.click(screen.getByRole("button", { name: "Details for #2 Aaron Judge" }));
      expect(within(screen.getByRole("dialog")).queryByRole("region", { name: /^Photos of / })).toBeNull();
    });
  });

  describe("an add with held photos: adversarial pass (NEO-431)", () => {
    const photosExt = () =>
      ({
        usePhotos: () => new Map(),
        useCardImages: () => new Map(),
        addPhoto: vi.fn(async (_copy: Copy, _side: string, _file: File) => {}),
        removePhoto: vi.fn(async () => {}),
        swapPhotos: vi.fn(async () => {}),
      }) satisfies CopyPhotosExtension;
    const jpeg = (name = "card.jpg") => new File(["x"], name, { type: "image/jpeg" });
    /** Ohtani already has a line (`copy-1`), so the write answering with that id stands in for "the new line is in the list". */
    function openAnotherCopy(photos: CopyPhotosExtension) {
      const store = makeStore({ photos });
      store.actions.addLineItem.mockResolvedValue({ copyId: "copy-1", merged: false, undo: store.undo });
      renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
      fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
      const drawer = screen.getByRole("dialog");
      fireEvent.click(within(drawer).getByRole("button", { name: /add another copy|add a copy/i }));
      const form = within(drawer).getByRole("form", { name: "Add another copy" });
      const box = within(form).getByRole("region", { name: /^Photos of / });
      const pick = (side: "front" | "back", file = jpeg()) =>
        act(async () => {
          fireEvent.change(box.querySelector(`[data-copy-photo-input="${side}"]`)!, { target: { files: [file] } });
        });
      return { ...store, drawer, form, box, pick };
    }
    let seq = 0;
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => `blob:held-${(seq += 1)}`);
      URL.revokeObjectURL = vi.fn();
    });

    it("one photo fails: the copy stays, the photo that made it is not tried again, the failed side's Add is where the keyboard lands", async () => {
      const photos = photosExt();
      photos.addPhoto.mockImplementation(async (_c, side) => {
        if (side === "back") throw new Error("That photo is too big. Add it again.");
      });
      const { form, drawer, pick } = openAnotherCopy(photos);
      await pick("front");
      await pick("back");
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(within(drawer).getAllByRole("status").some((s) => /Its back photo didn't save\. Try again under Edit\./.test(s.textContent ?? ""))).toBe(true),
      );
      // Edit opens by itself with the failure in the photo field.
      const editForm = await within(drawer).findByRole("form", { name: /edit/i });
      expect(within(editForm).getByRole("alert").textContent).toMatch(/Your copy is in, but the back photo didn't save\. That photo is too big\. Add it again\. Add it again here\./);
      expect(photos.addPhoto).toHaveBeenCalledTimes(2);
      expect(photos.addPhoto.mock.calls.map((c) => c[1])).toEqual(["front", "back"]);
    });

    it("both photos fail: one message names both, once per distinct reason", async () => {
      const photos = photosExt();
      photos.addPhoto.mockRejectedValue(new Error("Couldn't reach the photo store."));
      const { form, drawer, pick } = openAnotherCopy(photos);
      await pick("front");
      await pick("back");
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      const editForm = await within(drawer).findByRole("form", { name: /edit/i });
      const alertText = within(editForm).getByRole("alert").textContent ?? "";
      expect(alertText).toContain("front and back photos didn't save");
      expect(alertText).toContain("Add them again here.");
      expect(alertText.match(/Couldn't reach the photo store\./g)).toHaveLength(1);
      // Neither attempt was skipped because the other failed.
      expect(photos.addPhoto).toHaveBeenCalledTimes(2);
      expect(
        within(drawer).getAllByRole("status").some((s) => /\. Its front and back photos didn't save\. Try again under Edit\.$/.test(s.textContent ?? "")),
      ).toBe(true);
    });

    describe("a photo fails while another line's Edit form is open", () => {
      const NEW_LINE: Copy = { ...COPY_OHTANI, id: "copy-new", quantity: 2 };
      /** Line X (`copy-1`) open in Edit with a draft in it, and an add with one held photo ready to go. */
      async function editingX() {
        const photos = photosExt();
        photos.addPhoto.mockRejectedValue(new Error("Nope."));
        const store = makeStore({ photos, extraCopies: [NEW_LINE] });
        store.actions.addLineItem.mockResolvedValue({ copyId: NEW_LINE.id, merged: false, undo: store.undo });
        renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
        fireEvent.click(screen.getByRole("button", { name: /^Details for #1 Shohei Ohtani/ }));
        const drawer = screen.getByRole("dialog");
        const editButton = (id: string) => drawer.querySelector<HTMLElement>(`[data-copy-edit="${id}"]`)!;
        const editor = (id: string) => drawer.querySelector<HTMLElement>(`[data-copy-editor="${id}"]`);
        fireEvent.click(editButton("copy-1"));
        const notes = within(editor("copy-1")!).getByRole("textbox", { name: /^Notes/ }) as HTMLInputElement;
        fireEvent.change(notes, { target: { value: "My draft" } });
        fireEvent.click(within(drawer).getByRole("button", { name: /^Add another copy of / }));
        const form = within(drawer).getByRole("form", { name: "Add another copy" });
        const box = within(form).getByRole("region", { name: /^Photos of / });
        await act(async () => {
          fireEvent.change(box.querySelector('[data-copy-photo-input="front"]')!, { target: { files: [jpeg()] } });
        });
        const add = within(form).getByRole("button", { name: /^Add to collection$/ });
        return { drawer, form, notes, add, editButton, editor };
      }
      const failureSaid = (drawer: HTMLElement) =>
        waitFor(() =>
          expect(within(drawer).getAllByRole("status").some((s) => /Its front photo didn't save\./.test(s.textContent ?? ""))).toBe(true),
        );
      /** Longer than any queued focus move or open would take. */
      const settle = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

      it("X keeps its draft and the keyboard, and the new line's Edit opened by hand shows the failure", async () => {
        const { drawer, notes, add, editButton, editor } = await editingX();
        notes.focus();
        fireEvent.click(add);
        await failureSaid(drawer);
        await settle();
        expect(editor("copy-new")).toBeNull();
        expect(notes.isConnected).toBe(true);
        expect(notes.value).toBe("My draft");
        expect(document.activeElement).toBe(notes);

        fireEvent.click(editButton("copy-new"));
        const field = within(editor("copy-new")!).getByRole("region", { name: /^Photos of / });
        expect(within(field).getByRole("alert").textContent).toMatch(/^Your copy is in, but the front photo didn't save\./);
        await waitFor(() => expect(document.activeElement).toBe(within(field).getByRole("button", { name: "Add front" })));
      });

      it("the keyboard still in the Add form goes back to Add as it folds, leaving X alone", async () => {
        const { drawer, notes, add, editor } = await editingX();
        add.focus();
        fireEvent.click(add);
        await failureSaid(drawer);
        await waitFor(() => expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: /^Add another copy of / })));
        expect(editor("copy-1")).not.toBeNull();
        expect(notes.value).toBe("My draft");
      });

      it("Cancel on X leaves the failure waiting for the new line's own form, which stays shut until asked", async () => {
        const { drawer, add, editButton, editor } = await editingX();
        fireEvent.click(add);
        await failureSaid(drawer);
        fireEvent.click(within(editor("copy-1")!).getByRole("button", { name: "Cancel" }));
        await settle();
        expect(editor("copy-new")).toBeNull();
        fireEvent.click(editButton("copy-new"));
        const field = within(editor("copy-new")!).getByRole("region", { name: /^Photos of / });
        expect(within(field).getByRole("alert").textContent).toMatch(/front photo didn't save/);
        // Once it has been read in its form, Cancel there drops it.
        fireEvent.click(within(editor("copy-new")!).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(editor("copy-new")).toBeNull());
        fireEvent.click(editButton("copy-new"));
        expect(within(within(editor("copy-new")!).getByRole("region", { name: /^Photos of / })).getByRole("alert").textContent).toBe("");
      });

      it("with no form open it opens the new line's Edit by itself, once, and that form can be closed", async () => {
        const photos = photosExt();
        photos.addPhoto.mockRejectedValue(new Error("Nope."));
        const store = makeStore({ photos, extraCopies: [NEW_LINE] });
        store.actions.addLineItem.mockResolvedValue({ copyId: NEW_LINE.id, merged: false, undo: store.undo });
        renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
        fireEvent.click(screen.getByRole("button", { name: /^Details for #1 Shohei Ohtani/ }));
        const drawer = screen.getByRole("dialog");
        fireEvent.click(within(drawer).getByRole("button", { name: /^Add another copy of / }));
        const form = within(drawer).getByRole("form", { name: "Add another copy" });
        await act(async () => {
          fireEvent.change(form.querySelector('[data-copy-photo-input="front"]')!, { target: { files: [jpeg()] } });
        });
        fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
        await waitFor(() => expect(drawer.querySelector('[data-copy-editor="copy-new"]')).not.toBeNull());
        const opened = drawer.querySelector<HTMLElement>('[data-copy-editor="copy-new"]')!;
        fireEvent.click(within(opened).getByRole("button", { name: "Cancel" }));
        await settle();
        expect(drawer.querySelector('[data-copy-editor="copy-new"]')).toBeNull();
      });
    });

    it("a box add with photos says it's for sale, last", async () => {
      const photos = photosExt();
      renderAt(`/inventory?tab=checklists&set=${SET.id}&type=vt-base`, makeStore({ photos }));
      fireEvent.click(screen.getByRole("button", { name: "Details for #2 Aaron Judge" }));
      const drawer = screen.getByRole("dialog");
      const form = within(drawer).getByRole("form", { name: "Add a copy" });
      await act(async () => {
        fireEvent.change(form.querySelector('[data-copy-photo-input="front"]')!, { target: { files: [jpeg()] } });
      });
      fireEvent.click(within(form).getByRole("button", { name: "Add to inventory" }));
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(within(drawer).getAllByRole("status").some((s) => /, with its front photo\. It's for sale\.$/.test(s.textContent ?? ""))).toBe(true),
      );
    });

    it("Cancel on the opened Edit form drops the failure, so reopening Edit shows no stale alert", async () => {
      const photos = photosExt();
      photos.addPhoto.mockRejectedValue(new Error("Nope."));
      const { form, drawer, pick } = openAnotherCopy(photos);
      await pick("front");
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      const editForm = await within(drawer).findByRole("form", { name: /edit/i });
      expect(within(editForm).getByRole("alert").textContent).toMatch(/front photo didn't save/);
      fireEvent.click(within(editForm).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(within(drawer).queryByRole("form", { name: /edit/i })).toBeNull());
      fireEvent.click(within(drawer).getAllByRole("button", { name: /^Edit/ })[0]);
      const again = await within(drawer).findByRole("form", { name: /edit/i });
      expect(within(again).getByRole("alert").textContent).toBe("");
    });

    it("the draft resets after a good add: no held photo rides along into the next add, and no object URL is left unrevoked", async () => {
      const photos = photosExt();
      const { form, box, pick, drawer } = openAnotherCopy(photos);
      await pick("front");
      await pick("back");
      const made = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.results.map((r) => r.value);
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(within(drawer).getAllByRole("status").some((s) => /with its front and back photos/.test(s.textContent ?? ""))).toBe(true));
      for (const url of made) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
      expect(box.isConnected && within(box).queryByRole("img")).toBeFalsy();
    });

    it("Enter, Enter and a click on the busy button send one add", async () => {
      const photos = photosExt();
      let finish = () => {};
      photos.addPhoto.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
      const { actions, form, pick } = openAnotherCopy(photos);
      await pick("front");
      // Each event is its own discrete event, so React has re-rendered between them.
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.click(within(form).getByRole("button", { name: "Adding…" }));
      expect(actions.addLineItem).toHaveBeenCalledTimes(1);
      await act(async () => finish());
    });

    it("the Close button mid-upload does not lose the failure notice: the toast still says what happened", async () => {
      const photos = photosExt();
      let fail = (_e: Error) => {};
      photos.addPhoto.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
      const { form, pick, drawer } = openAnotherCopy(photos);
      await pick("front");
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(1));
      fireEvent.click(within(drawer).getByRole("button", { name: "Close card detail" }));
      await act(async () => fail(new Error("Gone.")));
      expect(screen.getAllByRole("status").some((s) => /front photo didn't save/.test(s.textContent ?? ""))).toBe(true);
    });

    it("the line-limit refusal keeps both held files, Add is ready, and a retry that succeeds uploads exactly those two files", async () => {
      const photos = photosExt();
      const { actions, form, pick, drawer } = openAnotherCopy(photos);
      actions.addLineItem.mockRejectedValueOnce(new Error("You already have 200 lines of this card. Stack some together first."));
      const front = jpeg("front.jpg");
      const back = jpeg("back.jpg");
      await pick("front", front);
      await pick("back", back);
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      await waitFor(() => expect(actions.addLineItem).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(form).getByRole("button", { name: /^Add to collection$/ }).getAttribute("aria-disabled")).toBeNull());
      expect(photos.addPhoto).not.toHaveBeenCalled();
      fireEvent.click(within(form).getByRole("button", { name: /^Add to collection$/ }));
      await waitFor(() => expect(photos.addPhoto).toHaveBeenCalledTimes(2));
      expect(photos.addPhoto.mock.calls.map((c) => (c[2] as File).name)).toEqual(["front.jpg", "back.jpg"]);
      expect(drawer.isConnected).toBe(true);
    });
  });

  it("edits and removes a copy, each with Undo", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "Edit #1 Shohei Ohtani, Raw" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Save copy" }));
    expect(actions.updateCopy).toHaveBeenCalledTimes(1);
    // A copy stored with no condition saves in the default (NEO-380).
    expect((actions.updateCopy.mock.calls[0] as unknown as [Copy, Partial<Copy>])[1].condition).toBe("Excellent");
    await act(async () => {});
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove #1 Shohei Ohtani, Raw" }));
    expect(actions.removeCopy).toHaveBeenCalledWith(COPY_OHTANI);
    await waitFor(() =>
      expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "Removed #1 Shohei Ohtani, Raw · Main")).toBe(true),
    );
  });
});

describe("the Up for Trade pile's hunt on the real collection spans binders and boxes (NEO-359)", () => {
  const BOX_JUDGE: Copy = { ...COPY_OHTANI, id: "copy-box-judge", cardId: JUDGE.id, homeId: "box-show", homeKind: "box", homeName: "Show box" };
  const BOX_OHTANI: Copy = { ...COPY_OHTANI, id: "copy-box-ohtani", homeId: "box-show", homeKind: "box", homeName: "Show box" };
  const huntFor = async (box: string, text: string) => {
    fireEvent.change(screen.getByRole("searchbox", { name: box }), { target: { value: text } });
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => /^\d+ (in|card)|^None/.test(s.textContent ?? ""))).toBe(true));
  };

  it("lists a copy in a box, marked for sale, and flags it where it lives", async () => {
    const store = renderAt("/collection?tab=binders&b=trade", makeStore({ boxCopies: [BOX_JUDGE] }));
    await huntFor("Hunt for a card to trade", "judge");
    const mine = screen.getByRole("list", { name: "In your binders and boxes" });
    const find = within(mine).getByRole("button", { name: "Find #2 Aaron Judge in Show box, for sale" });
    expect(find.textContent).toBe("In Show box, for sale");
    fireEvent.click(within(mine).getByRole("button", { name: `Put ${cardLabel(JUDGE)} up for trade` }));
    await waitFor(() => expect(store.actions.setTrade).toHaveBeenCalledWith(BOX_JUDGE, true));
  });

  it("asks which copy when a card lives in a binder and a box, naming the box's for sale", async () => {
    const store = renderAt("/collection?tab=binders&b=trade", makeStore({ boxCopies: [BOX_OHTANI] }));
    await huntFor("Hunt for a card to trade", "ohtani");
    const mine = screen.getByRole("list", { name: "In your binders and boxes" });
    fireEvent.click(within(mine).getByRole("button", { name: `Put ${cardLabel(OHTANI)} up for trade` }));
    const chooser = screen.getByRole("group", { name: "Which #1 Shohei Ohtani goes up for trade?" });
    const sale = within(chooser).getByRole("button", { name: /, the one for sale, up for trade$/ });
    expect(sale.textContent).toMatch(/Show box, for sale$/);
    expect(within(chooser).getAllByRole("button", { name: /^Put .* up for trade$/ })).toHaveLength(2);
    fireEvent.click(sale);
    await waitFor(() => expect(store.actions.setTrade).toHaveBeenCalledWith(BOX_OHTANI, true));
  });

  it("a binder's hunt still hides the box copy: the card reads as not in your binders", async () => {
    renderAt("/collection?tab=binders&b=binder-rainbow", makeStore({ boxCopies: [BOX_JUDGE] }));
    await huntFor("Hunt for one of your cards", "judge");
    expect(screen.getByRole("list", { name: "Not in your binders yet" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "In your binders" })).toBeNull();
    expect(screen.queryByRole("list", { name: "In your binders and boxes" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /in Show box|, for sale$/ })).toHaveLength(0);
  });
});

describe("Inventory is on for the real collection (NEO-364)", () => {
  const sections = (name: string) => within(screen.getByRole("navigation", { name }));

  it("has no Inventory tab beside the collection's: tab=inventory goes to My Boxes on /inventory, in place", () => {
    renderAt("/collection?tab=inventory");
    expect(pageUrl()).toBe("/inventory?tab=boxes");
    expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeTruthy();
    expect(sections("Inventory sections").getByRole("link", { name: "My Boxes" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("list", { name: "Your boxes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New box" })).toBeTruthy();
  });

  it("the collection's tabs are My Cards, My Binders, Checklists and Add cards, never Inventory", () => {
    renderAt("/collection");
    expect(sections("Collection sections").getAllByRole("link").map((l) => l.textContent)).toEqual([
      "My Cards",
      "My Binders",
      "Checklists",
      "Add cards",
    ]);
  });

  it("the inventory's tabs are Inventory, My Boxes, Checklists and Add cards, with the list the default", () => {
    renderAt("/inventory");
    expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeTruthy();
    const tabs = sections("Inventory sections").getAllByRole("link");
    expect(tabs.map((l) => l.textContent)).toEqual(["Inventory", "My Boxes", "Checklists", "Add cards"]);
    expect(tabs[0].getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeTruthy();
    expect(document.title).toBe("Inventory");
  });

  it("the shelf's Inventory long box leads to the Inventory list on /inventory", () => {
    renderAt("/collection?tab=binders");
    const door = screen.getByRole("link", { name: /^Inventory, \d+ cards? for sale$/ });
    expect(door.getAttribute("href")).toBe("/inventory?tab=cards");
    fireEvent.click(door);
    expect(pageUrl()).toBe("/inventory?tab=cards");
    expect(screen.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeTruthy();
  });

  it("a box on the collection's URL opens on My Boxes, and the old for-sale view on the list, each in place", () => {
    renderAt("/collection?tab=binders&b=box-show");
    expect(screen.getByRole("region", { name: "Show box, open" })).toBeTruthy();
    expect(pageUrl()).toBe("/inventory?tab=boxes&b=box-show");
    cleanup();
    renderAt("/collection?tab=binders&sale=1");
    expect(screen.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeTruthy();
    expect(pageUrl()).toBe("/inventory?tab=cards");
  });

  it("the Inventory list shows the box copies the store holds, one item per card", () => {
    const inBox: Copy = { ...COPY_OHTANI, id: "copy-box", homeId: "box-show", homeKind: "box", homeName: "Show box", quantity: 3 };
    renderAt("/inventory", makeStore({ boxCopies: [inBox] }));
    const list = screen.getByRole("list", { name: /^Every box, / });
    expect(within(list).getByRole("button", { name: /^×3 .*Shohei Ohtani.*in Show box$/ })).toBeTruthy();
  });

  it("the drawer's Sell puts a binder copy into a box (Unsorted first); a box copy has Take off sale instead", () => {
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).queryByRole("button", { name: /off sale$/ })).toBeNull();
    // Move stays binder to binder.
    fireEvent.click(within(drawer).getByRole("button", { name: "Move #1 Shohei Ohtani, Raw" }));
    const to = within(within(drawer).getByRole("form", { name: "Move Raw" })).getByRole("combobox", { name: "Move to" });
    expect(within(to).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ohtani rainbow"]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Keep it here" }));
    // Sell goes to a box, and Unsorted is always there.
    fireEvent.click(within(drawer).getByRole("button", { name: "Sell #1 Shohei Ohtani, Raw" }));
    const into = within(within(drawer).getByRole("form", { name: "Sell Raw" })).getByRole("combobox", { name: "Into which box" });
    expect(within(into).getAllByRole("option").map((o) => o.textContent)).toEqual(["Unsorted", "Show box"]);
  });

  it("a Sell the listing gate refuses says the gate's own words on the status line, and the copy stays where it was (NEO-370)", async () => {
    const store = makeStore();
    store.actions.moveCopy.mockRejectedValueOnce(
      Object.assign(new Error("[Request ID: x] Server Error"), { data: { code: "LISTING_NEEDS_DETAILS", message: GATE_WORDS } }),
    );
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "Sell #1 Shohei Ohtani, Raw" }));
    const form = within(drawer).getByRole("form", { name: "Sell Raw" });
    fireEvent.change(within(form).getByRole("combobox", { name: "Into which box" }), { target: { value: "box-show" } });
    // NEO-479: no common price for the card, so Sell needs one of its own.
    fireEvent.change(within(form).getByRole("textbox", { name: "Price" }), { target: { value: "1.50" } });
    fireEvent.submit(form);
    await waitFor(() => expect(store.actions.moveCopy).toHaveBeenCalledWith(COPY_OHTANI, "box-show", { minPrice: 1.5 }));
    await waitFor(() => expect(within(drawer).getAllByRole("status").some((s) => s.textContent === GATE_WORDS)).toBe(true));
    expect(within(drawer).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(drawer).queryByText(/up for sale in/)).toBeNull();
  });

  it("an undo the listing gate refuses (a removed line put back into a listed box) says why on the status line, never Undone. (NEO-370)", async () => {
    const store = makeStore();
    store.undo.mockImplementationOnce(async () => {
      throw Object.assign(new Error("[Request ID: x] Server Error"), { data: { code: "LISTING_NEEDS_DETAILS", message: GATE_WORDS } });
    });
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove #1 Shohei Ohtani, Raw" }));
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Undo" })).toBeTruthy());
    fireEvent.click(within(drawer).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(within(drawer).getAllByRole("status").some((s) => s.textContent === `That undo didn't go through. ${GATE_WORDS}`)).toBe(true),
    );
    expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "Undone.")).toBe(false);
  });

  it("Move here into an open box the listing gate refuses says the gate's words on the status line (NEO-370)", async () => {
    // The Inventory side hunts what the boxes hold: a card in Unsorted, moved into the open Show box.
    const inUnsorted: Copy = { ...COPY_OHTANI, id: "copy-unsorted", homeId: "box-unsorted", homeKind: "box", homeName: "Unsorted" };
    const store = makeStore({ boxCopies: [inUnsorted] });
    store.actions.moveCopy.mockRejectedValueOnce(
      Object.assign(new Error("[Request ID: x] Server Error"), { data: { code: "LISTING_NEEDS_DETAILS", message: GATE_WORDS } }),
    );
    renderAt("/inventory?tab=boxes&b=box-show", store);
    fireEvent.change(screen.getByRole("searchbox", { name: "Hunt for one of your cards" }), { target: { value: "ohtani" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Move here: .*Shohei Ohtani/ }));
    await waitFor(() => expect(store.actions.moveCopy).toHaveBeenCalledWith(inUnsorted, "box-show", {}));
    await waitFor(() => expect(statuses()).toContain(GATE_WORDS));
    expect(statuses().some((t) => t?.startsWith("Moved "))).toBe(false);
  });

  it("the collection's checklists never show a quantity field: Have / Want / Trade stay", () => {
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    expect(screen.getAllByRole("button", { name: /^Have #/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: /^Quantity of / })).toBeNull();
  });

  describe("a store with Inventory off keeps the old behaviour", () => {
    const OFF: Capabilities = { ...REAL_CAPABILITIES, inventory: false };

    it("a box on the URL just shows the shelf, and stays put", () => {
      renderAt("/collection?tab=binders&b=box-show", makeStore({ capabilities: OFF }));
      expect(screen.queryByRole("region", { name: "Show box, open" })).toBeNull();
      expect(screen.getByRole("list", { name: "Your binders" })).toBeTruthy();
      expect(pageUrl()).toBe("/collection?tab=binders&b=box-show");
    });

    it("the long box still leads to the app's inventory address", () => {
      renderAt("/collection?tab=binders", makeStore({ capabilities: OFF }));
      expect(screen.getByRole("link", { name: /^Inventory, \d+ cards? for sale$/ }).getAttribute("href")).toBe("/inventory");
    });
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/** NEO-370 — a listing half whose reads are still loading: enough to open the Sales and Sync status tabs. */
const LISTING: ListingExtension = {
  useSettings: () => undefined,
  syncVariant: vi.fn(async () => ({ queued: true })),
  setContainerListed: vi.fn(async () => {}),
  useSyncStatus: () => ({ platforms: [] }),
  loadSetProblems: vi.fn(async () => ({ problems: [], problemsTotal: 0 })),
  useSales: () => ({ sales: [], canLoadMore: false, loadingMore: false, loadMore: () => {} }),
  useGate: () => undefined,
};

const inventoryTabs = () =>
  within(screen.getByRole("navigation", { name: "Inventory sections" }))
    .getAllByRole("link")
    .map((l) => l.textContent);

describe("the Sales tab (NEO-370)", () => {
  it("a store with a listing extension ends the inventory's tabs with Sales, then Sync status", () => {
    renderAt("/inventory", makeStore({ listing: LISTING }));
    const names = inventoryTabs();
    expect(names.slice(-2)).toEqual(["Sales", "Sync status"]);
    expect(names).toContain("Add cards");
  });

  it("Sync status is deep-linkable (?tab=sync), and /collection?tab=sync goes there", async () => {
    renderAt("/collection?tab=sync", makeStore({ listing: LISTING }));
    await waitFor(() => expect(pageUrl()).toBe("/inventory?tab=sync"));
    expect(await screen.findByText(/^No marketplaces hooked up yet\./)).toBeTruthy();
    const link = within(screen.getByRole("navigation", { name: "Inventory sections" })).getByRole("link", {
      name: "Sync status",
    });
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("/collection?tab=sales goes to the inventory's Sales tab", async () => {
    renderAt("/collection?tab=sales", makeStore({ listing: LISTING }));
    await waitFor(() => expect(pageUrl()).toBe("/inventory?tab=sales"));
    expect(await screen.findByRole("heading", { level: 2, name: "What sold" })).toBeTruthy();
  });

  it("without a listing extension the tabs are absent", () => {
    renderAt("/inventory", makeStore());
    expect(inventoryTabs()).not.toContain("Sales");
    expect(inventoryTabs()).not.toContain("Sync status");
  });

  it("without a listing extension, tab=sales renders no Sales content and opens the first tab", () => {
    renderAt("/inventory?tab=sales", makeStore());
    expect(screen.queryByRole("list", { name: "Orders, newest first" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What sold" })).toBeNull();
    expect(inventoryTabs()).not.toContain("Sales");
  });

  it("an open box carries Listed on marketplaces; a binder never does", async () => {
    renderAt("/inventory?tab=boxes&b=box-show", makeStore({ listing: LISTING }));
    const toggle = (await screen.findByRole("checkbox", { name: "Listed on marketplaces" })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(LISTING.setContainerListed).toHaveBeenCalledWith("box-show", false);
    cleanup();
    renderAt("/collection?tab=binders&b=binder-rainbow", makeStore({ listing: LISTING }));
    await screen.findByRole("heading", { level: 2, name: "Ohtani rainbow" });
    expect(screen.queryByRole("checkbox", { name: "Listed on marketplaces" })).toBeNull();
  });

  it("without a listing half (the demo's case) an open box has no Listed on marketplaces", async () => {
    renderAt("/inventory?tab=boxes&b=box-show", makeStore());
    await screen.findByRole("heading", { level: 2, name: "Show box" });
    expect(screen.queryByRole("checkbox", { name: "Listed on marketplaces" })).toBeNull();
  });

  it("the flag alone is not enough: capabilities on but no listing half still hides the tab", () => {
    renderAt("/inventory", makeStore({ capabilities: { ...REAL_CAPABILITIES, marketplaceListing: true } }));
    expect(inventoryTabs()).not.toContain("Sales");
  });
});
