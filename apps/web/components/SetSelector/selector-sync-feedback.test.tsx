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
import { MAX_RETURNED_IDS } from "../../convex/selectorSyncStore";
import {
  blockedMessageFromErrors,
  buildUnlinkedNotices,
  returnedIdsFromFetch,
  totalsBySideFor,
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
    expect(plan).toEqual({ kind: "blocked", failedLabels: ["A marketplace"] });
  });

  it("never echoes an unrecognised platform key into the copy", () => {
    // Making this a property of the FUNCTION rather than of its callers is the
    // point: no caller can leak a key through here by passing a new one.
    const plan = planSinglePlatformStore([
      { platform: "some-internal-service", message: "x" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("some-internal-service");
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

  it("names BOTH sides directly, not only through blockedMessageFromErrors", () => {
    const plan = planSinglePlatformStore([
      { platform: "bsc", message: "503" },
      { platform: "sportlots", message: "ECONNRESET" },
    ]);
    expect(plan).toEqual({
      kind: "blocked",
      failedLabels: ["BuySportsCards", "SportLots"],
    });
  });

  it("de-duplicates the SAME platform appearing more than once in errors", () => {
    // The wire shape allows repeats (e.g. a retry that failed twice); the
    // alert must still say "BuySportsCards" once, not "BuySportsCards and
    // BuySportsCards".
    const plan = planSinglePlatformStore([
      { platform: "bsc", message: "first failure" },
      { platform: "bsc", message: "second failure" },
    ]);
    expect(plan).toEqual({ kind: "blocked", failedLabels: ["BuySportsCards"] });
  });

  it("calls a platform outside bsc/sportlots 'A marketplace', never by key", () => {
    // This test previously pinned an echo of the raw key. The security re-check
    // changed the rule: `fetchRawOptions` also emits "internal", and its outer
    // catch can attribute a failure to no marketplace at all, so echoing the key
    // puts an implementation detail in the DOM and makes "is this safe to
    // render" a property of every caller. The backend's own partialSyncMessage
    // maps unknown keys the same way.
    const plan = planSinglePlatformStore([
      { platform: "ebay", message: "not a real side yet" },
    ]) as Extract<ReturnType<typeof planSinglePlatformStore>, { kind: "blocked" }>;
    expect(plan.kind).toBe("blocked");
    expect(plan.failedLabels).toEqual(["A marketplace"]);
  });

  it("collapses several unknown platforms into one 'A marketplace'", () => {
    // They all render to the same label, so the alert must not read
    // "A marketplace and A marketplace".
    const plan = planSinglePlatformStore([
      { platform: "internal", message: "x" },
      { platform: "ebay", message: "y" },
    ]) as Extract<ReturnType<typeof planSinglePlatformStore>, { kind: "blocked" }>;
    expect(plan.failedLabels).toEqual(["A marketplace"]);
  });
});

describe("totalsBySideFor", () => {
  // The store truncates `unlinked` to a 50-row sample (UNLINK_NOTICE_LIMIT) and
  // reports the real count separately. Rendering the sample size would not be a
  // smaller truth — it would be a wrong one.
  it("attributes the scalar total when only one side is involved", () => {
    expect(
      totalsBySideFor([{ id: "a", value: "A", side: "bsc" }], 312),
    ).toEqual({ bsc: 312 });
  });

  it("declines to invent a split when both sides unlinked", () => {
    expect(
      totalsBySideFor(
        [
          { id: "a", value: "A", side: "bsc" },
          { id: "b", value: "B", side: "sportlots" },
        ],
        312,
      ),
    ).toBeUndefined();
  });

  it("is undefined with no total or no sample", () => {
    expect(totalsBySideFor([{ id: "a", value: "A", side: "bsc" }], undefined)).toBeUndefined();
    expect(totalsBySideFor([], 5)).toBeUndefined();
  });
});

describe("returnedIdsFromFetch", () => {
  // The store cannot answer "what did the marketplace stop listing" from the
  // items the FORM sends — those are what the operator confirmed. See the
  // helper's own note; these pin the union it derives instead.
  it("unions the plain lists with both halves of every auto-matched pair", () => {
    expect(
      returnedIdsFromFetch({
        bscOptions: [{ platformValue: "b1" }],
        slOptions: [{ platformValue: "s1" }],
        unmatchedBsc: [{ platformValue: "b2" }],
        unmatchedSl: [{ platformValue: "s2" }],
        autoMatched: [
          { bsc: { platformValue: "b3" }, sl: { platformValue: "s3" } },
        ],
      }),
    ).toEqual({ bsc: ["b1", "b2", "b3"], sportlots: ["s1", "s2", "s3"] });
  });

  it("de-dupes, since the partitions overlap the full lists today", () => {
    expect(
      returnedIdsFromFetch({
        bscOptions: [{ platformValue: "b1" }, { platformValue: "b2" }],
        unmatchedBsc: [{ platformValue: "b1" }],
        autoMatched: [
          { bsc: { platformValue: "b2" }, sl: { platformValue: "s1" } },
        ],
      }),
    ).toEqual({ bsc: ["b1", "b2"], sportlots: ["s1"] });
  });

  it("OMITS a side that blows the store's per-side cap, and keeps the other", () => {
    // The CI seed flow hit this for real: SportLots returns 2,563 sets for one
    // year, the store's cap threw, and the reconcile dialog sat open after
    // "Save 76 sets" with no visible error. Omitting means "no information
    // about this side" — the store leaves its links alone and the save still
    // lands. Truncating would be far worse: every id past the cut would look
    // delisted and get silently unlinked.
    const huge = Array.from({ length: MAX_RETURNED_IDS + 1 }, (_, i) => ({
      platformValue: `sl-${i}`,
    }));
    const ids = returnedIdsFromFetch({
      bscOptions: [{ platformValue: "b1" }],
      slOptions: huge,
    });
    expect(ids.sportlots).toBeUndefined();
    expect("sportlots" in ids).toBe(false);
    // The healthy side is unaffected — a partial answer beats no answer.
    expect(ids.bsc).toEqual(["b1"]);
  });

  it("keeps a side sitting exactly ON the cap", () => {
    const atCap = Array.from({ length: MAX_RETURNED_IDS }, (_, i) => ({
      platformValue: `sl-${i}`,
    }));
    const ids = returnedIdsFromFetch({ slOptions: atCap });
    expect(ids.sportlots).toHaveLength(MAX_RETURNED_IDS);
  });

  it("reports an untouched side as [], not as a missing key", () => {
    // `[]` says "asked, returned nothing" — which is what licenses an unlink.
    // Omitting the key would say "no information" and unlink nothing. The two
    // are NOT interchangeable, which is why the over-cap case above omits.
    const ids = returnedIdsFromFetch({ bscOptions: [{ platformValue: "b1" }] });
    expect(ids.sportlots).toEqual([]);
    expect(Object.keys(ids).sort()).toEqual(["bsc", "sportlots"]);
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
  it("returns undefined for an ABSENT result, so the arg is omitted", () => {
    // Fails closed. `[]` means "no errors"; undefined means "we no longer know
    // what the fetch reported", and claiming both sides were reached there
    // would license an unlink on a side we cannot vouch for.
    expect(coveredSidesFromErrors(undefined)).toBeUndefined();
    expect(coveredSidesFromErrors([])).toEqual(["bsc", "sportlots"]);
  });

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

  it("a single entry reads as a plain list, no 'and N more'", () => {
    const text = unlinkNoticeText([unlinked({ id: "a", value: "Solo" })], "setName");
    expect(text).toBe("No longer listed on BSC: 1 set — Solo");
  });

  it("exactly at the name limit: no trailing 'and N more'", () => {
    // Two names fit under the column's default limit — this is the boundary
    // between "spell them all out" and "start collapsing".
    const text = unlinkNoticeText(
      [unlinked({ id: "a", value: "A" }), unlinked({ id: "b", value: "B" })],
      "setName",
    );
    expect(text).toBe("No longer listed on BSC: 2 sets — A, B");
  });

  it("one over the limit: the first hidden entry tips into 'and 1 more'", () => {
    const text = unlinkNoticeText(
      [
        unlinked({ id: "a", value: "A" }),
        unlinked({ id: "b", value: "B" }),
        unlinked({ id: "c", value: "C" }),
      ],
      "setName",
    );
    expect(text).toBe("No longer listed on BSC: 3 sets — A, B, and 1 more");
  });

  it("seven entries, default column budget", () => {
    const text = unlinkNoticeText(
      Array.from({ length: 7 }, (_, i) =>
        unlinked({ id: `r${i}`, value: `Set ${i}` }),
      ),
      "setName",
    );
    expect(text).toBe(
      "No longer listed on BSC: 7 sets — Set 0, Set 1, and 5 more",
    );
  });

  it("seven entries, toast budget — more names fit before collapsing", () => {
    const text = unlinkNoticeText(
      Array.from({ length: 7 }, (_, i) =>
        unlinked({ id: `r${i}`, value: `Set ${i}` }),
      ),
      "setName",
      { maxNames: UNLINKED_NAME_LIMIT_TOAST },
    );
    expect(text).toBe(
      "No longer listed on BSC: 7 sets — Set 0, Set 1, Set 2, and 4 more",
    );
  });

  it("seven entries split across BOTH sides in one call", () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, i) =>
        unlinked({ id: `b${i}`, value: `BSC Set ${i}`, side: "bsc" as const }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        unlinked({
          id: `s${i}`,
          value: `SL Set ${i}`,
          side: "sportlots" as const,
        }),
      ),
    ];
    const notices = buildUnlinkedNotices(entries, "setName");
    expect(notices).toHaveLength(2);
    expect(notices[0].side).toBe("bsc");
    expect(notices[0].count).toBe(4);
    expect(notices[1].side).toBe("sportlots");
    expect(notices[1].count).toBe(3);
  });
});
