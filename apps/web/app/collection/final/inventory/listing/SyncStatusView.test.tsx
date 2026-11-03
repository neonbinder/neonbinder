import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Theme } from "@radix-ui/themes";
import SyncStatusView, { countsLine, foldedLines, platformState, runLines, setKind, setLine, stepKind } from "./SyncStatusView";
import SyncStatusTab from "./SyncStatusTab";
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
  stepLabels,
  stepName,
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
  type SyncStep,
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
    { reason: "rejected", cardNo: "4", cardLabel: "Frank Thomas", detail: "NeonBinder sent 2 for Near Mint, but the listing didn't take it." },
    { reason: "noLink" },
  ],
});

function draw(
  status: SyncStatus,
  opts: { readOnly?: boolean; load?: () => Promise<SetProblems>; unfinished?: PlatformSyncStatus["platform"][] } = {},
) {
  const loadProblems = vi.fn(opts.load ?? (async () => ({ problems: [], problemsTotal: 0 })));
  const tree = () => (
    <Theme>
      <MemoryRouter>
        <SyncStatusView
          status={status}
          loadProblems={loadProblems}
          readOnly={opts.readOnly}
          unfinishedSetup={opts.unfinished}
        />
      </MemoryRouter>
    </Theme>
  );
  const view = render(tree());
  return { view, loadProblems, rerender: () => view.rerender(tree()) };
}

/** A platform's part, by its heading (the parts are plain sections, not named regions). */
const section = (name: string) => screen.getByRole("heading", { name }).closest("section") as HTMLElement;
const flush = () => act(async () => {});
/** The screen's one run line: the view's first polite region (each set row's own comes after). */
const runLine = () => screen.getAllByRole("status")[0];

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
    expect(rows[1].textContent).toContain(
      "BuySportsCards turned this one down. NeonBinder sent 2 for Near Mint, but the listing didn't take it.",
    );
    expect(rows[1].textContent).not.toContain("They said");
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
      [{ connected: false, listing: false }, "Not connected", /^No BuySportsCards sign-in saved/, "Connect BuySportsCards in Profile → Credentials"],
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
      if (link) expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("/profile/credentials?platform=buysportscards");
      await expectAccessibleInBothModes(view.container, { label: `Sync status, ${word}`, rerender });
      cleanup();
      draw({ platforms: [bsc(over)] }, { readOnly: true });
      expect(screen.queryByRole("link")).toBeNull();
      cleanup();
    }
  });

  it("NEO-415: eBay not connected points at Profile → Credentials → eBay, in words and link", () => {
    draw({ platforms: [bsc({ platform: "ebay", connected: false, listing: false })] });
    const link = screen.getByRole("link", { name: "Connect eBay in Profile → Credentials" });
    expect(link.getAttribute("href")).toBe("/profile/credentials?platform=ebay");
    expect(screen.queryByText(/on your Profile/)).toBeNull();
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

  it("BSC and eBay runs ending in one read are one sentence in one polite line; queue churn says nothing", () => {
    const bscSteps = (last: SyncStep["status"]): SyncStep[] => [
      { kind: "read", condition: "Near Mint", status: "done" },
      { kind: "send", status: "done" },
      { kind: "confirm", condition: "Near Mint", status: last },
    ];
    const ebaySteps = (last: SyncStep["status"]): SyncStep[] => [
      { kind: "photos", status: "done" },
      { kind: "items", status: "done" },
      { kind: "offers", status: last },
    ];
    const before: SyncStatus = {
      platforms: [
        bsc({
          running: { startedAt: T, setLabel: "1989 Upper Deck Base", variantId: "v1", steps: bscSteps("working") },
          sets: [set({ status: "running", steps: bscSteps("working") })],
        }),
        bsc({
          platform: "ebay",
          running: { startedAt: T, setLabel: "1988 Topps Base", variantId: "v8", steps: ebaySteps("working") },
          sets: [set({ variantId: "v8", setLabel: "1988 Topps Base", status: "running", steps: ebaySteps("working") })],
        }),
      ],
    };
    // One read: both runs gone, BSC's last check landed, eBay's offers hit a snag.
    const after: SyncStatus = {
      platforms: [
        bsc({ sets: [set({ steps: bscSteps("done") })] }),
        bsc({
          platform: "ebay",
          sets: [set({ variantId: "v8", setLabel: "1988 Topps Base", status: "error", steps: ebaySteps("failed") })],
        }),
      ],
    };
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
    // One run line for the whole screen: none per platform, and the tab adds none of its own.
    const runLines = () => screen.getAllByRole("status").filter((el) => !el.closest("li"));
    expect(runLines()).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "BuySportsCards" })).queryAllByRole("status")).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "eBay" })).queryAllByRole("status")).toHaveLength(0);
    expect(runLine().textContent).toBe("");

    current = after;
    view.rerender(tree());
    expect(runLine().textContent).toBe(
      "Synced 1989 Upper Deck Base with BuySportsCards. 3 of 3 steps done. Set prices hit a snag.",
    );
    // A later read with nothing new, and a queued card coming and going, say nothing (no re-announce, no clear).
    current = {
      platforms: [
        bsc({
          sets: after.platforms[0].sets,
          queued: { cards: [{ cardId: "c1", variantId: "v1", setLabel: "x", changedAt: T }], more: false },
        }),
        after.platforms[1],
      ],
    };
    view.rerender(tree());
    expect(runLine().textContent).toBe(
      "Synced 1989 Upper Deck Base with BuySportsCards. 3 of 3 steps done. Set prices hit a snag.",
    );
  });

  it("loading shows a skeleton, then the platform", () => {
    const view = tab(undefined);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    tab({ platforms: [bsc()] });
    expect(screen.getByRole("heading", { level: 2, name: "BuySportsCards" })).toBeTruthy();
  });

  it("NEO-415: eBay beside BSC, its setup unfinished, its own reasons and its own Profile page", async () => {
    const { view, rerender } = draw(
      {
        platforms: [
          bsc(),
          bsc({
            platform: "ebay",
            sets: [
              set({
                problemsTotal: 3,
                problems: [
                  { reason: "noPhoto", cardNo: "1", cardLabel: "Ken Griffey Jr." },
                  { reason: "missingAspect", cardNo: "2", detail: "Team" },
                  { reason: "setupIncomplete", cardNo: "3" },
                ],
              }),
            ],
          }),
        ],
      },
      { unfinished: ["ebay"] },
    );
    const ebay = screen.getByRole("region", { name: "eBay" });
    expect(within(ebay).getByText("Setup unfinished")).toBeTruthy();
    // Held back for setup: the line says where eBay's settings live now.
    expect(within(ebay).getByText(/Finish your eBay setup in Profile → Credentials → eBay and this one goes up\./)).toBeTruthy();
    expect(within(ebay).getByRole("link", { name: "Finish your eBay setup" }).getAttribute("href")).toBe("/profile/credentials?platform=ebay");
    expect(within(ebay).getByText(/eBay listings need a photo/)).toBeTruthy();
    expect(within(ebay).getByText("eBay wants this card's Team, and we don't have it yet, so it's held back.", { exact: false })).toBeTruthy();
    // BSC reads as before.
    expect(within(screen.getByRole("region", { name: "BuySportsCards" })).getByText("Listing")).toBeTruthy();
    await expectAccessibleInBothModes(view.container, { label: "Sync status, eBay unfinished", rerender });
  });
});

/**
 * NEO-415 — the run's steps as a check-mark ledger: each condition read, the
 * one send, each condition checked back (eBay: photos, items, offers,
 * publish, take down). Labels are NB's own words with NB's condition names;
 * each step is a list item named "label, state", in a list named for the set
 * and platform, and one polite line says each step as it lands.
 */
describe("the sync steps ledger", () => {
  const BSC_RUN: SyncStep[] = [
    { kind: "read", condition: "Near Mint", status: "done" },
    { kind: "read", condition: "Excellent", status: "working" },
    { kind: "send", status: "waiting" },
    { kind: "confirm", condition: "Near Mint", status: "waiting" },
  ];
  const runningBsc = (steps: SyncStep[]) =>
    bsc({
      running: { startedAt: T, setLabel: "1989 Upper Deck Base", variantId: "v1", steps },
      sets: [set({ status: "running", steps })],
    });

  const names = (list: HTMLElement) =>
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label"));

  it("running: each step under Running now, named label and state, in run order", async () => {
    const { view, rerender } = draw({ platforms: [runningBsc(BSC_RUN)] });
    const list = within(section("Running now")).getByRole("list", {
      name: "Sync steps for 1989 Upper Deck Base on BuySportsCards",
    });
    expect(names(list)).toEqual([
      "Read Near Mint, done",
      "Read Excellent, working",
      "Send changes to BuySportsCards, waiting",
      "Double-check Near Mint, waiting",
    ]);
    // Each item's own words say the same (a reader in browse mode hears the content).
    expect(within(list).getByRole("listitem", { name: "Read Near Mint, done" }).textContent).toBe("Read Near Mint, done");
    // The running set's row does not draw the same ledger twice.
    expect(within(section("Last sync by set")).queryByRole("list", { name: /steps for/ })).toBeNull();
    expect(screen.getAllByRole("list", { name: /steps for 1989 Upper Deck Base/ })).toHaveLength(1);
    await expectAccessibleInBothModes(view.container, { label: "Sync status, steps running", rerender });
  });

  it("last sync: each set row keeps its last run's steps, reads folded, the failed one marked", async () => {
    const { view, rerender } = draw({
      platforms: [
        bsc({
          sets: [
            set({
              status: "error",
              lastError: "BuySportsCards timed out",
              steps: [
                { kind: "read", condition: "Near Mint", status: "done" },
                { kind: "read", condition: "Excellent", status: "done" },
                { kind: "send", status: "failed" },
              ],
            }),
            set({
              variantId: "v2",
              setLabel: "1990 Score Base",
              steps: [
                { kind: "read", condition: "Mint", status: "done" },
                { kind: "send", status: "done" },
                { kind: "confirm", condition: "Mint", status: "done" },
              ],
            }),
          ],
        }),
      ],
    });
    const sets = section("Last sync by set");
    expect(
      names(within(sets).getByRole("list", { name: "Last sync steps for 1989 Upper Deck Base on BuySportsCards" })),
    ).toEqual(["Gathering data, done", "Send changes to BuySportsCards, failed"]);
    expect(names(within(sets).getByRole("list", { name: "Last sync steps for 1990 Score Base on BuySportsCards" }))).toEqual([
      "Gathering data, done",
      "Send changes to BuySportsCards, done",
    ]);
    await expectAccessibleInBothModes(view.container, { label: "Sync status, last-run steps", rerender });
  });

  it("eBay: its own steps in NB's words, never eBay's", async () => {
    const steps: SyncStep[] = [
      { kind: "photos", status: "done" },
      { kind: "items", status: "done" },
      { kind: "offers", status: "working" },
      { kind: "publish", status: "waiting" },
      { kind: "withdraw", status: "waiting" },
    ];
    const { view, rerender } = draw({
      platforms: [bsc({ platform: "ebay", running: { startedAt: T, setLabel: "1988 Topps Base", variantId: "v1", steps } })],
    });
    expect(names(screen.getByRole("list", { name: "Sync steps for 1988 Topps Base on eBay" }))).toEqual([
      "Upload photos, done",
      "List the cards, done",
      "Set prices, working",
      "Go live, waiting",
      "Take down cards at 0, waiting",
    ]);
    await expectAccessibleInBothModes(view.container, { label: "Sync status, eBay steps", rerender });
  });

  it("BSC: one sheet's two conditions read as one step, photos go up before the send, the rest read last", () => {
    draw({
      platforms: [
        bsc({
          running: {
            startedAt: T,
            setLabel: "1989 Upper Deck Base",
            variantId: "v1",
            steps: [
              { kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "done" },
              { kind: "read", condition: "Excellent", status: "done" },
              { kind: "read", status: "done" },
              { kind: "photos", status: "done" },
              { kind: "send", status: "working" },
              { kind: "confirm", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "waiting" },
              { kind: "confirm", status: "waiting" },
            ],
          },
        }),
      ],
    });
    expect(names(screen.getByRole("list", { name: "Sync steps for 1989 Upper Deck Base on BuySportsCards" }))).toEqual([
      "Read Mint and Near Mint, done",
      "Read Excellent, done",
      "Read the other conditions, done",
      "Upload photos, done",
      "Send changes to BuySportsCards, working",
      "Double-check Mint and Near Mint, waiting",
      "Double-check the other conditions, waiting",
    ]);
  });

  it("no steps from the server: no ledger, the line as before", () => {
    draw({ platforms: [bsc({ running: { startedAt: T, setLabel: "1989 Upper Deck Base" }, sets: [set()] })] });
    expect(screen.queryByRole("list", { name: /steps for/ })).toBeNull();
  });

  it("says each step as it lands, once, in one polite line; arriving mid-run says nothing", () => {
    const { view } = draw({ platforms: [runningBsc(BSC_RUN)] });
    const line = runLine;
    expect(line().textContent).toBe("");

    const tree = (steps: SyncStep[]) => (
      <Theme>
        <MemoryRouter>
          <SyncStatusView status={{ platforms: [runningBsc(steps)] }} loadProblems={async () => ({ problems: [], problemsTotal: 0 })} />
        </MemoryRouter>
      </Theme>
    );
    const next: SyncStep[] = [
      BSC_RUN[0],
      { ...BSC_RUN[1], status: "done" },
      { ...BSC_RUN[2], status: "working" },
      BSC_RUN[3],
    ];
    view.rerender(tree(next));
    expect(line().textContent).toBe("Read Excellent, done. 2 of 4 steps done.");
    // A step going from waiting to working is not said.
    view.rerender(tree(next.map((s) => ({ ...s }))));
    expect(line().textContent).toBe("Read Excellent, done. 2 of 4 steps done.");

    view.rerender(tree([next[0], next[1], { ...next[2], status: "failed" }]));
    expect(line().textContent).toBe("Send changes to BuySportsCards hit a snag.");
  });

  /** The view over one platform, redrawn in place (the same tree, so the live line's state carries). */
  function live(first: PlatformSyncStatus, opts: { readOnly?: boolean } = {}) {
    const tree = (p: PlatformSyncStatus) => (
      <Theme>
        <MemoryRouter>
          <SyncStatusView
            status={{ platforms: [p] }}
            loadProblems={async () => ({ problems: [], problemsTotal: 0 })}
            readOnly={opts.readOnly}
          />
        </MemoryRouter>
      </Theme>
    );
    const view = render(tree(first));
    const line = runLine;
    return { view, line, redraw: (p: PlatformSyncStatus) => view.rerender(tree(p)) };
  }
  const lastStep = (status: SyncStep["status"]): SyncStep[] => [
    { kind: "read", condition: "Near Mint", status: "done" },
    { kind: "read", condition: "Excellent", status: "done" },
    { kind: "send", status: "done" },
    { kind: "confirm", condition: "Near Mint", status },
  ];

  it("a run that ends says how it went once, even when its last step lands in the read that clears it", () => {
    const { line, redraw } = live(runningBsc(lastStep("working")));
    expect(line().textContent).toBe("");
    // One read: the run is gone, and its row holds the last step done.
    redraw(bsc({ running: null, lastDrainAt: T, sets: [set({ steps: lastStep("done") })] }));
    expect(line().textContent).toBe("Synced 1989 Upper Deck Base with BuySportsCards. 4 of 4 steps done.");
    // Later reads of the finished state say nothing more.
    redraw(bsc({ running: null, lastDrainAt: T, sets: [set({ steps: lastStep("done") })] }));
    expect(line().textContent).toBe("Synced 1989 Upper Deck Base with BuySportsCards. 4 of 4 steps done.");
  });

  it("a run that ends on a snag names the step, or the set when no step owns it (the admin hears it too)", () => {
    const failed: SyncStep[] = [
      { kind: "read", condition: "Near Mint", status: "done" },
      { kind: "send", status: "failed" },
    ];
    const first = live(runningBsc(lastStep("waiting").slice(0, 3)), { readOnly: true });
    first.redraw(bsc({ running: null, sets: [set({ status: "error", lastError: "BuySportsCards timed out", steps: failed })] }));
    expect(first.line().textContent).toBe("Send changes to BuySportsCards hit a snag.");
    cleanup();

    const second = live(runningBsc(lastStep("working")));
    second.redraw(bsc({ running: null, sets: [set({ status: "error", steps: lastStep("done").slice(0, 3) })] }));
    expect(second.line().textContent).toBe("1989 Upper Deck Base hit a snag with BuySportsCards.");
  });

  it("a run that moves on to the next set says how the first one ended", () => {
    const { line, redraw } = live(runningBsc(lastStep("working")));
    redraw(
      bsc({
        running: { startedAt: T + 1, setLabel: "1990 Score Base", variantId: "v2", steps: [{ kind: "read", condition: "Mint", status: "working" }] },
        sets: [set({ variantId: "v2", setLabel: "1990 Score Base", status: "running" }), set({ steps: lastStep("done") })],
      }),
    );
    expect(line().textContent).toBe("Synced 1989 Upper Deck Base with BuySportsCards. 4 of 4 steps done.");
  });

  it("an equal ledger in a new array is no change: no render loop, nothing said again", () => {
    const { line, redraw } = live(runningBsc(BSC_RUN));
    const landed: SyncStep[] = [BSC_RUN[0], { ...BSC_RUN[1], status: "done" }, BSC_RUN[2], BSC_RUN[3]];
    redraw(runningBsc(landed));
    expect(line().textContent).toBe("Read Excellent, done. 2 of 4 steps done.");
    const writes: MutationRecord[] = [];
    const watch = new MutationObserver((records) => writes.push(...records));
    watch.observe(line(), { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 5; i++) {
      redraw(runningBsc(landed.map((s) => ({ ...s }))));
    }
    writes.push(...watch.takeRecords());
    watch.disconnect();
    expect(writes).toHaveLength(0);
    expect(line().textContent).toBe("Read Excellent, done. 2 of 4 steps done.");
  });

  it("axe, both themes: every step state, in the running ledger and the set rows' inline one, collector and admin", async () => {
    const all: SyncStep[] = [
      { kind: "read", condition: "Near Mint", status: "done" },
      { kind: "read", condition: "Excellent", status: "working" },
      { kind: "send", status: "waiting" },
    ];
    const status: SyncStatus = {
      platforms: [
        bsc({
          running: { startedAt: T, setLabel: "1989 Upper Deck Base", variantId: "v1", steps: all },
          sets: [
            set({ status: "running", steps: all }),
            // A set whose row still says running while another run is drawn above: its inline ledger shows working and waiting.
            set({ variantId: "v2", setLabel: "1990 Score Base", status: "running", steps: all }),
            set({
              variantId: "v3",
              setLabel: "1991 Fleer Base",
              status: "error",
              lastError: "BuySportsCards timed out",
              steps: [
                { kind: "read", condition: "Mint", status: "done" },
                { kind: "send", status: "failed" },
              ],
            }),
          ],
        }),
        bsc({
          platform: "ebay",
          sets: [
            set({
              steps: [
                { kind: "photos", status: "done" },
                { kind: "items", status: "done" },
                { kind: "offers", status: "failed" },
              ],
            }),
          ],
        }),
      ],
    };
    for (const readOnly of [false, true]) {
      const { view, rerender } = draw(status, { readOnly });
      const sets = within(screen.getByRole("region", { name: "BuySportsCards" }));
      expect(sets.getByRole("list", { name: "Last sync steps for 1990 Score Base on BuySportsCards" })).toBeTruthy();
      expect(sets.getByRole("listitem", { name: "Send changes to BuySportsCards, failed" })).toBeTruthy();
      expect(screen.getAllByRole("list", { name: /steps for/ }).every((l) => l.getAttribute("role") === "list")).toBe(true);
      await expectAccessibleInBothModes(view.container, {
        label: `Sync status, every step state${readOnly ? ", admin" : ""}`,
        rerender,
      });
      cleanup();
    }
  });

  describe("a set row's last run, folded (Jason: \"Gathering data\" then each step that updates)", () => {
    const VINTAGE_DONE: SyncStep[] = [
      { kind: "read", condition: "Near Mint", status: "done" },
      { kind: "read", condition: "Excellent", status: "done" },
      { kind: "read", condition: "Very Good", status: "done" },
      { kind: "read", condition: "Good", status: "done" },
      { kind: "read", status: "done" },
      { kind: "photos", status: "done" },
      { kind: "send", status: "done" },
      { kind: "confirm", condition: "Near Mint", status: "done" },
      { kind: "confirm", condition: "Excellent", status: "done" },
      { kind: "confirm", condition: "Very Good", status: "done" },
      { kind: "confirm", condition: "Good", status: "done" },
      { kind: "confirm", status: "done" },
    ];
    const fold = (steps: SyncStep[], platform: "bsc" | "ebay" = "bsc") =>
      foldedLines(steps, platform).map((l) => `${l.label}, ${l.status}`);

    it("vintage BSC, all done, with photos: one Gathering data, then the updates; check-backs go", () => {
      expect(fold(VINTAGE_DONE)).toEqual([
        "Gathering data, done",
        "Upload photos, done",
        "Send changes to BuySportsCards, done",
      ]);
      // The run going now keeps every step.
      expect(runLines(VINTAGE_DONE, "bsc")).toHaveLength(12);
    });

    it("a read that failed makes Gathering data failed", () => {
      expect(
        fold([
          { kind: "read", condition: "Near Mint", status: "done" },
          { kind: "read", condition: "Excellent", status: "failed" },
        ]),
      ).toEqual(["Gathering data, failed"]);
    });

    it("a check-back that failed stays, under its own label, so a failure never disappears", () => {
      expect(
        fold([
          { kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "done" },
          { kind: "read", condition: "Excellent", status: "done" },
          { kind: "send", status: "done" },
          { kind: "confirm", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "done" },
          { kind: "confirm", condition: "Excellent", status: "failed" },
        ]),
      ).toEqual(["Gathering data, done", "Send changes to BuySportsCards, done", "Double-check Excellent, failed"]);
    });

    it("unfinished reads (not on a finished row, but drawn safely) wear the least-finished state", () => {
      expect(
        fold([
          { kind: "read", condition: "Near Mint", status: "done" },
          { kind: "read", condition: "Excellent", status: "working" },
          { kind: "read", condition: "Good", status: "waiting" },
          { kind: "send", status: "waiting" },
        ]),
      ).toEqual(["Gathering data, waiting", "Send changes to BuySportsCards, waiting"]);
    });

    it("eBay has no reads: its row is unchanged", () => {
      const ebay: SyncStep[] = [
        { kind: "photos", status: "done" },
        { kind: "items", status: "done" },
        { kind: "offers", status: "done" },
        { kind: "publish", status: "done" },
        { kind: "withdraw", status: "failed" },
      ];
      expect(fold(ebay, "ebay")).toEqual([
        "Upload photos, done",
        "List the cards, done",
        "Set prices, done",
        "Go live, done",
        "Take down cards at 0, failed",
      ]);
    });

    it("drawn: the row's list holds the folded lines; Running now still shows every step", () => {
      draw({
        platforms: [
          bsc({
            running: { startedAt: T, setLabel: "1990 Score Base", variantId: "v2", steps: VINTAGE_DONE.slice(0, 3) },
            sets: [set({ variantId: "v2", setLabel: "1990 Score Base", status: "running" }), set({ steps: VINTAGE_DONE })],
          }),
        ],
      });
      expect(names(screen.getByRole("list", { name: "Last sync steps for 1989 Upper Deck Base on BuySportsCards" }))).toEqual([
        "Gathering data, done",
        "Upload photos, done",
        "Send changes to BuySportsCards, done",
      ]);
      expect(names(screen.getByRole("list", { name: "Sync steps for 1990 Score Base on BuySportsCards" }))).toEqual([
        "Read Near Mint, done",
        "Read Excellent, done",
        "Read Very Good, done",
      ]);
    });
  });

  it("labels: one sheet's conditions said as a list, none named is the rest, each unique within a run", () => {
    expect(
      stepLabels(
        [
          { kind: "read", condition: "Good" },
          { kind: "read", condition: "Good" },
          { kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"] },
          { kind: "confirm", conditions: ["Mint", "Near Mint", "Excellent"] },
          { kind: "read" },
          { kind: "confirm" },
        ],
        "bsc",
      ),
    ).toEqual([
      "Read Good",
      "Read Good (2)",
      "Read Mint and Near Mint",
      "Double-check Mint, Near Mint and Excellent",
      "Read the other conditions",
      "Double-check the other conditions",
    ]);
    expect(stepName("Go live", "working")).toBe("Go live, working");
    expect(stepKind("waiting")).toBe("waiting");
    expect(stepKind("working")).toBe("building");
    expect(stepKind("done")).toBe("built");
    expect(stepKind("failed")).toBe("failed");
  });
});
