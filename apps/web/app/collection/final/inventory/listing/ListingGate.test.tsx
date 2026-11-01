import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import {
  ChecklistGateText,
  SETTINGS_PATH,
  SYNC_STATUS_LINK,
  SyncStatusLink,
  checklistGateLine,
  intakeGateLine,
  takeSyncStatusArrival,
  useListingLock,
} from "./ListingGate";
import SyncStatusTab from "./SyncStatusTab";
import { stubListing } from "./stubListing";
import { CollectionModeProvider } from "../../mode";
import { CollectionStoreContext, type CollectionData, type CollectionStoreValue } from "../../data/store";
import { REAL_CAPABILITIES, type ListingGateView, type PlatformSyncStatus } from "../../data/types";

/**
 * NEO-370 — the screens' copy of the listing gate: `useListingLock` combines
 * the server's answer (`listingGate.forHome`) with what the copy will carry,
 * by the same rule the writers enforce (`lib/listingReadiness`).
 */
function lockWith(gate: ListingGateView | undefined, input: Partial<Parameters<typeof useListingLock>[0]> = {}) {
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: {} as CollectionData,
    actions: {},
    listing: stubListing({ useGate: () => gate }),
  } as CollectionStoreValue;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CollectionStoreContext.Provider value={value}>{children}</CollectionStoreContext.Provider>
  );
  return renderHook(() => useListingLock({ homeId: "box1", variantId: "v1", condition: "Excellent", ...input }), { wrapper })
    .result.current;
}

const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null };

afterEach(cleanup);

describe("useListingLock", () => {
  it("holds a listed box with no price anywhere", () => {
    expect(lockWith(HELD)).toMatchObject({ locked: true, needsPrice: true, needsCondition: false, syncing: true });
  });

  it("a price of the copy's own, even $0, or a common price lifts it", () => {
    expect(lockWith(HELD, { ownPriceCents: 0 }).locked).toBe(false);
    expect(lockWith({ ...HELD, commonPriceCents: 25 }).locked).toBe(false);
  });

  it("a missing condition holds it too; a graded copy is never held", () => {
    expect(lockWith({ ...HELD, commonPriceCents: 25 }, { condition: undefined })).toMatchObject({
      locked: true,
      needsCondition: true,
    });
    expect(lockWith(HELD, { graded: true, condition: undefined }).locked).toBe(false);
  });

  it("nothing is held while the gate loads, where it does not apply, or in a store with no listing", () => {
    expect(lockWith(undefined)).toMatchObject({ locked: false, syncing: false });
    expect(lockWith({ syncing: true, applies: false, commonPriceCents: null }).locked).toBe(false);
    const bare = renderHook(() => useListingLock({ homeId: "box1", variantId: "v1", condition: "Excellent" }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <CollectionStoreContext.Provider
          value={{ kind: "demo", capabilities: { ...REAL_CAPABILITIES, marketplaceListing: false }, data: {}, actions: {} } as never}
        >
          {children}
        </CollectionStoreContext.Provider>
      ),
    }).result.current;
    expect(bare.locked).toBe(false);
  });
});

describe("the gate's lines", () => {
  it("say what is missing and where to fix it, on each screen", () => {
    expect(checklistGateLine("Show box", { needsPrice: true, needsCondition: true })).toBe(
      "Price and condition first! Show box sells on your marketplaces, so set a common price above and pick a default condition in Profile → Settings before you stock it.",
    );
    expect(checklistGateLine("Show box", { needsPrice: false, needsCondition: true })).toBe(
      "Condition first! Show box sells on your marketplaces, so pick a default condition in Profile → Settings before you stock it.",
    );
    expect(intakeGateLine("Show box", { needsPrice: false, needsCondition: true })).toBe(
      "Condition first! Show box sells on your marketplaces, so pick a condition in Defaults before you send photos.",
    );
  });
});

describe("the checklist note's Profile → Settings link", () => {
  it("reads exactly as the line, with Profile → Settings a real link there", () => {
    const missing = { needsPrice: true, needsCondition: true };
    const { container } = render(
      <MemoryRouter>
        <p>
          <ChecklistGateText homeName="Show box" missing={missing} />
        </p>
      </MemoryRouter>,
    );
    expect(container.textContent).toBe(checklistGateLine("Show box", missing));
    expect(screen.getByRole("link", { name: "Profile → Settings" }).getAttribute("href")).toBe(SETTINGS_PATH);
  });

  it("no link when only the price is missing", () => {
    render(
      <MemoryRouter>
        <ChecklistGateText homeName="Show box" missing={{ needsPrice: true, needsCondition: false }} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("arriving on Sync status by \"See what's syncing\"", () => {
  const platform: PlatformSyncStatus = {
    platform: "bsc",
    connected: true,
    listing: true,
    needsReauth: false,
    paused: false,
    sellerConflict: false,
    running: null,
    queued: { cards: [], more: false },
    sets: [],
  };
  function tab() {
    const value = {
      kind: "convex",
      capabilities: REAL_CAPABILITIES,
      data: {} as CollectionData,
      actions: {},
      listing: stubListing({ useSyncStatus: () => ({ platforms: [platform] }) }),
    } as CollectionStoreValue;
    return render(
      <MemoryRouter initialEntries={["/inventory?tab=sync"]}>
        <CollectionStoreContext.Provider value={value}>
          <SyncStatusTab />
        </CollectionStoreContext.Provider>
      </MemoryRouter>,
    );
  }

  it("a plain click on the link puts the keyboard on Sync status's first heading", async () => {
    render(
      <MemoryRouter initialEntries={["/inventory?tab=checklists"]}>
        <CollectionModeProvider mode="app" surface="inventory">
          <SyncStatusLink />
        </CollectionModeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: SYNC_STATUS_LINK }));
    cleanup();
    tab();
    await act(async () => {});
    const heading = screen.getByRole("heading", { level: 2, name: "BuySportsCards" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    // Once: the next visit (a tab click, a Back) leaves focus alone.
    expect(takeSyncStatusArrival()).toBe(false);
  });

  it("any other way in leaves focus where it was", async () => {
    tab();
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
  });
});
