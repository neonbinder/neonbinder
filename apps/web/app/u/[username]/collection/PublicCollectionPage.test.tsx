/**
 * NEO-360 — the public share pages: one not-found for every null, and
 * `noindex` while open. NEO-444 — a shared binder is the real binder, read-only,
 * and a card pops out into a top loader.
 */

import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";

const queries = vi.hoisted(() => ({
  binder: undefined as unknown,
  needs: undefined as unknown,
  shelf: undefined as unknown,
  copies: [] as unknown[],
  status: "Exhausted",
  loadMore: (() => undefined) as (n: number) => void,
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = String((ref as { _name?: string })?._name ?? ref);
    if (name.includes("binderNeeds")) return queries.needs;
    if (name.includes("binder")) return queries.binder;
    if (name.includes("shelf")) return queries.shelf;
    return null;
  },
  usePaginatedQuery: () => ({ results: queries.copies, status: queries.status, loadMore: queries.loadMore }),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    publicCollection: {
      binder: "publicCollection:binder",
      binderCopies: "publicCollection:binderCopies",
      binderNeeds: "publicCollection:binderNeeds",
      shelf: "publicCollection:shelf",
      wantList: "publicCollection:wantList",
      trade: "publicCollection:trade",
      forSale: "publicCollection:forSale",
    },
    publicProfile: { getPublicProfileByUsername: "publicProfile:getPublicProfileByUsername" },
  },
}));

import { PublicBinderPage, PublicTradePage, PublicWantListPage } from "./PublicCollectionPage";

/** Where the router is, and a way to press the browser's Back. */
const router: { search: string; back: () => void } = { search: "", back: () => undefined };
function RouterProbe() {
  const { search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    router.search = search;
    router.back = () => void navigate(-1);
  });
  return null;
}

function renderAt(path: string) {
  render(
    <Theme>
      <MemoryRouter initialEntries={[path]}>
        <RouterProbe />
        <Routes>
          <Route path="/u/:username/binders/:path" element={<PublicBinderPage />} />
          <Route path="/u/:username/want-list" element={<PublicWantListPage />} />
          <Route path="/u/:username/up-for-trade" element={<PublicTradePage />} />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

/** The wide desk or the phone; reduced motion always, so a card opens at once. */
function setScreen({ wide }: { wide: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduced-motion") || (wide && query.includes("min-width")),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

const CARD = {
  _id: "card1",
  cardNumber: "1",
  cardName: "Dwight Gooden",
  sortOrder: 0,
  variantId: "v1",
  features: [],
  listingTitle: "1985 Topps #1 Dwight Gooden",
  players: [{ _id: "p1", name: "Dwight Gooden" }],
  teams: [],
  set: { _id: "s1", name: "Topps", season: "1985", sport: null, year: null, manufacturer: null },
  variant: {
    _id: "v1",
    level: "variantType",
    name: "Base",
    kind: "base",
    variantType: null,
    insert: null,
    parallel: null,
    cardCount: 1,
    baseCardCount: 1,
  },
};

beforeEach(() => {
  queries.binder = undefined;
  queries.needs = undefined;
  queries.shelf = undefined;
  queries.copies = [];
  queries.status = "Exhausted";
  queries.loadMore = () => undefined;
  setScreen({ wide: false });
});

const BINDER_URL = "/u/ace/binders/ohtani-rainbow-k7f3q2";
const LABEL = "1985 Topps #1 Dwight Gooden";
const FRONT = { imageUrl: "https://img.test/front.jpg", thumbUrl: "https://img.test/front-thumb.jpg" };
const BACK = { imageUrl: "https://img.test/back.jpg", thumbUrl: "https://img.test/back-thumb.jpg" };

function shareBinder(copies: unknown[], header: Record<string, unknown> = {}) {
  queries.binder = { name: "Ohtani rainbow", count: { copies: copies.length, lines: copies.length }, ...header };
  queries.copies = copies;
}

/** A filled pocket's button, by the start of its name. */
const pocket = (name: string | RegExp = LABEL) =>
  screen.getByRole("button", { name: typeof name === "string" ? new RegExp(`^${name}`) : name });

describe("public share pages", () => {
  it("a private, mistyped or missing binder all show the same not-found", () => {
    queries.binder = null;
    renderAt("/u/ace/binders/ohtani-rainbow-k7f3q2");
    expect(screen.getByRole("heading", { name: "Nothing to see here" })).toBeTruthy();
    expect(screen.getByText(/This page is private, or the link isn't quite right/)).toBeTruthy();
  });

  it("a bad username is not-found without asking the server", () => {
    queries.binder = { name: "Should not show", count: null };
    renderAt("/u/NOT%20OK/binders/ohtani-rainbow-k7f3q2");
    expect(screen.getByRole("heading", { name: "Nothing to see here" })).toBeTruthy();
    expect(screen.queryByText("Should not show")).toBeNull();
  });

  it("a private shelf is not-found; a public one lists its cards", () => {
    queries.shelf = null;
    renderAt("/u/ace/want-list");
    expect(screen.getByRole("heading", { name: "Nothing to see here" })).toBeTruthy();
    expect(document.title).toBe("Nothing to see here · NeonBinder");
  });

  it("a collector's own card shows, marked as not in the catalog (NEO-361)", () => {
    queries.shelf = { count: { copies: 1, lines: 1 } };
    queries.copies = [
      {
        key: "u1",
        quantity: 1,
        upForTrade: true,
        unlisted: {
          cardNumber: "77",
          player: "Rookie Nobody",
          set: null,
          variant: null,
          variantName: "Gold Foil",
          requestedSet: { sport: null, year: "1996", brand: "Playoff", name: "Contenders" },
        },
      },
    ];
    renderAt("/u/ace/up-for-trade");
    expect(screen.getAllByText(/Rookie Nobody/).length).toBeGreaterThan(0);
    expect(screen.getByText("Not in the NeonBinder catalog")).toBeTruthy();
    expect(screen.getAllByText("Unlisted").length).toBeGreaterThan(0);
  });

  it("Up for Trade tags a box copy as also for sale", () => {
    queries.shelf = { count: { copies: 1, lines: 1 } };
    queries.copies = [{ key: "a", quantity: 1, upForTrade: true, forSale: true, card: CARD }];
    renderAt("/u/ace/up-for-trade");
    expect(screen.getByRole("heading", { name: "Up for Trade" })).toBeTruthy();
    expect(screen.getByText("Also for sale")).toBeTruthy();
  });

  it("NEO-367: a tile shows the catalog card's Notes, and nothing when it has none", () => {
    queries.shelf = { count: { copies: 2, lines: 2 } };
    queries.copies = [
      { key: "a", quantity: 1, upForTrade: true, card: { ...CARD, notes: "Short print, about 1:120 packs" } },
      { key: "b", quantity: 1, upForTrade: true, card: { ...CARD, _id: "card2", cardNumber: "2" } },
    ];
    renderAt("/u/ace/up-for-trade");
    expect(screen.getAllByText("Short print, about 1:120 packs")).toHaveLength(1);
  });

  it("carries noindex while open", () => {
    queries.shelf = { count: null };
    renderAt("/u/ace/up-for-trade");
    expect(document.head.querySelector('meta[name="robots"][content="noindex"]')).not.toBeNull();
  });
});

describe("a shared binder is the real binder (NEO-444)", () => {
  it("draws a page of nine pockets: filled with the grade and Trade cue, the rest inert", () => {
    shareBinder([
      { key: "a", quantity: 2, condition: "Near Mint", grading: { grader: "PSA", grade: "10" }, slot: 4, upForTrade: true, card: CARD },
    ]);
    renderAt(BINDER_URL);
    expect(screen.getByRole("heading", { level: 1, name: "Ohtani rainbow" })).toBeTruthy();
    const page = screen.getByRole("group", { name: "Page 1" });
    expect(within(page).getAllByText("Empty pocket")).toHaveLength(8);
    // The one thing on the page to press is the one card, and the page's turn buttons.
    expect(within(page).getAllByRole("button")).toHaveLength(1);
    expect(pocket().getAttribute("aria-label")).toContain("PSA 10");
    expect(within(page).getByText("PSA 10")).toBeTruthy();
    expect(within(page).getByText("×2")).toBeTruthy();
    expect(within(page).getByText("Trade")).toBeTruthy();
    expect(screen.getByText("Page 1 of 1")).toBeTruthy();
  });

  it("shows no owner's action anywhere", () => {
    shareBinder([{ key: "a", quantity: 1, slot: 0, card: CARD }], { layout: { emptySlots: false, smart: true } });
    renderAt(BINDER_URL);
    const text = document.body.textContent ?? "";
    for (const word of ["Fill", "Add it", "Outside the rule", "Rename or delete", "Binder settings", "Print label", "Share", "Alt plus"]) {
      expect(text).not.toContain(word);
    }
    expect(pocket().getAttribute("aria-keyshortcuts")).toBeNull();
    expect(pocket().getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("nb-pocket-move-hint")).toBeNull();
  });

  it("keeps real page numbers, and a slotless copy goes after the last filled pocket", () => {
    shareBinder([
      { key: "loose", quantity: 1, card: { ...CARD, _id: "card2", cardNumber: "2", listingTitle: "x", players: [{ _id: "p2", name: "Loose Copy" }] } },
      { key: "a", quantity: 1, slot: 0, card: CARD },
      { key: "far", quantity: 1, slot: 19, card: { ...CARD, _id: "card3", cardNumber: "3", players: [{ _id: "p3", name: "Far Page" }] } },
    ]);
    renderAt(BINDER_URL);
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(router.search).toBe("?page=2");
    expect(within(screen.getByRole("group", { name: "Page 2" })).getAllByText("Empty pocket")).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const third = screen.getByRole("group", { name: "Page 3" });
    expect(within(third).getByRole("button", { name: /Far Page.*pocket 2 on page 3/ })).toBeTruthy();
    expect(within(third).getByRole("button", { name: /Loose Copy.*pocket 3 on page 3/ })).toBeTruthy();
  });

  it("never loses a copy whose pocket is already taken", () => {
    shareBinder([
      { key: "a", quantity: 1, slot: 0, card: CARD },
      { key: "b", quantity: 1, slot: 0, card: { ...CARD, _id: "card2", cardNumber: "2", players: [{ _id: "p2", name: "Second Copy" }] } },
    ]);
    renderAt(BINDER_URL);
    expect(screen.getByRole("button", { name: /Second Copy.*pocket 2 on page 1/ })).toBeTruthy();
  });

  it("reads every page before drawing the binder, with no Show more", () => {
    const loadMore = vi.fn();
    queries.status = "CanLoadMore";
    queries.loadMore = loadMore;
    shareBinder([{ key: "a", quantity: 1, slot: 0, card: CARD }]);
    renderAt(BINDER_URL);
    expect(loadMore).toHaveBeenCalledWith(60);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /open$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("an empty binder says so, and draws no binder", () => {
    shareBinder([], { description: "Every Ohtani" });
    renderAt(BINDER_URL);
    expect(screen.getByText("This binder is empty for now.")).toBeTruthy();
    expect(screen.getByText("Every Ohtani")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /open$/ })).toBeNull();
  });

  it("a sorted binder with shared empty slots shows a need pocket that does nothing", () => {
    const need = { ...CARD, _id: "card9", cardNumber: "9", players: [{ _id: "p9", name: "Need Ninety" }] };
    shareBinder([{ key: "a", quantity: 1, card: CARD }], { layout: { sort: "checklist", emptySlots: true, smart: false } });
    queries.needs = { needs: [{ card: need }], supported: true, truncated: false };
    renderAt(BINDER_URL);
    expect(screen.getByText(/Need Ninety.*this binder still needs it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Need Ninety/ })).toBeNull();
    expect(pocket()).toBeTruthy();
  });

  it("an unsorted binder keeps its Still needs section below the binder", () => {
    const need = { ...CARD, _id: "card9", cardNumber: "9", players: [{ _id: "p9", name: "Need Ninety" }] };
    shareBinder([{ key: "a", quantity: 1, slot: 0, card: CARD }], { layout: { emptySlots: true, smart: true } });
    queries.needs = { needs: [{ card: need }], supported: true, truncated: false };
    renderAt(BINDER_URL);
    expect(screen.getByRole("heading", { level: 2, name: "Still needs" })).toBeTruthy();
    expect(screen.getAllByText(/Need Ninety/).length).toBeGreaterThan(0);
  });

  it("a pocket shows that copy's own photo, not another copy's of the same card", () => {
    shareBinder([
      { key: "a", quantity: 1, slot: 0, card: CARD, photos: { front: FRONT } },
      { key: "b", quantity: 1, slot: 1, card: CARD },
    ]);
    renderAt(BINDER_URL);
    expect(pocket(/pocket 1 on page 1/).querySelector("img")?.getAttribute("src")).toBe(FRONT.thumbUrl);
    expect(pocket(/pocket 2 on page 1/).querySelector("img")).toBeNull();
  });

  it.each([
    ["stored", {}],
    ["sorted", { layout: { sort: "checklist", emptySlots: false, smart: false } }],
  ])("a %s binder skips a copy with no card to draw", (_kind, header) => {
    shareBinder(
      [
        { key: "none", quantity: 1, slot: 0 },
        { key: "a", quantity: 1, slot: 1, card: CARD },
      ],
      header,
    );
    renderAt(BINDER_URL);
    expect(within(screen.getByRole("group", { name: "Page 1" })).getAllByRole("button")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("No longer in the catalog");
  });

  it("on a wide screen: the spread, its inside cover with no owner's controls, and PageDown", () => {
    setScreen({ wide: true });
    shareBinder(
      [
        { key: "a", quantity: 1, slot: 0, card: CARD },
        { key: "far", quantity: 1, slot: 9, card: CARD },
      ],
      { description: "Every Ohtani" },
    );
    renderAt(BINDER_URL);
    expect(screen.getByText("Inside cover and page 1 of 2")).toBeTruthy();
    const binder = screen.getByRole("region", { name: "Ohtani rainbow, open" });
    expect(within(binder).getByText("Every Ohtani")).toBeTruthy();
    expect(within(binder).getByText("2 cards")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rename|settings|label/i })).toBeNull();
    fireEvent.keyDown(document.body, { key: "PageDown" });
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(router.search).toBe("?page=2");
    fireEvent.keyDown(document.body, { key: "PageUp" });
    expect(screen.getByText("Inside cover and page 1 of 2")).toBeTruthy();
    expect(router.search).toBe("");
  });

  it("a pasted link opens on its page", () => {
    shareBinder([
      { key: "a", quantity: 1, slot: 0, card: CARD },
      { key: "far", quantity: 1, slot: 9, card: CARD },
    ]);
    renderAt(`${BINDER_URL}?page=2`);
    expect(screen.getByRole("group", { name: "Page 2" })).toBeTruthy();
  });
});

describe("the top loader (NEO-444)", () => {
  const COPY = {
    key: "a",
    quantity: 3,
    condition: "Near Mint",
    grading: { grader: "PSA", grade: "10" },
    slot: 0,
    upForTrade: true,
    forSale: true,
    card: { ...CARD, notes: "Short print, about 1:120 packs" },
    photos: { front: FRONT, back: BACK },
  };

  it("pops the card out with its title and everything the tile showed, in the URL", () => {
    shareBinder([COPY]);
    renderAt(BINDER_URL);
    fireEvent.click(pocket());
    expect(router.search).toBe("?card=a");
    const dialog = screen.getByRole("dialog", { name: new RegExp(`^${LABEL}`) });
    expect(within(dialog).getByRole("heading", { level: 2, name: new RegExp(`^${LABEL}`) })).toBeTruthy();
    expect(within(dialog).getByText("PSA 10")).toBeTruthy();
    expect(within(dialog).getByText("×3")).toBeTruthy();
    expect(within(dialog).getByText("Trade")).toBeTruthy();
    expect(within(dialog).getByText("Also for sale")).toBeTruthy();
    expect(within(dialog).getByText("Short print, about 1:120 packs")).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: new RegExp(`^${LABEL}`) }).getAttribute("src")).toBe(FRONT.imageUrl);
    expect(within(dialog).getByRole("link", { name: /See it full size/ }).getAttribute("href")).toBe(FRONT.imageUrl);
  });

  it("See the back shows the back photo, and See the front returns", () => {
    shareBinder([COPY]);
    renderAt(BINDER_URL);
    fireEvent.click(pocket());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "See the back" }));
    expect(within(dialog).getByRole("img", { name: /the back$/ }).getAttribute("src")).toBe(BACK.imageUrl);
    expect(within(dialog).getByRole("link", { name: /See it full size/ }).getAttribute("href")).toBe(BACK.imageUrl);
    fireEvent.click(within(dialog).getByRole("button", { name: "See the front" }));
    expect(within(dialog).getByRole("img", { name: new RegExp(`^${LABEL}`) }).getAttribute("src")).toBe(FRONT.imageUrl);
  });

  it("with no photo it draws the card; with only one side there is no flip", () => {
    shareBinder([{ key: "a", quantity: 1, slot: 0, card: CARD }]);
    renderAt(BINDER_URL);
    fireEvent.click(pocket());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img", { name: new RegExp(`^${LABEL}`) }).tagName).toBe("DIV");
    expect(within(dialog).queryByRole("button", { name: "See the back" })).toBeNull();
    expect(within(dialog).queryByRole("link", { name: /full size/ })).toBeNull();
  });

  it("marks a collector's own card as not in the catalog, and never shows a copy's own notes", () => {
    shareBinder([
      {
        key: "u1",
        quantity: 1,
        slot: 0,
        notes: "Paid too much for this",
        unlisted: {
          cardNumber: "77",
          player: "Rookie Nobody",
          set: null,
          variant: null,
          requestedSet: { sport: null, year: "1996", brand: "Playoff", name: "Contenders" },
        },
      },
    ]);
    renderAt(BINDER_URL);
    fireEvent.click(pocket(/Rookie Nobody/));
    expect(within(screen.getByRole("dialog")).getByText("Not in the NeonBinder catalog")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Paid too much");
  });

  it.each([
    ["Escape", () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })],
    ["the close button", () => fireEvent.click(screen.getByRole("button", { name: "Close the top loader" }))],
    ["the backdrop", () => fireEvent.click(screen.getByRole("dialog").previousElementSibling!)],
    ["Back", () => act(() => router.back())],
  ])("%s puts it down and hands focus back to the pocket", (_how, close) => {
    shareBinder([COPY]);
    renderAt(BINDER_URL);
    const opener = pocket();
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    close();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.search).toBe("");
    expect(document.activeElement).toBe(pocket());
  });

  it("a shared link opens the card on its page; closing stays there", () => {
    shareBinder([
      { key: "a", quantity: 1, slot: 0, card: CARD },
      { key: "far", quantity: 1, slot: 9, card: { ...CARD, _id: "card3", cardNumber: "3", players: [{ _id: "p3", name: "Far Page" }] } },
    ]);
    renderAt(`${BINDER_URL}?card=far`);
    expect(screen.getByRole("dialog", { name: /Far Page/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.search).toBe("?page=2");
    expect(screen.getByRole("group", { name: "Page 2" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Far Page/ }));
  });

  it("a card key that isn't in this binder opens nothing", () => {
    shareBinder([COPY]);
    renderAt(`${BINDER_URL}?card=nope`);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pocket()).toBeTruthy();
  });

  it("PageDown does not turn the binder behind an open card", () => {
    shareBinder([
      { key: "a", quantity: 1, slot: 0, card: CARD },
      { key: "far", quantity: 1, slot: 9, card: CARD },
    ]);
    renderAt(BINDER_URL);
    fireEvent.click(pocket(/pocket 1 on page 1/));
    fireEvent.keyDown(document.body, { key: "PageDown" });
    expect(router.search).toBe("?card=a");
  });
});
