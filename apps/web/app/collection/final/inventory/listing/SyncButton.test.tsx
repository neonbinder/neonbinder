import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SyncButton, { NOT_LISTING_LINE, syncToast } from "./SyncButton";
import { SYNC_STATUS_LINK } from "./ListingGate";
import { CollectionModeProvider } from "../../mode";
import { LISTING, NOT_CONNECTED, NOT_SYNCING, stubListing } from "./stubListing";
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
  /** The listing gate's `syncing` (NEO-370): the collector is set up for syncing. Default true. */
  syncing?: boolean;
}) {
  let variant = { id: "base1", title: "1989 Upper Deck Base" };
  const notify = vi.fn();
  const syncVariant = vi.fn(opts.sync ?? (async () => ({ queued: true })));
  const listing = stubListing({
    useSettings: () => (opts.settings === null ? undefined : { bsc: opts.settings ?? LISTING, ebay: NOT_CONNECTED }),
    syncVariant,
    useGate: () => ({ syncing: opts.syncing ?? true, applies: false, commonPriceCents: null }),
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
      <MemoryRouter initialEntries={["/inventory?tab=checklists"]}>
        <CollectionModeProvider mode="app" surface="inventory">
          <CollectionStoreContext.Provider value={value}>
            <PageApiContext.Provider value={pageApi}>
              <SyncButton variantId={variant.id} title={variant.title} />
            </PageApiContext.Provider>
          </CollectionStoreContext.Provider>
        </CollectionModeProvider>
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return {
    view,
    notify,
    syncVariant,
    rerender: () => view.rerender(tree()),
    /** The checklist moves on to another set (the header stays mounted). */
    showSet: (id: string, title: string) => {
      variant = { id, title };
      view.rerender(tree());
    },
  };
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
    expect(notify).toHaveBeenCalledWith("1989 Upper Deck Base is already in the works. Give it a minute, then Sync again.");
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
    expect(NOT_LISTING_LINE).toBe("Nothing to sync to yet. Connect a marketplace on your Profile.");
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

  describe("\"See what's syncing\" (Jason, 2026-11-01)", () => {
    const link = () => screen.queryByRole("link", { name: SYNC_STATUS_LINK });

    it("appears after a press, in a live region, and goes to Inventory → Sync status", async () => {
      setup({});
      expect(link()).toBeNull();
      // The region is there before the press, so what lands in it is announced.
      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");
      fireEvent.click(button());
      await flush();
      const a = link();
      expect(a).not.toBeNull();
      expect(region.contains(a)).toBe(true);
      expect(new URL(a!.getAttribute("href")!, "http://x").searchParams.get("tab")).toBe("sync");
      // A real link: a Tab stop of its own, right after Sync.
      expect(a!.tabIndex).toBe(0);
      expect(button().compareDocumentPosition(a!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("says \"Sync started.\" first when the press set a run going; a throttled press shows the link alone", async () => {
      setup({});
      fireEvent.click(button());
      await flush();
      expect(screen.getByRole("status").textContent).toBe(`Sync started. ${SYNC_STATUS_LINK}`);
      cleanup();
      setup({ sync: async () => ({ queued: false, ignored: "throttled" }) });
      fireEvent.click(button());
      await flush();
      expect(screen.getByRole("status").textContent).toBe(SYNC_STATUS_LINK);
    });

    it("a refused press takes the link away", async () => {
      let fail = false;
      setup({
        sync: async () => {
          if (fail) throw new Error("Signed out");
          return { queued: true };
        },
      });
      fireEvent.click(button());
      await flush();
      expect(link()).not.toBeNull();
      fail = true;
      fireEvent.click(button());
      await flush();
      expect(link()).toBeNull();
    });

    it("never carries over to another set the checklist moves on to", async () => {
      const s = setup({});
      fireEvent.click(button());
      await flush();
      expect(link()).not.toBeNull();
      s.showSet("base2", "1990 Upper Deck Base");
      expect(screen.getByRole("button", { name: "Sync 1990 Upper Deck Base" })).toBeTruthy();
      expect(link()).toBeNull();
    });

    it("is not there for a collector who is not set up for syncing, pressed or not", async () => {
      setup({ syncing: false });
      fireEvent.click(button());
      await flush();
      expect(link()).toBeNull();
    });

    it("is not there before a press, or after a press that went nowhere (nothing lists)", async () => {
      setup({ settings: NOT_SYNCING, syncing: false });
      expect(link()).toBeNull();
      fireEvent.click(button());
      await flush();
      expect(link()).toBeNull();
    });

    it("passes axe in light and dark with the link showing", async () => {
      const s = setup({});
      fireEvent.click(button());
      await flush();
      expect(link()).not.toBeNull();
      await expectAccessibleInBothModes(s.view.container, { label: "Sync button, after a press", rerender: s.rerender });
    });
  });

  it("syncToast covers each answer", () => {
    expect(syncToast("Base", { queued: true })).toBe("Syncing Base now. Watch it on Sync status.");
    expect(syncToast("Base", { queued: false, ignored: "throttled" })).toBe("Base is already in the works. Give it a minute, then Sync again.");
    expect(syncToast("Base", { queued: false, ignored: "notListing" })).toBe(NOT_LISTING_LINE);
    expect(syncToast("Base", { queued: false })).toBe(
      "Nothing in Base links to a marketplace you list on, so there's nothing to sync.",
    );
  });
});
