/**
 * NEO-345 (D9) — the armed backfill that reads every stored card's OWN
 * attribute tokens through `applyBscAttributeFill`.
 *
 * Pins: dry run by default and writes nothing; an armed call on an unarmed
 * deployment is refused with the report; the armed run writes exactly what the
 * dry run reported (one planner); the counts; the leaf's format reaches AU
 * cards and a leaf without one is reported; a page ends on its write bound and
 * resumes at the first undecided row; a second walk writes nothing.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ENV_FLAG = "ALLOW_BSC_ATTRIBUTE_BACKFILL";
const SEEDED_AT = 1_700_000_000_000;

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  delete process.env[ENV_FLAG];
});

async function seedLeaf(
  t: T,
  features: Record<string, string> = { autographed: "None" },
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SEEDED_AT,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "insert",
      value: "Autographs",
      platformData: {},
      parentId: sportId,
      children: [],
      features,
      lastUpdated: SEEDED_AT,
    });
    return { sportId, leafId };
  });
}

async function seedCard(
  t: T,
  leafId: Id<"selectorOptions">,
  cardNumber: string,
  fields: Partial<Doc<"cardChecklist">> = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    insertTestCard(ctx, {
      selectorOptionId: leafId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number(cardNumber) || 0,
      lastUpdated: SEEDED_AT,
      ...fields,
    }),
  );
}

const allCards = (t: T) =>
  t.run(async (ctx) => ctx.db.query("cardChecklist").collect());

/** Walk every page with the given args; returns the summed counts. */
async function walk(
  t: T,
  args: { confirm?: string; scanLimit?: number; writeLimit?: number } = {},
) {
  const totals = {
    rowsNormalised: 0,
    printRunsSet: 0,
    printRunDisagreements: 0,
    autographsFormatted: 0,
    leavesAwaitingFormat: 0,
  };
  const leaves = new Set<string>();
  let cursor: number | null = null;
  let pages = 0;
  for (;;) {
    const page = await t.mutation(internal.backfillBscAttributeFeatures.run, {
      ...args,
      ...(cursor !== null ? { cursor } : {}),
    });
    pages++;
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[k] += page.counts[k];
    }
    for (const id of page.leavesAwaitingFormat) leaves.add(id);
    if (page.done) {
      expect(page.cursor).toBeNull();
      return { totals, leaves, pages, last: page };
    }
    expect(page.cursor).not.toBeNull();
    expect(page.cursor).not.toBe(cursor);
    cursor = page.cursor;
    if (pages > 50) throw new Error("backfill walk did not converge");
  }
}

/** A representative pre-NEO-345 set of rows. */
async function seedFixture(t: T) {
  const formatted = await seedLeaf(t, { autographed: "None", autographFormat: "On Card" });
  const unanswered = await seedLeaf(t);
  const player = await t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: "Ken Griffey Jr.",
      nameNormalized: normalizePlayerName("Ken Griffey Jr."),
      sportId: formatted.sportId,
      lastUpdated: SEEDED_AT,
    }),
  );
  const ids = {
    numbered: await seedCard(t, formatted.leafId, "1", { attributes: ["SN25"] }),
    relic: await seedCard(t, formatted.leafId, "2", { attributes: ["MEM"] }),
    rookie: await seedCard(t, formatted.leafId, "3", { attributes: ["RC"] }),
    auto: await seedCard(t, formatted.leafId, "4", {
      attributes: ["AU"],
      playerIds: [player],
      features: { autographed: "None" },
    }),
    disagreeing: await seedCard(t, formatted.leafId, "5", {
      attributes: ["SN25"],
      printRun: 50,
    }),
    awaiting: await seedCard(t, unanswered.leafId, "6", {
      attributes: ["AU"],
      features: { autographed: "None" },
    }),
    clean: await seedCard(t, formatted.leafId, "7", { attributes: ["NUM"], printRun: 10 }),
    bare: await seedCard(t, formatted.leafId, "8"),
  };
  return { ids, formattedLeaf: formatted.leafId, unansweredLeaf: unanswered.leafId };
}

describe("backfillBscAttributeFeatures — arming", () => {
  test("a dry run (the default) reports and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedFixture(t);
    const before = await allCards(t);
    const page = await t.mutation(internal.backfillBscAttributeFeatures.run, {});
    expect(page.armed).toBe(false);
    expect(page.message).toMatch(/^Dry run/);
    expect(page.counts.rowsNormalised).toBeGreaterThan(0);
    expect(await allCards(t)).toEqual(before);
  });

  test("confirm on an unarmed deployment is refused with the report, nothing written", async () => {
    const t = convexTest(schema, modules);
    await seedFixture(t);
    const before = await allCards(t);
    const page = await t.mutation(internal.backfillBscAttributeFeatures.run, {
      confirm: "BACKFILL",
    });
    expect(page.armed).toBe(false);
    expect(page.message).toMatch(/^Refused/);
    expect(page.counts.rowsNormalised).toBeGreaterThan(0);
    expect(await allCards(t)).toEqual(before);
  });

  test("the env flag alone does not arm it (confirm is per invocation)", async () => {
    const t = convexTest(schema, modules);
    await seedFixture(t);
    process.env[ENV_FLAG] = "1";
    const before = await allCards(t);
    const page = await t.mutation(internal.backfillBscAttributeFeatures.run, {});
    expect(page.armed).toBe(false);
    expect(await allCards(t)).toEqual(before);
  });
});

describe("backfillBscAttributeFeatures — what an armed run writes", () => {
  test("dry and armed agree, the rows read as NB's vocabulary, and a second walk writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { ids, unansweredLeaf } = await seedFixture(t);

    const dry = await walk(t);
    process.env[ENV_FLAG] = "1";
    const armed = await walk(t, { confirm: "BACKFILL" });
    expect(armed.last.armed).toBe(true);
    // One planner: the dry run reported exactly what the armed run did.
    expect(armed.totals).toEqual(dry.totals);
    expect([...armed.leaves]).toEqual([...dry.leaves]);

    expect(armed.totals).toEqual({
      // numbered, relic, rookie, auto, disagreeing (canonicalised to NUM
      // with the raw token kept beside it).
      rowsNormalised: 5,
      printRunsSet: 1,
      printRunDisagreements: 1,
      autographsFormatted: 1,
      leavesAwaitingFormat: 1,
    });
    expect([...armed.leaves]).toEqual([unansweredLeaf]);

    const get = (id: Id<"cardChecklist">) => t.run(async (ctx) => ctx.db.get(id));

    const numbered = await get(ids.numbered);
    expect(numbered!.attributes).toEqual(["NUM"]);
    expect(numbered!.printRun).toBe(25);

    const relic = await get(ids.relic);
    // Union, nothing removed: BSC's own MEM stays beside NB's RELIC.
    expect(relic!.attributes).toEqual(["MEM", "RELIC"]);
    expect(relic!.isRelic).toBe(true);

    const rookie = await get(ids.rookie);
    expect(rookie!.isRookie).toBe(true);
    expect(rookie!.features?.isRookie).toBe("true");

    const auto = await get(ids.auto);
    expect(auto!.features?.autographed).toBe("On Card");
    expect(auto!.features?.signedBy).toBe("Ken Griffey Jr.");

    const disagreeing = await get(ids.disagreeing);
    expect(disagreeing!.printRun).toBe(50);
    expect(disagreeing!.attributes).toContain("NUM");
    expect(disagreeing!.attributes).toContain("SN25");

    // No answer for that leaf: the AU card is reported, not guessed.
    const awaiting = await get(ids.awaiting);
    expect(awaiting!.features?.autographed).toBe("None");
    expect(awaiting!.lastUpdated).toBe(SEEDED_AT);

    for (const id of [ids.clean, ids.bare]) {
      expect((await get(id))!.lastUpdated).toBe(SEEDED_AT);
    }

    const again = await walk(t, { confirm: "BACKFILL" });
    expect(again.totals.rowsNormalised).toBe(0);
    expect(again.totals.autographsFormatted).toBe(0);
    expect(again.totals.printRunsSet).toBe(0);
  });
});

describe("backfillBscAttributeFeatures — paging", () => {
  test("a page ends on its write bound and resumes at the first undecided row", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    const ids: Array<Id<"cardChecklist">> = [];
    for (let i = 1; i <= 7; i++) {
      ids.push(await seedCard(t, leafId, String(i), { attributes: [`SN${i}`] }));
    }

    process.env[ENV_FLAG] = "1";
    const first = await t.mutation(internal.backfillBscAttributeFeatures.run, {
      confirm: "BACKFILL",
      writeLimit: 3,
    });
    expect(first.done).toBe(false);
    expect(first.counts.rowsNormalised).toBe(3);
    // Rows 4..7 are untouched until the next page.
    expect((await t.run(async (ctx) => ctx.db.get(ids[3])))!.printRun).toBeUndefined();

    const rest = await walk(t, { confirm: "BACKFILL", writeLimit: 3 });
    expect(rest.totals.rowsNormalised).toBe(4);
    for (const [i, id] of ids.entries()) {
      const row = await t.run(async (ctx) => ctx.db.get(id));
      expect(row!.printRun).toBe(i + 1);
      expect(row!.attributes).toEqual(["NUM"]);
    }
  });

  test("the scan bound pages too, and dry pages match armed pages", async () => {
    const t = convexTest(schema, modules);
    const { leafId } = await seedLeaf(t);
    for (let i = 1; i <= 5; i++) {
      await seedCard(t, leafId, String(i), { attributes: i % 2 ? ["RC"] : [] });
    }
    const dry = await walk(t, { scanLimit: 2 });
    process.env[ENV_FLAG] = "1";
    const armed = await walk(t, { confirm: "BACKFILL", scanLimit: 2 });
    expect(dry.pages).toBe(3);
    expect(armed.pages).toBe(dry.pages);
    expect(armed.totals).toEqual(dry.totals);
    expect(armed.totals.rowsNormalised).toBe(3);
  });
});
