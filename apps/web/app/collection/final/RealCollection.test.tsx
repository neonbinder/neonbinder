import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";
import { cardLabel } from "./data/labels";
import { CollectionStoreContext, completionOf, type CollectionActions, type CollectionData, type CollectionStoreValue } from "./data/store";
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
 * `kind: "convex"`, `REAL_CAPABILITIES` (binders and boxes, wants, trade and
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
}: { loading?: boolean; capabilities?: Capabilities } = {}) {
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
    useCopiesOf: (id) => (id === null ? undefined : L([COPY_OHTANI, COPY_GOLD].filter((c) => c.cardId === id))),
    useCopiesInVariant: (id) => (id === null ? undefined : L([COPY_OHTANI, COPY_GOLD].filter((c) => c.variantId === id))),
    useSummary: () => L({ copies: 2, cards: 2, exact: true, offBuild: 0 }),
    useContainers: () => L(CONTAINERS),
    useContainerCopies: (id) =>
      id === null ? undefined : L({ copies: id === "main" ? [COPY_OHTANI, COPY_GOLD] : [], truncated: false }),
    useTradeCopies: () => L({ copies: [], truncated: false }),
    useWants: () => L(wants),
    useCopiesOfCards: (ids) =>
      ids === null
        ? undefined
        : L(Object.fromEntries(ids.map((id) => [id, [COPY_OHTANI, COPY_GOLD].filter((c) => c.cardId === id)]))),
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
  };
  const value: CollectionStoreValue = { kind: "convex", capabilities, data, actions };
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

  it("Have adds through the store and offers Undo", async () => {
    const { actions, undo } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    expect(screen.getByText(/Have/, { selector: "p" }).textContent).toContain("Have 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    expect(actions.addHave).toHaveBeenCalledWith(JUDGE);
    await waitFor(() => expect(statuses()).toContain("Added #2 Aaron Judge to Main"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
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
    renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`, store);
    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    await waitFor(() => expect(statuses()).toContain("That card is gone."));
  });

  it("waits for a pause in typing, then offers a player by his nickname and lists all his cards", async () => {
    const { log, actions } = renderAt("/collection?tab=checklists");
    fireEvent.change(searchBox(), { target: { value: "doc gooden" } });
    // Not asked yet: the box waits 300ms for a pause.
    expect(log.search.at(-1)).toBe("");
    const offer = await screen.findByRole("button", { name: "Every Dwight Gooden card, as Doc Gooden" });
    fireEvent.click(offer);
    expect(pageUrl()).toBe("/collection?tab=checklists&player=pl-gooden");
    const results = screen.getByRole("region", { name: "Every Dwight Gooden card" });
    fireEvent.click(within(results).getByRole("button", { name: `Have ${cardLabel(GOODEN)}` }));
    expect(actions.addHave).toHaveBeenCalledWith(GOODEN);
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
    fireEvent.click(within(drawer).getByRole("button", { name: "Add to collection" }));
    expect(actions.addLineItem).toHaveBeenCalledTimes(1);
    const [, details] = actions.addLineItem.mock.calls[0] as unknown as [Card, Copy & { homeId?: string }];
    expect(details.quantity).toBe(1);
    expect(details.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(details).not.toHaveProperty("demo");
    expect(details.homeId).toBe("main");
    await waitFor(() => expect(within(drawer).getAllByRole("status").some((s) => s.textContent?.startsWith("Added #2 Aaron Judge"))).toBe(true));
  });

  it("edits and removes a copy, each with Undo", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "Edit #1 Shohei Ohtani, Raw" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Save copy" }));
    expect(actions.updateCopy).toHaveBeenCalledTimes(1);
    await act(async () => {});
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove #1 Shohei Ohtani, Raw" }));
    expect(actions.removeCopy).toHaveBeenCalledWith(COPY_OHTANI);
    await waitFor(() =>
      expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "Removed #1 Shohei Ohtani, Raw · Main")).toBe(true),
    );
  });
});

describe("Inventory on the real collection (NEO-359)", () => {
  it("is the boxes and what is for sale, apart from the collection", () => {
    renderAt("/inventory");
    expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Collection sections" })).toBeNull();
    const boxes = screen.getByRole("list", { name: "Your boxes" });
    expect(within(boxes).getByRole("button", { name: "Show box, box, 0 cards for sale" })).toBeTruthy();
    expect(within(boxes).queryByRole("button", { name: /^Main,|^Ohtani rainbow,/ })).toBeNull();
    expect(screen.getByText("0 cards for sale in 1 box.")).toBeTruthy();
  });

  it("with no box yet, says nothing is for sale and how to start", () => {
    const store = makeStore();
    store.value.data.useContainers = () => CONTAINERS.filter((c) => c.kind !== "box");
    renderAt("/inventory", store);
    expect(screen.getByText("Nothing for sale yet.")).toBeTruthy();
    expect(screen.getByText(/press Sell/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "The whole stock" })).toBeNull();
    expect(screen.getByRole("button", { name: "New box" })).toBeTruthy();
  });

  it("New box makes a box, never a binder", async () => {
    const { actions } = renderAt("/inventory");
    fireEvent.click(screen.getByRole("button", { name: "New box" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Box name"), { target: { value: "Dime box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Put it on the shelf" }));
    await waitFor(() => expect(actions.createContainer).toHaveBeenCalledWith({ kind: "box", name: "Dime box" }));
  });

  it("the drawer's Sell puts a binder's copy in a box; its Move offers binders only", async () => {
    const { actions } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    fireEvent.click(screen.getByRole("button", { name: "Details for #1 Shohei Ohtani" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "Move #1 Shohei Ohtani, Raw" }));
    const to = within(within(drawer).getByRole("form", { name: "Move Raw" })).getByRole("combobox", { name: "Move to" });
    expect(within(to).getAllByRole("option").map((o) => o.textContent)).toEqual(["Ohtani rainbow"]);
    fireEvent.click(within(drawer).getByRole("button", { name: "Keep it here" }));

    fireEvent.click(within(drawer).getByRole("button", { name: "Sell #1 Shohei Ohtani, Raw" }));
    const panel = within(drawer).getByRole("form", { name: "Sell Raw" });
    expect(within(within(panel).getByRole("combobox", { name: "Into which box" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Show box",
    ]);
    fireEvent.click(within(panel).getByRole("button", { name: "Put it up for sale" }));
    await waitFor(() => expect(actions.moveCopy).toHaveBeenCalledWith(COPY_OHTANI, "box-show", undefined));
    await waitFor(() =>
      expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "#1 Shohei Ohtani is up for sale in Show box.")).toBe(true),
    );
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
