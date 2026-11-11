/**
 * PR 451 (NEO-487) — the background BSC team lane's decision
 * (`nextBscTeamCheckStep`) and its two ends: the enqueue mutation and the
 * item/completion round trip, driven by hand (convex-test cannot mount the
 * workpool component; see lib/testing/bsc-team-lane.ts).
 *
 * The lane's retry ladder for FAILED lookups is pinned end to end in
 * bscTeamEnrichmentQueue.test.ts; this file pins what PR 451 added: a card
 * deferred by a 429 or an open cooldown goes back to the window's end WITHOUT
 * spending a pass, and goes to the operator once it has waited 30 minutes.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  BSC_TEAM_CHECK_MAX_PASSES,
  BSC_TEAM_CHECK_OPERATOR_AFTER_MS,
  BSC_TEAM_ENQUEUE_CHUNK_SIZE,
  nextBscTeamCheckStep,
} from "./bscTeamPool";
import { BSC_TEAM_ENRICH_DELAY_MS } from "./adapters/buysportscards";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { insertTestCard } from "../lib/testing/card-row";
import { captureBscTeamLane, runBscTeamLane } from "../lib/testing/bsc-team-lane";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_800_000_000_000;
const FIRST = NOW - 60_000;
const item = (pass: number, firstQueuedAt = FIRST) => ({ pass, firstQueuedAt });

describe("nextBscTeamCheckStep", () => {
  test.each([["answered"], ["notNeeded"]] as const)("%s is done", (outcome) => {
    expect(nextBscTeamCheckStep({ outcome }, item(1), NOW)).toEqual({ kind: "done" });
  });

  test("a failure retries at now, then +60 s, then +5 min, then goes to the operator", () => {
    expect(nextBscTeamCheckStep({ outcome: "failed" }, item(1), NOW)).toEqual({
      kind: "retry",
      pass: 2,
      runAt: NOW + 60_000,
    });
    expect(nextBscTeamCheckStep({ outcome: "failed" }, item(2), NOW)).toEqual({
      kind: "retry",
      pass: 3,
      runAt: NOW + 300_000,
    });
    expect(nextBscTeamCheckStep({ outcome: "failed" }, item(BSC_TEAM_CHECK_MAX_PASSES), NOW)).toEqual({
      kind: "giveUp",
      reason: "passes",
    });
  });

  test("a pass number past the bound still gives up (a stale item never loops)", () => {
    expect(nextBscTeamCheckStep({ outcome: "failed" }, item(9), NOW)).toEqual({
      kind: "giveUp",
      reason: "passes",
    });
  });

  test("a deferral pushes back to the window's end and carries no pass", () => {
    const step = nextBscTeamCheckStep({ outcome: "deferred", until: NOW + 90_000 }, item(1), NOW);
    expect(step).toEqual({ kind: "pushBack", runAt: NOW + 90_000 });
  });

  test("a deferral on the LAST pass is still a push-back, never a give-up (no pass is spent)", () => {
    const step = nextBscTeamCheckStep(
      { outcome: "deferred", until: NOW + 90_000 },
      item(BSC_TEAM_CHECK_MAX_PASSES),
      NOW,
    );
    expect(step.kind).toBe("pushBack");
  });

  test.each([
    ["no until", undefined],
    ["an until already past", NOW - 5_000],
    ["a NaN until", Number.NaN],
    ["an infinite until", Number.POSITIVE_INFINITY],
  ])("a deferral with %s runs at now, or at the deadline when that is nearer", (_name, until) => {
    const step = nextBscTeamCheckStep(
      { outcome: "deferred", ...(until !== undefined ? { until } : {}) },
      item(1),
      NOW,
    );
    // Infinity is finite-checked out to "now"; the others fall to now as well.
    expect(step).toEqual({ kind: "pushBack", runAt: NOW });
  });

  test("a push-back never lands past the 30 minute deadline", () => {
    const firstQueuedAt = NOW - 29 * 60_000;
    const deadline = firstQueuedAt + BSC_TEAM_CHECK_OPERATOR_AFTER_MS;
    const step = nextBscTeamCheckStep({ outcome: "deferred", until: NOW + 10 * 60_000 }, item(1, firstQueuedAt), NOW);
    expect(step).toEqual({ kind: "pushBack", runAt: deadline });
  });

  test("a card that has waited the full 30 minutes goes to the operator, at the deadline exactly", () => {
    const deadline = NOW;
    const firstQueuedAt = deadline - BSC_TEAM_CHECK_OPERATOR_AFTER_MS;
    expect(nextBscTeamCheckStep({ outcome: "deferred", until: NOW + 1 }, item(1, firstQueuedAt), NOW)).toEqual({
      kind: "giveUp",
      reason: "waited",
    });
    expect(
      nextBscTeamCheckStep({ outcome: "deferred", until: NOW + 1 }, item(1, firstQueuedAt + 1), NOW).kind,
    ).toBe("pushBack");
  });
});

describe("the lane end to end (item + completion)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedCard(t: ReturnType<typeof convexTest>, n = 1): Promise<Id<"cardChecklist">> {
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
        cardNumber: String(n),
        cardName: `Card ${n}`,
        platformData: { bsc: { ref: `bsc-${n}`, src: "b0" } },
        sortOrder: n,
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

  test("an open cooldown pushes the card back to the window's end, keeps its pass, and makes no BSC call", async () => {
    const t = convexTest(schema, modules);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const card = await seedCard(t);
    await openWindow(t, NOW + 90_000);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [card], pass: 2 });
    expect(await runBscTeamLane(t, lane, 1)).toBe(1);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lane).toHaveLength(1);
    expect(lane[0].item).toMatchObject({ cardChecklistId: card, pass: 2 });
    expect(lane[0].runAt).toBe(NOW + 90_000);
    // Not flagged: the operator has not been handed it yet.
    expect((await t.run(async (ctx) => ctx.db.get(card)))?.teamCheckDoneAt).toBeUndefined();
  });

  test("NEO-482: the first card answered after a window closes resets the cooldown streak", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ teamName: "Reds" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const card = await seedCard(t);
    await t.run(async (ctx) =>
      ctx.db.insert("marketplaceCooldowns", {
        platform: "bsc", endpoint: "cardListing", until: NOW - 1, last429At: NOW - 30_001, streak: 2, updatedAt: NOW,
      }),
    );
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [card] });
    expect(await runBscTeamLane(t, lane, 1)).toBe(1);

    const rows = await t.run(async (ctx) => ctx.db.query("marketplaceCooldowns").collect());
    expect(rows[0].streak).toBe(0);
    expect(lane).toHaveLength(0);
  });

  test("a card that has waited 30 minutes while the window stays open is handed to the operator", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn());
    const card = await seedCard(t);
    await openWindow(t, NOW + 600_000);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, {
      cardChecklistIds: [card],
      firstQueuedAt: NOW - BSC_TEAM_CHECK_OPERATOR_AFTER_MS - 1,
    });
    await runBscTeamLane(t, lane, 1);

    expect(lane).toHaveLength(0);
    const row = await t.run(async (ctx) => ctx.db.get(card));
    expect(row?.teamCheckOutcome).toBe("gaveUp");
    expect(row?.teamCheckDoneAt).toBeDefined();
  });

  test("the slot is held BSC_TEAM_ENRICH_DELAY_MS after each call: about one BSC call every 2 s (NEO-482)", async () => {
    // Paced below BSC's volume limit, deployment wide. 300 cards at ~2 s each
    // is ~10 min, inside BSC_TEAM_CHECK_OPERATOR_AFTER_MS with no 429.
    expect(BSC_TEAM_ENRICH_DELAY_MS).toBe(1_700);
    const t = convexTest(schema, modules);
    let calledAt: number | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calledAt = Date.now();
        return new Response("{}", { status: 200 });
      }),
    );
    const card = await seedCard(t);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [card] });
    expect(await runBscTeamLane(t, lane, 1)).toBe(1);

    expect(calledAt).not.toBeNull();
    const heldMs = Date.now() - calledAt!;
    expect(heldMs).toBeGreaterThanOrEqual(BSC_TEAM_ENRICH_DELAY_MS);
    expect(heldMs).toBeLessThan(BSC_TEAM_ENRICH_DELAY_MS + 1_000);
  });

  test("cardChecklist's drain estimate mirrors the lane's pace", () => {
    // cardChecklist.ts cannot import the "use node" adapter, so it keeps a copy.
    const src = readFileSync(join(__dirname, "cardChecklist.ts"), "utf8");
    const mirror = src.match(/const BSC_TEAM_ENRICH_DELAY_MS = ([\d_]+);/);
    expect(mirror).not.toBeNull();
    expect(Number(mirror![1].replace(/_/g, ""))).toBe(BSC_TEAM_ENRICH_DELAY_MS);
  });

  test("a push-back is never scheduled past the deadline", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn());
    const card = await seedCard(t);
    const firstQueuedAt = NOW - 29 * 60_000;
    await openWindow(t, NOW + 600_000);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [card], firstQueuedAt });
    await runBscTeamLane(t, lane, 1);

    expect(lane).toHaveLength(1);
    expect(lane[0].runAt).toBe(firstQueuedAt + BSC_TEAM_CHECK_OPERATOR_AFTER_MS);
  });
});

describe("enqueueBscTeamChecks", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedCards(t: ReturnType<typeof convexTest>, count: number): Promise<Id<"cardChecklist">[]> {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport", value: "Baseball", platformData: {}, children: [], lastUpdated: NOW,
      });
      const leafId = await ctx.db.insert("selectorOptions", {
        level: "setName", value: "2024 Topps", platformData: {}, parentId: sportId, children: [], lastUpdated: NOW,
      });
      await ctx.db.patch(sportId, { children: [leafId] });
      const ids: Id<"cardChecklist">[] = [];
      for (let n = 1; n <= count; n += 1) {
        ids.push(
          await insertTestCard(ctx, {
            selectorOptionId: leafId, cardNumber: String(n), cardName: `Card ${n}`,
            platformData: { bsc: { ref: `bsc-${n}`, src: "b0" } }, sortOrder: n, lastUpdated: NOW,
          }),
        );
      }
      return ids;
    });
  }

  test("a fresh card starts on pass 1, stamped with now", async () => {
    const t = convexTest(schema, modules);
    const [a] = await seedCards(t, 1);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [a] });
    expect(lane.map((l) => l.item)).toEqual([{ cardChecklistId: a, pass: 1, firstQueuedAt: NOW }]);
  });

  test.each([
    [0, 1],
    [-4, 1],
    [2.9, 2],
    [99, BSC_TEAM_CHECK_MAX_PASSES],
  ])("a pass of %s is clamped to %s", async (given, expected) => {
    const t = convexTest(schema, modules);
    const [a] = await seedCards(t, 1);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: [a], pass: given });
    expect(lane[0].item.pass).toBe(expected);
  });

  test("a long list is added one chunk at a time, the rest scheduled", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedCards(t, BSC_TEAM_ENQUEUE_CHUNK_SIZE + 3);
    const lane = captureBscTeamLane();
    await t.mutation(internal.bscTeamPool.enqueueBscTeamChecks, { cardChecklistIds: ids });
    expect(lane).toHaveLength(BSC_TEAM_ENQUEUE_CHUNK_SIZE);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({ from: BSC_TEAM_ENQUEUE_CHUNK_SIZE, pass: 1, firstQueuedAt: NOW });
  });
});
