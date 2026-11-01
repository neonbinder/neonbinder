import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SyncStatusView, { countsLine, platformState, setKind, setLine } from "./SyncStatusView";
import SyncStatusTab from "./SyncStatusTab";
import { stubListing } from "./stubListing";
import { PAUSED_LINE, PROBLEM_COPY, REAUTH_LINE, SELLER_CONFLICT_LINE, whenSynced } from "./copy";
import { expectAccessibleInBothModes } from "@/lib/testing/axe";
import { CollectionStoreContext, type CollectionData, type CollectionStoreValue } from "../../data/store";
import {
  REAL_CAPABILITIES,
  type PlatformSyncStatus,
  type SetProblems,
  type SyncSetResult,
  type SyncStatus,
} from "../../data/types";

/**
 * NEO-370 Rev 4 — the Sync status screen: what runs now, what waits for the
 * next sync, each set's last result. Shared by Inventory → Sync status and
 * the admin's read-only copy (`readOnly`: no Profile links).
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

const T = new Date(2026, 10, 1, 14, 14).getTime();

function bsc(over: Partial<PlatformSyncStatus> = {}): PlatformSyncStatus {
  return {
    platform: "bsc",
    connected: true,
    listing: true,
    needsReauth: false,
    paused: false,
    sellerConflict: false,
    running: null,
    queued: { cards: [], more: false },
    sets: [],
    ...over,
  };
}

function set(over: Partial<SyncSetResult> = {}): SyncSetResult {
  return {
    variantId: "v1",
    setLabel: "1989 Upper Deck Base",
    status: "idle",
    lastRunAt: T,
    lastSuccessAt: T,
    counts: { listed: 12, pushed: 3, zeroed: 1, skipped: 0 },
    problemsTotal: 0,
    problems: [],
    ...over,
  };
}

const SEVEN_HELD: SyncSetResult = set({
  variantId: "v2",
  setLabel: "1990 Score Base",
  problemsTotal: 7,
  problems: [
    { reason: "noPrice", cardNo: "1", cardLabel: "Nolan Ryan" },
    { reason: "priceTooHigh", cardNo: "2", cardLabel: "Barry Bonds" },
    { reason: "sharedLink", cardNo: "3", cardLabel: "Ken Griffey Jr." },
    { reason: "rejected", cardNo: "4", cardLabel: "Frank Thomas", detail: "duplicate" },
    { reason: "noLink" },
  ],
});

function draw(status: SyncStatus, opts: { readOnly?: boolean; load?: () => Promise<SetProblems> } = {}) {
  const loadProblems = vi.fn(opts.load ?? (async () => ({ problems: [], problemsTotal: 0 })));
  const tree = () => (
    <Theme>
      <MemoryRouter>
        <SyncStatusView status={status} loadProblems={loadProblems} readOnly={opts.readOnly} />
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { view, loadProblems, rerender: () => view.rerender(tree()) };
}

const section = (name: string) => screen.getByRole("region", { name });
const flush = () => act(async () => {});

afterEach(cleanup);

describe("the Sync status screen", () => {
  it("running: says which set and when it started", async () => {
    const { view, rerender } = draw({
      platforms: [bsc({ running: { startedAt: T, setLabel: "1989 Upper Deck Base", variantId: "v1" } })],
    });
    expect(screen.getByRole("heading", { level: 2, name: "BuySportsCards" })).toBeTruthy();
    expect(screen.getByText("Listing")).toBeTruthy();
    expect(within(section("Running now")).getByText(/Syncing/).textContent).toBe(
      `Syncing 1989 Upper Deck Base with BuySportsCards, started ${whenSynced(T)}.`,
    );
    await expectAccessibleInBothModes(view.container, { label: "Sync status, running", rerender });
  });

  it("nothing running: the last sync and the next round", () => {
    draw({ platforms: [bsc({ lastDrainAt: T, scheduledAt: T + 15 * 60_000 })] });
    expect(within(section("Running now")).getByText(/^Nothing syncing right now\./).textContent).toBe(
      `Nothing syncing right now. Last sync finished ${whenSynced(T)}. Next round around ${whenSynced(T + 15 * 60_000)}.`,
    );
  });

  it("queued: each card with its set and when, oldest first; capped says 'and more'", async () => {
    const { view, rerender } = draw({
      platforms: [
        bsc({
          queued: {
            cards: [
              { cardId: "c1", cardNo: "1", cardLabel: "Ken Griffey Jr.", variantId: "v1", setLabel: "1989 Upper Deck Base", changedAt: T },
              { cardId: "c2", cardNo: "17", variantId: "v1", setLabel: "1989 Upper Deck Base", changedAt: T + 1 },
              // Gone from the catalog, set and all: no number, no name.
              { cardId: "c3", variantId: "v9", setLabel: "A set no longer in NeonBinder", changedAt: T + 2 },
            ],
            more: true,
          },
        }),
      ],
    });
    const queue = section("Queued for the next sync (3+)");
    const items = within(queue).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `#1 Ken Griffey Jr. in 1989 Upper Deck Basequeued ${whenSynced(T)}`,
      `#17 in 1989 Upper Deck Basequeued ${whenSynced(T + 1)}`,
      `A card no longer in NeonBinder in A set no longer in NeonBinderqueued ${whenSynced(T + 2)}`,
    ]);
    expect(within(queue).getByText(/^And more\./)).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "Sync status, queue capped", rerender });
  });

  it("sets with problems: the first five inline with reasons; 'Show all' loads the rest once, on demand", async () => {
    const all: SetProblems = {
      problemsTotal: 7,
      problems: [
        ...SEVEN_HELD.problems,
        { reason: "graded", cardNo: "6", cardLabel: "Cal Ripken Jr." },
        { reason: "noCondition", cardNo: "7", cardLabel: "Tony Gwynn" },
      ],
    };
    const { view, loadProblems, rerender } = draw(
      { platforms: [bsc({ sets: [set(), SEVEN_HELD, set({ variantId: "v3", setLabel: "1991 Fleer Base", status: "error", lastSuccessAt: undefined, lastError: "BuySportsCards timed out", counts: undefined })] })] },
      { load: async () => all },
    );
    const rows = within(section("Last sync by set")).getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain(`Synced ${whenSynced(T)}.`);
    expect(rows[0].textContent).toContain("12 listed, 3 updated, 1 taken to 0");
    expect(rows[1].textContent).toContain("7 held back:");
    expect(rows[1].textContent).toContain(`#1 Nolan Ryan ${PROBLEM_COPY.noPrice}`);
    expect(rows[1].textContent).toContain("They said: “duplicate”");
    expect(rows[1].textContent).toContain("A BuySportsCards card we can't match");
    expect(rows[2].textContent).toContain(`Hit a snag ${whenSynced(T)}: BuySportsCards timed out. The next round tries again.`);
    await expectAccessibleInBothModes(view.container, { label: "Sync status, sets with problems", rerender });

    const more = screen.getByRole("button", { name: "Show all 7 held back in 1990 Score Base" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(loadProblems).toHaveBeenCalledWith("v2", "bsc");
    await flush();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(more.getAttribute("aria-controls")!)!;
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    expect(list.textContent).toContain("#7 Tony Gwynn");
    await expectAccessibleInBothModes(view.container, { label: "Sync status, held-back list open", rerender });
    // Closing and opening again reads nothing new.
    fireEvent.click(more);
    fireEvent.click(more);
    expect(loadProblems).toHaveBeenCalledTimes(1);
  });

  it("a held-back list that fails to load says so", async () => {
    draw({ platforms: [bsc({ sets: [SEVEN_HELD] })] }, { load: async () => Promise.reject(new Error("nope")) });
    fireEvent.click(screen.getByRole("button", { name: "Show all 7 held back in 1990 Score Base" }));
    await flush();
    expect(screen.getByText(/^Couldn.t pull the full list\./)).toBeTruthy();
  });

  it("empty: nothing queued, no sets yet, in NB's words", async () => {
    const { view, rerender } = draw({ platforms: [bsc()] });
    expect(within(section("Queued for the next sync")).getByText("Nothing waiting. Your boxes and BuySportsCards are square.")).toBeTruthy();
    expect(within(section("Last sync by set")).getByText(/^No sets synced yet\./)).toBeTruthy();
    expect(within(section("Running now")).getByText(/No sync has run yet\./)).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "Sync status, empty", rerender });
  });

  it("no platforms at all: the way to the Profile (and none in the admin's copy)", () => {
    draw({ platforms: [] });
    expect(screen.getByRole("link", { name: "Save a sign-in on your Profile" }).getAttribute("href")).toBe("/profile/credentials");
    cleanup();
    draw({ platforms: [] }, { readOnly: true });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("each platform state says what to do, with a Profile link only for the collector", async () => {
    const cases: [Partial<PlatformSyncStatus>, string, string | RegExp, string | null][] = [
      [{ connected: false, listing: false }, "Not connected", /^No BuySportsCards sign-in saved/, "Connect BuySportsCards on your Profile"],
      [{ listing: false }, "Not started", /^Your sign-in is saved, but listing hasn.t started\./, "Start listing on BuySportsCards from your Profile"],
      [{ needsReauth: true }, "Needs sign-in", REAUTH_LINE, "Sign in to BuySportsCards again"],
      [{ paused: true }, "On a break", PAUSED_LINE, null],
      [{ sellerConflict: true }, "Seller account in use", SELLER_CONFLICT_LINE, null],
    ];
    for (const [over, word, line, link] of cases) {
      const { view, rerender } = draw({ platforms: [bsc(over)] });
      expect(screen.getByText(word)).toBeTruthy();
      expect(screen.getByText(line instanceof RegExp ? line : (t) => t.startsWith(line))).toBeTruthy();
      if (link) expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/profile/credentials");
      await expectAccessibleInBothModes(view.container, { label: `Sync status, ${word}`, rerender });
      cleanup();
      draw({ platforms: [bsc(over)] }, { readOnly: true });
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
  });

  it("the pure helpers: glyph, line and counts", () => {
    expect(setKind({ status: "running", problemsTotal: 3 })).toBe("building");
    expect(setKind({ status: "error", problemsTotal: 0 })).toBe("failed");
    expect(setKind({ status: "idle", problemsTotal: 2 })).toBe("blocked");
    expect(setKind({ status: "idle", problemsTotal: 0 })).toBe("built");
    expect(setLine(set({ status: "running" }), "bsc")).toBe("Syncing now…");
    expect(setLine(set({ lastSuccessAt: undefined, lastRunAt: undefined }), "bsc")).toBe("Not synced yet.");
    expect(setLine(set({ status: "error", lastError: undefined, lastRunAt: undefined }), "bsc")).toBe(
      "Hit a snag: BuySportsCards didn't answer. The next round tries again.",
    );
    expect(countsLine({ listed: 0, pushed: 0, zeroed: 0, skipped: 2 })).toBe("0 listed, 2 skipped");
    expect(countsLine(undefined)).toBeNull();
    expect(platformState(bsc()).word).toBe("Listing");
  });
});

describe("the Sync status tab", () => {
  function tab(status: SyncStatus | undefined, listing = true) {
    const value = {
      kind: "convex",
      capabilities: REAL_CAPABILITIES,
      data: {} as CollectionData,
      actions: {},
      ...(listing ? { listing: stubListing({ useSyncStatus: () => status }) } : {}),
    } as CollectionStoreValue;
    return render(
      <Theme>
        <MemoryRouter>
          <CollectionStoreContext.Provider value={value}>
            <SyncStatusTab />
          </CollectionStoreContext.Provider>
        </MemoryRouter>
      </Theme>,
    );
  }

  it("draws nothing in a store with no listing (the demo)", () => {
    expect(tab(undefined, false).container.textContent).toBe("");
  });

  it("loading shows a skeleton, then the platform", () => {
    const view = tab(undefined);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    tab({ platforms: [bsc()] });
    expect(screen.getByRole("heading", { level: 2, name: "BuySportsCards" })).toBeTruthy();
  });
});
