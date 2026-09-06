/**
 * NEO-252 — a skip LOG may say how much is missing and what it is called, and
 * nothing else.
 *
 * `SideResolution.missing` is built by `label()`, which renders an unresolvable
 * ancestor as `<level>=<value>` — and that value is the operator's own text: a
 * set they named, a sport they typed, a variant only their shop uses. NEO-47
 * keeps that out of `selectorSyncStatus.message` because reactive state is
 * served to the browser. The same reasoning reaches a Convex log: it is
 * retained, searchable, and read by people who are not the operator, so
 * "it's only a log" is a claim about the audience, not about the data.
 *
 * The rule is enforced by rendering every skip log through `missingSummary`
 * rather than by changing `missing` itself — the structured value still names
 * the row, which is what a caller needs and what the resolvability tests assert
 * on. This file is the proof at the OTHER end: real actions and mutations, a
 * chain whose every row is named something that could not occur as a level, a
 * facet, or a slug, and an assertion over everything they actually printed.
 *
 * One test per swept source file, each driving more than one of its swept
 * lines, because the failure mode is a single site that was missed.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo252_logs",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo252_logs",
  name: "Admin",
  role: "admin",
};

const SENTINEL = 1_000_000;

/**
 * Row display values chosen so a leak cannot hide.
 *
 * Deliberately NOT "Base", "Topps" or "2024": those are substrings of real
 * marketplace slugs (`baseball`, `2024-topps`), so a negative assertion built
 * on them fails on a body that is perfectly clean — a test that lies in the
 * safe direction is the harder failure to notice.
 */
const POISON = {
  sport: "ZZ Operator Typed Sport",
  year: "ZZ Operator Typed Year",
  manufacturer: "ZZ Operator Typed Brand",
  setName: "ZZ Operator Typed Set",
  variantType: "ZZ Operator Typed Variant",
} as const;

const POISON_VALUES = Object.values(POISON);

/** Every line the run printed, across every console channel. */
function capturedLines(): string[] {
  const channels = [console.log, console.warn, console.error] as unknown as Array<{
    mock: { calls: unknown[][] };
  }>;
  return channels
    .flatMap((fn) => fn.mock.calls)
    .map((call) =>
      call
        .map((arg) =>
          typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg)),
        )
        .join(" "),
    );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A chain with NO marketplace ids anywhere, every row poison-named.
 *
 * This is the ordinary hand-built set, and it is the shape that drives every
 * swept branch: each one fires precisely because a side cannot be resolved.
 */
async function seedPoisonChain(t: ReturnType<typeof convexTest>): Promise<{
  sportId: Id<"selectorOptions">;
  yearId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
}> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: POISON.sport,
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: POISON.year,
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: POISON.manufacturer,
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: POISON.setName,
      platformData: {},
      parentId: mfrId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: POISON.variantType,
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { sportId, yearId, setNameId, variantTypeId };
  });
}

/**
 * Asserts a swept line RAN, and that it carries no row display value.
 *
 * Scoped to the lines matching `marker` rather than to everything the run
 * printed, and that narrowing is deliberate. `planSelectorSync` also logs, and
 * its `withheld N item(s) … ambiguities` dump names sibling ROWS on purpose —
 * it is the only record of which items a sync declined to attach, it is
 * `console.warn`-only by documented design, and it is not one of the lines
 * NEO-252 swept. Asserting over the whole console would couple this file to
 * that separate decision and fail for a reason it is not testing.
 */
function expectSafeLogs(marker: string) {
  const lines = capturedLines().filter((line) => line.includes(marker));
  // The swept line must actually have RUN, or the loop below passes vacuously
  // — which is exactly how a "fixed" log site goes on leaking.
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    for (const value of POISON_VALUES) {
      expect(line).not.toContain(value);
    }
  }
}

describe("convex/selectorOptions.ts — swept skip logs carry no row value", () => {
  test("storeSelectorOptions, syncSetsAcrossManufacturers", async () => {
    const t = convexTest(schema, modules);
    const { yearId, setNameId } = await seedPoisonChain(t);

    // (1) The coverage-narrowing warn. An old SPA bundle sends error-derived
    // `coveredSides`, the chain resolves neither side, and both are dropped —
    // logging the parent chain's unresolvable rows as it goes.
    await t
      .withIdentity(ADMIN)
      .mutation(api.selectorOptions.storeSelectorOptions, {
        level: "variantType",
        parentId: setNameId,
        options: [{ value: POISON.variantType, platformData: {} }],
        coveredSides: ["bsc", "sportlots"],
        returnedIds: { bsc: [], sportlots: [] },
      });
    expectSafeLogs("dropping bsc from coveredSides");
    expectSafeLogs("dropping sportlots from coveredSides");
    // The positive half: what it says INSTEAD. Pinned so the test cannot pass
    // by the line having quietly lost its diagnostic payload — a log that says
    // nothing leaks nothing, and is also useless.
    expect(capturedLines().join("\n")).toContain(
      "missing=3 (sport,year,setName)",
    );

    // (2) The BSC-only set sync, refused before any request is built.
    await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.syncSetsAcrossManufacturers, { yearId });
    expectSafeLogs("[syncSetsAcrossManufacturers] no BSC ids on this path");
    expect(capturedLines().join("\n")).toContain("missing=2 (sport,year)");
  });
});

describe("convex/setReconciliation.ts — swept skip logs carry no row value", () => {
  test("storeReconciledOptions, fetchRawOptions", async () => {
    const t = convexTest(schema, modules);
    const { setNameId, variantTypeId } = await seedPoisonChain(t);

    // (1) The reconciler's own copy of the coverage narrowing. The two
    // mutations carry independent copies of this logic by design, so proving
    // the property on one says nothing about the other.
    await t
      .withIdentity(ADMIN)
      .mutation(api.setReconciliation.storeReconciledOptions, {
        level: "variantType",
        parentId: setNameId,
        reconciledItems: [
          {
            value: POISON.variantType,
            platformData: {},
            metadata: undefined,
          },
        ],
        coveredSides: ["bsc", "sportlots"],
        returnedIds: { bsc: [], sportlots: [] },
      });
    expectSafeLogs("dropping bsc from coveredSides");
    expectSafeLogs("dropping sportlots from coveredSides");

    // (2) The fetch's own skip line. Both sides are skipped, so it returns
    // before either adapter is reached — no network, and the log is the only
    // thing this branch produces.
    await t
      .withIdentity(ADMIN)
      .action(api.setReconciliation.fetchRawOptions, {
        level: "insert",
        parentId: variantTypeId,
        parentFilters: {
          sport: POISON.sport,
          year: POISON.year,
          manufacturer: POISON.manufacturer,
          setName: POISON.setName,
          variantType: POISON.variantType,
        },
      });
    expectSafeLogs("[fetchRawOptions] skipping");
    // Both sides named, both as counts + level names. The BSC half also proves
    // the untagged `variantType` entry is rendered by NAME — that row is the
    // one whose value an operator is most likely to have typed themselves.
    const fetchLine = capturedLines().find((l) =>
      l.includes("[fetchRawOptions] skipping"),
    );
    expect(fetchLine).toContain("bsc_missing=4 (sport,year,setName,variantType)");
    expect(fetchLine).toContain("sl_missing=4 (sport,year,manufacturer,unlinked set)");
  });
});
