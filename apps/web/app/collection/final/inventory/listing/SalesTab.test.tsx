import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SalesTab from "./SalesTab";
import { BSC_ORDERS_URL } from "./copy";
import { PageApiContext, type PageApi } from "../../pageApi";
import {
  CollectionStoreContext,
  type CollectionData,
  type CollectionStoreValue,
  type ListingExtension,
} from "../../data/store";
import { REAL_CAPABILITIES, type Card, type CardId, type Sale, type SalesPage } from "../../data/types";

/**
 * NEO-370 — the Sales tab: the listing switch, then the collector's orders
 * newest first, a page at a time. The store is a stub; the card names come
 * from the store's `useCards`.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const GOODEN = {
  id: "c1",
  set: { id: "s1", name: "Topps", season: "1985", year: 1985, brand: { id: "b", name: "Topps" }, sport: { id: "sp", name: "Baseball" } },
  variant: { id: "v1", kind: "base", name: null },
  cardNumber: "620",
  players: [{ id: "p1", name: "Dwight Gooden" }],
  teams: [],
  printRun: null,
  features: [],
  cardVariation: null,
  isVariation: false,
  sortOrder: 1,
} as unknown as Card;

function sale(over: Partial<Sale> & Pick<Sale, "id" | "orderNo">): Sale {
  return {
    platform: "bsc",
    orderDate: new Date(2026, 9, 30).getTime(),
    status: "READY_TO_SHIP",
    totals: { totalCents: 1250, netCents: 1050 },
    items: [],
    ...over,
  };
}

function setup(page: Partial<SalesPage>, opts: { listing?: boolean } = {}) {
  const loadMore = vi.fn();
  const useCards = vi.fn((ids: readonly CardId[] | null) => ids?.map((id) => (id === "c1" ? GOODEN : null)));
  const listing: ListingExtension = {
    useSettings: () => ({ bsc: { enabled: true, connected: true, needsReauth: false, paused: false } }),
    setEnabled: vi.fn(async () => {}),
    useVariantStatus: () => undefined,
    resyncVariant: vi.fn(async () => 0),
    useSales: () => ({ sales: [], canLoadMore: false, loadingMore: false, loadMore, ...page }),
  };
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: { useCards } as unknown as CollectionData,
    actions: {},
    ...(opts.listing === false ? {} : { listing }),
  } as CollectionStoreValue;
  const pageApi = { notify: vi.fn(), inform: vi.fn() } as unknown as PageApi;
  const view = render(
    <Theme>
      <MemoryRouter>
        <CollectionStoreContext.Provider value={value}>
          <PageApiContext.Provider value={pageApi}>
            <SalesTab />
          </PageApiContext.Provider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>,
  );
  return { view, loadMore, useCards };
}

afterEach(cleanup);

describe("the Sales tab", () => {
  it("draws nothing in a store with no listing (the demo)", () => {
    const { view } = setup({}, { listing: false });
    expect(view.container.textContent).toBe("");
  });

  it("no sales yet: the switch, the empty note, and the way to BSC's orders page", () => {
    setup({ sales: [] });
    expect(screen.getByRole("heading", { level: 2, name: "Selling on BuySportsCards" })).toBeTruthy();
    expect((screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/^No sales yet\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open BSC orders (opens in a new tab)" });
    expect(link.getAttribute("href")).toBe(BSC_ORDERS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: "Show more sales" })).toBeNull();
  });

  it("the first page loading shows a skeleton, not the empty note", () => {
    setup({ sales: undefined });
    expect(screen.queryByText(/^No sales yet\./)).toBeNull();
    expect(screen.queryByRole("list", { name: "Orders, newest first" })).toBeNull();
  });

  it("an order shows its number, status, day, totals and each line by NB's card name", () => {
    setup({
      sales: [
        sale({
          id: "o1",
          orderNo: "100245",
          items: [
            { platformCardId: "bsc-1", cardId: "c1", condition: "near_mint", quantity: 2, priceCents: 500, applied: true },
            { platformCardId: "bsc-9", condition: "excellent", quantity: 1, priceCents: 250, applied: false, problem: "unmatched" },
            {
              platformCardId: "bsc-1",
              cardId: "c1",
              condition: "near_mint",
              quantity: 3,
              priceCents: 500,
              applied: true,
              problem: "oversold",
              shortBy: 2,
            },
          ],
        }),
      ],
    });
    const orders = screen.getByRole("list", { name: "Orders, newest first" });
    const order = within(orders).getByRole("article", { name: "Order 100245" });
    expect(order.textContent).toContain("Ready to ship");
    expect(order.textContent).toContain("6 cards, $12.50, you keep $10.50");
    const lines = within(order).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines[0]).toBe("2× 1985 Topps #620 Dwight Gooden (Near mint)$5.00 each");
    expect(lines[1]).toContain("BuySportsCards card bsc-9 (Excellent)$2.50 each");
    expect(lines[1]).toContain("We couldn't match this to a card in NeonBinder");
    expect(lines[2]).toContain("Sold 3 on BuySportsCards but only 1 in your boxes.");
  });

  it("Show more sales loads the next page in place, and waits while one is on its way", () => {
    const { loadMore } = setup({ sales: [sale({ id: "o1", orderNo: "1" })], canLoadMore: true });
    fireEvent.click(screen.getByRole("button", { name: "Show more sales" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ sales: [sale({ id: "o1", orderNo: "1" })], canLoadMore: false, loadingMore: true });
    expect((screen.getByRole("button", { name: "Loading sales…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
