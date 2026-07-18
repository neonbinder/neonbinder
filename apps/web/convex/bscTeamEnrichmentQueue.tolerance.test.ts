/**
 * NEO-90: isolated from `convex/bscTeamEnrichmentQueue.test.ts` because it
 * needs a file-scoped `vi.mock` of `./adapters/buysportscards` to force
 * `resolveBscCardTeam` to throw — `resolveBscCardTeam`'s real
 * implementation deliberately swallows every externally-triggerable error
 * (bad response, network failure, JSON parse failure all return `null`
 * from inside its own try/catch), so there's no way to reach
 * `processBscTeamEnrichmentQueue`'s own try/catch around
 * `ctx.runAction(resolveBscCardTeam, ...)` through realistic inputs alone.
 * Mocking the module is the only way to prove that outer catch actually
 * tolerates a throw and keeps draining the tail — this is a real
 * behavioral guarantee (the queue must never wedge on one bad card), not
 * a framework detail, so it's worth covering even though it needs a
 * heavier-handed test technique. Kept in its own file since `vi.mock` is
 * hoisted and file-scoped in Vitest — mocking `resolveBscCardTeam` here
 * would otherwise break every other (real-fetch-based) test in the
 * sibling file.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    resolveBscCardTeam: internalAction({
      args: { cardChecklistId: v.id("cardChecklist") },
      returns: v.null(),
      handler: async (): Promise<null> => {
        throw new Error("simulated resolveBscCardTeam failure");
      },
    }),
  };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

describe("processBscTeamEnrichmentQueue — tolerance of a card that throws", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("one card's resolveBscCardTeam throwing does not abort the rest of the tail", async () => {
    const t = convexTest(schema, modules);

    const variantTypeId = await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      });
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
    });

    const cardA = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "1",
        cardName: "Card 1",
        platformData: { bsc: "bsc-1" },
        sortOrder: 0,
        lastUpdated: Date.now(),
      }),
    );
    const cardB = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: "2",
        cardName: "Card 2",
        platformData: { bsc: "bsc-2" },
        sortOrder: 1,
        lastUpdated: Date.now(),
      }),
    );

    // With resolveBscCardTeam mocked to always throw, the initial call
    // (processing cardA) must resolve cleanly (no uncaught rejection) —
    // the outer try/catch in processBscTeamEnrichmentQueue swallows the
    // failure and schedules the tail (cardB) to be attempted next.
    await expect(
      t.action(internal.adapters.buysportscards.processBscTeamEnrichmentQueue, {
        cardChecklistIds: [cardA, cardB],
      }),
    ).resolves.toBeNull();

    // Draining the reschedule chain (cardB's turn) must ALSO complete
    // without throwing, even though it fails too — proving the try/catch
    // shields every card, not just the first, from wedging the queue.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Neither card was actually resolved (the mock always throws before
    // doing anything useful), but critically nothing in the chain blew up.
    const a = await t.run(async (ctx) => ctx.db.get(cardA));
    const b = await t.run(async (ctx) => ctx.db.get(cardB));
    expect(a!.teamCheckDoneAt).toBeUndefined();
    expect(b!.teamCheckDoneAt).toBeUndefined();
  });
});
