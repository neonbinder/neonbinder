import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SyncStatusView, { countsLine, platformState, setKind, setLine } from "./SyncStatusView";
import SyncStatusTab, { finishedLine } from "./SyncStatusTab";
import { stubListing } from "./stubListing";
import {
  PAUSED_LINE,
  PAUSED_LINE_READ_ONLY,
  PROBLEM_COPY,
  PROBLEM_COPY_READ_ONLY,
  REAUTH_LINE,
  REAUTH_LINE_READ_ONLY,
  SELLER_CONFLICT_LINE,
  problemSentence,
  whenSynced,
} from "./copy";
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
 * the admin's read-only copy (`readOnly`: no Profile links, and every line
 * about the collector rather than to them).
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

/** A platform's part, by its heading (the parts are plain sections, not named regions). */
const section = (name: string) => screen.getByRole("heading", { name }).closest("section") as HTMLElement;
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
    expect(more.textContent).toBe("Show all 7 held back");
    fireEvent.click(more);
    expect(loadProblems).toHaveBeenCalledWith("v2", "bsc");
    await flush();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // Open: the words say what a press does now; the name stays put.
    expect(more.textContent).toBe("Show fewer");
    expect(screen.getByRole("button", { name: "Show all 7 held back in 1990 Score Base" })).toBe(more);
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

  it("the platform's parts are not landmarks; the only regions are the platforms", () => {
    draw({ platforms: [bsc({ sets: [set()] })] });
    expect(screen.getAllByRole("region").map((r) => r.querySelector("h2")?.textContent)).toEqual(["BuySportsCards"]);
    expect(screen.getByRole("list", { name: "Last sync by set" })).toBeTruthy();
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
    expect(screen.getByText(/and syncing starts on its own\.$/)).toBeTruthy();
    cleanup();
    draw({ platforms: [] }, { readOnly: true });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("each platform state says what to do, with a Profile link only for the collector", async () => {
    // Rev 5: a saved, unpaused sign-in IS listing, so a pause (or a dead
    // sign-in) arrives with listing false and must still read as itself.
    const cases: [Partial<PlatformSyncStatus>, string, string | RegExp | null, string | null][] = [
      [{ connected: false, listing: false }, "Not connected", /^No BuySportsCards sign-in saved/, "Connect BuySportsCards on your Profile"],
      [{ needsReauth: true }, "Needs sign-in", REAUTH_LINE, "Sign in to BuySportsCards again"],
      [{ needsReauth: true, listing: false }, "Needs sign-in", REAUTH_LINE, "Sign in to BuySportsCards again"],
      [{ paused: true, listing: false }, "On a break", PAUSED_LINE, null],
      [{ sellerConflict: true, listing: false }, "Seller account in use", SELLER_CONFLICT_LINE, null],
      // Saved, none of the above, not listing: a testing account. No line, no link.
      [{ listing: false }, "Not syncing", null, null],
    ];
    for (const [over, word, line, link] of cases) {
      const { view, rerender } = draw({ platforms: [bsc(over)] });
      expect(screen.getByText(word)).toBeTruthy();
      expect(screen.queryByText("Not started")).toBeNull();
      if (line) expect(screen.getByText(line instanceof RegExp ? line : (t) => t.startsWith(line))).toBeTruthy();
      if (!link) expect(screen.queryByRole("link")).toBeNull();
      if (link) expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/profile/credentials");
      await expectAccessibleInBothModes(view.container, { label: `Sync status, ${word}`, rerender });
      cleanup();
      draw({ platforms: [bsc(over)] }, { readOnly: true });
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
  });

  it("the admin's copy never talks to the collector: no 'you', no 'Press', no 'on your Profile'", async () => {
    // Every line the collector reads as an instruction or as "your", each in
    // its own state (one platform per render).
    const TO_THE_COLLECTOR = /\b(you|your|yours|press|pick one|set a common price)\b|on your profile/i;
    const NO_PRICE_SET = set({
      problemsTotal: 4,
      problems: [
        { reason: "noPrice", cardNo: "1", cardLabel: "Nolan Ryan" },
        { reason: "sharedLink", cardNo: "3", cardLabel: "Ken Griffey Jr." },
        { reason: "noCondition", cardNo: "5", cardLabel: "Bo Jackson" },
        { reason: "rejected", cardNo: "7", detail: "duplicate" },
      ],
    });
    const states: SyncStatus[] = [
      { platforms: [] },
      { platforms: [bsc()] },
      { platforms: [bsc({ connected: false, listing: false })] },
      { platforms: [bsc({ needsReauth: true, listing: false })] },
      { platforms: [bsc({ paused: true, listing: false })] },
      { platforms: [bsc({ sellerConflict: true, listing: false })] },
      { platforms: [bsc({ sets: [NO_PRICE_SET] })] },
    ];
    for (const status of states) {
      const { view } = draw(status, { readOnly: true });
      expect(view.container.textContent).not.toMatch(TO_THE_COLLECTOR);
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
    // What it says instead.
    const { view, rerender } = draw({ platforms: [bsc()] }, { readOnly: true });
    expect(within(section("Queued for the next sync")).getByText("Nothing waiting. Their boxes and BuySportsCards are square.")).toBeTruthy();
    expect(within(section("Last sync by set")).getByText("No sets synced yet.")).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "Admin Sync status, empty", rerender });
    cleanup();
    draw({ platforms: [bsc({ paused: true, listing: false })] }, { readOnly: true });
    expect(screen.getByText(PAUSED_LINE_READ_ONLY)).toBeTruthy();
    cleanup();
    draw({ platforms: [bsc({ needsReauth: true })] }, { readOnly: true });
    expect(screen.getByText(REAUTH_LINE_READ_ONLY)).toBeTruthy();
    cleanup();
    draw({ platforms: [bsc({ sets: [NO_PRICE_SET] })] }, { readOnly: true });
    for (const reason of ["noPrice", "sharedLink", "noCondition"] as const) {
      expect(screen.getByText(PROBLEM_COPY_READ_ONLY[reason], { exact: false })).toBeTruthy();
      expect(screen.queryByText(PROBLEM_COPY[reason], { exact: false })).toBeNull();
    }
    // Every reason, said read-only, is about the card, never to its owner.
    for (const reason of Object.keys(PROBLEM_COPY) as (keyof typeof PROBLEM_COPY)[]) {
      expect(problemSentence({ reason, detail: "duplicate" }, true)).not.toMatch(TO_THE_COLLECTOR);
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

  it("says once, politely, when one of my sets finishes or hits a snag; queue churn says nothing", () => {
    const running = (over: Partial<SyncSetResult> = {}) => set({ status: "running", ...over });
    const before: SyncStatus = {
      platforms: [bsc({ sets: [running(), running({ variantId: "v3", setLabel: "1991 Fleer Base" }), set({ variantId: "v4" })] })],
    };
    const after: SyncStatus = {
      platforms: [
        bsc({
          sets: [
            set(),
            set({ variantId: "v3", setLabel: "1991 Fleer Base", status: "error" }),
            set({ variantId: "v4" }),
          ],
        }),
      ],
    };
    expect(finishedLine(before, after)).toBe(
      "1989 Upper Deck Base finished syncing with BuySportsCards. 1991 Fleer Base hit a snag syncing with BuySportsCards.",
    );
    // Nothing was running: nothing to say (a queued card coming or going included).
    const churn: SyncStatus = {
      platforms: [bsc({ sets: [set()], queued: { cards: [{ cardId: "c1", variantId: "v1", setLabel: "x", changedAt: T }], more: false } })],
    };
    expect(finishedLine({ platforms: [bsc({ sets: [set()] })] }, churn)).toBe("");
    expect(finishedLine(undefined, after)).toBe("");

    let current: SyncStatus = before;
    const value = {
      kind: "convex",
      capabilities: REAL_CAPABILITIES,
      data: {} as CollectionData,
      actions: {},
      listing: stubListing({ useSyncStatus: () => current }),
    } as CollectionStoreValue;
    const tree = () => (
      <Theme>
        <MemoryRouter>
          <CollectionStoreContext.Provider value={value}>
            <SyncStatusTab />
          </CollectionStoreContext.Provider>
        </MemoryRouter>
      </Theme>
    );
    const view = render(tree());
    const line = () => view.container.querySelector("div.space-y-4 > p[role='status']")!;
    expect(line().textContent).toBe("");
    current = after;
    view.rerender(tree());
    expect(line().textContent).toBe(finishedLine(before, after));
    // A later read with nothing newly finished keeps the line (no re-announce, no clear).
    current = { platforms: [bsc({ sets: after.platforms[0].sets })] };
    view.rerender(tree());
    expect(line().textContent).toBe(finishedLine(before, after));
  });

  it("loading shows a skeleton, then the platform", () => {
    const view = tab(undefined);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    tab({ platforms: [bsc()] });
    expect(screen.getByRole("heading", { level: 2, name: "BuySportsCards" })).toBeTruthy();
  });
});
