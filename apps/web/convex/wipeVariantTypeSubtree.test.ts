/**
 * NEO-304 — the armed wipe of one variant type's subtree.
 *
 * The fixture is one set carrying TWO variant types: "Insert" (the target)
 * with two inserts, two parallels and cards on all of them, and "Base" (the
 * sibling) with its own parallel and cards. Every holding type the reference
 * graph names is present at least once inside the subtree, and at least once
 * OUTSIDE it, so a wipe that reached too far has something to break.
 *
 * The assertions that matter:
 *   - the dry run's counts are exact;
 *   - the armed run removes the subtree and leaves NO dangling reference in
 *     any referencing table (a scan of every one of them);
 *   - every document outside the subtree is byte-identical afterwards, except
 *     the variant type's `children` cache, which is cleared;
 *   - each arm refuses on its own, writing nothing;
 *   - a run stopped after every batch still converges, and every stop point
 *     is itself a consistent state.
 *
 * Every call runs with NO identity, the `npx convex run` shape (NEO-214).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  ENV_FLAG,
  SUBTREE_REFERENCE_GRAPH,
  WIPED_TABLES,
} from "./wipeVariantTypeSubtree";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_700_000_000_000;
const PHRASE = "wipe Insert under Baseball / 2026 / Bowman / Bowman";

type T = ReturnType<typeof convexTest>;
type SO = Id<"selectorOptions">;
type Card = Id<"cardChecklist">;

type Fixture = {
  sport: SO;
  year: SO;
  brand: SO;
  set: SO;
  insertVt: SO;
  baseVt: SO;
  insA: SO;
  insB: SO;
  parA1: SO;
  parA2: SO;
  baseP: SO;
  cards: Record<string, Card>;
  /** Every id the wipe must delete, by table. */
  doomed: Record<(typeof WIPED_TABLES)[number], string[]>;
};

async function seed(t: T): Promise<Fixture> {
  return t.run(async (ctx) => {
    const row = async (
      level:
        | "sport"
        | "year"
        | "manufacturer"
        | "setName"
        | "variantType"
        | "insert"
        | "parallel",
      value: string,
      parentId?: SO,
      extra: Record<string, unknown> = {},
    ): Promise<SO> => {
      const id = await ctx.db.insert("selectorOptions", {
        level,
        value,
        platformData: {},
        ...(parentId ? { parentId } : {}),
        children: [],
        lastUpdated: NOW,
        ...extra,
      });
      if (parentId) {
        const parent = await ctx.db.get(parentId);
        await ctx.db.patch(parentId, {
          children: [...(parent?.children ?? []), id],
        });
      }
      return id;
    };
    const card = async (
      selectorOptionId: SO,
      cardNumber: string,
      extra: Record<string, unknown> = {},
    ): Promise<Card> =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber,
        cardName: `Card ${cardNumber}`,
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
        ...extra,
      });

    const sport = await row("sport", "Baseball");
    const year = await row("year", "2026", sport);
    const brand = await row("manufacturer", "Bowman", year);
    const set = await row("setName", "Bowman", brand);
    const insertVt = await row("variantType", "Insert", set, {
      platformData: { bsc: { b0: "bowman-inserts" }, sportlots: { s0: "901" } },
      platformLabels: { bsc: { b0: "Inserts" }, sportlots: { s0: "Bowman Inserts" } },
      platformSlotSeq: { bsc: 1, sportlots: 1 },
      metadata: { isInsert: true },
    });
    const baseVt = await row("variantType", "Base", set, {
      platformData: { bsc: { b0: "bowman-base" } },
      metadata: { isBase: true },
    });

    // ── the subtree ────────────────────────────────────────────────────────
    const insA = await row("insert", "Chrome Prospects", insertVt, {
      platformData: { bsc: { b0: "chrome-prospects" }, sportlots: { s0: "77" } },
    });
    const insB = await row("insert", "Bowman Scouts", insertVt);
    const parA1 = await row("parallel", "Refractor", insA, {
      platformData: { bsc: { b0: "chrome-prospects-refractor" } },
    });
    const parA2 = await row("parallel", "Gold", insA);

    // ── the sibling, outside ───────────────────────────────────────────────
    const baseP = await row("parallel", "Base Refractor", baseVt);

    const player = await ctx.db.insert("players", {
      name: "Jackson Holliday",
      nameNormalized: "holliday jackson",
      sportId: sport,
      lastUpdated: NOW,
    });

    const cards: Record<string, Card> = {
      a1: await card(insA, "CP-1", {
        imageUrls: { front: "https://example.test/a1.jpg" },
        playerIds: [player],
      }),
      a3: await card(insA, "CP-3"),
      b1: await card(insB, "BS-1"),
      p1c1: await card(parA1, "CP-1"),
      p1c2: await card(parA1, "CP-2"),
      p2c1: await card(parA2, "CP-1"),
      // A card on the variant type row itself: not below it, kept.
      vtOwn: await card(insertVt, "I-1"),
      base1: await card(baseVt, "1", { playerIds: [player] }),
      base2: await card(baseVt, "2"),
      baseP1: await card(baseP, "1"),
    };
    // A variation of a1, on the same row.
    cards.a2 = await card(insA, "CP-1b", { variationOfCardId: cards.a1 });

    // ── cross-listings: out of, into, and within the subtree; one outside ──
    const xOut = await ctx.db.insert("cardCrossListings", {
      cardChecklistId: cards.a3,
      selectorOptionId: baseP,
      lastUpdated: NOW,
    });
    const xIn = await ctx.db.insert("cardCrossListings", {
      cardChecklistId: cards.base1,
      selectorOptionId: parA1,
      lastUpdated: NOW,
    });
    const xInternal = await ctx.db.insert("cardCrossListings", {
      cardChecklistId: cards.p1c1,
      selectorOptionId: insB,
      lastUpdated: NOW,
    });
    await ctx.db.insert("cardCrossListings", {
      cardChecklistId: cards.base2,
      selectorOptionId: baseP,
      lastUpdated: NOW,
    });

    // ── staged review, candidates, skips ───────────────────────────────────
    const qPlayer = await ctx.db.insert("entityReviewQueue", {
      selectorOptionId: insA,
      batchId: "batch-a",
      createdByUserId: "admin",
      kind: "player",
      name: "Jackson Holliday",
      sportId: sport,
      status: "ready",
    });
    const qTeam = await ctx.db.insert("entityReviewQueue", {
      selectorOptionId: insA,
      batchId: "batch-a",
      createdByUserId: "admin",
      kind: "team",
      name: "Norfolk Tides",
      sportId: sport,
      status: "pending",
      source: { kind: "careerTeamOf", playerRowId: qPlayer },
    });
    // Outside: one on the kept variant type, one on the sibling.
    await ctx.db.insert("entityReviewQueue", {
      selectorOptionId: insertVt,
      batchId: "batch-vt",
      createdByUserId: "admin",
      kind: "player",
      name: "Someone",
      sportId: sport,
      status: "ready",
    });
    await ctx.db.insert("entityReviewQueue", {
      selectorOptionId: baseVt,
      batchId: "batch-base",
      createdByUserId: "admin",
      kind: "player",
      name: "Someone Else",
      sportId: sport,
      status: "ready",
    });

    const candidate = (selectorOptionId: SO, cardNumber: string) =>
      ctx.db.insert("checklistCandidates", {
        selectorOptionId,
        batchId: "cand",
        createdByUserId: "admin",
        cardNumber,
        cardName: `Candidate ${cardNumber}`,
        platformData: {},
        bucket: "matched",
        stem: cardNumber,
        status: "ready",
        lastUpdated: NOW,
      });
    const cand = await candidate(parA2, "CP-9");
    await candidate(baseP, "9");

    const skip = (selectorOptionId: SO, name: string) =>
      ctx.db.insert("entityReviewSkips", {
        selectorOptionId,
        kind: "player",
        nameNormalized: name.toLowerCase(),
        name,
        skippedAt: NOW,
        skippedByUserId: "admin",
      });
    const skipIn = await skip(insB, "CHECKLIST");
    await skip(baseVt, "CHECKLIST");

    // ── sync status: one keyed on a subtree row, one on the variant type
    //    (its insert column, naming a subtree row), one on the sibling ─────
    const statusIn = await ctx.db.insert("selectorSyncStatus", {
      level: "parallel",
      parentId: insA,
      status: "done",
      unlinked: [{ id: parA2, value: "Gold", side: "bsc" }],
      updatedAt: NOW,
    });
    const statusVt = await ctx.db.insert("selectorSyncStatus", {
      level: "insert",
      parentId: insertVt,
      status: "done",
      unlinked: [{ id: insB, value: "Bowman Scouts", side: "sportlots" }],
      updatedAt: NOW,
    });
    await ctx.db.insert("selectorSyncStatus", {
      level: "parallel",
      parentId: baseVt,
      status: "error",
      message: "sibling column",
      updatedAt: NOW,
    });

    return {
      sport,
      year,
      brand,
      set,
      insertVt,
      baseVt,
      insA,
      insB,
      parA1,
      parA2,
      baseP,
      cards,
      doomed: {
        selectorOptions: [insA, insB, parA1, parA2],
        cardChecklist: [
          cards.a1,
          cards.a2,
          cards.a3,
          cards.b1,
          cards.p1c1,
          cards.p1c2,
          cards.p2c1,
        ],
        cardCrossListings: [xOut, xIn, xInternal],
        entityReviewQueue: [qPlayer, qTeam],
        checklistCandidates: [cand],
        entityReviewSkips: [skipIn],
        selectorSyncStatus: [statusIn, statusVt],
      },
    };
  });
}

/** Every table a referenced id can live in, and every doc in it. */
const SNAPSHOT_TABLES = [
  ...WIPED_TABLES,
  "players",
  "playerAliases",
  "teams",
  "teamAliases",
  "leagues",
  "franchises",
] as const;

async function snapshot(t: T): Promise<Map<string, unknown>> {
  const docs = await t.run(async (ctx) => {
    const out: Array<{ _id: string }> = [];
    for (const table of SNAPSHOT_TABLES) {
      out.push(...(await ctx.db.query(table).collect()));
    }
    return out;
  });
  return new Map(docs.map((doc) => [doc._id, doc]));
}

/**
 * Scan every referencing table in the graph and report each id field that
 * points at nothing. Written from the schema, field by field.
 */
async function danglingReferences(t: T): Promise<string[]> {
  return t.run(async (ctx) => {
    const bad: string[] = [];
    const check = async (where: string, id: string | undefined) => {
      if (id === undefined) return;
      if ((await ctx.db.get(id as never)) === null) bad.push(`${where} -> ${id}`);
    };
    for (const row of await ctx.db.query("selectorOptions").collect()) {
      await check(`selectorOptions ${row._id}.parentId`, row.parentId);
      for (const child of row.children ?? []) {
        await check(`selectorOptions ${row._id}.children`, child);
      }
    }
    for (const row of await ctx.db.query("selectorSyncStatus").collect()) {
      await check(`selectorSyncStatus ${row._id}.parentId`, row.parentId);
      for (const entry of row.unlinked ?? []) {
        await check(`selectorSyncStatus ${row._id}.unlinked`, entry.id);
      }
    }
    for (const row of await ctx.db.query("cardChecklist").collect()) {
      await check(`cardChecklist ${row._id}.selectorOptionId`, row.selectorOptionId);
      await check(`cardChecklist ${row._id}.variationOfCardId`, row.variationOfCardId);
      for (const p of row.playerIds ?? []) {
        await check(`cardChecklist ${row._id}.playerIds`, p);
      }
    }
    for (const row of await ctx.db.query("cardCrossListings").collect()) {
      await check(`cardCrossListings ${row._id}.cardChecklistId`, row.cardChecklistId);
      await check(`cardCrossListings ${row._id}.selectorOptionId`, row.selectorOptionId);
    }
    for (const row of await ctx.db.query("entityReviewQueue").collect()) {
      await check(`entityReviewQueue ${row._id}.selectorOptionId`, row.selectorOptionId);
      await check(`entityReviewQueue ${row._id}.sportId`, row.sportId);
      if (row.source?.kind === "careerTeamOf") {
        await check(`entityReviewQueue ${row._id}.source`, row.source.playerRowId);
      }
      if (row.source?.kind === "leagueOf") {
        await check(`entityReviewQueue ${row._id}.source`, row.source.teamRowId);
      }
    }
    for (const row of await ctx.db.query("entityReviewSkips").collect()) {
      await check(`entityReviewSkips ${row._id}.selectorOptionId`, row.selectorOptionId);
    }
    for (const row of await ctx.db.query("checklistCandidates").collect()) {
      await check(`checklistCandidates ${row._id}.selectorOptionId`, row.selectorOptionId);
    }
    for (const table of [
      "players",
      "playerAliases",
      "teams",
      "teamAliases",
      "leagues",
      "franchises",
    ] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        await check(`${table} ${row._id}.sportId`, row.sportId);
      }
    }
    return bad;
  });
}

const run = (t: T, args: Record<string, unknown>) =>
  t.action(internal.wipeVariantTypeSubtree.run, args as never);

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string") logged.push(line);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Every id the wipe logged as deleted. */
function loggedIds(): Set<string> {
  const ids = new Set<string>();
  for (const line of logged) {
    let parsed: { msg?: string; ids?: Array<string | { id: string }> };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.msg !== "wipe_variant_type_subtree_deleted") continue;
    for (const entry of parsed.ids ?? []) {
      ids.add(typeof entry === "string" ? entry : entry.id);
    }
  }
  return ids;
}

const EXPECTED_TOTALS = {
  selectorOptions: { total: 4, insert: 2, parallel: 2, other: 0 },
  cardChecklist: 7,
  cardCrossListings: 3,
  entityReviewQueue: 2,
  checklistCandidates: 1,
  entityReviewSkips: 1,
  selectorSyncStatus: 2,
};

describe("NEO-304: dry run", () => {
  test("is the default, needs no arming, writes nothing, and counts exactly", async () => {
    const t = convexTest(schema, modules);
    const f = await seed(t);
    const before = await snapshot(t);

    const report = await run(t, { variantTypeId: f.insertVt });

    expect(report.mode).toBe("dryRun");
    if (report.mode !== "dryRun") throw new Error("unreachable");
    expect(report.armed).toBe(false);
    expect(report.totals).toEqual(EXPECTED_TOTALS);
    expect(report.target).toEqual({
      id: f.insertVt,
      value: "Insert",
      path: "Baseball / 2026 / Bowman / Bowman",
      confirmPhrase: PHRASE,
      isBase: false,
      bsc: { b0: "bowman-inserts" },
      sportlots: { s0: "901" },
      hasOwnCards: true,
      statusRows: 1,
    });
    // Exactly the rows holding more than their own checklist, with what.
    expect(report.beyondChecklist).toEqual([
      {
        id: f.insA,
        level: "insert",
        value: "Chrome Prospects",
        holds: {
          children: 2,
          cards: 3,
          cardsWithImages: 1,
          crossListingsOut: 1,
          reviewQueue: 2,
          syncStatus: 1,
        },
      },
      {
        id: f.parA1,
        level: "parallel",
        value: "Refractor",
        holds: { cards: 2, crossListingsIn: 1, crossListingsInternal: 1 },
      },
      {
        id: f.parA2,
        level: "parallel",
        value: "Gold",
        holds: { cards: 1, candidates: 1 },
      },
    ]);
    expect(report.blockers).toEqual([]);
    expect(report.rows).toBeUndefined();

    expect(await snapshot(t)).toEqual(before);
  });

  test("detail lists every row with its level, parent, slots and holdings", async () => {
    const t = convexTest(schema, modules);
    const f = await seed(t);

    const report = await run(t, { variantTypeId: f.insertVt, detail: true });
    if (report.mode !== "dryRun") throw new Error("unreachable");

    expect(report.rows).toEqual([
      {
        id: f.insA,
        level: "insert",
        value: "Chrome Prospects",
        parentId: f.insertVt,
        bsc: { b0: "chrome-prospects" },
        sportlots: { s0: "77" },
        holds: {
          children: 2,
          cards: 3,
          cardsWithImages: 1,
          crossListingsOut: 1,
          reviewQueue: 2,
          syncStatus: 1,
        },
      },
      {
        id: f.insB,
        level: "insert",
        value: "Bowman Scouts",
        parentId: f.insertVt,
        bsc: {},
        sportlots: {},
        holds: { cards: 1, skips: 1 },
      },
      {
        id: f.parA1,
        level: "parallel",
        value: "Refractor",
        parentId: f.insA,
        bsc: { b0: "chrome-prospects-refractor" },
        sportlots: {},
        holds: { cards: 2, crossListingsIn: 1, crossListingsInternal: 1 },
      },
      {
        id: f.parA2,
        level: "parallel",
        value: "Gold",
        parentId: f.insA,
        bsc: {},
        sportlots: {},
        holds: { cards: 1, candidates: 1 },
      },
    ]);
  });

  test("a probe that saturates is counted exactly by paging", async () => {
    // 150 staged candidates on one row is past the 100-row probe.
    const t = convexTest(schema, modules);
    const f = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i += 1) {
        await ctx.db.insert("checklistCandidates", {
          selectorOptionId: f.insB,
          batchId: "big",
          createdByUserId: "admin",
          cardNumber: `${i}`,
          cardName: `c${i}`,
          platformData: {},
          bucket: "bscOnly",
          stem: `${i}`,
          status: "pending",
          lastUpdated: NOW,
        });
      }
    });

    const report = await run(t, { variantTypeId: f.insertVt });
    if (report.mode !== "dryRun") throw new Error("unreachable");
    expect(report.totals.checklistCandidates).toBe(151);
  });

  test("refuses a target that is not a variant type, even as a dry run", async () => {
    const t = convexTest(schema, modules);
    const f = await seed(t);
    await expect(run(t, { variantTypeId: f.set })).rejects.toThrow(
      /setName row, not a variantType/,
    );
    await expect(run(t, { variantTypeId: f.insA })).rejects.toThrow(
      /insert row, not a variantType/,
    );
  });

  test("locate finds the variant type by its set path, with its phrase", async () => {
    const t = convexTest(schema, modules);
    const f = await seed(t);
    const found = await t.query(internal.wipeVariantTypeSubtree.locate, {
      sport: "baseball",
      year: "2026",
      brand: "BOWMAN",
      set: "Bowman ",
    });
    expect(found).toEqual([
      {
        setId: f.set,
        path: "Baseball / 2026 / Bowman / Bowman",
        variantTypes: [
          {
            id: f.insertVt,
            value: "Insert",
            isBase: false,
            children: 2,
            bsc: { b0: "bowman-inserts" },
            sportlots: { s0: "901" },
            confirmPhrase: PHRASE,
          },
          {
            id: f.baseVt,
            value: "Base",
            isBase: true,
            children: 1,
            bsc: { b0: "bowman-base" },
            sportlots: {},
            confirmPhrase: "wipe Base under Baseball / 2026 / Bowman / Bowman",
          },
        ],
      },
    ]);
  });
});

describe("NEO-304: armed run", () => {
  test("removes the subtree, leaves nothing dangling, and touches nothing else", async () => {
    vi.stubEnv(ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const f = await seed(t);
    const before = await snapshot(t);

    const result = await run(t, {
      variantTypeId: f.insertVt,
      dryRun: false,
      confirm: PHRASE,
    });

    expect(result).toEqual({
      mode: "applied",
      complete: true,
      deleted: EXPECTED_TOTALS,
      notEmpty: [],
      message: expect.stringContaining("Wiped."),
    });

    // Nothing points at nothing, in any referencing table.
    expect(await danglingReferences(t)).toEqual([]);

    // Exactly the doomed ids are gone; everything else is byte-identical,
    // except the variant type's children cache.
    const after = await snapshot(t);
    const doomed = new Set(Object.values(f.doomed).flat());
    const gone = [...before.keys()].filter((id) => !after.has(id));
    expect(new Set(gone)).toEqual(doomed);
    for (const [id, doc] of after) {
      if (id === f.insertVt) continue;
      expect(doc, `outside row ${id} changed`).toEqual(before.get(id));
    }

    // The variant type survives with its links, its cache emptied.
    const { children, ...vtAfter } = after.get(f.insertVt) as {
      children: string[];
    };
    const { children: childrenBefore, ...vtBefore } = before.get(
      f.insertVt,
    ) as { children: string[] };
    expect(childrenBefore).toEqual([f.insA, f.insB]);
    expect(children).toEqual([]);
    expect(vtAfter).toEqual(vtBefore);

    // The sibling variant type and the parent chain are untouched (covered
    // above; stated for the reader).
    for (const id of [f.baseVt, f.baseP, f.set, f.brand, f.year, f.sport]) {
      expect(after.get(id)).toEqual(before.get(id));
    }

    // Every deleted id was logged.
    expect(loggedIds()).toEqual(doomed);

    // A replay over the wiped subtree is a clean no-op.
    const again = await run(t, {
      variantTypeId: f.insertVt,
      dryRun: false,
      confirm: PHRASE,
    });
    expect(again).toMatchObject({
      complete: true,
      deleted: {
        selectorOptions: { total: 0, insert: 0, parallel: 0, other: 0 },
        cardChecklist: 0,
        cardCrossListings: 0,
        entityReviewQueue: 0,
        checklistCandidates: 0,
        entityReviewSkips: 0,
        selectorSyncStatus: 0,
      },
    });
    expect(await snapshot(t)).toEqual(after);
  });

  test("clears a children cache that already held stale ids", async () => {
    // The cache can name rows that are gone (the kind of drift NEO-300 left).
    // Filtering out what this run deletes would leave those behind.
    vi.stubEnv(ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const f = await seed(t);
    await t.run(async (ctx) => {
      const ghost = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: "Ghost",
        platformData: {},
        lastUpdated: NOW,
      });
      await ctx.db.delete(ghost);
      const vt = await ctx.db.get(f.insertVt);
      await ctx.db.patch(f.insertVt, {
        children: [...(vt?.children ?? []), ghost],
      });
    });

    const result = await run(t, {
      variantTypeId: f.insertVt,
      dryRun: false,
      confirm: PHRASE,
    });
    expect(result).toMatchObject({ complete: true });
    const vt = await t.run(async (ctx) => ctx.db.get(f.insertVt));
    expect(vt?.children).toEqual([]);
    expect(await danglingReferences(t)).toEqual([]);
  });

  test("a run stopped after every batch converges, and every stop is consistent", async () => {
    vi.stubEnv(ENV_FLAG, "1");
    const t = convexTest(schema, modules);
    const f = await seed(t);

    const sum = {
      selectorOptions: { total: 0, insert: 0, parallel: 0, other: 0 },
      cardChecklist: 0,
      cardCrossListings: 0,
      entityReviewQueue: 0,
      checklistCandidates: 0,
      entityReviewSkips: 0,
      selectorSyncStatus: 0,
    };
    let calls = 0;
    let complete = false;
    while (!complete) {
      calls += 1;
      if (calls > 100) throw new Error("did not converge");
      const result = await run(t, {
        variantTypeId: f.insertVt,
        dryRun: false,
        confirm: PHRASE,
        batchSize: 1,
        timeBudgetMs: 0,
      });
      if (result.mode !== "applied") throw new Error("unreachable");
      complete = result.complete;
      for (const key of Object.keys(sum) as Array<keyof typeof sum>) {
        if (key === "selectorOptions") {
          for (const level of ["total", "insert", "parallel", "other"] as const) {
            sum.selectorOptions[level] += result.deleted.selectorOptions[level];
          }
        } else {
          sum[key] += result.deleted[key];
        }
      }
      // Each partial stop is a consistent state on its own.
      expect(await danglingReferences(t)).toEqual([]);
    }

    expect(calls).toBeGreaterThan(5);
    expect(sum).toEqual(EXPECTED_TOTALS);
    const after = await snapshot(t);
    for (const ids of Object.values(f.doomed)) {
      for (const id of ids) expect(after.has(id)).toBe(false);
    }
    expect((after.get(f.insertVt) as { children: string[] }).children).toEqual(
      [],
    );
  });

  test("a variation outside the subtree is a blocker: listed, then refused", async () => {
    vi.stubEnv(ENV_FLAG, "true");
    const t = convexTest(schema, modules);
    const f = await seed(t);
    // A Base card claiming to vary a subtree card: an invariant break, and
    // deleting its parent would leave it dangling.
    const stray = await t.run(async (ctx) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId: f.baseVt,
        cardNumber: "CP-3b",
        cardName: "Stray",
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
        variationOfCardId: f.cards.a3,
      }),
    );

    const report = await run(t, { variantTypeId: f.insertVt });
    if (report.mode !== "dryRun") throw new Error("unreachable");
    expect(report.blockers).toEqual([
      {
        cardId: f.cards.a3,
        childCardId: stray,
        childSelectorOptionId: f.baseVt,
      },
    ]);

    await expect(
      run(t, { variantTypeId: f.insertVt, dryRun: false, confirm: PHRASE }),
    ).rejects.toThrow(/outside this variant type/);

    // The stray and its parent are both still there, and what did land
    // before the refusal left nothing dangling.
    const after = await snapshot(t);
    expect(after.has(stray)).toBe(true);
    expect(after.has(f.cards.a3)).toBe(true);
    expect(await danglingReferences(t)).toEqual([]);
  });
});

describe("NEO-304: refusals write nothing", () => {
  test.each([
    ["no arming flag", undefined, PHRASE, /not armed/],
    ["a flag that is not true or 1", "yes", PHRASE, /not armed/],
    ["a missing confirm", "true", undefined, /confirm does not match/],
    [
      "the sibling's phrase",
      "true",
      "wipe Base under Baseball / 2026 / Bowman / Bowman",
      /confirm does not match/,
    ],
    ["a near-miss phrase", "true", `${PHRASE} `, /confirm does not match/],
  ])("%s", async (_label, flag, confirm, error) => {
    if (flag !== undefined) vi.stubEnv(ENV_FLAG, flag);
    const t = convexTest(schema, modules);
    const f = await seed(t);
    const before = await snapshot(t);

    await expect(
      run(t, {
        variantTypeId: f.insertVt,
        dryRun: false,
        ...(confirm !== undefined ? { confirm } : {}),
      }),
    ).rejects.toThrow(error);

    expect(await snapshot(t)).toEqual(before);
  });

  test("every deleting mutation re-asserts the flag, the phrase and membership", async () => {
    const t = convexTest(schema, modules);
    const f = await seed(t);
    const before = await snapshot(t);
    const armed = { variantTypeId: f.insertVt, confirm: PHRASE };

    // Unarmed: straight to a batch, around the entry point.
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        ...armed,
        nodeId: f.parA1,
      }),
    ).rejects.toThrow(/not armed/);
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.deleteEmptyNodes, {
        ...armed,
        nodeIds: [f.parA2],
      }),
    ).rejects.toThrow(/not armed/);

    vi.stubEnv(ENV_FLAG, "true");
    // Armed, but a node from the SIBLING variant type.
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        ...armed,
        nodeId: f.baseP,
      }),
    ).rejects.toThrow(/not under this variant type/);
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeNodeRefsPage, {
        ...armed,
        nodeId: f.baseVt,
      }),
    ).rejects.toThrow(/not under this variant type/);
    // The variant type itself is kept, so it is not a member either.
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.wipeCardsPage, {
        ...armed,
        nodeId: f.insertVt,
      }),
    ).rejects.toThrow(/not under this variant type/);
    // Armed, right node, wrong phrase.
    await expect(
      t.mutation(internal.wipeVariantTypeSubtree.finalizeVariantType, {
        variantTypeId: f.insertVt,
        confirm: "wipe Insert",
      }),
    ).rejects.toThrow(/confirm does not match/);

    expect(await snapshot(t)).toEqual(before);
  });
});

describe("NEO-304: the surface and the graph are pinned", () => {
  const source = readFileSync(join(__dirname, "wipeVariantTypeSubtree.ts"), "utf8");

  test("every function in the module is internal", () => {
    const exported = [
      ...source.matchAll(/export const (\w+) = (\w+)\(\{/g),
    ].map(([, name, kind]) => [name, kind]);
    expect(exported.map(([name]) => name).sort()).toEqual(
      [
        "countRefsPage",
        "deleteEmptyNodes",
        "finalizeVariantType",
        "listChildren",
        "locate",
        "readTarget",
        "run",
        "surveyCardsPage",
        "surveyNodeRefs",
        "wipeCardsPage",
        "wipeNodeRefsPage",
      ].sort(),
    );
    for (const [name, kind] of exported) {
      expect(
        ["internalQuery", "internalMutation", "internalAction"],
        `${name} is declared ${kind}`,
      ).toContain(kind);
    }
  });

  test("the reference graph covers every table schema.ts points at a wiped table", () => {
    // Comments name ids too ("Re-add as v.id(...)"); only code counts.
    const schemaSrc = readFileSync(join(__dirname, "schema.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const starts = [...schemaSrc.matchAll(/^ {2}(\w+): defineTable\(/gm)];
    expect(starts.length).toBeGreaterThan(20);
    const blocks = new Map<string, string>();
    starts.forEach((match, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].index : schemaSrc.length;
      blocks.set(match[1], schemaSrc.slice(match.index, end));
    });
    // `selectorOptions` is `defineTable(selectorOptionFields)`: its fields
    // live in that object above the schema.
    const fieldsStart = schemaSrc.indexOf("export const selectorOptionFields = {");
    const fieldsEnd = schemaSrc.indexOf("\n};", fieldsStart);
    expect(fieldsStart).toBeGreaterThan(0);
    blocks.set(
      "selectorOptions",
      blocks.get("selectorOptions")! + schemaSrc.slice(fieldsStart, fieldsEnd),
    );

    const referencing = new Set<string>();
    for (const wiped of WIPED_TABLES) {
      for (const [table, text] of blocks) {
        if (text.includes(`v.id("${wiped}")`)) referencing.add(table);
      }
    }
    expect([...referencing].sort()).toEqual(
      Object.keys(SUBTREE_REFERENCE_GRAPH).sort(),
    );
  });
});
