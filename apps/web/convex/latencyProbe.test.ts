/**
 * NEO-407 — the latency probe's targets answer signed-out, return nothing,
 * and write nothing.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

describe("latencyProbe", () => {
  test("ping and pingMutation answer null, signed out, on an empty database", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.latencyProbe.ping, { nonce: "a" })).toBeNull();
    expect(await t.mutation(api.latencyProbe.pingMutation, { nonce: "b" })).toBeNull();
  });

  test("pingMutation writes nothing", async () => {
    const t = convexTest(schema, modules);
    const before = await t.run(async (ctx) => (await ctx.db.query("selectorOptions").collect()).length);
    expect(await t.mutation(api.latencyProbe.pingMutation, { nonce: "c" })).toBeNull();
    const after = await t.run(async (ctx) => (await ctx.db.query("selectorOptions").collect()).length);
    expect(after).toBe(before);
  });
});
