/**
 * NEO-235 — coverage for the scripted `hallOfFameQid` repair.
 *
 * The four values NEO-96 shipped all pointed at unrelated Wikidata entities
 * (a Polish village, a beetle, "creator deity", a Serbian footballer), and
 * because `sportConfig` is COPIED onto each sport row at creation, correcting
 * the constants does not reach a deployment that already has rows. This task
 * is what reaches them.
 *
 * What these tests pin, and why each matters:
 *
 *  - a known-bad value IS repaired (the whole point);
 *  - a correct value is NOT rewritten (so the task is idempotent, and a second
 *    run in production writes nothing);
 *  - an UNKNOWN value is left alone and REPORTED — the safety property. An
 *    operator may have set a sport-specific Hall by hand, and a repair that
 *    silently converged everything to the default would destroy that without
 *    anyone seeing it happen;
 *  - a dry run patches NOTHING while reporting exactly what a real run would
 *    do, because that is the output an operator reads before committing.
 *
 * Lives at the convex/ root like every other convex-test file here.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/** The verified institutions — see convex/sportConfig.ts. */
const BASEBALL_HOF = "Q809892";
const FOOTBALL_HOF = "Q778412";

/** The value NEO-96 shipped for baseball: "Grochów", a village in Poland. */
const BAD_BASEBALL_HOF = "Q1194380";

async function seedSportRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    value: string;
    sportQid?: string;
    hallOfFameQid?: string;
    omitWikidata?: boolean;
    omitSportConfig?: boolean;
  },
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport" as const,
      value: opts.value,
      platformData: {},
      children: [],
      ...(opts.omitSportConfig
        ? {}
        : {
            sportConfig: {
              skuCode: "BB",
              league: "MLB",
              espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
              ...(opts.omitWikidata
                ? {}
                : {
                    wikidata: {
                      sportQid: opts.sportQid ?? "Q5369",
                      ...(opts.hallOfFameQid !== undefined
                        ? { hallOfFameQid: opts.hallOfFameQid }
                        : {}),
                    },
                  }),
            },
          }),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

const hofQidOf = (t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.sportConfig?.wikidata?.hallOfFameQid);

describe("repairSportHallOfFameQids:run", () => {
  test("repairs a baseball row carrying the known-bad QID", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, {
      value: "Baseball",
      hallOfFameQid: BAD_BASEBALL_HOF,
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([
      { sport: "Baseball", from: BAD_BASEBALL_HOF, to: BASEBALL_HOF },
    ]);
    expect(await hofQidOf(t, sportId)).toBe(BASEBALL_HOF);
  });

  test("keeps the rest of sportConfig intact — it patches one field, not the object", async () => {
    // `skuCode`/`league`/`espn` sit on the same object and an operator may have
    // edited any of them; a replace instead of a spread would silently drop them.
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, {
      value: "Baseball",
      hallOfFameQid: BAD_BASEBALL_HOF,
    });

    await t.mutation(internal.repairSportHallOfFameQids.run, {});

    const config = await t.run(
      async (ctx) => (await ctx.db.get(sportId))?.sportConfig,
    );
    expect(config?.skuCode).toBe("BB");
    expect(config?.league).toBe("MLB");
    expect(config?.espn?.leagueName).toBe("Major League Baseball");
    expect(config?.wikidata?.sportQid).toBe("Q5369");
  });

  test("leaves an already-correct row alone and reports it — a second run writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedSportRow(t, { value: "Baseball", hallOfFameQid: BASEBALL_HOF });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([
      { sport: "Baseball", reason: "already_correct", value: BASEBALL_HOF },
    ]);
  });

  test("leaves an UNKNOWN QID alone and reports it as skipped_unknown_value", async () => {
    // The safety property: an operator may have set a sport-specific Hall by
    // hand, and this task must surface it rather than converge it away.
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, {
      value: "Baseball",
      hallOfFameQid: "Q7442130", // Seattle Mariners Hall of Fame — a real, deliberate-looking choice
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([
      { sport: "Baseball", reason: "unknown_value", value: "Q7442130" },
    ]);
    expect(await hofQidOf(t, sportId)).toBe("Q7442130");
  });

  test("fills in a MISSING hallOfFameQid for a sport we ship a default for", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, { value: "Baseball" });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    // No `from` — there was nothing there to record.
    expect(result.repaired).toEqual([{ sport: "Baseball", to: BASEBALL_HOF }]);
    expect(await hofQidOf(t, sportId)).toBe(BASEBALL_HOF);
  });

  test("a dry run reports the same repair but patches nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, {
      value: "Baseball",
      hallOfFameQid: BAD_BASEBALL_HOF,
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.repaired).toEqual([
      { sport: "Baseball", from: BAD_BASEBALL_HOF, to: BASEBALL_HOF },
    ]);
    // The row is untouched — this is the output an operator reads BEFORE
    // committing, so it must not have committed anything.
    expect(await hofQidOf(t, sportId)).toBe(BAD_BASEBALL_HOF);
  });

  test("is idempotent — the second run repairs nothing", async () => {
    const t = convexTest(schema, modules);
    await seedSportRow(t, { value: "Baseball", hallOfFameQid: BAD_BASEBALL_HOF });

    await t.mutation(internal.repairSportHallOfFameQids.run, {});
    const second = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(second.repaired).toEqual([]);
    expect(second.skipped.map((s) => s.reason)).toEqual(["already_correct"]);
  });

  test("repairs every mapped sport in one pass, matching each row to its OWN sport's Hall", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSportRow(t, {
      value: "Baseball",
      hallOfFameQid: BAD_BASEBALL_HOF,
    });
    const football = await seedSportRow(t, {
      value: "Football",
      sportQid: "Q41323",
      hallOfFameQid: "Q1382553", // the beetle
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toHaveLength(2);
    expect(await hofQidOf(t, baseball)).toBe(BASEBALL_HOF);
    expect(await hofQidOf(t, football)).toBe(FOOTBALL_HOF);
  });

  test("a custom sport we ship no default for is skipped, not guessed at", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSportRow(t, {
      value: "Cricket",
      sportQid: "Q5375",
      hallOfFameQid: BAD_BASEBALL_HOF,
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([
      { sport: "Cricket", reason: "no_default_for_sport", value: BAD_BASEBALL_HOF },
    ]);
    expect(await hofQidOf(t, sportId)).toBe(BAD_BASEBALL_HOF);
  });

  test("a row whose sportQid disagrees with its name is skipped rather than made wronger", async () => {
    const t = convexTest(schema, modules);
    await seedSportRow(t, {
      value: "Baseball",
      sportQid: "Q41323", // American football's QID on a row named Baseball
      hallOfFameQid: BAD_BASEBALL_HOF,
    });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([
      { sport: "Baseball", reason: "sport_qid_mismatch", value: BAD_BASEBALL_HOF },
    ]);
  });

  test("a row with no sportConfig at all is left to the storeSelectorOptions backfill", async () => {
    const t = convexTest(schema, modules);
    await seedSportRow(t, { value: "Baseball", omitSportConfig: true });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([{ sport: "Baseball", reason: "no_sport_config" }]);
  });

  test("a row with sportConfig but no wikidata block is skipped — enrichment is off for it", async () => {
    const t = convexTest(schema, modules);
    await seedSportRow(t, { value: "Baseball", omitWikidata: true });

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([{ sport: "Baseball", reason: "no_wikidata_config" }]);
  });

  test("ignores non-sport rows entirely", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year" as const,
        value: "1989",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      }),
    );

    const result = await t.mutation(internal.repairSportHallOfFameQids.run, {});

    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
