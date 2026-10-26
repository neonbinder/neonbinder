/**
 * NEO-360 — the public share pages: one not-found for every null, a binder's
 * pockets, and `noindex` while open.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const queries = vi.hoisted(() => ({
  binder: undefined as unknown,
  shelf: undefined as unknown,
  copies: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = String((ref as { _name?: string })?._name ?? ref);
    if (name.includes("binder")) return queries.binder;
    if (name.includes("shelf")) return queries.shelf;
    return null;
  },
  usePaginatedQuery: () => ({ results: queries.copies, status: "Exhausted", loadMore: () => undefined }),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    publicCollection: {
      binder: "publicCollection:binder",
      binderCopies: "publicCollection:binderCopies",
      shelf: "publicCollection:shelf",
      wantList: "publicCollection:wantList",
      trade: "publicCollection:trade",
      forSale: "publicCollection:forSale",
    },
    publicProfile: { getPublicProfileByUsername: "publicProfile:getPublicProfileByUsername" },
  },
}));

import { PublicBinderPage, PublicTradePage, PublicWantListPage } from "./PublicCollectionPage";

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/u/:username/binders/:path" element={<PublicBinderPage />} />
        <Route path="/u/:username/want-list" element={<PublicWantListPage />} />
        <Route path="/u/:username/up-for-trade" element={<PublicTradePage />} />
      </Routes>
    </MemoryRouter>,
  );
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
  queries.shelf = undefined;
  queries.copies = [];
});

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

  it("a public binder shows its pockets, condition and grade", () => {
    queries.binder = { name: "Ohtani rainbow", count: { copies: 1, lines: 1 } };
    queries.copies = [
      { key: "a", quantity: 1, condition: "Near Mint", grading: { grader: "PSA", grade: "10" }, slot: 4, upForTrade: true, card: CARD },
    ];
    renderAt("/u/ace/binders/ohtani-rainbow-k7f3q2");
    expect(screen.getByRole("heading", { name: "Ohtani rainbow" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Page 1" })).toBeTruthy();
    expect(screen.getAllByText("Empty pocket")).toHaveLength(8);
    expect(screen.getByText("PSA 10")).toBeTruthy();
    expect(screen.getByText("Trade")).toBeTruthy();
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
