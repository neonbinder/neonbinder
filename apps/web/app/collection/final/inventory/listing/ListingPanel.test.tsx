import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import ListingPanel, { statusLine } from "./ListingPanel";
import { CONSENT_LINE, PROBLEM_COPY, problemSentence, saleItemProblem, whenSynced } from "./copy";
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
 * store is a stub: settings, one variant's status, and spies for the switch,
 * Resync and the leave-time flush. Copy is pinned where a collector reads it;
 * focus is pinned wherever a control swaps out or goes inert.
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
  setEnabled?: () => Promise<void>;
  variantId?: string;
  strict?: boolean;
}) {
  // What the stub store answers; change it and call `rerender()`.
  const state = { settings: opts.settings, status: opts.status, variantId: opts.variantId ?? "base1" };
  const notify = vi.fn();
  const setEnabled = vi.fn(opts.setEnabled ?? (async () => {}));
  const resyncVariant = vi.fn(opts.resync ?? (async () => 2));
  const flushListing = vi.fn(async () => {});
  const useVariantStatus = vi.fn(() => state.status);
  const listing: ListingExtension = {
    useSettings: () => (state.settings ? { bsc: state.settings } : undefined),
    setEnabled,
    useVariantStatus,
    resyncVariant,
    flushListing,
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
  // A fresh element each time: re-rendering the same one bails out.
  const tree = () => {
    const panel = (
      <Theme>
        <MemoryRouter>
          <CollectionStoreContext.Provider value={value}>
            <PageApiContext.Provider value={pageApi}>
              <ListingPanel variantId={state.variantId} title="Base" cards={CARDS} />
            </PageApiContext.Provider>
          </CollectionStoreContext.Provider>
        </MemoryRouter>
      </Theme>
    );
    return opts.strict ? <StrictMode>{panel}</StrictMode> : panel;
  };
  const view = render(tree());
  const rerender = () => view.rerender(tree());
  return { view, state, rerender, notify, setEnabled, resyncVariant, flushListing, useVariantStatus };
}

const flush = () => act(async () => {});
/** Lets the deferred leave (a zero-delay timer) run. */
const afterLeave = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const AT_2_14 = new Date(2026, 10, 1, 14, 14).getTime();
const IDLE: VariantListingStatus = { pending: false, run: { status: "idle", listed: 1, problems: [], problemsTotal: 0 } };

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(cleanup);

const isInert = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

describe("the listing panel", () => {
  it("draws nothing in a store with no listing (the demo)", () => {
    const { view } = setup({ settings: ON, listing: false });
    expect(view.container.textContent).toBe("");
  });

  it("listing off: the short switch says what switching on does first, and the toast only confirms", async () => {
    const { setEnabled, notify, useVariantStatus } = setup({ settings: OFF });
    // Off, it never asks for the variant's status.
    expect(useVariantStatus).toHaveBeenCalledWith(null);
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const described = toggle.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe(CONSENT_LINE);
    fireEvent.click(toggle);
    await flush();
    expect(setEnabled).toHaveBeenCalledWith("bsc", true);
    expect(notify).toHaveBeenCalledWith("Listing on BuySportsCards is on.");
  });

  it("not connected: the switch stays focusable but does nothing, and its description points at Profile", () => {
    const { setEnabled } = setup({ settings: { ...OFF, connected: false } });
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(isInert(toggle)).toBe(true);
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(false);
    const note = document.getElementById(toggle.getAttribute("aria-describedby")!);
    expect(note?.textContent).toContain("Save your BuySportsCards sign-in first.");
    const link = screen.getByRole("link", { name: "Connect BuySportsCards on your Profile" });
    expect(link.getAttribute("href")).toBe("/profile/credentials");
    // No consent line before there is a sign-in to switch on with.
    expect(screen.queryByText(CONSENT_LINE)).toBeNull();
  });

  it("while a flip is on its way the switch is aria-disabled and a second press does nothing", async () => {
    let release = () => {};
    const { setEnabled } = setup({
      settings: OFF,
      setEnabled: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(isInert(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(setEnabled).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(isInert(toggle)).toBe(false);
  });

  it("switching on parks focus on Resync once the switch swaps out", async () => {
    const { state, rerender } = setup({ settings: OFF });
    const toggle = screen.getByRole("switch", { name: "List on BuySportsCards" });
    toggle.focus();
    fireEvent.click(toggle);
    state.settings = ON;
    state.status = IDLE;
    rerender();
    await flush();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Resync Base with BuySportsCards" }));
  });

  it("a swap leaves focus alone when it was somewhere else on the page", async () => {
    const { state, rerender } = setup({ settings: OFF });
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    state.settings = ON;
    state.status = IDLE;
    rerender();
    await flush();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("switched off elsewhere while Resync had focus: focus lands on the listing group", async () => {
    const { state, rerender } = setup({ settings: ON, status: IDLE });
    screen.getByRole("button", { name: "Resync Base with BuySportsCards" }).focus();
    state.settings = OFF;
    rerender();
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "BuySportsCards listing" }));
  });

  it("listing on: says how many are listed and when it synced, and when a waiting change goes up", () => {
    setup({
      settings: ON,
      status: {
        pending: true,
        run: { status: "idle", listed: 12, lastSuccessAt: Date.now(), problems: [], problemsTotal: 0 },
      },
    });
    const line = screen.getByRole("status");
    expect(line.textContent).toMatch(
      /^12 listed on BuySportsCards\. Synced .+\. Syncing soon, when you leave this checklist or within 15 minutes\.$/,
    );
    expect(screen.queryByRole("button", { name: /Can't list on/ })).toBeNull();
  });

  it("Can't list on BuySportsCards (M) opens a list naming each card by number and player, with why", () => {
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
            { reason: "notOnSheet" },
          ],
          problemsTotal: 5,
        },
      },
    });
    const toggle = screen.getByRole("button", { name: "Can't list on BuySportsCards (5)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      `#2 Darryl Strawberry ${PROBLEM_COPY.noPrice}`,
      `#1 Doc Gooden ${PROBLEM_COPY.rejected} They said: “price below minimum”`,
      `A BuySportsCards card we can't match ${PROBLEM_COPY.notOnSheet}`,
    ]);
    expect(screen.getByText("Showing the first 3 of 5. Fix these and Resync to see the rest.")).toBeTruthy();
  });

  it("the problems list emptying while open keeps the button (and focus), then closing parks focus on Resync", async () => {
    const { state, rerender } = setup({
      settings: ON,
      status: { pending: false, run: { status: "idle", listed: 0, problems: [{ cardId: "c1", reason: "noPrice" }], problemsTotal: 1 } },
    });
    const toggle = screen.getByRole("button", { name: "Can't list on BuySportsCards (1)" });
    toggle.focus();
    fireEvent.click(toggle);
    state.status = IDLE;
    rerender();
    await flush();
    const emptied = screen.getByRole("button", { name: "Can't list on BuySportsCards (0)" });
    expect(emptied).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByText("All clear. Nothing's held back now.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /Can't list on/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Resync Base with BuySportsCards" }));
  });

  it("Resync sends the checklist again with a short confirmation, and is described by the status line", async () => {
    const { resyncVariant, notify } = setup({ settings: ON, status: IDLE });
    const button = screen.getByRole("button", { name: "Resync Base with BuySportsCards" });
    expect(button.textContent).toBe("Resync");
    const described = button.getAttribute("aria-describedby")!.split(" ");
    expect(described).toEqual([screen.getByRole("status").id]);
    fireEvent.click(button);
    await flush();
    expect(resyncVariant).toHaveBeenCalledWith("base1");
    expect(notify).toHaveBeenCalledWith("Resyncing Base with BuySportsCards.");
  });

  it("Resync keeps its focus and its words through a run, and presses do nothing meanwhile", async () => {
    let release: (n: number) => void = () => {};
    const { state, rerender, resyncVariant } = setup({
      settings: ON,
      status: IDLE,
      resync: () => new Promise<number>((resolve) => (release = resolve)),
    });
    const button = screen.getByRole("button", { name: "Resync Base with BuySportsCards" }) as HTMLButtonElement;
    button.focus();
    fireEvent.click(button);
    expect(isInert(button)).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Resync");
    fireEvent.click(button);
    expect(resyncVariant).toHaveBeenCalledTimes(1);
    state.status = { pending: false, run: { status: "running", problems: [], problemsTotal: 0 } };
    rerender();
    await act(async () => release(2));
    expect(isInert(button)).toBe(true);
    expect(document.activeElement).toBe(button);
    state.status = IDLE;
    rerender();
    await flush();
    expect(isInert(button)).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("Resync waits while a sync runs, and while BuySportsCards is paused", () => {
    const { resyncVariant } = setup({
      settings: ON,
      status: { pending: false, run: { status: "running", problems: [], problemsTotal: 0 } },
    });
    const running = screen.getByRole("button", { name: "Resync Base with BuySportsCards" });
    expect(isInert(running)).toBe(true);
    fireEvent.click(running);
    expect(resyncVariant).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("Syncing with BuySportsCards now…");
    cleanup();
    setup({ settings: { ...ON, paused: true }, status: { pending: true, run: null } });
    expect(isInert(screen.getByRole("button", { name: "Resync Base with BuySportsCards" }))).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "BuySportsCards is on a break. Changes wait here and go up when it's back.",
    );
  });

  it("a sign-in that ran out says so, with the way back, and Resync is described by it", () => {
    setup({ settings: { ...ON, needsReauth: true }, status: { pending: true, run: null } });
    const link = screen.getByRole("link", { name: "Sign in to BuySportsCards again" });
    expect(link.getAttribute("href")).toBe("/profile/credentials");
    const button = screen.getByRole("button", { name: "Resync Base with BuySportsCards" });
    expect(isInert(button)).toBe(true);
    const [statusId, reauthId] = button.getAttribute("aria-describedby")!.split(" ");
    expect(statusId).toBe(screen.getByRole("status").id);
    expect(document.getElementById(reauthId)?.contains(link)).toBe(true);
    // Nothing goes up on a dead sign-in, so the line never says "soon".
    expect(screen.getByRole("status").textContent).toBe("Waiting on your BuySportsCards sign-in to go up.");
  });
});

describe("leaving the checklist sends waiting changes up", () => {
  it("once, when the checklist closes with listing on", async () => {
    const { view, flushListing } = setup({ settings: ON, status: IDLE });
    await afterLeave();
    expect(flushListing).not.toHaveBeenCalled();
    view.unmount();
    await afterLeave();
    expect(flushListing).toHaveBeenCalledTimes(1);
  });

  it("never with listing off", async () => {
    const { view, flushListing } = setup({ settings: OFF });
    setVisibility("hidden");
    view.unmount();
    await afterLeave();
    expect(flushListing).not.toHaveBeenCalled();
  });

  it("switching to another checklist is a leave", async () => {
    const { state, rerender, flushListing } = setup({ settings: ON, status: IDLE });
    state.variantId = "insert1";
    rerender();
    await afterLeave();
    expect(flushListing).toHaveBeenCalledTimes(1);
  });

  it("hiding the tab, then closing it, is one leave; coming back starts a new one", async () => {
    const { view, flushListing } = setup({ settings: ON, status: IDLE });
    setVisibility("hidden");
    expect(flushListing).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(flushListing).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    setVisibility("hidden");
    expect(flushListing).toHaveBeenCalledTimes(2);
    view.unmount();
    await afterLeave();
    expect(flushListing).toHaveBeenCalledTimes(2);
  });

  it("pagehide alone is a leave", () => {
    const { flushListing } = setup({ settings: ON, status: IDLE });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(flushListing).toHaveBeenCalledTimes(1);
  });

  it("React's development double mount is not a leave", async () => {
    const { flushListing } = setup({ settings: ON, status: IDLE, strict: true });
    await afterLeave();
    expect(flushListing).not.toHaveBeenCalled();
  });

  it("switching listing on in the panel, then leaving, sends the first push", async () => {
    const { view, state, rerender, flushListing } = setup({ settings: OFF });
    state.settings = ON;
    state.status = IDLE;
    rerender();
    view.unmount();
    await afterLeave();
    expect(flushListing).toHaveBeenCalledTimes(1);
  });
});

describe("statusLine", () => {
  const settings = { paused: false, needsReauth: false };
  it("before the first run", () => {
    expect(statusLine(settings, { pending: false, run: null }, NOW)).toBe(
      "Not on BuySportsCards yet. Resync sends this checklist up.",
    );
    expect(statusLine(settings, { pending: true, run: null }, NOW)).toBe(
      "Going up to BuySportsCards when you leave this checklist or within 15 minutes.",
    );
  });

  it("a dead sign-in never promises soon", () => {
    const dead = { paused: false, needsReauth: true };
    expect(statusLine(dead, { pending: true, run: null }, NOW)).toBe("Waiting on your BuySportsCards sign-in to go up.");
    expect(
      statusLine(dead, { pending: true, run: { status: "idle", listed: 3, lastSuccessAt: AT_2_14, problems: [], problemsTotal: 0 } }, NOW),
    ).toBe(`3 listed on BuySportsCards. Synced ${whenSynced(AT_2_14, NOW)}. Changes wait for your sign-in.`);
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
    ).toBe(
      `3 listed on BuySportsCards. Last sent ${whenSynced(AT_2_14, NOW)}. Syncing soon, when you leave this checklist or within 15 minutes.`,
    );
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
