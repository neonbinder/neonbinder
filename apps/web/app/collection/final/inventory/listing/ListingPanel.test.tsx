import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import ListingPanel, { statusLine } from "./ListingPanel";
import { PROBLEM_COPY, problemSentence, saleItemProblem, whenSynced } from "./copy";
import { PageApiContext, type PageApi } from "../../pageApi";
import {
  CollectionStoreContext,
  type CollectionData,
  type CollectionStoreValue,
  type ListingExtension,
} from "../../data/store";
import {
  REAL_CAPABILITIES,
  type Card,
  type ListingPlatformSettings,
  type ListingProblemReason,
  type VariantListingStatus,
} from "../../data/types";

/**
 * NEO-370 — a checklist's BuySportsCards panel on the inventory side. The
 * store is a stub: settings, one variant's status, and spies for the switch
 * and Resync. Copy is pinned where a collector reads it.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const OFF: ListingPlatformSettings = { enabled: false, connected: true, needsReauth: false, paused: false };
const ON: ListingPlatformSettings = { ...OFF, enabled: true };

function card(id: string, cardNumber: string, player: string): Card {
  return {
    id,
    cardNumber,
    players: [{ id: `p-${id}`, name: player }],
    teams: [],
    features: [],
    cardVariation: null,
    printRun: null,
  } as unknown as Card;
}
const CARDS = [card("c1", "1", "Doc Gooden"), card("c2", "2", "Darryl Strawberry")];

function setup(opts: {
  settings?: ListingPlatformSettings;
  status?: VariantListingStatus;
  listing?: boolean;
  resync?: () => Promise<number>;
}) {
  const notify = vi.fn();
  const setEnabled = vi.fn(async () => {});
  const resyncVariant = vi.fn(opts.resync ?? (async () => 2));
  const useVariantStatus = vi.fn(() => opts.status);
  const listing: ListingExtension = {
    useSettings: () => (opts.settings ? { bsc: opts.settings } : undefined),
    setEnabled,
    useVariantStatus,
    resyncVariant,
    useSales: () => ({ sales: [], canLoadMore: false, loadingMore: false, loadMore: () => {} }),
  };
  const pageApi = {
    openCard: vi.fn(),
    goToChecklists: vi.fn(),
    openSuggestion: vi.fn(),
    notify,
    inform: vi.fn(),
    undoLast: vi.fn(),
    run: vi.fn(),
  } as unknown as PageApi;
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: {} as CollectionData,
    actions: {},
    ...(opts.listing === false ? {} : { listing }),
  } as CollectionStoreValue;
  const view = render(
    <Theme>
      <MemoryRouter>
        <CollectionStoreContext.Provider value={value}>
          <PageApiContext.Provider value={pageApi}>
            <ListingPanel variantId="base1" title="Base" cards={CARDS} />
          </PageApiContext.Provider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>,
  );
  return { view, notify, setEnabled, resyncVariant, useVariantStatus };
}

const flush = () => act(async () => {});
const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const AT_2_14 = new Date(2026, 10, 1, 14, 14).getTime();

afterEach(cleanup);

describe("the listing panel", () => {
  it("draws nothing in a store with no listing (the demo)", () => {
    const { view } = setup({ settings: ON, listing: false });
    expect(view.container.textContent).toBe("");
  });

  it("listing off: the short switch, and switching it on says when the boxes go up", async () => {
    const { setEnabled, notify, useVariantStatus } = setup({ settings: OFF });
    // Off, it never asks for the variant's status.
    expect(useVariantStatus).toHaveBeenCalledWith(null);
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(setEnabled).toHaveBeenCalledWith("bsc", true);
    expect(notify).toHaveBeenCalledWith("Listing on BuySportsCards is on. Your boxes go up in about a minute.");
  });

  it("not connected: the switch is off limits and points at Profile", () => {
    setup({ settings: { ...OFF, connected: false } });
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    const link = screen.getByRole("link", { name: "Connect BuySportsCards on your Profile" });
    expect(link.getAttribute("href")).toBe("/profile/credentials");
  });

  it("listing on: says how many are listed and when it synced, and Syncing soon while a change waits", () => {
    setup({
      settings: ON,
      status: {
        pending: true,
        run: { status: "idle", listed: 12, lastSuccessAt: Date.now(), problems: [], problemsTotal: 0 },
      },
    });
    const line = screen.getByRole("status");
    expect(line.textContent).toMatch(/^12 listed on BuySportsCards\. Synced .+\. Syncing soon\.$/);
    expect(screen.queryByRole("button", { name: /Can't list on BSC/ })).toBeNull();
  });

  it("Can't list on BSC (M) opens a list naming each card by number and player, with why", () => {
    setup({
      settings: ON,
      status: {
        pending: false,
        run: {
          status: "idle",
          listed: 1,
          problems: [
            { cardId: "c2", reason: "noPrice" },
            { cardId: "c1", reason: "rejected", detail: "price below minimum" },
            { platformCardId: "998877", reason: "notOnSheet" },
          ],
          problemsTotal: 5,
        },
      },
    });
    const toggle = screen.getByRole("button", { name: "Can't list on BSC (5)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      `#2 Darryl Strawberry ${PROBLEM_COPY.noPrice}`,
      `#1 Doc Gooden ${PROBLEM_COPY.rejected} They said: “price below minimum”`,
      `A BuySportsCards card we can't match (id 998877) ${PROBLEM_COPY.notOnSheet}`,
    ]);
    expect(screen.getByText("Showing the first 3 of 5. Fix these and Resync to see the rest.")).toBeTruthy();
  });

  it("Resync sends the checklist again and says so", async () => {
    const { resyncVariant, notify } = setup({
      settings: ON,
      status: { pending: false, run: { status: "idle", listed: 1, problems: [], problemsTotal: 0 } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resync Base with BuySportsCards" }));
    await flush();
    expect(resyncVariant).toHaveBeenCalledWith("base1");
    expect(notify).toHaveBeenCalledWith("Resyncing Base with BuySportsCards. It goes up in about a minute.");
  });

  it("Resync waits while a sync runs, and while BuySportsCards is paused", () => {
    setup({
      settings: ON,
      status: { pending: false, run: { status: "running", problems: [], problemsTotal: 0 } },
    });
    expect((screen.getByRole("button", { name: "Resync Base with BuySportsCards" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Syncing with BuySportsCards now…");
    cleanup();
    setup({ settings: { ...ON, paused: true }, status: { pending: true, run: null } });
    expect((screen.getByRole("button", { name: "Resync Base with BuySportsCards" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "BuySportsCards is on a break. Changes wait here and go up when it's back.",
    );
  });

  it("a sign-in that ran out says so, with the way back", () => {
    setup({ settings: { ...ON, needsReauth: true }, status: { pending: false, run: null } });
    expect(screen.getByRole("link", { name: "Sign in to BuySportsCards again" }).getAttribute("href")).toBe(
      "/profile/credentials",
    );
  });
});

describe("statusLine", () => {
  const settings = { paused: false, needsReauth: false };
  it("before the first run", () => {
    expect(statusLine(settings, { pending: false, run: null }, NOW)).toBe(
      "Not on BuySportsCards yet. Resync sends this checklist up.",
    );
    expect(statusLine(settings, { pending: true, run: null }, NOW)).toBe("Going up to BuySportsCards in about a minute.");
  });

  it("a failed run says what NB wrote and when", () => {
    expect(
      statusLine(
        settings,
        { pending: false, run: { status: "error", lastRunAt: AT_2_14, lastError: "BuySportsCards signed us out", problems: [], problemsTotal: 0 } },
        NOW,
      ),
    ).toBe(`The last sync hit a snag (${whenSynced(AT_2_14, NOW)}): BuySportsCards signed us out. Resync to try again.`);
  });

  it("after Resync cleared the clean run, it says when it was last sent", () => {
    expect(
      statusLine(settings, { pending: true, run: { status: "idle", listed: 3, lastRunAt: AT_2_14, problems: [], problemsTotal: 0 } }, NOW),
    ).toBe(`3 listed on BuySportsCards. Last sent ${whenSynced(AT_2_14, NOW)}. Syncing soon.`);
  });
});

describe("listing copy", () => {
  const REASONS: ListingProblemReason[] = [
    "noLink",
    "sharedLink",
    "numberMismatch",
    "noPrice",
    "priceTooHigh",
    "noCondition",
    "graded",
    "notOnSheet",
    "rejected",
  ];
  it("every reason has plain words and none of NB's internal ones", () => {
    for (const reason of REASONS) {
      const text = problemSentence({ reason });
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/outbox|lease|commit|sku|platformData|ref\b/i);
    }
  });

  it("an oversold line says how many sold and how many the boxes had", () => {
    expect(saleItemProblem({ problem: "oversold", quantity: 3, shortBy: 2 })).toBe(
      "Sold 3 on BuySportsCards but only 1 in your boxes. We took that one; 2 more need a look.",
    );
    expect(saleItemProblem({ problem: "oversold", quantity: 2, shortBy: 2 })).toBe(
      "Sold 2 on BuySportsCards but only 0 in your boxes. We took none; 2 more need a look.",
    );
    expect(saleItemProblem({ quantity: 1 })).toBeNull();
  });

  it("times read as today's clock, or a day", () => {
    expect(whenSynced(AT_2_14, NOW)).not.toMatch(/Nov|2026/);
    expect(whenSynced(new Date(2025, 4, 2).getTime(), NOW)).toMatch(/2025/);
  });
});
