import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SyncButton, { NOT_LISTING_LINE, syncToast } from "./SyncButton";
import { LISTING, NOT_SYNCING, stubListing } from "./stubListing";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import { PageApiContext, type PageApi } from "../../pageApi";
import { CollectionStoreContext, type CollectionData, type CollectionStoreValue } from "../../data/store";
import { REAL_CAPABILITIES, type ListingPlatformSettings, type SyncVariantResult } from "../../data/types";

/**
 * NEO-370 Rev 4/5 — the checklist header's Sync: one press, every platform
 * the collector lists on, the outcome on the status line. Inert with its
 * reason (never native disabled) while nothing lists anywhere (no saved,
 * unpaused sign-in: Rev 5 has no Start); hidden in the demo.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

function setup(opts: {
  settings?: ListingPlatformSettings | null;
  sync?: () => Promise<SyncVariantResult>;
  listing?: boolean;
}) {
  const notify = vi.fn();
  const syncVariant = vi.fn(opts.sync ?? (async () => ({ queued: true })));
  const listing = stubListing({
    useSettings: () => (opts.settings === null ? undefined : { bsc: opts.settings ?? LISTING }),
    syncVariant,
  });
  const value = {
    kind: "convex",
    capabilities: REAL_CAPABILITIES,
    data: {} as CollectionData,
    actions: {},
    ...(opts.listing === false ? {} : { listing }),
  } as CollectionStoreValue;
  const pageApi = { notify, inform: vi.fn() } as unknown as PageApi;
  const tree = () => (
    <Theme>
      <MemoryRouter>
        <CollectionStoreContext.Provider value={value}>
          <PageApiContext.Provider value={pageApi}>
            <SyncButton variantId="base1" title="1989 Upper Deck Base" />
          </PageApiContext.Provider>
        </CollectionStoreContext.Provider>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { view, notify, syncVariant, rerender: () => view.rerender(tree()) };
}

const button = () => screen.getByRole("button", { name: "Sync 1989 Upper Deck Base" });
const flush = () => act(async () => {});

afterEach(cleanup);

describe("the checklist's Sync button", () => {
  it("is not there in a store that lists nowhere (the demo)", () => {
    const { view } = setup({ listing: false });
    expect(view.container.textContent).toBe("");
  });

  it("listing: a press syncs this set and the toast points to Sync status", async () => {
    const { notify, syncVariant } = setup({});
    expect(button().getAttribute("aria-disabled")).toBeNull();
    expect(button().getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(button());
    expect(syncVariant).toHaveBeenCalledWith("base1");
    // Busy while the press is out: a second one does nothing.
    expect(button().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button());
    expect(syncVariant).toHaveBeenCalledTimes(1);
    await flush();
    expect(notify).toHaveBeenCalledWith("Syncing 1989 Upper Deck Base now. Watch it on Sync status.");
    expect(button().getAttribute("aria-busy")).toBeNull();
  });

  it("a press within the throttle says to give it a minute", async () => {
    const { notify } = setup({ sync: async () => ({ queued: false, ignored: "throttled" }) });
    fireEvent.click(button());
    await flush();
    expect(notify).toHaveBeenCalledWith("1989 Upper Deck Base just synced. Give it a minute, then Sync again.");
  });

  it("a server that says nothing lists points to the Profile", async () => {
    const { notify } = setup({ sync: async () => ({ queued: false, ignored: "notListing" }) });
    fireEvent.click(button());
    await flush();
    expect(notify).toHaveBeenCalledWith(NOT_LISTING_LINE);
  });

  it("a refusal says the server's words", async () => {
    const { notify } = setup({
      sync: async () => {
        throw new Error("Signed out");
      },
    });
    fireEvent.click(button());
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toMatch(/Signed out/);
  });

  it("nothing lists: shown, inert (never native disabled), the reason its description; a press says it and sends nothing", () => {
    const { notify, syncVariant } = setup({ settings: NOT_SYNCING });
    const b = button();
    expect(b.hasAttribute("disabled")).toBe(false);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(b.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe(NOT_LISTING_LINE);
    // Rev 5: no Start to point at; saving a sign-in is what syncs.
    expect(NOT_LISTING_LINE).toBe("Nothing to sync to yet. Save a marketplace sign-in on your Profile.");
    fireEvent.click(b);
    expect(syncVariant).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(NOT_LISTING_LINE);
  });

  it("no sign-in saved, or the platform paused: inert with the same reason", () => {
    for (const settings of [
      { ...NOT_SYNCING, connected: false },
      { ...NOT_SYNCING, paused: true },
    ]) {
      setup({ settings });
      expect(button().getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(button().getAttribute("aria-describedby")!)?.textContent).toBe(NOT_LISTING_LINE);
      cleanup();
    }
  });

  it("while the settings load it is inert and busy, and a press does nothing", () => {
    const { notify, syncVariant } = setup({ settings: null });
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button());
    expect(syncVariant).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes axe in light and dark, listing and inert", async () => {
    const live = setup({});
    await expectAccessibleInBothModes(live.view.container, { label: "Sync button, listing", rerender: live.rerender });
    cleanup();
    const inert = setup({ settings: NOT_SYNCING });
    await expectAccessibleInBothModes(inert.view.container, { label: "Sync button, nothing lists", rerender: inert.rerender });
  });

  it("syncToast covers each answer", () => {
    expect(syncToast("Base", { queued: true })).toBe("Syncing Base now. Watch it on Sync status.");
    expect(syncToast("Base", { queued: false, ignored: "notListing" })).toBe(NOT_LISTING_LINE);
    expect(syncToast("Base", { queued: false })).toBe(
      "Nothing in Base links to a marketplace you list on, so there's nothing to sync.",
    );
  });
});
