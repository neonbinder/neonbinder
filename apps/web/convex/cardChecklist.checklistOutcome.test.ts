/**
 * PR 451 (NEO-478) — `teamCheckOutcome: "checklist"`, the stamp a card gets
 * when the operator's publisher checklist answered its team (BSC never asked).
 *
 *  - `enqueueBscTeamBackfill` mode "reask" never re-asks such a card (BSC was
 *    not the source) and counts it as `checklistNoTeam`; a "gaveUp" card in
 *    the same page is still selected.
 *  - `getCardChecklist` returns such a row (its `returns` validator is
 *    strict: an unlisted literal fails the whole checklist).
 *
 * Fixtures mirror `cardChecklist.bscTeamEnrichment.test.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { insertTestCard } from "../lib/testing/card-row";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_checklist_outcome_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_checklist_outcome_001",
  role: "admin",
};

let harnesses: Array<ReturnType<typeof convexTest>> = [];
function harness() {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  return t;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const t of harnesses) await cancelScheduled(t);
  harnesses = [];
});

async function seedLeaf(t: ReturnType<typeof convexTest>): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(sportId, { children: [setNameId] });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [leafId] });
    return leafId;
  });
}

async function insertCard(
  t: ReturnType<typeof convexTest>,
  leafId: Id<"selectorOptions">,
  cardNumber: string,
  outcome: "checklist" | "gaveUp" | "answered",
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    insertTestCard(ctx, {
      selectorOptionId: leafId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: { bsc: { ref: `bsc-${cardNumber}`, src: "b0" } },
      sortOrder: Number(cardNumber),
      lastUpdated: Date.now(),
      teamCheckDoneAt: 5,
      teamCheckOutcome: outcome,
    }),
  );
}

describe("enqueueBscTeamBackfill mode reask and a checklist-answered card", () => {
  test("counts it as checklistNoTeam and never queues it, while a gaveUp card beside it is queued", async () => {
    const t = harness();
    const leafId = await seedLeaf(t);
    const fromChecklist = await insertCard(t, leafId, "1", "checklist");
    const gaveUp = await insertCard(t, leafId, "2", "gaveUp");
    vi.stubEnv("ALLOW_BSC_TEAM_REASK", "1");

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      mode: "reask",
      confirm: "REASK",
    });

    expect(result.counts).toMatchObject({ checklistNoTeam: 1, gaveUp: 1, legacyNoOutcome: 0 });
    expect(result).toMatchObject({ selected: 1, enqueued: 1 });
    const row = await t.run((ctx) => ctx.db.get(fromChecklist));
    expect(row?.teamCheckOutcome).toBe("checklist");
    expect(row?.teamCheckDoneAt).toBe(5);
    const queued = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((j) => j.name.includes("enqueueBscTeamChecks"))
        .flatMap((j) => (j.args[0] as { cardChecklistIds: string[] }).cardChecklistIds),
    );
    expect(queued).toEqual([gaveUp]);
  });

  test("a page holding only checklist-answered cards selects nothing", async () => {
    const t = harness();
    const leafId = await seedLeaf(t);
    await insertCard(t, leafId, "1", "checklist");
    await insertCard(t, leafId, "2", "checklist");

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      mode: "reask",
      dryRun: true,
    });

    expect(result.selected).toBe(0);
    expect(result.counts.checklistNoTeam).toBe(2);
  });

  test("the unchecked mode ignores it too: it is already stamped", async () => {
    const t = harness();
    const leafId = await seedLeaf(t);
    await insertCard(t, leafId, "1", "checklist");

    const result = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {
      dryRun: true,
    });

    expect(result.selected).toBe(0);
  });
});

describe("getCardChecklist with a checklist-answered row", () => {
  test("returns the row and its teamCheckOutcome under the strict validator", async () => {
    const t = harness();
    const leafId = await seedLeaf(t);
    await insertCard(t, leafId, "1", "checklist");

    const rows = await t
      .withIdentity(ADMIN_IDENTITY)
      .query(api.selectorOptions.getCardChecklist, { selectorOptionId: leafId });

    expect(rows).toHaveLength(1);
    expect(rows[0].teamCheckOutcome).toBe("checklist");
  });
});
