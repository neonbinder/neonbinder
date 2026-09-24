/**
 * NEO-305 — Sync Sets no longer makes a flagship's SportLots colours into sets
 * when BSC answered for the year.
 *
 * ## The bug
 *
 * Sync Sets on Baseball › 2026 › Bowman created "Bowman Blue", "Bowman Gold",
 * "Bowman Neon Green" … as SETS. BSC lists three there (Bowman, Bowman Chrome,
 * Bowman Sapphire Edition); the colours are Bowman's parallels. NEO-237 keeps
 * the flagship (the set named after its brand) from prefix-hiding anything, so
 * every SportLots-only name extending it became a root and
 * `createSetsFromSlRoots` wrote it.
 *
 * ## What is asserted
 *
 * `classify` in `syncSetsAcrossManufacturers` turns `flagshipAbsorbs` on for a
 * scope only when (a) the BSC phase of THIS sync filed BSC's list, (b) the
 * scope holds a set with a BSC id and (c) it is not Unknown. Each test here
 * holds (b) and (c) and varies (a) — filed, skipped, paused, errored — plus
 * one that holds (a) and breaks (b). The colours are sets exactly when the
 * flag is off: NEO-237's behaviour is the fallback, not a casualty.
 *
 * Both adapters are module-mocked, so nothing here reaches a live marketplace
 * (NEO-247).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

type Option = { value: string; platformValue: string };

const mockState = vi.hoisted(() => ({
  /** BSC's flat year-wide set list, or a failure. */
  bsc: { success: true, options: [] as Option[] } as {
    success: boolean;
    options: Option[];
    message?: string;
  },
  /** SportLots' list for the brand, as the adapter returns it (stripped). */
  slSets: [] as Option[],
}));

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
      handler: async () => mockState.bsc,
    }),
  };
});

vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  const { action } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchSportLotsSelectorOptions: action({
      args: {
        level: v.string(),
        parentFilters: v.object({
          sport: v.optional(v.string()),
          year: v.optional(v.string()),
          manufacturer: v.optional(v.string()),
          setName: v.optional(v.string()),
          variantType: v.optional(v.string()),
        }),
        platformFilters: v.optional(v.record(v.string(), v.string())),
        labelContext: v.optional(
          v.object({ manufacturer: v.optional(v.string()) }),
        ),
        brandScope: v.optional(v.object({ setNamePrefix: v.string() })),
        requestId: v.optional(v.string()),
      },
      returns: v.object({
        success: v.boolean(),
        options: v.array(
          v.object({ value: v.string(), platformValue: v.string() }),
        ),
        message: v.optional(v.string()),
      }),
      handler: async () => ({ success: true, options: mockState.slSets }),
    }),
  };
});

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo305_flagship",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo305_flagship",
  name: "Admin User",
  role: "admin",
};

const PAUSE_ENV = "NEONBINDER_PAUSED_PLATFORMS";
let savedPause: string | undefined;

/** 2026 Bowman on SportLots, labels as the real-brand adapter strips them. */
const BOWMAN_SL: Option[] = [
  { value: "Bowman", platformValue: "sl-bowman" },
  { value: "Chrome", platformValue: "sl-chrome" },
  { value: "Sapphire Edition", platformValue: "sl-sapphire" },
  { value: "Blue", platformValue: "sl-blue" },
  { value: "Gold", platformValue: "sl-gold" },
  { value: "Neon Green", platformValue: "sl-neon-green" },
];

/** What BSC lists for 2026 Bowman. */
const BOWMAN_BSC: Option[] = [
  { value: "Bowman", platformValue: "bsc-bowman" },
  { value: "Bowman Chrome", platformValue: "bsc-bowman-chrome" },
  { value: "Bowman Sapphire Edition", platformValue: "bsc-bowman-sapphire" },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  savedPause = process.env[PAUSE_ENV];
  delete process.env[PAUSE_ENV];
  mockState.bsc = { success: true, options: [] };
  mockState.slSets = BOWMAN_SL;
});

afterEach(() => {
  if (savedPause === undefined) delete process.env[PAUSE_ENV];
  else process.env[PAUSE_ENV] = savedPause;
});

/**
 * Baseball / 2026 / Bowman with SportLots ids on sport, year and brand (the
 * attach rule the SportLots phase gates on) and, unless `bscIds: false`, BSC
 * ids on sport and year (what makes the BSC phase resolvable).
 */
async function seedYear(
  t: ReturnType<typeof convexTest>,
  opts: { bscIds?: boolean } = {},
) {
  const bsc = opts.bscIds !== false;
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {
        ...(bsc ? { bsc: { b0: "baseball" } } : {}),
        sportlots: { s0: "BB" },
      },
      platformSlotSeq: { ...(bsc ? { bsc: 1 } : {}), sportlots: 1 },
      children: [],
      lastUpdated: Date.now(),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2026",
      platformData: {
        ...(bsc ? { bsc: { b0: "2026" } } : {}),
        sportlots: { s0: "2026" },
      },
      platformSlotSeq: { ...(bsc ? { bsc: 1 } : {}), sportlots: 1 },
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    const bowmanId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Bowman",
      metadata: { setNamePrefix: "Bowman" },
      platformData: { sportlots: { s0: "BOW" } },
      platformSlotSeq: { sportlots: 1 },
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    await ctx.db.patch(yearId, { children: [bowmanId] });
    return { yearId, bowmanId };
  });
}

/** A set under the brand, optionally carrying a BSC id (condition b). */
async function insertSet(
  t: ReturnType<typeof convexTest>,
  brandId: Id<"selectorOptions">,
  value: string,
  bscId?: string,
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: bscId ? { bsc: { b0: bscId } } : {},
      ...(bscId ? { platformSlotSeq: { bsc: 1 } } : {}),
      parentId: brandId,
      children: [],
      lastUpdated: Date.now(),
    });
    const brand = await ctx.db.get(brandId);
    await ctx.db.patch(brandId, { children: [...(brand?.children ?? []), id] });
    return id;
  });
}

async function setNamesUnder(
  t: ReturnType<typeof convexTest>,
  brandId: Id<"selectorOptions">,
) {
  return t.run(async (ctx) =>
    (await ctx.db.query("selectorOptions").collect())
      .filter((r) => r.level === "setName" && r.parentId === brandId)
      .map((r) => r.value)
      .sort(),
  );
}

const sync = (
  t: ReturnType<typeof convexTest>,
  yearId: Id<"selectorOptions">,
  manufacturerId: Id<"selectorOptions">,
) =>
  t
    .withIdentity(ADMIN_IDENTITY)
    .action(api.selectorOptions.syncSetsAcrossManufacturers, {
      yearId,
      manufacturerId,
    });

/** What NEO-237 alone makes of the same SportLots list: three colour sets. */
const WITH_COLOUR_SETS = [
  "Bowman",
  "Bowman Blue",
  "Bowman Gold",
  "Bowman Neon Green",
];

describe("syncSetsAcrossManufacturers: the flagship absorbs only when BSC answered (NEO-305)", () => {
  test("BSC filed its list: the colours are left to Bowman's Parallels sync, not made sets", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    mockState.bsc = { success: true, options: BOWMAN_BSC };

    const result = await sync(t, yearId, bowmanId);

    expect(result.success).toBe(true);
    expect(await setNamesUnder(t, bowmanId)).toEqual([
      "Bowman",
      "Bowman Chrome",
      "Bowman Sapphire Edition",
    ]);
    expect(result.slCreated).toBe(0);
    expect(result.slFlagshipParallels).toBe(3);
    expect(result.message).toContain(
      "3 SportLots parallels parked for the flagship's Parallels sync",
    );
  });

  test("BSC skipped (no BSC ids on the path): NEO-237 unchanged, the colours become sets", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t, { bscIds: false });
    // (b) and (c) hold: the flagship already carries a BSC id.
    await insertSet(t, bowmanId, "Bowman", "bsc-bowman");

    const result = await sync(t, yearId, bowmanId);

    expect(result.skippedSides).toContain("bsc");
    expect(result.slFlagshipParallels).toBe(0);
    expect(await setNamesUnder(t, bowmanId)).toEqual(
      expect.arrayContaining(WITH_COLOUR_SETS),
    );
  });

  test("BSC paused: NEO-237 unchanged, the colours become sets", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    await insertSet(t, bowmanId, "Bowman", "bsc-bowman");
    process.env[PAUSE_ENV] = "buysportscards";
    // Would absorb if it were asked — the pause must be what turns it off.
    mockState.bsc = { success: true, options: BOWMAN_BSC };

    const result = await sync(t, yearId, bowmanId);

    expect(result.pausedSides).toContain("bsc");
    expect(result.slFlagshipParallels).toBe(0);
    expect(await setNamesUnder(t, bowmanId)).toEqual(
      expect.arrayContaining(WITH_COLOUR_SETS),
    );
  });

  test("BSC errored: NEO-237 unchanged, the colours become sets", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    await insertSet(t, bowmanId, "Bowman", "bsc-bowman");
    mockState.bsc = { success: false, options: [], message: "upstream 503" };

    const result = await sync(t, yearId, bowmanId);

    expect(result.failedPlatforms).toContain("bsc");
    expect(result.slFlagshipParallels).toBe(0);
    expect(await setNamesUnder(t, bowmanId)).toEqual(
      expect.arrayContaining(WITH_COLOUR_SETS),
    );
  });

  test("BSC filed, but nothing under this brand carries a BSC id: the colours become sets", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    // A hand-built flagship, no BSC id; BSC's year list has nothing for Bowman.
    await insertSet(t, bowmanId, "Bowman");
    mockState.bsc = {
      success: true,
      options: [{ value: "Topps Chrome", platformValue: "bsc-topps-chrome" }],
    };

    const result = await sync(t, yearId, bowmanId);

    expect(result.slFlagshipParallels).toBe(0);
    expect(await setNamesUnder(t, bowmanId)).toEqual(
      expect.arrayContaining(WITH_COLOUR_SETS),
    );
  });

  test("a second sync after absorbing writes nothing new either (retry-safe)", async () => {
    const t = convexTest(schema, modules);
    const { yearId, bowmanId } = await seedYear(t);
    mockState.bsc = { success: true, options: BOWMAN_BSC };

    await sync(t, yearId, bowmanId);
    const before = await setNamesUnder(t, bowmanId);
    const again = await sync(t, yearId, bowmanId);

    expect(await setNamesUnder(t, bowmanId)).toEqual(before);
    expect(again.slCreated).toBe(0);
    expect(again.slFlagshipParallels).toBe(3);
  });
});
