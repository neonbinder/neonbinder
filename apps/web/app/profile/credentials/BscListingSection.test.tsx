import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import {
  CONSENT_LINE,
  PAUSED_LINE,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  listingDay,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 Rev 4 — listing on BuySportsCards, under the BSC sign-in on
 * Profile → Credentials: nothing to start without a sign-in; the consent
 * warning and a one-way Start; then since when, and that removing the
 * sign-in stops it. Saving a sign-in alone never starts listing.
 */

type Settings = {
  connected: boolean;
  listing: boolean;
  listingSince?: number;
  needsReauth: boolean;
  paused: boolean;
  sellerConflict: boolean;
};

const mocks = vi.hoisted(() => ({
  settings: undefined as { bsc: Settings } | undefined,
  start: vi.fn(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    listingSync: {
      listingSettings: "listingSync:listingSettings",
      startListing: "listingSync:startListing",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "listingSync:listingSettings" ? mocks.settings : undefined),
  useMutation: () => mocks.start,
}));

import BscListingSection from "./BscListingSection";

const BASE: Settings = { connected: true, listing: false, needsReauth: false, paused: false, sellerConflict: false };
const SINCE = new Date(2026, 9, 30).getTime();

function draw(settings: Settings | undefined) {
  mocks.settings = settings ? { bsc: settings } : undefined;
  const tree = () => (
    <Theme>
      <BscListingSection />
    </Theme>
  );
  const view = render(tree());
  return { view, rerender: () => view.rerender(tree()) };
}

const start = () => screen.getByRole("button", { name: "Start listing on BuySportsCards" });
const flush = () => act(async () => {});

beforeEach(() => {
  mocks.start.mockReset();
});
afterEach(cleanup);

describe("Profile → BuySportsCards listing", () => {
  it("draws nothing while loading or with no sign-in saved: there is nothing to start", () => {
    expect(draw(undefined).view.container.textContent).toBe("");
    cleanup();
    expect(draw({ ...BASE, connected: false }).view.container.textContent).toBe("");
  });

  it("connected, not listing: the consent warning, then Start, described by it", async () => {
    const { view, rerender } = draw(BASE);
    expect(screen.getByRole("heading", { level: 3, name: "Listing on BuySportsCards" })).toBeTruthy();
    const description = document.getElementById(start().getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(`Heads up before you start${CONSENT_LINE}`);
    expect(CONSENT_LINE).toMatch(/goes to 0\.$/);
    await expectAccessibleInBothModes(view.container, { label: "BSC listing, not started", rerender });
  });

  it("Start starts listing; once the settings say so, focus lands on the heading", async () => {
    mocks.start.mockResolvedValue({ started: true });
    const { rerender } = draw(BASE);
    start().focus();
    fireEvent.click(start());
    expect(mocks.start).toHaveBeenCalledWith({ platform: "bsc" });
    expect(start().getAttribute("aria-busy")).toBe("true");
    // A second press while the first is out does nothing.
    fireEvent.click(start());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await flush();
    expect(screen.getByRole("status").textContent).toBe("You're live on BuySportsCards. Your boxes go up within 15 minutes.");
    mocks.settings = { bsc: { ...BASE, listing: true, listingSince: SINCE } };
    rerender();
    await flush();
    expect(screen.queryByRole("button", { name: "Start listing on BuySportsCards" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Listing on BuySportsCards" }));
  });

  it("a seller account that lists elsewhere: Start is refused and says why", async () => {
    mocks.start.mockResolvedValue({ started: false, reason: "sellerConflict" });
    draw(BASE);
    fireEvent.click(start());
    await flush();
    expect(screen.getByRole("status").textContent).toBe(SELLER_CONFLICT_LINE);
  });

  it("a sign-in removed meanwhile: Start says to save it first", async () => {
    mocks.start.mockResolvedValue({ started: false, reason: "notConnected" });
    draw(BASE);
    fireEvent.click(start());
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Save your BuySportsCards sign-in above first, then start listing.");
  });

  it("listing: since when, and that removing the sign-in stops listing and sales", async () => {
    const { view, rerender } = draw({ ...BASE, listing: true, listingSince: SINCE });
    expect(screen.getByText(`Listing your boxes on BuySportsCards since ${listingDay(SINCE)}.`)).toBeTruthy();
    expect(screen.getByText(/Removing your BuySportsCards sign-in stops listing and sales/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC listing, listing", rerender });
  });

  it("a seller conflict before starting shows the line in place of Start", async () => {
    const { view, rerender } = draw({ ...BASE, sellerConflict: true });
    expect(screen.getByText(SELLER_CONFLICT_LINE)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC listing, seller conflict", rerender });
  });

  it("a seller conflict after starting holds pushing back: the conflict line, not 'since'", async () => {
    const { view, rerender } = draw({ ...BASE, listing: true, listingSince: SINCE, sellerConflict: true });
    expect(screen.getByText(SELLER_CONFLICT_LINE)).toBeTruthy();
    expect(screen.queryByText(/^Listing your boxes on BuySportsCards/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC listing, conflict after start", rerender });
  });

  it("a dead sign-in and a pause are said beside the state", async () => {
    const reauth = draw({ ...BASE, listing: true, listingSince: SINCE, needsReauth: true });
    expect(screen.getByText(REAUTH_LINE)).toBeTruthy();
    await expectAccessibleInBothModes(reauth.view.container, { label: "BSC listing, needs sign-in", rerender: reauth.rerender });
    cleanup();
    const paused = draw({ ...BASE, listing: true, listingSince: SINCE, paused: true, needsReauth: true });
    expect(screen.getByText(PAUSED_LINE)).toBeTruthy();
    expect(screen.queryByText(REAUTH_LINE)).toBeNull();
    await expectAccessibleInBothModes(paused.view.container, { label: "BSC listing, paused", rerender: paused.rerender });
  });
});
