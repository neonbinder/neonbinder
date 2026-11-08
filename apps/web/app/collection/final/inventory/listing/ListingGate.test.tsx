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
  useIntakeRunLock,
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

const HELD: ListingGateView = { syncing: true, applies: true, commonPriceCents: null, variantHasCards: true };

afterEach(cleanup);

describe("useListingLock", () => {
  it("holds a listed box with no price anywhere", () => {
    expect(lockWith(HELD)).toMatchObject({ locked: true, needsPrice: true, needsCondition: false, syncing: true });
  });

  it("a price of the copy's own, even $0, or a common price lifts it", () => {
    expect(lockWith(HELD, { ownPriceCents: 0 }).locked).toBe(false);
    expect(lockWith({ ...HELD, commonPriceCents: 25, variantHasCards: true }).locked).toBe(false);
  });

  it("a missing condition holds it too; a graded copy is never held", () => {
    expect(lockWith({ ...HELD, commonPriceCents: 25, variantHasCards: true }, { condition: undefined })).toMatchObject({
      locked: true,
      needsCondition: true,
    });
    expect(lockWith(HELD, { graded: true, condition: undefined }).locked).toBe(false);
  });

  it("nothing is held while the gate loads, where it does not apply, or in a store with no listing", () => {
    expect(lockWith(undefined)).toMatchObject({ locked: false, syncing: false });
    expect(lockWith({ syncing: true, applies: false, commonPriceCents: null, variantHasCards: true }).locked).toBe(false);
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
  });

  it("intake: a price is asked for in the set's name, a condition alone is not", () => {
    expect(intakeGateLine("Show box", "1988 Topps Base", { needsPrice: true, needsCondition: false })).toBe(
      "Price tag first! Show box sells on your marketplaces and 1988 Topps Base has no price yet. Set one in Defaults and your photos go up.",
    );
    expect(intakeGateLine("Show box", "1988 Topps Base", { needsPrice: false, needsCondition: true })).toBe(
      "Condition first! Show box sells on your marketplaces. Pick one in Defaults and your photos go up.",
    );
    expect(intakeGateLine("Show box", "1988 Topps Base", { needsPrice: true, needsCondition: true })).toBe(
      "Price and condition first! Show box sells on your marketplaces and 1988 Topps Base has no price yet. Set both in Defaults and your photos go up.",
    );
  });

  it("intake: a set with no known title is still named, and a run that stopped taking photos talks about saving", () => {
    expect(intakeGateLine("Show box", null, { needsPrice: true, needsCondition: false })).toBe(
      "Price tag first! Show box sells on your marketplaces and this set has no price yet. Set one in Defaults and your photos go up.",
    );
    expect(intakeGateLine("Show box", "1988 Topps Base", { needsPrice: true, needsCondition: false }, { collecting: false })).toBe(
      "Price tag first! Show box sells on your marketplaces and 1988 Topps Base has no price yet. Set one in Defaults before you save these cards.",
    );
    expect(intakeGateLine("Show box", null, { needsPrice: false, needsCondition: true }, { collecting: false })).toBe(
      "Condition first! Show box sells on your marketplaces. Pick one in Defaults before you save these cards.",
    );
  });
});

describe("useIntakeRunLock (NEO-452)", () => {
  function intakeLock(gate: ListingGateView | undefined, input: Partial<Parameters<typeof useIntakeRunLock>[0]> = {}) {
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
    return renderHook(
      () => useIntakeRunLock({ homeId: "box1", variantId: "v1", condition: "Excellent", ...input }),
      { wrapper },
    ).result.current;
  }

  it("while the gate loads it is never ready and says it has not loaded, where useListingLock reads open", () => {
    expect(intakeLock(undefined)).toEqual({
      ready: false,
      needsSet: false,
      needsPrice: false,
      needsCondition: false,
      locked: false,
      syncing: false,
      loaded: false,
      setHasNoCards: false,
    });
    expect(lockWith(undefined).locked).toBe(false);
  });

  it("while the gate loads with no set it still says the set is missing", () => {
    expect(intakeLock(undefined, { variantId: null })).toMatchObject({ needsSet: true, ready: false, loaded: false });
  });

  it("a set with no cards is never ready and asks for nothing else, whatever the price or condition", () => {
    for (const gate of [HELD, { ...HELD, commonPriceCents: 25, variantHasCards: true }, { syncing: true, applies: false, commonPriceCents: null, variantHasCards: true }]) {
      expect(intakeLock({ ...gate, variantHasCards: false }, { condition: undefined })).toEqual({
        ready: false,
        needsSet: false,
        needsPrice: false,
        needsCondition: false,
        locked: false,
        syncing: true,
        loaded: true,
        setHasNoCards: true,
      });
    }
  });

  it("a gate that says nothing of cards, or says the set has them, doesn't flag an empty set", () => {
    expect(intakeLock(HELD).setHasNoCards).toBe(false);
    expect(intakeLock({ ...HELD, variantHasCards: true }).setHasNoCards).toBe(false);
  });

  it("with no set there is no empty set to flag", () => {
    expect(intakeLock({ ...HELD, variantHasCards: true }, { variantId: null }).setHasNoCards).toBe(false);
  });

  it("a listed box with no price asks for the price once it has a set, and is locked", () => {
    expect(intakeLock(HELD)).toMatchObject({ loaded: true, ready: false, needsSet: false, needsPrice: true, locked: true, syncing: true });
  });

  it("with no set it asks for the set, never the price, and is not locked on a price it can't look up", () => {
    expect(intakeLock(HELD, { variantId: null })).toMatchObject({
      loaded: true,
      ready: false,
      needsSet: true,
      needsPrice: false,
      locked: false,
    });
  });

  it("a price of its own (even $0) or the set's common price makes it ready", () => {
    expect(intakeLock(HELD, { ownPriceCents: 0 })).toMatchObject({ ready: true, locked: false });
    expect(intakeLock({ ...HELD, commonPriceCents: 25, variantHasCards: true })).toMatchObject({ ready: true, locked: false });
  });

  it("a missing condition locks it; a graded run needs neither", () => {
    expect(intakeLock({ ...HELD, commonPriceCents: 25, variantHasCards: true }, { condition: undefined })).toMatchObject({
      ready: false,
      needsCondition: true,
      locked: true,
    });
    expect(intakeLock(HELD, { graded: true, condition: undefined })).toMatchObject({ ready: true, locked: false });
  });

  it("a box that does not list, or a collector who does not sync, is ready with a set", () => {
    expect(intakeLock({ syncing: true, applies: false, commonPriceCents: null, variantHasCards: true })).toMatchObject({ ready: true, locked: false, loaded: true });
    expect(intakeLock({ syncing: false, applies: false, commonPriceCents: null, variantHasCards: true })).toMatchObject({ ready: true, syncing: false });
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
