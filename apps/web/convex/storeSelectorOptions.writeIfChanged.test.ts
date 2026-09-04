/**
 * Unit tests for the NEO-85 write-if-changed guard in `storeSelectorOptions`.
 *
 * `storeSelectorOptions` upserts marketplace-synced options. Before NEO-85 it
 * ALWAYS patched a matching existing row (bumping `lastUpdated`) even when the
 * merged data was byte-identical to what was stored. In Convex, patching a row
 * invalidates every query that read it, so a no-op sync re-rendered and
 * reflowed the SetSelector columns for nothing — moving elements under
 * Maestro's coordinate taps (the weeks-long dropped-tap flake).
 *
 * These tests pin the guard: an unchanged option must NOT patch (and must NOT
 * bump `lastUpdated`); a genuinely changed option must still patch + bump.
 * `lastUpdated` is a "data last changed" marker — it is never displayed or used
 * for staleness (the FE "Last synced" reads cardChecklist.lastUpdated) — so a
 * fixed sentinel value surviving a no-op sync is the observable proof that the
 * row was not patched.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** Admin identity that satisfies requireAdmin (role="admin" in JWT). */
const ADMIN_IDENTITY = {
  subject: "admin_store_wic_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_store_wic_001",
  name: "Admin User",
  role: "admin",
};

// A fixed, far-in-the-past lastUpdated. A real patch replaces it with
// Date.now() (~1.7e12), so its survival vs replacement cleanly distinguishes
// "did not patch" from "did patch".
const SENTINEL = 1_000_000;

describe("storeSelectorOptions write-if-changed (NEO-85)", () => {
  test("does NOT patch or bump lastUpdated when the incoming option equals the existing row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const id: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: { b0: "bsc-fb" }, sportlots: { s0: "sl-fb" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
        // NEO-211: the sync now records the marketplace's own name for the set
        // against the slot it lives in — that stored label is what
        // `getSelectorSyncSuggestions` reads to notice a marketplace rename,
        // and at these levels the incoming display value IS the label. A row
        // that has never been synced by the new code lacks it, and writing it
        // for the first time is a genuine change; seeding it here keeps this
        // test about the NO-CHANGE path it was written for.
        platformLabels: { bsc: { b0: "Football" }, sportlots: { s0: "Football" } },
        children: [],
        // NEO-96: a synced sport row carries its config. Without this the
        // one-time sportConfig backfill would (correctly) patch the row, and
        // this test is specifically about the NO-CHANGE path.
        sportConfig: {
          skuCode: "FB",
          league: "NFL",
          espn: { path: "football/nfl", leagueName: "National Football League" },
          wikidata: { sportQid: "Q41323", hallOfFameQid: "Q1382553" },
        },
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [
        { value: "Football", platformData: { bsc: "bsc-fb", sportlots: "sl-fb" } },
      ],
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    // Unchanged → no patch → sentinel survives.
    expect(row?.lastUpdated).toBe(SENTINEL);
    expect(row?.platformData).toEqual({
      bsc: { b0: "bsc-fb" },
      sportlots: { s0: "sl-fb" },
    });
  });

  test("does NOT patch when a partial option merges to identical data", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const id: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: { b0: "bsc-fb" }, sportlots: { s0: "sl-fb" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
        // Only the BSC slot gets a label here: the option below carries no SL
        // id, so the SL side is not touched at all (NEO-211 — an absent side
        // is never refreshed and never unlinked without explicit coverage).
        platformLabels: { bsc: { b0: "Football" } },
        children: [],
        // NEO-96: a synced sport row carries its config. Without this the
        // one-time sportConfig backfill would (correctly) patch the row, and
        // this test is specifically about the NO-CHANGE path.
        sportConfig: {
          skuCode: "FB",
          league: "NFL",
          espn: { path: "football/nfl", leagueName: "National Football League" },
          wikidata: { sportQid: "Q41323", hallOfFameQid: "Q1382553" },
        },
        lastUpdated: SENTINEL,
      }),
    );

    // Option supplies only bsc (same value); merge preserves sportlots, so the
    // merged object equals the stored one → still a no-op.
    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Football", platformData: { bsc: "bsc-fb" } }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.lastUpdated).toBe(SENTINEL);
    expect(row?.platformData).toEqual({
      bsc: { b0: "bsc-fb" },
      sportlots: { s0: "sl-fb" },
    });
  });

  test("DOES patch and bump lastUpdated when platformData differs", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    const id: Id<"selectorOptions"> = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: { bsc: { b0: "bsc-fb" } },
      platformSlotSeq: { bsc: 1 },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    await asAdmin.mutation(api.selectorOptions.storeSelectorOptions, {
      level: "sport",
      options: [{ value: "Football", platformData: { bsc: "bsc-fb-NEW" } }],
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    // Changed → patched → sentinel replaced with a real Date.now() bump.
    expect(row?.lastUpdated).not.toBe(SENTINEL);
    expect(row?.lastUpdated).toBeGreaterThan(SENTINEL);
    expect(row?.platformData.bsc).toEqual({ b0: "bsc-fb-NEW" });
  });

});
