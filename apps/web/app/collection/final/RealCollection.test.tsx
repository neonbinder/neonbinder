import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Theme } from "@radix-ui/themes";
import FinalCollectionPage from "./FinalCollectionPage";
import { cardLabel } from "./data/labels";
import { CollectionStoreContext, completionOf, type CollectionActions, type CollectionData, type CollectionStoreValue } from "./data/store";
import { NO_CAPABILITIES, type Card, type Copy, type DrillItem, type EntityPick, type SetRef, type Suggestion, type Variant } from "./data/types";

/**
 * NEO-358 — signed-in `/collection` on a store shaped like the real one:
 * `kind: "convex"`, every capability off, reads that can be `undefined`, and
 * writes that resolve with an undo. The store here is hand-built over a tiny
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
  quantity: 1,
  acquiredAt: "2026-10-01",
  notes: "",
};
const COPY_GOLD: Copy = { ...COPY_OHTANI, id: "copy-2", cardId: OHTANI_GOLD.id, variantId: GOLD.id };

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
function makeStore({ loading = false }: { loading?: boolean } = {}) {
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
  } satisfies CollectionActions;
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
    useSummary: () => L({ copies: 2, cards: 2 }),
    // Newest first: the Gold Refractor was the last Have.
    useOwnedCards: () =>
      L({
        cards: [OHTANI_GOLD, CARDS.find((c) => c.id === COPY_OHTANI.cardId)!],
        copiesByCard: { [OHTANI_GOLD.id]: { quantity: 1, lines: 1 }, [COPY_OHTANI.cardId]: { quantity: 1, lines: 1 } },
        total: 2,
        goneCardIds: [],
        truncated: false,
      }),
  };
  const value: CollectionStoreValue = { kind: "convex", capabilities: NO_CAPABILITIES, data, actions };
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

describe("My Cards on the real collection", () => {
  it("opens Base on the board and loads another checklist's cards only when asked", () => {
    const { log } = renderAt("/collection");
    expect(screen.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeTruthy();
    expect(log.variantCards).toContain(BASE.id);
    expect(log.variantCards).not.toContain(GOLD.id);

    fireEvent.click(screen.getByRole("button", { name: "Show the Gold Refractor cards of 2024 Topps Chrome" }));
    expect(log.variantCards).toContain(GOLD.id);
  });

  it("shows the demo's binder shelf nowhere; a tally of the collection instead", () => {
    renderAt("/collection");
    expect(screen.getByRole("heading", { level: 2, name: "Everything I own" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Shelves and binders" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Binder" })).toBeNull();
  });

  it("lists every card I own under the tally, newest first, each opening the drawer", () => {
    renderAt("/collection");
    const list = screen.getByRole("list", { name: "Everything I own, 2 cards" });
    const cards = within(list).getAllByRole("button");
    expect(cards.map((b) => b.getAttribute("aria-label"))).toEqual([
      `${cardLabel(OHTANI_GOLD)}, have`,
      `${cardLabel(CARDS.find((c) => c.id === COPY_OHTANI.cardId)!)}, have`,
    ]);
    fireEvent.click(cards[0]);
    expect(within(screen.getByRole("dialog")).getByRole("img", { name: new RegExp(`^${escapeRe(cardLabel(OHTANI_GOLD))}`) })).toBeTruthy();
  });

  it("shows skeletons, never an empty board, while the reads are in flight", () => {
    renderAt("/collection", makeStore({ loading: true }));
    expect(statuses()).toContain("Firing up the scoreboard…");
    expect(screen.queryByText("Nothing on the board yet. Pick a set and light it up.")).toBeNull();
  });

  it("a wall's checklists fold until opened, Base first", () => {
    const { log } = renderAt(`/collection?tab=cards&set=${SET.id}`);
    expect(screen.getByRole("group", { name: "2024 Topps Chrome checklist wall" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the Gold Refractor tiles" }).getAttribute("aria-expanded")).toBe("false");
    expect(log.variantCards).not.toContain(GOLD.id);
    expect(screen.getByRole("button", { name: "Base #2 Aaron Judge, need" })).toBeTruthy();
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

  it("Have adds through the store and offers Undo; rows carry no Want or Trade", async () => {
    const { actions, undo } = renderAt(`/collection?tab=checklists&set=${SET.id}&type=vt-base`);
    expect(screen.getByText(/Have/, { selector: "p" }).textContent).toContain("Have 1 of 3");
    expect(screen.queryByRole("button", { name: /^Want / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Trade / })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Have #2 Aaron Judge" }));
    expect(actions.addHave).toHaveBeenCalledWith(JUDGE);
    await waitFor(() => expect(statuses()).toContain("Added #2 Aaron Judge to your collection"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
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
    const which = screen.getByRole("group", { name: "Which teams" });
    expect(within(which).getByRole("button", { name: "Just this team" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(which).getByRole("button", { name: "Include the whole franchise" }));
    await waitFor(() => expect(pageUrl()).toBe("/collection?tab=checklists&team=tm-mets&franchise=fr-mets&whole=1"));
    expect(log.entity.at(-1)).toEqual({ kind: "team", id: "tm-mets", wholeFranchise: true });
    cleanup();

    renderAt("/collection?tab=checklists&team=tm-yankees");
    expect(screen.getByRole("region", { name: "Every New York Yankees card" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Which teams" })).toBeNull();
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
    const [, details] = actions.addLineItem.mock.calls[0] as unknown as [Card, Copy];
    expect(details.quantity).toBe(1);
    expect(details.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(details.demo).toBeUndefined();
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
      expect(within(drawer).getAllByRole("status").some((s) => s.textContent === "Removed #1 Shohei Ohtani, Raw")).toBe(true),
    );
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
