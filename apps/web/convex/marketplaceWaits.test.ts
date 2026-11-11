/**
 * PR 451 (NEO-487) — the rows behind "Waiting on BuySportsCards...":
 * `marketplaceWaits` open / edge / expire (internal) and `forRun` (public).
 *
 * The owner is always the identity the action runs as, never an argument, so
 * one collector never sees another's wait. A run key that fails its shape
 * check reads and writes nothing. Public-surface pins live in
 * publicFunctionAuth.test.ts.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MARKETPLACE_WAIT_ROWS_PER_RUN, MARKETPLACE_WAIT_TTL_MS } from "./marketplaceWaits";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_451" };
const THEM = { subject: "collector_them_451" };
const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("marketplaceWaits").collect());
const scheduled = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
const seed = (
  t: ReturnType<typeof convexTest>,
  owner: string,
  runKey: string,
  waitingSince: number | undefined,
  accumulatedMs: number,
) =>
  t.run(async (ctx) =>
    ctx.db.insert("marketplaceWaits", {
      ownerId: owner, runKey, platform: "bsc", accumulatedMs, updatedAt: NOW,
      ...(waitingSince !== undefined ? { waitingSince } : {}),
    }),
  );

describe("marketplaceWaits.open", () => {
  test("inserts one row owned by the caller's identity, already waiting, and schedules its own expiry an hour out", async () => {
    const t = convexTest(schema, modules);
    const id = await t.withIdentity(ME).mutation(internal.marketplaceWaits.open, {
      runKey: "run_1", platform: "bsc", waitingSince: NOW - 5,
    });
    expect(id).not.toBeNull();
    expect(await rows(t)).toEqual([
      expect.objectContaining({
        _id: id, ownerId: ME.subject, runKey: "run_1", platform: "bsc", waitingSince: NOW - 5, accumulatedMs: 0,
      }),
    ]);
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("marketplaceWaits:expire");
    expect(jobs[0].args[0]).toEqual({ waitId: id });
    expect(jobs[0].scheduledTime).toBe(NOW + MARKETPLACE_WAIT_TTL_MS);
  });

  test("no identity (a scheduled run): nothing is written", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.marketplaceWaits.open, { runKey: "run_1", platform: "bsc", waitingSince: NOW });
    expect(id).toBeNull();
    expect(await rows(t)).toEqual([]);
    expect(await scheduled(t)).toEqual([]);
  });

  test.each([[""], ["has space"], ["x".repeat(65)]])("a bad run key %s: nothing is written", async (runKey) => {
    const t = convexTest(schema, modules);
    const id = await t.withIdentity(ME).mutation(internal.marketplaceWaits.open, { runKey, platform: "bsc", waitingSince: NOW });
    expect(id).toBeNull();
    expect(await rows(t)).toEqual([]);
  });
});

describe("marketplaceWaits.edge and expire", () => {
  test("an edge closes the wait: waitingSince is cleared and the total set", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, ME.subject, "run_1", NOW - 10, 0);
    await t.mutation(internal.marketplaceWaits.edge, { waitId: id, waitingSince: null, accumulatedMs: 4_200 });
    const [row] = await rows(t);
    expect(row.waitingSince).toBeUndefined();
    expect(row.accumulatedMs).toBe(4_200);
  });

  test("an edge can reopen the wait", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, ME.subject, "run_1", undefined, 800);
    await t.mutation(internal.marketplaceWaits.edge, { waitId: id, waitingSince: NOW, accumulatedMs: 800 });
    expect((await rows(t))[0]).toMatchObject({ waitingSince: NOW, accumulatedMs: 800 });
  });

  test("a negative total is stored as zero", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, ME.subject, "run_1", NOW, 0);
    await t.mutation(internal.marketplaceWaits.edge, { waitId: id, waitingSince: null, accumulatedMs: -50 });
    expect((await rows(t))[0].accumulatedMs).toBe(0);
  });

  test("an edge for a row that expired is a no-op, not an error", async () => {
    const t = convexTest(schema, modules);
    const id = await seed(t, ME.subject, "run_1", NOW, 0);
    await t.mutation(internal.marketplaceWaits.expire, { waitId: id });
    await expect(
      t.mutation(internal.marketplaceWaits.edge, { waitId: id, waitingSince: null, accumulatedMs: 1 }),
    ).resolves.toBeNull();
    expect(await rows(t)).toEqual([]);
  });

  test("expire deletes only its own row, and twice is harmless", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, ME.subject, "run_1", NOW, 0);
    const b = await seed(t, ME.subject, "run_1", NOW, 0);
    await t.mutation(internal.marketplaceWaits.expire, { waitId: a });
    await t.mutation(internal.marketplaceWaits.expire, { waitId: a });
    expect((await rows(t)).map((r) => r._id)).toEqual([b]);
  });
});

describe("marketplaceWaits.forRun", () => {
  const forRun = (t: ReturnType<typeof convexTest>, who: typeof ME | null, runKey: string) =>
    (who ? t.withIdentity(who) : t).query(api.marketplaceWaits.forRun, { runKey });

  test("nothing waiting: zero, and no waitingSince key", async () => {
    const t = convexTest(schema, modules);
    expect(await forRun(t, ME, "run_1")).toEqual({ accumulatedMs: 0 });
  });

  test("sums the closed time over every recorder's row, and takes the earliest open wait", async () => {
    const t = convexTest(schema, modules);
    await seed(t, ME.subject, "run_1", NOW - 3_000, 1_000);
    await seed(t, ME.subject, "run_1", NOW - 9_000, 2_500);
    await seed(t, ME.subject, "run_1", undefined, 500);
    expect(await forRun(t, ME, "run_1")).toEqual({ waitingSince: NOW - 9_000, accumulatedMs: 4_000 });
  });

  test("every row closed: only the total, no waitingSince", async () => {
    const t = convexTest(schema, modules);
    await seed(t, ME.subject, "run_1", undefined, 700);
    await seed(t, ME.subject, "run_1", undefined, 300);
    expect(await forRun(t, ME, "run_1")).toEqual({ accumulatedMs: 1_000 });
  });

  test("another collector's rows, even under the same run key, are invisible", async () => {
    const t = convexTest(schema, modules);
    await seed(t, THEM.subject, "run_1", NOW - 1_000, 9_999);
    await seed(t, ME.subject, "run_1", undefined, 100);
    expect(await forRun(t, ME, "run_1")).toEqual({ accumulatedMs: 100 });
    expect(await forRun(t, THEM, "run_1")).toEqual({ waitingSince: NOW - 1_000, accumulatedMs: 9_999 });
  });

  test("another run's rows are not mixed in", async () => {
    const t = convexTest(schema, modules);
    await seed(t, ME.subject, "run_2", NOW, 5_000);
    expect(await forRun(t, ME, "run_1")).toEqual({ accumulatedMs: 0 });
  });

  test("no identity: nothing, however many rows exist", async () => {
    const t = convexTest(schema, modules);
    await seed(t, ME.subject, "run_1", NOW, 5_000);
    expect(await forRun(t, null, "run_1")).toEqual({ accumulatedMs: 0 });
  });

  test("a malformed key reads nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t, ME.subject, "run_1", NOW, 5_000);
    expect(await forRun(t, ME, "run 1")).toEqual({ accumulatedMs: 0 });
    expect(await forRun(t, ME, "")).toEqual({ accumulatedMs: 0 });
  });

  test("reads no more than the per-run row cap", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < MARKETPLACE_WAIT_ROWS_PER_RUN + 5; i += 1) await seed(t, ME.subject, "run_1", undefined, 1);
    expect((await forRun(t, ME, "run_1")).accumulatedMs).toBe(MARKETPLACE_WAIT_ROWS_PER_RUN);
  });

  test("the answer carries only times: no owner, run key or row id", async () => {
    const t = convexTest(schema, modules);
    const id: Id<"marketplaceWaits"> = await seed(t, ME.subject, "run_1", NOW, 1);
    const out = JSON.stringify(await forRun(t, ME, "run_1"));
    expect(out).not.toContain(ME.subject);
    expect(out).not.toContain(id);
    expect(out).not.toContain("run_1");
  });
});
