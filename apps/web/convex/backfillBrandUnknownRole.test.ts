/**
 * NEO-272 — the one-shot backfill that gives the existing "All Brands"
 * manufacturer rows the `metadata.isBrandUnknown` NB role.
 *
 * "All Brands" is not a brand: it is the marketplace's no-filter option on its
 * brand axis — "show all cards from all brands" — carried as a `manufacturer`
 * row. `syncSetsAcrossManufacturers` files a BSC set under it when the set's
 * name prefix-matches no real manufacturer, so what hangs off it is the sets
 * whose brand NB has not identified. A name meaning "show everything" says
 * nothing about any card beneath it, so composing it into a generated listing
 * title is meaningless text in a buyer-facing field — and it spends 12 of an
 * 80-character budget doing it. The runtime fix is a flag on the row; this task
 * is what puts the flag on the rows that already exist.
 *
 * The name match lives here and ONLY here — the ticket's own split, and the
 * product invariant's: a one-time migration may match by name, the runtime path
 * never may (the name is a marketplace filter label NB does not own). So these
 * tests pin two different things at once: that the match finds those rows, and
 * that it refuses to keep deciding anything afterwards (a second run writes
 * nothing, and an operator's explicit `false` survives).
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedYear(t: ReturnType<typeof convexTest>, value = "1995") {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "year",
      value,
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

async function seedManufacturer(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  opts: {
    /** A SportLots id, as a marketplace-supplied "All Brands" row really has. */
    sportlots?: Record<string, string>;
    isBrandUnknown?: boolean;
    cardNumberPrefix?: string;
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value,
      platformData: opts.sportlots ? { sportlots: opts.sportlots } : {},
      ...(opts.isBrandUnknown !== undefined || opts.cardNumberPrefix
        ? {
            metadata: {
              ...(opts.isBrandUnknown !== undefined
                ? { isBrandUnknown: opts.isBrandUnknown }
                : {}),
              ...(opts.cardNumberPrefix
                ? { cardNumberPrefix: opts.cardNumberPrefix }
                : {}),
            },
          }
        : {}),
      parentId,
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

const dry = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillBrandUnknownRole.run, {});

/**
 * BOTH arms: the per-invocation token AND the per-deployment flag. A helper
 * that set only one of them would make every test below a test of the other
 * one by accident.
 */
const armed = (t: ReturnType<typeof convexTest>) => {
  vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
  return t.mutation(internal.backfillBrandUnknownRole.run, {
    confirm: "BACKFILL",
  });
};

/** The token, on a deployment that was never armed. */
const armedButNoFlag = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.backfillBrandUnknownRole.run, {
    confirm: "BACKFILL",
  });

describe("backfillBrandUnknownRole — the dry run", () => {
  test("reports exactly what an armed run would do, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");
    const topps = await seedManufacturer(t, year, "Topps");

    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.granted).toBe(1);
    expect(report.skippedCounts.brandKnown).toBe(1);
    expect(report.rows).toEqual([
      { id: bucket, value: "All Brands", action: "granted" },
    ]);

    // NOT WRITTEN. This is the whole contract of a dry run, and the assertion
    // that a report the operator reads is not itself the change.
    const after = await t.run(async (ctx) => [
      await ctx.db.get(bucket),
      await ctx.db.get(topps),
    ]);
    expect(after[0]?.metadata?.isBrandUnknown).toBeUndefined();
    expect(after[0]?.lastUpdated).toBe(SENTINEL);
    expect(after[1]?.metadata?.isBrandUnknown).toBeUndefined();
  });

  test("the token WITHOUT the deployment flag is refused, and says which flag", async () => {
    // The two arms guard different mistakes. `confirm` is per-invocation and is
    // identical on every deployment, so it cannot catch a `--prod` typed out of
    // habit — the environment flag is the half that can. A refusal, not a
    // throw: the operator still gets the report they asked for, plus the one
    // line telling them what to do next.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");

    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
    // The plan is still reported in full, so the refusal costs the operator
    // nothing but the second command.
    expect(report.granted).toBe(1);
    expect(report.rows).toEqual([
      { id: bucket, value: "All Brands", action: "granted" },
    ]);

    // AND nothing was written.
    const row = await t.run(async (ctx) => ctx.db.get(bucket));
    expect(row?.metadata?.isBrandUnknown).toBeUndefined();
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("an unrecognised flag value does not arm the deployment", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "yes");
    const report = await armedButNoFlag(t);

    expect(report.armed).toBe(false);
    expect(report.message).toContain("ALLOW_SELECTOR_BACKFILL");
    expect(
      (await t.run(async (ctx) => ctx.db.get(bucket)))?.metadata
        ?.isBrandUnknown,
    ).toBeUndefined();
  });

  test("the flag ALONE writes nothing — the per-invocation token is still required", async () => {
    // An armed deployment is a state that outlives one command. If the flag
    // were sufficient, the plain dry-run command would start writing.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await dry(t);

    expect(report.armed).toBe(false);
    expect(report.granted).toBe(1);
    expect(
      (await t.run(async (ctx) => ctx.db.get(bucket)))?.metadata
        ?.isBrandUnknown,
    ).toBeUndefined();
  });

  test("an omitted `confirm` is a dry run — a half-typed command cannot arm itself", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    await seedManufacturer(t, year, "All Brands");

    // Not the token, so not armed.
    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(internal.backfillBrandUnknownRole.run, {
      confirm: "yes",
    });

    expect(report.armed).toBe(false);
    expect(report.granted).toBe(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("selectorOptions").collect(),
    );
    expect(
      rows.every((r) => r.metadata?.isBrandUnknown === undefined),
    ).toBe(true);
  });
});

describe("backfillBrandUnknownRole — the armed run", () => {
  test("grants the role to the 'All Brands' row", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");

    const report = await armed(t);

    expect(report.armed).toBe(true);
    expect(report.message).toContain("Applied");
    expect(report.granted).toBe(1);
    expect(
      (await t.run(async (ctx) => ctx.db.get(bucket)))?.metadata
        ?.isBrandUnknown,
    ).toBe(true);
  });

  test("there is ONE 'All Brands' row per year per sport, and every one of them is granted", async () => {
    // The row lives under a `year` parent, per year, per sport — a deployment
    // with a century of synced hockey years has a century of them. A task that
    // stopped at the first one would leave every other year's titles carrying
    // a name that means "show everything".
    const t = convexTest(schema, modules);
    const years = await Promise.all([
      seedYear(t, "1995"),
      seedYear(t, "1996"),
      seedYear(t, "1997"),
    ]);
    const buckets: Id<"selectorOptions">[] = [];
    for (const year of years) {
      buckets.push(await seedManufacturer(t, year, "All Brands"));
      await seedManufacturer(t, year, "Topps");
    }

    const report = await armed(t);

    expect(report.scanned).toBe(6);
    expect(report.granted).toBe(3);
    expect(report.skippedCounts.brandKnown).toBe(3);

    const flags = await t.run(async (ctx) =>
      Promise.all(
        buckets.map(async (id) => (await ctx.db.get(id))?.metadata?.isBrandUnknown),
      ),
    );
    expect(flags).toEqual([true, true, true]);
  });

  test("matching folds case and whitespace, through the project's ONE normaliser", async () => {
    // `selectorValueKey` is the same fold `syncSetsAcrossManufacturers` applies
    // when it looks for a row to adopt, so the two cannot disagree about which
    // row it is.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const odd = await seedManufacturer(t, year, "  all BRANDS ");

    const report = await armed(t);

    expect(report.granted).toBe(1);
    expect(
      (await t.run(async (ctx) => ctx.db.get(odd)))?.metadata?.isBrandUnknown,
    ).toBe(true);
  });

  test("a MARKETPLACE-SUPPLIED 'All Brands' gets the role too — it is the same row playing the same part", async () => {
    // SportLots offers "All Brands" as the no-filter option on its own hockey
    // brand list, so many of these rows arrive with a SportLots id rather than
    // being minted by NB — the normal case, not a curiosity. The runtime sync
    // adopts exactly such a row, and the product invariant has no "custom vs
    // not" distinction to hang a different answer on.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const derived = await seedManufacturer(t, year, "All Brands", {
      sportlots: { s0: "17" },
    });

    const report = await armed(t);

    expect(report.granted).toBe(1);
    const row = await t.run(async (ctx) => ctx.db.get(derived));
    expect(row?.metadata?.isBrandUnknown).toBe(true);
    // And the linkage is untouched: losing a marketplace id means inventory
    // cannot be listed.
    expect(row?.platformData.sportlots).toEqual({ s0: "17" });
  });

  test("is IDEMPOTENT — a second run writes nothing and reports the steady state", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands");

    await armed(t);
    const afterFirst = await t.run(async (ctx) => ctx.db.get(bucket));

    const second = await armed(t);
    expect(second.granted).toBe(0);
    expect(second.skippedCounts.alreadyHasRole).toBe(1);
    expect(second.rows).toEqual([
      { id: bucket, value: "All Brands", action: "already_has_role" },
    ]);

    const afterSecond = await t.run(async (ctx) => ctx.db.get(bucket));
    expect(afterSecond?.lastUpdated).toBe(afterFirst?.lastUpdated);
  });

  test("keeps the rest of `metadata` — it patches one field, not the object", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const bucket = await seedManufacturer(t, year, "All Brands", {
      cardNumberPrefix: "DK-",
    });

    await armed(t);

    const row = await t.run(async (ctx) => ctx.db.get(bucket));
    expect(row?.metadata?.isBrandUnknown).toBe(true);
    expect(row?.metadata?.cardNumberPrefix).toBe("DK-");
  });

  test("narrowing by `parentId` reads one year and leaves the others alone", async () => {
    // The documented recovery for a deployment too large for one transaction:
    // drain it a year at a time. It narrows what is READ; it decides nothing
    // differently.
    const t = convexTest(schema, modules);
    const [y1995, y1996] = await Promise.all([
      seedYear(t, "1995"),
      seedYear(t, "1996"),
    ]);
    const bucket1995 = await seedManufacturer(t, y1995, "All Brands");
    const bucket1996 = await seedManufacturer(t, y1996, "All Brands");

    vi.stubEnv("ALLOW_SELECTOR_BACKFILL", "1");
    const report = await t.mutation(internal.backfillBrandUnknownRole.run, {
      confirm: "BACKFILL",
      parentId: y1995,
    });

    expect(report.scanned).toBe(1);
    expect(report.granted).toBe(1);

    const after = await t.run(async (ctx) => [
      await ctx.db.get(bucket1995),
      await ctx.db.get(bucket1996),
    ]);
    expect(after[0]?.metadata?.isBrandUnknown).toBe(true);
    expect(after[1]?.metadata?.isBrandUnknown).toBeUndefined();
    expect(after[1]?.lastUpdated).toBe(SENTINEL);
  });
});

describe("backfillBrandUnknownRole — what it refuses to touch", () => {
  test("a real brand row is never granted the role", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const topps = await seedManufacturer(t, year, "Topps");
    const upperDeck = await seedManufacturer(t, year, "Upper Deck");

    const report = await armed(t);

    expect(report.granted).toBe(0);
    expect(report.skippedCounts.brandKnown).toBe(2);
    // Ordinary brands are COUNTED, never listed — a listing-title fix has no
    // business emitting the deployment's whole manufacturer catalogue.
    expect(report.rows).toEqual([]);

    const after = await t.run(async (ctx) => [
      await ctx.db.get(topps),
      await ctx.db.get(upperDeck),
    ]);
    expect(after[0]?.metadata?.isBrandUnknown).toBeUndefined();
    expect(after[1]?.metadata?.isBrandUnknown).toBeUndefined();
  });

  test("never overwrites an operator's explicit `false`", async () => {
    // `false` is a deliberate decision — "this really is a brand, leave it in
    // my titles". Re-deriving the role from the name on every run would undo
    // that answer the next time anybody ran the command.
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const demoted = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: false,
    });

    const report = await armed(t);

    expect(report.granted).toBe(0);
    expect(report.skippedCounts.alreadyHasRole).toBe(1);
    expect(report.rows).toEqual([
      { id: demoted, value: "All Brands", action: "already_has_role" },
    ]);

    const row = await t.run(async (ctx) => ctx.db.get(demoted));
    expect(row?.metadata?.isBrandUnknown).toBe(false);
    expect(row?.lastUpdated).toBe(SENTINEL);
  });

  test("never re-writes an existing `true` — the row is not touched at all", async () => {
    const t = convexTest(schema, modules);
    const year = await seedYear(t);
    const already = await seedManufacturer(t, year, "All Brands", {
      isBrandUnknown: true,
    });

    const report = await armed(t);

    expect(report.granted).toBe(0);
    expect(report.skippedCounts.alreadyHasRole).toBe(1);
    expect(
      (await t.run(async (ctx) => ctx.db.get(already)))?.lastUpdated,
    ).toBe(SENTINEL);
  });

  test("levels other than manufacturer are not scanned at all", async () => {
    // A setName row named "All Brands" is not the brand axis's filter option,
    // and the year above it is not either. Only the manufacturer level is read.
    const t = convexTest(schema, modules);
    const year = await seedYear(t, "All Brands");
    const bucket = await seedManufacturer(t, year, "All Brands");
    const setName = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "All Brands",
        platformData: {},
        parentId: bucket,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const report = await armed(t);

    expect(report.scanned).toBe(1);
    expect(report.granted).toBe(1);

    const after = await t.run(async (ctx) => [
      await ctx.db.get(year),
      await ctx.db.get(setName),
    ]);
    expect(after[0]?.metadata?.isBrandUnknown).toBeUndefined();
    expect(after[1]?.metadata?.isBrandUnknown).toBeUndefined();
  });

  test("the per-row report is CAPPED, while the counts stay exact", async () => {
    // One bucket per year per sport means the list an operator reads can run to
    // hundreds. The cap is on the list, never on the number they are told.
    const t = convexTest(schema, modules);
    for (let i = 0; i < 55; i++) {
      const year = await seedYear(t, `${1900 + i}`);
      await seedManufacturer(t, year, "All Brands");
    }

    const report = await armed(t);

    expect(report.granted).toBe(55);
    expect(report.rows).toHaveLength(50);
    expect(report.rows.every((r) => r.action === "granted")).toBe(true);
  });
});
