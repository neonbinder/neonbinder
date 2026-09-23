/**
 * NEO-296 (audit condition 3) — a TRUNCATED year index skips the whole BSC
 * bucketing phase, not just the re-home moves.
 *
 * ## The bug
 *
 * `syncSetsAcrossManufacturers` builds a year-wide holder map from
 * `listYearSetRows`, which stops at `MAX_YEAR_SET_ROWS` and says so. That map
 * is rung 1 of `routeBscSets` — "NB already has a row for this BSC id" — and
 * rung 1 is what keeps the router legal: a set NB owns a row for is routed by
 * THAT ROW'S OWN NB NAME, never by the marketplace's.
 *
 * Truncation was handled by suppressing the `moves`. The same partial map
 * still fed the bucketing, so a set whose NB row the read never reached looked
 * like a set NB has no row for, fell to rung 2, and was filed under whatever
 * brand BSC's OWN name for it prefix-matched. That is NB behaviour keyed on a
 * marketplace value — CLAUDE.md, product invariant rule 4 — and it is the one
 * thing the "whose name decides" rule in `selectorSyncMatch.ts` exists to stop.
 *
 * ## What is asserted
 *
 * With the index truncated, the phase writes NOTHING and says so. A skipped
 * phase is recoverable (the next sync files the sets) and visible; a set filed
 * under a brand a marketplace name chose is neither.
 *
 * `MAX_YEAR_SET_ROWS` is module-mocked down rather than seeded past: the real
 * cap is 3,000 rows and the behaviour under test has nothing to do with the
 * number. The BSC adapter is module-mocked, so nothing here can reach a live
 * marketplace (NEO-247).
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const mockState = vi.hoisted(() => ({
  /** What BSC's flat year-wide set list returns. */
  bscSets: [] as Array<{ value: string; platformValue: string }>,
  /** Lowered so a two-row year counts as truncated. */
  maxYearSetRows: 1,
}));

vi.mock("./setFromMarketplace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./setFromMarketplace")>();
  return {
    ...actual,
    // A getter, not a value: the second test lowers and restores the cap at
    // run time, and a captured number would freeze whatever it was at import.
    get MAX_YEAR_SET_ROWS() {
      return mockState.maxYearSetRows;
    },
  };
});

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.object({
          sport: v.optional(v.string()),
          year: v.optional(v.string()),
          manufacturer: v.optional(v.string()),
          setName: v.optional(v.string()),
          variantType: v.optional(v.string()),
        }),
        platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
        requestId: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        options: v.array(
          v.object({ value: v.string(), platformValue: v.string() }),
        ),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, options: mockState.bscSets }),
    }),
  };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo296_trunc",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo296_trunc",
  name: "Admin User",
  role: "admin",
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockState.bscSets = [];
});

/**
 * Baseball / 2024 with BSC ids on sport and year (what makes the BSC phase
 * resolvable) and NO SportLots ids anywhere (so the SportLots phase is skipped
 * and this test is about one phase only). Topps carries a `setNamePrefix`, so
 * a set named "Topps Chrome" is exactly what rung 2 would file under it.
 */
async function seedYear(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" } },
      platformSlotSeq: { bsc: 1 },
      primaryPlatformId: { bsc: "b0" },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: { bsc: { b0: "2024" } },
      platformSlotSeq: { bsc: 1 },
      primaryPlatformId: { bsc: "b0" },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const toppsId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      // A brand row is born with its prefix equal to its value.
      metadata: { setNamePrefix: "Topps" },
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    return { sportId, yearId, toppsId };
  });
}

async function insertSet(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId,
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function setNameValues(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    (await ctx.db.query("selectorOptions").collect())
      .filter((r) => r.level === "setName")
      .map((r) => r.value)
      .sort(),
  );
}

describe("syncSetsAcrossManufacturers: a truncated year index skips the BSC phase", () => {
  test("files nothing, and says so, rather than routing by BSC's name for the set", async () => {
    const t = convexTest(schema, modules);
    const { yearId, toppsId } = await seedYear(t);
    // Two rows against a mocked cap of one: `listYearSetRows` returns a
    // PARTIAL map and reports `truncated`.
    await insertSet(t, toppsId, "Chrome");
    await insertSet(t, toppsId, "Heritage");
    const before = await setNameValues(t);

    // A BSC set whose marketplace name prefix-matches Topps. If the phase ran
    // on the partial index this would be filed under Topps on the strength of
    // that name alone.
    mockState.bscSets = [
      { value: "Topps Chrome Update", platformValue: "bsc-chrome-update" },
    ];

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.selectorOptions.syncSetsAcrossManufacturers, { yearId });

    expect(await setNameValues(t)).toEqual(before);
    expect(result.totalSets).toBe(0);
    expect(result.message).toContain("too many sets this year to file BSC's list");
    // The operator's rows are untouched — nothing was re-homed either.
    const parents = await t.run(async (ctx) =>
      (await ctx.db.query("selectorOptions").collect())
        .filter((r) => r.level === "setName")
        .map((r) => r.parentId),
    );
    expect(parents.every((p) => p === toppsId)).toBe(true);
  });

  test("an UNtruncated index still files the set — the guard is the truncation, not the fetch", async () => {
    // The control. Without it this file would pass just as well against a
    // function that had stopped filing sets altogether.
    const t = convexTest(schema, modules);
    mockState.maxYearSetRows = 3000;
    try {
      const { yearId, toppsId } = await seedYear(t);
      await insertSet(t, toppsId, "Chrome");
      mockState.bscSets = [
        { value: "Topps Chrome Update", platformValue: "bsc-chrome-update" },
      ];

      const result = await t
        .withIdentity(ADMIN_IDENTITY)
        .action(api.selectorOptions.syncSetsAcrossManufacturers, { yearId });

      expect(result.message).not.toContain("too many sets this year");
      // Filed UNDER TOPPS, by the brand's prefix — the routing the truncated
      // run must not attempt, so the fixture has to prove it works here.
      const filed = await t.run(async (ctx) =>
        (await ctx.db.query("selectorOptions").collect()).find(
          (r) => r.level === "setName" && r.value === "Topps Chrome Update",
        ),
      );
      expect(filed?.parentId).toBe(toppsId);
    } finally {
      mockState.maxYearSetRows = 1;
    }
  });
});
