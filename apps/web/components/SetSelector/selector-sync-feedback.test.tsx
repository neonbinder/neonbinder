/**
 * NEO-211 — the two pure decisions a re-sync now makes about what to TELL the
 * operator, tested away from any component.
 *
 * `planSinglePlatformStore` is the guard that stops an adapter outage being
 * written as "the marketplace no longer lists these" (plan B), and
 * `buildUnlinkedNotices` is the only report anyone ever gets that a marketplace
 * link was detached (plan D — nothing about it is recorded in the database, by
 * Jason's own decision, so if the sentence is wrong the event is simply lost).
 *
 * Named `.test.tsx` deliberately: the `convex-lib` vitest project only picks up
 * `convex/**` and `lib/**`, so a `.test.ts` under `components/` would be
 * collected by neither project and silently never run.
 */

import { describe, expect, it } from "vitest";
import {
  blockedMessageFromErrors,
  buildUnlinkedNotices,
  coveredSidesFromErrors,
  joinLabels,
  levelLabelPlural,
  levelNoun,
  partialFailureMessage,
  planSinglePlatformStore,
  unlinkNoticeText,
  UNLINKED_NAME_LIMIT_TOAST,
  type UnlinkedEntry,
} from "./selector-sync-feedback";

describe("planSinglePlatformStore", () => {
  it("covers BOTH sides when nothing errored", () => {
    // This is what licenses the store to act on the empty side's rows: positive
    // evidence the marketplace was asked and had nothing. `coveredSides` is
    // mandatory for an unlink — absent means unlink nothing.
    expect(planSinglePlatformStore([])).toEqual({
      kind: "store",
      coveredSides: ["bsc", "sportlots"],
    });
  });

  it("blocks on ANY error, and names the platform in full", () => {
    const plan = planSinglePlatformStore([
      { platform: "sportlots", message: "socket hang up" },
    ]);
    expect(plan).toEqual({ kind: "blocked", failedLabels: ["SportLots"] });
  });

  it("blocks on an unattributable `internal` error too", () => {
    // We cannot claim a side was covered when we do not know which one broke.
    const plan = planSinglePlatformStore([
      { platform: "internal", message: "boom" },
    ]);
    expect(plan.kind).toBe("blocked");
  });

  it("carries no adapter text out — only our own platform names", () => {
    // Security review, 2026-09-03: user-facing error copy is never BUILT from
    // third-party marketplace response text on the client.
    const plan = planSinglePlatformStore([
      { platform: "bsc", message: "<img src=x onerror=alert(1)>" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("onerror");
    expect(
      partialFailureMessage("Sync failed: could not load variants", plan as never),
    ).toBe(
      "Sync failed: could not load variants. BuySportsCards failed, nothing was changed.",
    );
  });

  it("keeps the existing prefix first, because isError is a startsWith on it", () => {
    const plan = planSinglePlatformStore([
      { platform: "sportlots", message: "x" },
    ]);
    const msg = partialFailureMessage(
      "Sync failed: could not load parallels",
      plan as never,
    );
    expect(msg.startsWith("Sync failed: could not load parallels")).toBe(true);
  });

  it("reads naturally when both platforms failed", () => {
    expect(joinLabels(["BuySportsCards", "SportLots"])).toBe(
      "BuySportsCards and SportLots",
    );
  });
});

describe("blockedMessageFromErrors", () => {
  it("names both platforms when both adapters failed", () => {
    expect(
      blockedMessageFromErrors("Sync failed: could not load variants", [
        { platform: "bsc", message: "503" },
        { platform: "sportlots", message: "socket hang up" },
      ]),
    ).toBe(
      "Sync failed: could not load variants. BuySportsCards and SportLots failed, nothing was changed.",
    );
  });

  it("returns null with nothing to report, so no empty accusation renders", () => {
    expect(blockedMessageFromErrors("Sync failed", [])).toBeNull();
  });
});

describe("coveredSidesFromErrors", () => {
  it("excludes a side that reported an error", () => {
    expect(
      coveredSidesFromErrors([{ platform: "bsc", message: "503" }]),
    ).toEqual(["sportlots"]);
  });

  it("ignores a platform that is not a side", () => {
    expect(
      coveredSidesFromErrors([{ platform: "internal", message: "x" }]),
    ).toEqual(["bsc", "sportlots"]);
  });
});

describe("level nouns", () => {
  it("uses the columns' own public words, not SetAttributesPanel's", () => {
    // The columns say "Sub-Variants" where the older attributes panel says
    // "Parallel". Two maps that disagree about what a level is called is worse
    // than either one; this is the map both NEO-211 surfaces share.
    expect(levelNoun("parallel", 2)).toBe("sub-variants");
    expect(levelLabelPlural("parallel")).toBe("Sub-Variants");
    expect(levelNoun("setName", 1)).toBe("set");
    expect(levelNoun("variantType", 2)).toBe("variant types");
  });
});

const unlinked = (over: Partial<UnlinkedEntry> = {}): UnlinkedEntry => ({
  id: "row1",
  value: "Topps Heritage",
  side: "bsc",
  ...over,
});

describe("buildUnlinkedNotices", () => {
  it("names up to two rows in the column, then ', and N more'", () => {
    // Two, because this renders inside a min-w-[260px] max-w-[340px] column.
    const notices = buildUnlinkedNotices(
      [
        unlinked({ id: "a", value: "Topps Heritage" }),
        unlinked({ id: "b", value: "Topps Chrome" }),
        unlinked({ id: "c", value: "Topps Finest" }),
        unlinked({ id: "d", value: "Topps Gallery" }),
      ],
      "setName",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toBe(
      "No longer listed on BSC: 4 sets — Topps Heritage, Topps Chrome, and 2 more",
    );
  });

  it("gives the toast a wider budget without a second function", () => {
    const text = unlinkNoticeText(
      [
        unlinked({ id: "a", value: "A" }),
        unlinked({ id: "b", value: "B" }),
        unlinked({ id: "c", value: "C" }),
      ],
      "setName",
      { maxNames: UNLINKED_NAME_LIMIT_TOAST },
    );
    expect(text).toBe("No longer listed on BSC: 3 sets — A, B, C");
  });

  it("splits by side, BSC first, joined with ' · '", () => {
    const text = unlinkNoticeText(
      [
        unlinked({ id: "a", value: "Topps Heritage", side: "sportlots" }),
        unlinked({ id: "b", value: "Topps Chrome", side: "bsc" }),
      ],
      "setName",
    );
    expect(text).toBe(
      "No longer listed on BSC: 1 set — Topps Chrome · No longer listed on SportLots: 1 set — Topps Heritage",
    );
  });

  it("trusts the server's total over the sample it sent", () => {
    // A 400-row unlink has to say "400 sets", not claim there were two.
    const notices = buildUnlinkedNotices(
      [unlinked({ id: "a", value: "A" }), unlinked({ id: "b", value: "B" })],
      "setName",
      { totalsBySide: { bsc: 400 } },
    );
    expect(notices[0].text).toBe(
      "No longer listed on BSC: 400 sets — A, B, and 398 more",
    );
  });

  it("hoists a row that still has cards into the named sample, and says why", () => {
    // When only two names fit, the ones worth naming are the ones with broken
    // listings behind them — not whichever two the server returned first.
    const notices = buildUnlinkedNotices(
      [
        unlinked({ id: "a", value: "Plain One" }),
        unlinked({ id: "b", value: "Plain Two" }),
        unlinked({ id: "c", value: "Has Cards", hasCards: true }),
      ],
      "setName",
    );
    expect(notices[0].text).toBe(
      "No longer listed on BSC: 3 sets — Has Cards (has cards — listing on BSC will fail until re-linked), Plain One, and 1 more",
    );
  });

  it("says nothing at all when nothing was unlinked", () => {
    expect(buildUnlinkedNotices([], "setName")).toEqual([]);
    expect(unlinkNoticeText([], "setName")).toBe("");
  });
});
