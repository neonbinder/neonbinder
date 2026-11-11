/**
 * PR 451 (NEO-487) — `syncStatus`'s projection of a run step's BSC wait:
 * `marketplaceWaitingSince` is shown only on a step that is still working
 * (a finished step, or a step of a run that died holding its lease, is not
 * waiting on anything), and `marketplaceWaitMs`, the measured total, is kept.
 * Only times cross to the client.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_451w" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  await t.run((ctx) =>
    ctx.db.insert("marketplaceListingStates", {
      ownerId: ME.subject, platform: "bsc", listingStartedAt: 1, platformAccountId: "acct", lastUpdated: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", { userId: ME.subject, siteCredentials: [{ site: "buysportscards", hasCredentials: true }] }),
  );
  return { t, fx };
}

const run = (
  t: ReturnType<typeof convexTest>,
  variantId: Id<"selectorOptions">,
  steps: unknown[],
  extra: Record<string, unknown> = {},
) =>
  t.run((ctx) =>
    ctx.db.insert("marketplaceListingSyncs", {
      ownerId: ME.subject, variantId, platform: "bsc", status: "running", problems: [], conditionsPushed: [],
      lastUpdated: 1, lastRunAt: 50, leaseToken: "lease-secret", leaseExpiresAt: Date.now() + 60_000,
      progress: { runStartedAt: 50, steps },
      ...extra,
    } as never),
  );

const bsc = async (t: ReturnType<typeof convexTest>) =>
  (await t.withIdentity(ME).query(api.listingSync.syncStatus, {})).platforms[0];

describe("syncStatus — a step's wait on BSC", () => {
  test("the working step carries its open wait and total; a done step carries its total only", async () => {
    const { t, fx } = await setup();
    await run(t, fx.baseId, [
      { kind: "read", status: "done", finishedAt: 5, marketplaceWaitMs: 1_200 },
      { kind: "send", status: "working", marketplaceWaitingSince: 4_000, marketplaceWaitMs: 300 },
      { kind: "confirm", status: "waiting" },
    ]);
    const p = await bsc(t);
    const expected = [
      { kind: "read", status: "done", marketplaceWaitMs: 1_200 },
      { kind: "send", status: "working", marketplaceWaitingSince: 4_000, marketplaceWaitMs: 300 },
      { kind: "confirm", status: "waiting" },
    ];
    expect(p.running?.steps).toEqual(expected);
    expect(p.sets[0].steps).toEqual(expected);
  });

  test("a stale waitingSince on a step that is not working is not shown", async () => {
    const { t, fx } = await setup();
    await run(t, fx.baseId, [
      { kind: "read", status: "done", finishedAt: 5, marketplaceWaitingSince: 4_000, marketplaceWaitMs: 10 },
      { kind: "send", status: "waiting", marketplaceWaitingSince: 4_100 },
    ]);
    const p = await bsc(t);
    expect(p.running?.steps).toEqual([
      { kind: "read", status: "done", marketplaceWaitMs: 10 },
      { kind: "send", status: "waiting" },
    ]);
  });

  test("a run that died holding its lease: its working step reads failed and is not waiting", async () => {
    const { t, fx } = await setup();
    await run(
      t,
      fx.baseId,
      [{ kind: "send", status: "working", marketplaceWaitingSince: 4_000, marketplaceWaitMs: 700 }],
      { leaseExpiresAt: Date.now() - 1 },
    );
    const p = await bsc(t);
    expect(p.running).toBeNull();
    expect(p.sets[0].steps).toEqual([{ kind: "send", status: "failed", marketplaceWaitMs: 700 }]);
  });

  test("a finished run's record keeps the measured total", async () => {
    const { t, fx } = await setup();
    await run(t, fx.baseId, [{ kind: "send", status: "done", finishedAt: 9, marketplaceWaitMs: 2_500 }], {
      status: "idle", leaseToken: undefined, leaseExpiresAt: undefined,
    });
    const p = await bsc(t);
    expect(p.sets[0].steps).toEqual([{ kind: "send", status: "done", marketplaceWaitMs: 2_500 }]);
  });

  test("a step with no wait fields projects none (no undefined keys)", async () => {
    const { t, fx } = await setup();
    await run(t, fx.baseId, [{ kind: "send", status: "working" }]);
    const p = await bsc(t);
    expect(Object.keys(p.running!.steps[0]).sort()).toEqual(["kind", "status"]);
  });
});
