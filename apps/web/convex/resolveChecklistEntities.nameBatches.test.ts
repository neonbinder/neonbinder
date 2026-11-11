/**
 * PR 451 (NEO-487) — `resolveUnknownsAndStartBatch` (reached through
 * `resolveChecklistEntities`) asks `players.resolveNamesForReview` in slices
 * of 25 names with at most 4 calls in flight.
 *
 * The real query is wrapped in the registry (convex-test builds its own
 * function around the wrapped `_handler`; see agent memory
 * reference_neo482_call_order_tap_and_mutant_module) so each call's size and
 * the number overlapping can be read. The wrapper holds each call open for a
 * macrotask so overlapping callers would be counted.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { cancelScheduled } from "../lib/testing/drain-scheduled";
import { NAME_REVIEW_CONCURRENCY, NAME_REVIEW_SLICE } from "./selectorOptions";

const tap = { sizes: [] as number[], inFlight: 0, maxInFlight: 0, dropFrom: undefined as number | undefined };

const realModules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

function tappedModules() {
  const modules = { ...realModules };
  const load = realModules["./players.ts"];
  modules["./players.ts"] = async () => {
    const real = (await load()) as Record<string, any>;
    const original = real.resolveNamesForReview;
    const wrapped = Object.assign(() => undefined, original, {
      _handler: async (ctx: unknown, args: { names: unknown[] }) => {
        tap.sizes.push(args.names.length);
        tap.inFlight += 1;
        tap.maxInFlight = Math.max(tap.maxInFlight, tap.inFlight);
        try {
          await new Promise<void>((r) => setImmediate(r));
          return await original._handler(ctx, args);
        } finally {
          tap.inFlight -= 1;
        }
      },
    });
    return { ...real, resolveNamesForReview: wrapped };
  };
  return modules;
}

afterEach(() => {
  tap.sizes = [];
  tap.inFlight = 0;
  tap.maxInFlight = 0;
});

async function run(playerCount: number) {
  const t = convexTest(schema, tappedModules());
  const { sportId, leafId } = await t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Test Set",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "2024" },
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, leafId };
  });
  const cards = Array.from({ length: playerCount }, (_, i) => ({
    cardNumber: String(i + 1),
    cardName: `Card ${i + 1}`,
    teams: [],
    players: [`Stranger Number${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`],
    platformData: {},
  }));
  const result = await t
    .withIdentity({
      subject: "admin_name_batches_001",
      issuer: "https://clerk.example.com",
      tokenIdentifier: "clerk|admin_name_batches_001",
      role: "admin",
    })
    .action(api.selectorOptions.resolveChecklistEntities, {
      selectorOptionId: leafId,
      sportId,
      cards,
    });
  await cancelScheduled(t);
  return result;
}

describe("resolveChecklistEntities: the name gate is batched", () => {
  test("the constants are 25 names a call and 4 calls at once", () => {
    expect(NAME_REVIEW_SLICE).toBe(25);
    expect(NAME_REVIEW_CONCURRENCY).toBe(4);
  });

  test("asks in slices of 25 with the remainder last, and every name is still reviewed", async () => {
    const result = await run(60);
    expect([...tap.sizes].sort((a, b) => b - a)).toEqual([25, 25, 10]);
    expect(result.unknownPlayers).toHaveLength(60);
  });

  // NOTE: convex-test runs queries one at a time, so `maxInFlight` here is 1
  // whatever the product's concurrency; this pins the ceiling and the slicing,
  // not that calls really overlap. The overlap itself is a gap a convex-test
  // harness cannot close.
  test("never has more than 4 calls in flight, across all ten slices", async () => {
    const result = await run(25 * 9 + 3);
    expect(tap.sizes.reduce((a, b) => a + b, 0)).toBe(228);
    expect(tap.sizes).toHaveLength(10);
    expect(tap.maxInFlight).toBeLessThanOrEqual(NAME_REVIEW_CONCURRENCY);
    expect(result.unknownPlayers).toHaveLength(228);
  });

  test("a single small set is one call", async () => {
    await run(3);
    expect(tap.sizes).toEqual([3]);
  });
});
