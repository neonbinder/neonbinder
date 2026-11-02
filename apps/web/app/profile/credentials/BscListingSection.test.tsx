import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import {
  NOT_SYNCING_LINE,
  PAUSED_LINE,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  listingDay,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 Rev 5 — where BuySportsCards syncing stands, under the BSC sign-in
 * on Profile → Credentials. A saved, unpaused sign-in IS syncing: no Start,
 * no control at all here (the consent sits beside Connect, see
 * components/modules/profile-credentials-panel.test.tsx). The state line is
 * one polite live region, mounted before the sign-in is saved, so the flip
 * to "Listing … since" is announced.
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
}));

vi.mock("@/convex/_generated/api", () => ({
  api: { listingSync: { listingSettings: "listingSync:listingSettings" } },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "listingSync:listingSettings" ? mocks.settings : undefined),
  // Rev 5 writes nothing from here: a mutation hook would be a Start coming back.
  useMutation: () => {
    throw new Error("BscListingSection must not write");
  },
}));

import BscListingSection from "./BscListingSection";

const LISTING: Settings = {
  connected: true,
  listing: true,
  listingSince: new Date(2026, 9, 30).getTime(),
  needsReauth: false,
  paused: false,
  sellerConflict: false,
};
const SINCE = LISTING.listingSince!;
const SINCE_LINE = `Listing your boxes on BuySportsCards since ${listingDay(SINCE)}.`;

function draw(settings: Settings | undefined) {
  mocks.settings = settings ? { bsc: settings } : undefined;
  const tree = () => (
    <Theme>
      <BscListingSection />
    </Theme>
  );
  const view = render(tree());
  return {
    view,
    rerender: (next?: Settings) => {
      if (next) mocks.settings = { bsc: next };
      view.rerender(tree());
    },
  };
}

const heading = () => screen.queryByRole("heading", { level: 3, name: "Listing on BuySportsCards" });

afterEach(cleanup);

describe("Profile → BuySportsCards syncing", () => {
  it("loading or no sign-in saved: nothing shows but the empty polite status line", () => {
    for (const settings of [undefined, { ...LISTING, connected: false, listing: false }]) {
      const { view } = draw(settings);
      expect(view.container.textContent).toBe("");
      expect(heading()).toBeNull();
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.getAttribute("aria-atomic")).toBe("true");
      expect(status.className).toContain("sr-only");
      cleanup();
    }
  });

  it("saving the sign-in fills the SAME live region with since when (announced, not just drawn)", () => {
    const { rerender } = draw({ ...LISTING, connected: false, listing: false });
    const before = screen.getByRole("status");
    rerender(LISTING);
    const after = screen.getByRole("status");
    expect(after).toBe(before);
    expect(after.textContent).toBe(SINCE_LINE);
    expect(after.className).not.toContain("sr-only");
  });

  it("listing: since when, and that removing the sign-in stops listing and sales; no control", async () => {
    const { view, rerender } = draw(LISTING);
    expect(heading()).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(SINCE_LINE);
    expect(screen.getByText(/Removing your BuySportsCards sign-in stops listing and sales\.$/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Start/)).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC syncing, listing", rerender: () => rerender() });
  });

  it("listing with no since stamp: says it plainly", () => {
    draw({ ...LISTING, listingSince: undefined });
    expect(screen.getByRole("status").textContent).toBe("Listing your boxes on BuySportsCards.");
  });

  it("paused for everyone (listing false): the paused line, not 'Not syncing'", async () => {
    const { view, rerender } = draw({ ...LISTING, listing: false, paused: true });
    expect(screen.getByRole("status").textContent).toBe(PAUSED_LINE);
    expect(screen.getAllByText(PAUSED_LINE)).toHaveLength(1);
    expect(screen.queryByText(NOT_SYNCING_LINE)).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC syncing, paused", rerender: () => rerender() });
  });

  it("paused and a dead sign-in: only the pause is said (signing in waits on it)", () => {
    draw({ ...LISTING, listing: false, paused: true, needsReauth: true });
    expect(screen.getByText(PAUSED_LINE)).toBeTruthy();
    expect(screen.queryByText(REAUTH_LINE)).toBeNull();
  });

  it("a dead sign-in: said beside the listing state", async () => {
    const { view, rerender } = draw({ ...LISTING, needsReauth: true });
    expect(screen.getByRole("status").textContent).toBe(SINCE_LINE);
    expect(screen.getByText(REAUTH_LINE)).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "BSC syncing, needs sign-in", rerender: () => rerender() });
  });

  it("a seller account that lists from another NB account: the conflict line, never 'since'", async () => {
    const { view, rerender } = draw({ ...LISTING, listing: false, sellerConflict: true });
    expect(screen.getByRole("status").textContent).toBe(SELLER_CONFLICT_LINE);
    expect(screen.queryByText(/^Listing your boxes/)).toBeNull();
    expect(screen.queryByText(/Removing your/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC syncing, seller conflict", rerender: () => rerender() });
  });

  it("saved, but not syncing for none of those reasons: a plain 'Not syncing.'", async () => {
    const { view, rerender } = draw({ ...LISTING, listing: false, listingSince: undefined });
    expect(NOT_SYNCING_LINE).toBe("Not syncing.");
    expect(screen.getByRole("status").textContent).toBe(NOT_SYNCING_LINE);
    expect(screen.queryByText(/Removing your/)).toBeNull();
    await expectAccessibleInBothModes(view.container, { label: "BSC syncing, not syncing", rerender: () => rerender() });
  });
});
