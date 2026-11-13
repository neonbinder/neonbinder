import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SalesTab from "./SalesTab";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import { BSC_ORDERS_URL } from "./copy";
import { stubListing } from "./stubListing";
import { PageApiContext, type PageApi } from "../../pageApi";
import {
  CollectionStoreContext,
  type CollectionData,
  type CollectionStoreValue,
} from "../../data/store";
import {
  REAL_CAPABILITIES,
  type Card,
  type CardId,
  type Sale,
  type SalesPage,
} from "../../data/types";

/**
 * NEO-370 — the Sales tab: the collector's orders newest first, a page at a time. The store is a stub; the card names come
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

function setup(
  initial: Partial<SalesPage>,
  opts: { listing?: boolean; sandbox?: boolean; url?: string } = {},
) {
  // What the stub store answers; change it and call `rerender()`.
  const state: { page: Partial<SalesPage> } = { page: initial };
  const loadMore = vi.fn();
  const useCards = vi.fn((ids: readonly CardId[] | null) => ids?.map((id) => (id === "c1" ? GOODEN : null)));
  const listing = stubListing({
    useSales: () => ({ sales: [], canLoadMore: false, loadingMore: false, loadMore, ...state.page }),
    ...(opts.sandbox !== undefined
      ? { useEbaySetup: () => ({ connected: true, setupComplete: true, sandbox: opts.sandbox! }) }
      : {}),
  });
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: { useCards } as unknown as CollectionData,
    actions: {},
    ...(opts.listing === false ? {} : { listing }),
  } as CollectionStoreValue;
  const pageApi = { notify: vi.fn(), inform: vi.fn() } as unknown as PageApi;
  // A fresh element each time: re-rendering the same one bails out.
  const tree = () => (
    <Theme>
      <MemoryRouter initialEntries={[opts.url ?? "/inventory?tab=sales"]}>
        <CollectionStoreContext.Provider value={value}>
          <PageApiContext.Provider value={pageApi}>
            <SalesTab />
          </PageApiContext.Provider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  const rerender = (page: Partial<SalesPage> = state.page) => {
    state.page = page;
    view.rerender(tree());
  };
  return { view, loadMore, useCards, rerender };
}

afterEach(cleanup);

describe("the Sales tab", () => {
  it("draws nothing in a store with no listing (the demo)", () => {
    const { view } = setup({}, { listing: false });
    expect(view.container.textContent).toBe("");
  });

  it("no sales yet: the empty note and the way to BSC's orders page, and no listing switch (Rev 4)", () => {
    setup({ sales: [] });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Selling on BuySportsCards" })).toBeNull();
    expect(screen.getByText(/^No sales yet\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open BuySportsCards orders (opens in a new tab)" });
    expect(link.getAttribute("href")).toBe(BSC_ORDERS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: "Show more sales" })).toBeNull();
  });

  it("a populated Sales list passes axe in light and dark (matched, unmatched, mismatched and oversold lines)", async () => {
    const { view, rerender } = setup({
      canLoadMore: true,
      sales: [
        sale({
          id: "o1",
          orderNo: "100245",
          items: [
            { cardId: "c1", condition: "near_mint", quantity: 2, priceCents: 500, applied: true },
            { condition: "excellent", quantity: 1, priceCents: 250, applied: false, problem: "unmatched" },
            { cardId: "c1", condition: "near_mint", quantity: 3, priceCents: 500, applied: true, problem: "oversold", shortBy: 2 },
          ],
        }),
        sale({
          id: "o2",
          orderNo: "100198",
          status: "SHIPPED",
          totals: { subtotalCents: 75 },
          items: [
            { cardId: "c9", condition: "very_good", quantity: 1, priceCents: 75, applied: false, problem: "linkMismatch" },
          ],
        }),
      ],
    });
    expect(screen.getByRole("list", { name: "Orders, newest first" })).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "Sales tab, populated", rerender: () => rerender() });
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
            { cardId: "c1", condition: "near_mint", quantity: 2, priceCents: 500, applied: true },
            { condition: "excellent", quantity: 1, priceCents: 250, applied: false, problem: "unmatched" },
            {
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
    const order = within(orders).getByRole("article", { name: "BuySportsCards order 100245" });
    expect(order.textContent).toContain("Ready to ship");
    expect(order.textContent).toContain("6 items, $12.50, you keep $10.50");
    const lines = within(order).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines[0]).toBe("2× 1985 Topps #620 Dwight Gooden (Near mint)$5.00 each");
    expect(lines[1]).toContain("1× A BuySportsCards card we can't match (Excellent)$2.50 each");
    expect(lines[1]).toContain("We couldn't match this to a card in NeonBinder");
    expect(lines[2]).toContain("Sold 3 on BuySportsCards but only 1 in your boxes.");
  });

  it("Show more sales loads the next page in place, and waits while one is on its way", () => {
    const { loadMore } = setup({ sales: [sale({ id: "o1", orderNo: "1" })], canLoadMore: true });
    fireEvent.click(screen.getByRole("button", { name: "Show more sales" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    cleanup();
    const again = setup({ sales: [sale({ id: "o1", orderNo: "1" })], canLoadMore: false, loadingMore: true });
    // The same words while loading, aria-disabled (never native disabled) so focus stays put.
    const button = screen.getByRole("button", { name: "Show more sales" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(again.loadMore).not.toHaveBeenCalled();
  });

  it("when a page lands, focus moves to its first order and a quiet status says how many show", () => {
    const first = [sale({ id: "o1", orderNo: "1" }), sale({ id: "o2", orderNo: "2" })];
    const { rerender } = setup({ sales: first, canLoadMore: true });
    const status = screen.getAllByRole("status").find((el) => el.classList.contains("sr-only"))!;
    expect(status.textContent).toBe("");
    const button = screen.getByRole("button", { name: "Show more sales" });
    button.focus();
    fireEvent.click(button);
    rerender({ sales: first, canLoadMore: false, loadingMore: true });
    expect(document.activeElement).toBe(button);
    const next = [...first, sale({ id: "o3", orderNo: "3" }), sale({ id: "o4", orderNo: "4" })];
    rerender({ sales: next, canLoadMore: true, loadingMore: false });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "BuySportsCards order 3" }));
    expect(status.textContent).toBe("Showing 4 sales.");

    fireEvent.click(screen.getByRole("button", { name: "Show more sales" }));
    rerender({ sales: next, canLoadMore: false, loadingMore: true });
    const last = [...next, sale({ id: "o5", orderNo: "5" })];
    rerender({ sales: last, canLoadMore: false, loadingMore: false });
    expect(screen.queryByRole("button", { name: "Show more sales" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "BuySportsCards order 5" }));
    expect(status.textContent).toBe("Showing 5 sales. That's every sale.");
  });

  it("a page that brings nothing parks focus on the last order, not the page", () => {
    const first = [sale({ id: "o1", orderNo: "1" })];
    const { rerender } = setup({ sales: first, canLoadMore: true });
    fireEvent.click(screen.getByRole("button", { name: "Show more sales" }));
    // A render before the store starts loading (here its paging flag moved first): nothing moves yet.
    rerender({ sales: first, canLoadMore: false });
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 3, name: "BuySportsCards order 1" }));
    rerender({ sales: first, canLoadMore: false, loadingMore: true });
    rerender({ sales: first, canLoadMore: false, loadingMore: false });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "BuySportsCards order 1" }));
  });

  it("NEO-415: an eBay order says eBay, reads eBay's words, and links to itself (sandbox too)", () => {
    setup(
      {
        sales: [
          sale({
            id: "e1",
            platform: "ebay",
            orderNo: "12-34567-89012",
            status: "NOT_STARTED",
            items: [
              { cardId: "c1", condition: "NM", quantity: 1, priceCents: 2500, applied: true },
              { condition: "EX", quantity: 1, priceCents: 300, applied: false, problem: "unmatched" },
            ],
          }),
        ],
      },
      { sandbox: true },
    );
    // The marketplace is in the order's name, so moving by heading says which one sold it.
    const order = screen.getByRole("article", { name: "eBay order 12-34567-89012" });
    expect(within(order).getByRole("heading", { level: 3, name: "eBay order 12-34567-89012" })).toBeTruthy();
    expect(within(order).getByText("Ready to ship")).toBeTruthy();
    expect(within(order).getByText("(Near Mint or better)")).toBeTruthy();
    // NEO-520: a line NB didn't list is never called a card; with no title it says where it sold.
    expect(within(order).getByText("A sale with no title")).toBeTruthy();
    const link = within(order).getByRole("link", { name: "Open order 12-34567-89012 on eBay (opens in a new tab)" });
    expect(link.getAttribute("href")).toBe("https://www.sandbox.ebay.com/sh/ord/details?orderid=12-34567-89012");
    // Both platforms' orders pages up top: BSC is connected in the stub, eBay sold.
    expect(screen.getByRole("link", { name: "Open eBay orders (opens in a new tab)" }).getAttribute("href")).toBe(
      "https://www.sandbox.ebay.com/sh/ord",
    );
    expect(screen.getByRole("link", { name: "Open BuySportsCards orders (opens in a new tab)" })).toBeTruthy();
  });

  describe("NEO-520: eBay lines NB didn't list", () => {
    const foreign = (over: Record<string, unknown> = {}) => ({
      condition: "",
      quantity: 1,
      priceCents: 499,
      applied: false,
      problem: "unmatched" as const,
      ...over,
    });
    const ebay = (items: Sale["items"], id = "e1") =>
      sale({ id, platform: "ebay", orderNo: "27-11111-22222", status: "NOT_STARTED", totals: { totalCents: 499 }, items });
    const orderOf = (name: string) => screen.getByRole("article", { name });

    it("names a line with no card by eBay's own title, shows the eBay problem line, and hides the empty condition", () => {
      setup({ sales: [ebay([foreign({ title: "2024 Topps Chrome #205 Some Player RC" })])] });
      const line = within(orderOf("eBay order 27-11111-22222")).getAllByRole("listitem")[0];
      expect(line.textContent).toBe(
        "1× 2024 Topps Chrome #205 Some Player RC$4.99 eachNeonBinder didn't list this one. Boxes untouched. Pull it by hand.",
      );
      expect(line.textContent).not.toContain("()");
      expect(line.textContent).not.toMatch(/\bcard\b/i);
    });

    it("a line with no title says it has none, never calling it a card", () => {
      setup({ sales: [ebay([foreign()])] });
      expect(within(orderOf("eBay order 27-11111-22222")).getByText("A sale with no title")).toBeTruthy();
    });

    it("a 200-character title with no spaces wraps instead of running off the screen (WCAG 1.4.10)", () => {
      const title = "X".repeat(200);
      setup({ sales: [ebay([foreign({ title })])] });
      const name = within(orderOf("eBay order 27-11111-22222")).getByText(title);
      expect(name.className).toContain("break-words");
      expect(name.className).toContain("min-w-0");
    });

    it("a blank title falls back to the plain words", () => {
      setup({ sales: [ebay([foreign({ title: "   " })])] });
      expect(within(orderOf("eBay order 27-11111-22222")).getByText("A sale with no title")).toBeTruthy();
    });

    it("the header counts items when any line has no NB card, and the singular is item", () => {
      setup({ sales: [ebay([foreign({ title: "One thing" })])] });
      expect(orderOf("eBay order 27-11111-22222").textContent).toContain("1 item, $4.99");
      cleanup();
      setup({
        sales: [
          ebay([
            { cardId: "c1", condition: "NM", quantity: 2, priceCents: 100, applied: true },
            foreign({ quantity: 3, title: "Lot" }),
          ]),
        ],
      });
      expect(orderOf("eBay order 27-11111-22222").textContent).toContain("5 items");
    });

    it("an order whose every line has an NB card still counts cards", () => {
      setup({ sales: [ebay([{ cardId: "c1", condition: "NM", quantity: 2, priceCents: 100, applied: true }])] });
      expect(orderOf("eBay order 27-11111-22222").textContent).toContain("2 cards");
    });

    it("a BuySportsCards line with no card says items in the header but keeps its own name and problem words", () => {
      setup({ sales: [sale({ id: "b1", orderNo: "77", items: [{ condition: "excellent", quantity: 1, priceCents: 250, applied: false, problem: "unmatched" }] })] });
      const order = orderOf("BuySportsCards order 77");
      expect(order.textContent).toContain("1 item");
      expect(order.textContent).toContain("A BuySportsCards card we can't match");
      expect(order.textContent).toContain("We couldn't match this to a card in NeonBinder");
    });

    it("a line whose card left the catalog keeps its words even with a title", () => {
      setup({ sales: [ebay([foreign({ cardId: "gone", problem: undefined, title: "Some title" })])] });
      expect(within(orderOf("eBay order 27-11111-22222")).getByText("A card that has left the catalog")).toBeTruthy();
    });

    it("passes axe in both modes", async () => {
      const { view, rerender } = setup({ sales: [ebay([foreign({ title: "Binder lot" }), foreign({ title: undefined })])] });
      await expectAccessibleInBothModes(view.container, { label: "Sales tab, eBay unmatched lines", rerender: () => rerender() });
    });
  });

  it("NEO-500: a one-order link (?sorder=) marks that order and focuses its heading", () => {
    setup(
      { sales: [sale({ id: "o1", orderNo: "1" }), sale({ id: "o2", orderNo: "2" })] },
      { url: "/inventory?tab=sales&sorder=o2" },
    );
    const head = screen.getByRole("heading", { level: 3, name: "BuySportsCards order 2" });
    expect(document.activeElement).toBe(head);
    expect(head.closest("article")?.getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByRole("heading", { level: 3, name: "BuySportsCards order 1" }).closest("article")?.getAttribute("aria-current"),
    ).toBeNull();
  });

  it("NEO-500: an order past the loaded pages loads more until it shows, then takes focus", () => {
    const first = [sale({ id: "o1", orderNo: "1" })];
    const { loadMore, rerender } = setup({ sales: first, canLoadMore: true }, { url: "/inventory?tab=sales&sorder=o3" });
    expect(loadMore).toHaveBeenCalledTimes(1);
    rerender({ sales: first, canLoadMore: false, loadingMore: true });
    expect(loadMore).toHaveBeenCalledTimes(1);
    const next = [...first, sale({ id: "o2", orderNo: "2" }), sale({ id: "o3", orderNo: "3" })];
    rerender({ sales: next, canLoadMore: true, loadingMore: false });
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "BuySportsCards order 3" }));
  });

  it("NEO-500: an order link waits out a page already loading, and gives up after ten pages", () => {
    const first = [sale({ id: "o1", orderNo: "1" })];
    const { loadMore, rerender } = setup(
      { sales: first, canLoadMore: true, loadingMore: true },
      { url: "/inventory?tab=sales&sorder=missing" },
    );
    expect(loadMore).not.toHaveBeenCalled();
    for (let n = 0; n < 15; n++) {
      rerender({ sales: first, canLoadMore: true, loadingMore: false });
      rerender({ sales: first, canLoadMore: true, loadingMore: true });
    }
    expect(loadMore).toHaveBeenCalledTimes(10);
  });
});
