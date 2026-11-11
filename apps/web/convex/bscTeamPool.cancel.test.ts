/**
 * PR 451 (NEO-482) — emptying the BSC team lane for the E2E reset.
 *
 *  - `cancelAllBscTeamChecks` is armed like every reset step;
 *  - a cancelled item reaches the REAL completion as `canceled` and is done:
 *    no re-enqueue, no hand-off to the operator, no write to the row;
 *  - an item whose row is gone (a stale item from the previous seed) ends on
 *    its first run as `notNeeded`, even behind an open cooldown: the row is
 *    read first, so there is no cooldown read and no BSC call.
 *
 * convex-test cannot mount the workpool component (see
 * lib/testing/bsc-team-lane.ts), so `cancelAll` itself is spied.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { BSC_TEAM_CHECK_MAX_PASSES, BSC_TEAM_CHECK_OPERATOR_AFTER_MS, bscTeamPool } from "./bscTeamPool";
import * as cooldowns from "./marketplaceCooldowns";
import { insertTestCard } from "../lib/testing/card-row";
import { captureBscTeamLane, runBscTeamLane } from "../lib/testing/bsc-team-lane";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_800_000_000_000;
const ARM = "ALLOW_RESET_SET_BUILDER_DATA";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seedCard(t: ReturnType<typeof convexTest>): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport", value: "Baseball", platformData: {}, children: [], lastUpdated: NOW,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "setName", value: "2024 Topps", platformData: {}, parentId: sportId, children: [], lastUpdated: NOW,
    });
    await ctx.db.patch(sportId, { children: [leafId] });
    return insertTestCard(ctx, {
      selectorOptionId: leafId,
      cardNumber: "1",
      cardName: "Card 1",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sortOrder: 1,
      lastUpdated: NOW,
    });
  });
}

const openWindow = (t: ReturnType<typeof convexTest>, until: number) =>
  t.run(async (ctx) =>
    ctx.db.insert("marketplaceCooldowns", {
      platform: "bsc", endpoint: "cardListing", until, last429At: NOW, streak: 1, updatedAt: NOW,
    }),
  );

/**
 * Counts every run of the cooldown read (`marketplaceCooldowns.get`):
 * convex-test runs a registered function through its `_handler`. The live-row
 * control below proves the spy sees the read.
 */
function spyCooldownReads() {
  return vi.spyOn(cooldowns.get as unknown as { _handler: (...a: unknown[]) => unknown }, "_handler");
}

describe("cancelAllBscTeamChecks", () => {
  test("refuses when the reset is not armed, and cancels nothing", async () => {
    vi.stubEnv(ARM, "");
    const cancelAll = vi.spyOn(bscTeamPool, "cancelAll").mockResolvedValue(undefined);
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.bscTeamPool.cancelAllBscTeamChecks, {})).rejects.toThrow(
      /not armed/,
    );
    expect(cancelAll).not.toHaveBeenCalled();
  });

  test("armed, it cancels the whole lane once", async () => {
    vi.stubEnv(ARM, "true");
    const cancelAll = vi.spyOn(bscTeamPool, "cancelAll").mockResolvedValue(undefined);
    const t = convexTest(schema, modules);
    await t.mutation(internal.bscTeamPool.cancelAllBscTeamChecks, {});
    expect(cancelAll).toHaveBeenCalledTimes(1);
  });
});

describe("a cancelled item", () => {
  // The two items that WOULD act on any other result: a last-pass item (a
  // failure gives up) and one past the 30-minute clock (a deferral gives up).
  test.each([
    ["on its last pass", { pass: BSC_TEAM_CHECK_MAX_PASSES, firstQueuedAt: NOW - 60_000 }],
    ["past the 30-minute clock", { pass: 1, firstQueuedAt: NOW - BSC_TEAM_CHECK_OPERATOR_AFTER_MS - 1 }],
  ])("%s is done: no re-enqueue, never handed to the operator", async (_name, at) => {
    const t = convexTest(schema, modules);
    const card = await seedCard(t);
    const before = await t.run(async (ctx) => ctx.db.get(card));
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.onBscTeamCheckComplete, {
      workId: "work-cancelled",
      context: { cardChecklistId: card, ...at },
      result: { kind: "canceled" },
    } as never);

    expect(lane).toHaveLength(0);
    const after = await t.run(async (ctx) => ctx.db.get(card));
    expect(after?.teamCheckOutcome).toBeUndefined();
    expect(after?.teamCheckDoneAt).toBeUndefined();
    expect(after).toEqual(before);
  });

  test("control: the same last-pass item reported failed IS handed to the operator", async () => {
    const t = convexTest(schema, modules);
    const card = await seedCard(t);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.onBscTeamCheckComplete, {
      workId: "work-failed",
      context: { cardChecklistId: card, pass: BSC_TEAM_CHECK_MAX_PASSES, firstQueuedAt: NOW - 60_000 },
      result: { kind: "failed", error: "boom" },
    } as never);
    expect(lane).toHaveLength(0);
    expect((await t.run(async (ctx) => ctx.db.get(card)))?.teamCheckOutcome).toBe("gaveUp");
  });
});

describe("runBscTeamCheckItem reads the row before the cooldown", () => {
  test("a deleted row behind an open cooldown is notNeeded at once: no cooldown read, no call", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const card = await seedCard(t);
    await openWindow(t, NOW + 600_000);
    await t.run(async (ctx) => ctx.db.delete(card));
    const reads = spyCooldownReads();

    const result = await t.action(internal.adapters.buysportscards.runBscTeamCheckItem, {
      cardChecklistId: card,
      pass: 1,
      firstQueuedAt: NOW - 60_000,
    });

    expect(result).toEqual({ outcome: "notNeeded" });
    expect(reads).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a settled row behind an open cooldown is notNeeded the same way", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const card = await seedCard(t);
    await openWindow(t, NOW + 600_000);
    await t.run(async (ctx) => ctx.db.patch(card, { teamCheckDoneAt: NOW - 1_000 }));
    const reads = spyCooldownReads();

    const result = await t.action(internal.adapters.buysportscards.runBscTeamCheckItem, {
      cardChecklistId: card,
      pass: 1,
      firstQueuedAt: NOW - 60_000,
    });

    expect(result).toEqual({ outcome: "notNeeded" });
    expect(reads).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("control: a live row behind the same window reads the cooldown and is deferred", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const card = await seedCard(t);
    await openWindow(t, NOW + 600_000);
    const reads = spyCooldownReads();

    const result = await t.action(internal.adapters.buysportscards.runBscTeamCheckItem, {
      cardChecklistId: card,
      pass: 1,
      firstQueuedAt: NOW - 60_000,
    });

    expect(result).toEqual({ outcome: "deferred", until: NOW + 600_000 });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("on the lane, a stale item ends on its first run instead of waiting out the window", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn());
    const card = await seedCard(t);
    await openWindow(t, NOW + 600_000);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [card] });
    await t.run(async (ctx) => ctx.db.delete(card));

    expect(await runBscTeamLane(t, lane, 5)).toBe(1);
    expect(lane).toHaveLength(0);
    expect(Date.now()).toBeLessThan(NOW + 60_000);
  });
});
