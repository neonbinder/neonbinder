/**
 * PR 451 (NEO-487) — the deployment-wide BSC cooldown (`marketplaceCooldowns.ts`).
 *
 * The window arithmetic is pure (`nextCooldown`, `parseRetryAfterMs`) and is
 * pinned there; `record429`, `recordSuccess` and `get` are pinned through
 * convex-test for the parts that need the table: no escalation inside an open
 * window, the streak reset on a success after a window (NEO-482), and that
 * the healthy path never writes.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  COOLDOWN_STREAK_RESET_MS,
  RETRY_AFTER_MAX_MS,
  nextCooldown,
  parseRetryAfterMs,
  successResetsStreak,
} from "./marketplaceCooldowns";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_800_000_000_000;
const KEY = { platform: "bsc", endpoint: "cardListing" } as const;

describe("nextCooldown", () => {
  test("the constants match BSC's measured 15-45 s lockout (NEO-482)", () => {
    expect(COOLDOWN_BASE_MS).toBe(15_000);
    expect(COOLDOWN_MAX_MS).toBe(120_000);
    expect(RETRY_AFTER_MAX_MS).toBe(600_000);
  });

  test("the first 429 opens a 15 second window with streak 1", () => {
    expect(nextCooldown(null, NOW)).toEqual({ until: NOW + 15_000, streak: 1, escalated: true });
  });

  test("consecutive windows with no success between escalate 15 s, 30 s, 60 s, then the 120 s cap", () => {
    let row: { until: number; last429At: number; streak: number } | null = null;
    let at = NOW;
    const windows: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const next = nextCooldown(row, at);
      windows.push(next.until - at);
      row = { until: next.until, last429At: at, streak: next.streak };
      at = next.until + 1; // the window has lapsed, well inside the 15 min reset
    }
    expect(windows).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  test("a 429 inside an open window leaves the window and the streak alone", () => {
    const row = { until: NOW + 30_000, last429At: NOW - 30_000, streak: 3 };
    expect(nextCooldown(row, NOW)).toEqual({ until: NOW + 30_000, streak: 3, escalated: false });
    // Even a huge Retry-After does not extend a live window.
    expect(nextCooldown(row, NOW, 9_999_999)).toEqual({ until: NOW + 30_000, streak: 3, escalated: false });
  });

  test("a window that lapsed more than 15 minutes ago starts the streak over", () => {
    const row = { until: NOW - COOLDOWN_STREAK_RESET_MS, last429At: NOW - COOLDOWN_STREAK_RESET_MS - 1, streak: 5 };
    expect(nextCooldown(row, NOW)).toMatchObject({ streak: 1, until: NOW + COOLDOWN_BASE_MS });
  });

  test("a 429 exactly 15 minutes after the last still continues the streak", () => {
    const row = { until: NOW - 1, last429At: NOW - COOLDOWN_STREAK_RESET_MS, streak: 2 };
    expect(nextCooldown(row, NOW)).toMatchObject({ streak: 3, until: NOW + 60_000 });
  });

  test("a row whose streak a success reset to 0 opens the base window again", () => {
    const row = { until: NOW - 1_000, last429At: NOW - 16_000, streak: 0 };
    expect(nextCooldown(row, NOW)).toEqual({ until: NOW + COOLDOWN_BASE_MS, streak: 1, escalated: true });
  });

  test("the longer of the doubled window and Retry-After wins", () => {
    expect(nextCooldown(null, NOW, 150_000).until).toBe(NOW + 150_000);
    // Retry-After shorter than the base window does not shorten it.
    expect(nextCooldown(null, NOW, 5_000).until).toBe(NOW + COOLDOWN_BASE_MS);
  });

  test("Retry-After is honoured past the 120 s cap, up to 10 minutes", () => {
    expect(nextCooldown(null, NOW, 300_000).until).toBe(NOW + 300_000);
    expect(nextCooldown(null, NOW, 3_600_000).until).toBe(NOW + RETRY_AFTER_MAX_MS);
  });

  test.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "a Retry-After of %s is ignored",
    (retryAfter) => {
      expect(nextCooldown(null, NOW, retryAfter).until).toBe(NOW + COOLDOWN_BASE_MS);
    },
  );

  test("a very long streak cannot overflow the cap", () => {
    const row = { until: NOW - 1, last429At: NOW - 1, streak: 5_000 };
    expect(nextCooldown(row, NOW).until).toBe(NOW + COOLDOWN_MAX_MS);
  });
});

describe("successResetsStreak", () => {
  const closed = { until: NOW - 1_000, last429At: NOW - 16_000, streak: 2 };

  test("a call asked after the window closed resets a live streak", () => {
    expect(successResetsStreak(closed, NOW, NOW - 500)).toBe(true);
    expect(successResetsStreak(closed, NOW, closed.until)).toBe(true);
  });

  test("a call already in flight when the window opened does not", () => {
    expect(successResetsStreak(closed, NOW, closed.until - 1)).toBe(false);
  });

  test("nothing resets while a window is open", () => {
    expect(successResetsStreak({ ...closed, until: NOW + 5_000 }, NOW, NOW)).toBe(false);
  });

  test("no row, or a streak already at 0, has nothing to reset", () => {
    expect(successResetsStreak(null, NOW, NOW)).toBe(false);
    expect(successResetsStreak({ ...closed, streak: 0 }, NOW, NOW)).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  test("delta-seconds become milliseconds", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
    expect(parseRetryAfterMs("  7 ", NOW)).toBe(7_000);
  });

  test("an HTTP date is the distance from now", () => {
    const at = new Date(NOW + 90_000).toUTCString();
    expect(parseRetryAfterMs(at, NOW)).toBe(90_000);
  });

  test("an HTTP date in the past is zero, not negative", () => {
    expect(parseRetryAfterMs(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
  });

  test.each([[undefined], [null], [""], ["soon"], ["x".repeat(80)]])(
    "%s is not a Retry-After",
    (value) => {
      expect(parseRetryAfterMs(value as string | null | undefined, NOW)).toBeUndefined();
    },
  );

  // "-5" and "1.5" are not delta-seconds; V8's Date.parse reads them as dates
  // far in the past, so they come back as a zero wait. `nextCooldown` ignores
  // a zero, so either answer ends in the same window.
  test.each([["-5"], ["1.5"]])("%s never yields a positive wait", (value) => {
    expect(parseRetryAfterMs(value, NOW) ?? 0).toBe(0);
  });
});

describe("marketplaceCooldowns.record429 and get", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const rows = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => ctx.db.query("marketplaceCooldowns").collect());

  test("the healthy path reads and writes nothing: get on an empty table returns null and leaves it empty", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toBeNull();
    expect(await rows(t)).toEqual([]);
  });

  test("the first 429 inserts one row and get reports its end", async () => {
    const t = convexTest(schema, modules);
    const out = await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    expect(out).toEqual({ until: NOW + 15_000, streak: 1, escalated: true });
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toEqual({ until: NOW + 15_000 });
    expect(await rows(t)).toHaveLength(1);
  });

  test("once the window has passed, get reports it closed with a live streak, and does not delete the row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    vi.setSystemTime(NOW + 15_000);
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toEqual({ closedAt: NOW + 15_000 });
    expect(await rows(t)).toHaveLength(1);
  });

  test("get answers null once the streak is past the 15 minute backstop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    vi.setSystemTime(NOW + COOLDOWN_STREAK_RESET_MS + 1);
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toBeNull();
  });

  test("a 429 inside the open window writes nothing and does not escalate", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    const before = await rows(t);
    vi.setSystemTime(NOW + 10_000);
    const again = await t.mutation(internal.marketplaceCooldowns.record429, { ...KEY, retryAfterMs: 500_000 });
    expect(again).toEqual({ until: NOW + 15_000, streak: 1, escalated: false });
    expect(await rows(t)).toEqual(before);
  });

  test("a 429 after the window lapsed escalates the same row to the next step", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    vi.setSystemTime(NOW + 16_000);
    const second = await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    expect(second).toEqual({ until: NOW + 16_000 + 30_000, streak: 2, escalated: true });
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ streak: 2, last429At: NOW + 16_000 });
  });

  test("with no success between them, 429s escalate 15 s, 30 s, 60 s, 120 s and stay at 120 s", async () => {
    const t = convexTest(schema, modules);
    let at = NOW;
    const windows: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(at);
      const out = await t.mutation(internal.marketplaceCooldowns.record429, KEY);
      windows.push(out.until - at);
      at = out.until + 1;
    }
    expect(windows).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
  });

  test("a success after the window resets the streak to 0, so the next 429 opens at 15 s again", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY); // 15 s, streak 1
    vi.setSystemTime(NOW + 16_000);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY); // 30 s, streak 2
    vi.setSystemTime(NOW + 47_000);
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toEqual({ closedAt: NOW + 46_000 });

    const reset = await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW + 46_500 });
    expect(reset).toEqual({ reset: true });
    expect((await rows(t))[0]).toMatchObject({ streak: 0, until: NOW + 46_000 });
    // Nothing more to record: the healthy path again.
    expect(await t.query(internal.marketplaceCooldowns.get, KEY)).toBeNull();

    vi.setSystemTime(NOW + 100_000);
    const next = await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    expect(next).toEqual({ until: NOW + 100_000 + 15_000, streak: 1, escalated: true });
  });

  test("a success writes nothing when there is no streak to reset", async () => {
    const t = convexTest(schema, modules);
    // No row at all.
    expect(await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW })).toEqual({ reset: false });
    expect(await rows(t)).toEqual([]);
    // A row whose streak is already 0.
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    vi.setSystemTime(NOW + 20_000);
    await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW + 19_000 });
    const before = await rows(t);
    vi.setSystemTime(NOW + 30_000);
    expect(await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW + 29_000 })).toEqual({ reset: false });
    expect(await rows(t)).toEqual(before);
  });

  test("a success inside an open window, or from a call asked before it closed, writes nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    const before = await rows(t);
    vi.setSystemTime(NOW + 5_000);
    expect(await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW + 5_000 })).toEqual({ reset: false });
    vi.setSystemTime(NOW + 20_000);
    expect(await t.mutation(internal.marketplaceCooldowns.recordSuccess, { ...KEY, askedAt: NOW - 1 })).toEqual({ reset: false });
    expect(await rows(t)).toEqual(before);
  });

  test("backstop: a 429 after 15 quiet minutes starts the streak over at 15 seconds", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    vi.setSystemTime(NOW + 16_000);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY); // streak 2
    vi.setSystemTime(NOW + 16_000 + COOLDOWN_STREAK_RESET_MS + 1);
    const later = await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    expect(later.streak).toBe(1);
    expect(later.until - (NOW + 16_000 + COOLDOWN_STREAK_RESET_MS + 1)).toBe(COOLDOWN_BASE_MS);
  });

  test("the cooldown log line carries platform, endpoint and timing only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await t.mutation(internal.marketplaceCooldowns.record429, KEY);
    const line = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(line).toEqual({
      msg: "marketplace_cooldown_opened",
      platform: "bsc",
      operation: "cardListing",
      streak: 1,
      ms: 15_000,
    });
  });
});
