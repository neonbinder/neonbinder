/**
 * NEO-237 (D7) — the rename-suggestion doors never tell a manufacturer row
 * linked THROUGH SportLots' all-brands option that "SportLots calls this All
 * Brands". That id names no brand; it is routing, not a label. Both doors
 * share one predicate (`slotIsSlAllBrands` in selectorOptions.ts, built on
 * `isSlAllBrandsBrandId`), pinned here rather than only in the pure-helper
 * suite because the shape that matters is the row's SLOT, not the predicate
 * in isolation. Companion to `selectorSyncSuggestions.test.ts` (the general
 * rename-suggestion behaviour this suite does not repeat).
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo237_sl_all_brands",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo237_sl_all_brands",
  name: "Admin User",
  role: "admin",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** A via-All-Brands manufacturer row: its NB name differs from the sentinel's label. */
async function viaAllBrandsBrand(
  t: ReturnType<typeof convexTest>,
  value = "Bandai",
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: { sportlots: { s0: "All Brands" } },
      platformLabels: { sportlots: { s0: "All Brands" } },
      primaryPlatformId: { sportlots: "s0" },
      platformSlotSeq: { sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** An ordinary manufacturer row whose SL label really does differ. */
async function ordinaryBrand(
  t: ReturnType<typeof convexTest>,
  value: string,
  slLabel: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: { sportlots: { s0: "topps-id" } },
      platformLabels: { sportlots: { s0: slLabel } },
      primaryPlatformId: { sportlots: "s0" },
      platformSlotSeq: { sportlots: 1 },
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

describe("getSelectorSyncSuggestions suppresses the SL side on a via-All-Brands manufacturer", () => {
  test("a brand named after the sentinel's own label offers no suggestion", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await viaAllBrandsBrand(t, "Bandai");

    const result = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "manufacturer", parentId: undefined },
    );
    expect(result).toEqual([]);
  });

  test("control: an ordinary manufacturer row with a genuinely different SL label still gets a suggestion", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await ordinaryBrand(t, "Topps Inc", "Topps");

    const result = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "manufacturer", parentId: undefined },
    );
    expect(result).toHaveLength(1);
    expect(result[0].suggestions).toEqual([
      { side: "sportlots", label: "Topps", foldEqual: false },
    ]);
  });

  test("the Unknown row itself (also linked via the sentinel) is suppressed the same way", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Unknown",
        metadata: { isBrandUnknown: true },
        platformData: { sportlots: { s0: "All Brands" } },
        platformLabels: { sportlots: { s0: "All Brands" } },
        primaryPlatformId: { sportlots: "s0" },
        platformSlotSeq: { sportlots: 1 },
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const result = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "manufacturer", parentId: undefined },
    );
    expect(result).toEqual([]);
  });
});

describe("applySelectorSyncSuggestions counts a via-All-Brands decision as skipped", () => {
  test("accepting a decision against the sentinel slot is skipped, not applied — the row is not renamed", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const rowId = await viaAllBrandsBrand(t, "Bandai");
    const row = await t.run((ctx) => ctx.db.get(rowId as Id<"selectorOptions">));

    const result = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "manufacturer",
        parentId: undefined,
        decisions: [
          {
            existingId: rowId,
            baseVersion: row!.lastUpdated!,
            side: "sportlots",
            action: "accept",
          },
        ],
      },
    );
    expect(result).toEqual({
      applied: 0,
      declined: 0,
      stale: 0,
      clashed: 0,
      skipped: 1,
    });

    const after = await t.run((ctx) => ctx.db.get(rowId as Id<"selectorOptions">));
    expect(after?.value).toBe("Bandai");
  });
});
