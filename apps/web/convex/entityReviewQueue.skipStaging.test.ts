/**
 * NEO-330 — "Skip remaining names" is terminal: no step is left open under a
 * name the operator has just skipped.
 *
 * CI (flow checklist-wizard-skip-commits-and-unskip): the operator pressed
 * "Skip remaining names (17)", and seconds later the wizard showed "New Team:
 * Columbus Chill — Needed by: Glen Lang" with Confirm & Save gone. Glen Lang's
 * Wikidata lookup landed while the bulk skip was in flight: after the page's
 * query had chosen its ids, before its mutation wrote them. The player was
 * still undecided, so `applyLookupResult` staged his career team as a new
 * undecided row the page could not contain, the mutation skipped him, and the
 * walk ended with the staged step open.
 *
 * Two halves of one fix, each pinned here:
 *
 *   1. The skip's own mutation skips each settled row's staged steps in the
 *      same transaction (NEO-341, `skipStagedStepsOf` in
 *      `decideRowsByIdsImpl`), so a step staged after the page was chosen is
 *      skipped with its parent and the walk ends on the same page. The race
 *      is reproduced by driving `runBulkDecidePage` with a ctx whose
 *      `runQuery` lands the lookup right after the page query returns —
 *      convex-test runs transactions serially, so that is the only way to put
 *      the lookup in the window. (NEO-330 first fixed this with a re-read of
 *      the batch on the skip's last page; the merge with NEO-341 kept one
 *      mechanism, the transactional one.)
 *   2. `stageCareerTeamRowsImpl` / `stageLeagueRowsImpl` refuse a SKIPPED
 *      parent, so nothing stages under a row once it is skipped — which is
 *      what makes (1) race-free. The public `stageCareerTeamRows` (the
 *      wizard's belt-and-braces pass) is how a test reaches the impl guard
 *      directly; `applyLookupResult` already drops any decided row's result.
 *
 * Fixture conventions follow entityReviewQueue.careerTeamStaging.test.ts. The
 * staging's pool enqueue is scheduled and never drained (convex-test does not
 * mount the workpool component).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { runBulkDecidePage } from "./entityReviewQueue";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_skipstage_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_skipstage_001",
  role: "admin",
};

const BATCH = "batch-skip-stage";

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Hockey",
      sportConfig: { skuCode: "HK", league: "NHL" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertRow(
  t: T,
  opts: {
    sportId: Id<"selectorOptions">;
    kind: "player" | "team";
    name: string;
    status?: "pending" | "ready" | "error";
    enrichment?: Record<string, unknown>;
    decision?: Record<string, unknown>;
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: BATCH,
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized:
        opts.kind === "player" ? normalizePlayerName(opts.name) : normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: opts.status ?? "pending",
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.decision ? { decision: opts.decision as never } : {}),
    }),
  );
}

async function batchRows(t: T): Promise<Array<Doc<"entityReviewQueue">>> {
  return t.run(async (ctx) => ctx.db.query("entityReviewQueue").collect());
}

const GLEN_LANG_CAREER = [{ name: "Columbus Chill", fromYear: 1991, toYear: 1993 }];

/**
 * An action ctx for `runBulkDecidePage` that hands its queries and mutations
 * to convex-test, and runs `afterFirstQuery` once — right after the page's
 * query has chosen its ids, before the mutation that writes them. That is the
 * window a lookup landed in on CI.
 */
function actionCtx(t: T, afterFirstQuery: () => Promise<unknown>): ActionCtx {
  let landed = false;
  // Untyped on purpose: this forwards whatever reference the action passes.
  const run = t as unknown as {
    query: (ref: unknown, args: unknown) => Promise<unknown>;
    mutation: (ref: unknown, args: unknown) => Promise<unknown>;
  };
  return {
    auth: { getUserIdentity: async () => ADMIN_IDENTITY },
    runQuery: async (ref: unknown, args: unknown) => {
      const result = await run.query(ref, args);
      if (!landed) {
        landed = true;
        await afterFirstQuery();
      }
      return result;
    },
    runMutation: async (ref: unknown, args: unknown) => run.mutation(ref, args),
  } as unknown as ActionCtx;
}

/** The client's `drainRemaining`, against `runBulkDecidePage`. */
async function drainSkip(
  ctx: ActionCtx,
  selectorOptionId: Id<"selectorOptions">,
): Promise<{ calls: number; decided: number }> {
  let cursor: number | null = null;
  let decided = 0;
  for (let calls = 1; calls <= 10; calls++) {
    const result = await runBulkDecidePage(
      ctx,
      { selectorOptionId, batchId: BATCH, ...(cursor !== null ? { cursor } : {}) },
      "skip",
    );
    decided += result.decided;
    if (!result.hasMore || result.cursor === null) return { calls, decided };
    cursor = result.cursor;
  }
  throw new Error("skip walk did not converge in 10 pages");
}

describe("NEO-330: a lookup landing mid-skip cannot leave a step open", () => {
  test("a player's career team staged between the page's query and its write is skipped too", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertRow(t, { sportId, kind: "player", name: "Tony Martino", status: "ready" });
    const glen = await insertRow(t, { sportId, kind: "player", name: "Glen Lang" });

    const ctx = actionCtx(t, () =>
      t.mutation(internal.entityReviewQueue.applyLookupResult, {
        id: glen,
        status: "ready",
        enrichment: { careerTeams: GLEN_LANG_CAREER },
      }),
    );
    const { calls, decided } = await drainSkip(ctx, sportId);

    const rows = await batchRows(t);
    const staged = rows.filter(
      (r) => r.source?.kind === "careerTeamOf" && r.source.playerRowId === glen,
    );
    // The lookup really did land in the window and stage the step…
    expect(staged.map((r) => r.name)).toEqual(["Columbus Chill"]);
    // …and it was skipped with its parent rather than left open.
    expect(staged[0].decision).toEqual({ action: "skip" });
    expect(rows.every((r) => r.decision?.action === "skip")).toBe(true);
    expect(decided).toBe(3);
    // In the same transaction as Glen's own skip: no second page needed.
    expect(calls).toBe(1);
  });

  test("a team's league staged in the same window is skipped too", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, { sportId, kind: "team", name: "Tulsa Oilers" });

    const ctx = actionCtx(t, () =>
      t.mutation(internal.entityReviewQueue.applyLookupResult, {
        id: team,
        status: "ready",
        enrichment: { league: "Central Hockey League" },
      }),
    );
    await drainSkip(ctx, sportId);

    const rows = await batchRows(t);
    const league = rows.find((r) => r.kind === "league");
    expect(league?.source).toMatchObject({ kind: "leagueOf", teamRowId: team });
    expect(league?.decision).toEqual({ action: "skip" });
    expect(rows.every((r) => r.decision?.action === "skip")).toBe(true);
  });

  test("with no late row the last page ends the walk exactly as before", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertRow(t, { sportId, kind: "player", name: "Kyuin Shim", status: "ready" });

    const result = await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });
    expect(result.decided).toBe(1);
    expect(result.hasMore).toBe(false);
  });
});

describe("NEO-330: nothing stages under a skipped name", () => {
  test("a lookup landing after the bulk skip stages no team row, and the batch stays all-decided", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const glen = await insertRow(t, { sportId, kind: "player", name: "Glen Lang" });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .action(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: glen,
      status: "ready",
      enrichment: { careerTeams: GLEN_LANG_CAREER },
    });

    const rows = await batchRows(t);
    expect(rows.filter((r) => r.kind === "team")).toEqual([]);
    expect(rows.every((r) => r.decision?.action === "skip")).toBe(true);
  });

  test("the wizard's belt-and-braces pass stages nothing for a skipped player", async () => {
    // The lookup landed first (so the row carries a career), and the step it
    // staged is gone — the shape a stale client can still send this call for.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const glen = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Glen Lang",
      status: "ready",
      enrichment: { careerTeams: GLEN_LANG_CAREER },
      decision: { action: "skip" },
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, { reviewRowId: glen });

    expect(added).toBe(0);
    expect((await batchRows(t)).filter((r) => r.kind === "team")).toEqual([]);
  });

  test("hand-typed career teams on a skipped player are refused, not dropped", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const glen = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Glen Lang",
      status: "ready",
      decision: { action: "skip" },
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: glen,
        careerTeams: [{ name: "Columbus Chill", fromYear: 1991 }],
      }),
    ).rejects.toThrow(/Undo this row's skip/);
    expect((await batchRows(t)).filter((r) => r.kind === "team")).toEqual([]);
  });

  test("a typed league on a skipped team is refused, and stages nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const team = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Tulsa Oilers",
      status: "ready",
      decision: { action: "skip" },
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.stageLeagueRows, {
        reviewRowId: team,
        leagueName: "Central Hockey League",
      }),
    ).rejects.toThrow(/Undo this row's skip/);
    expect((await batchRows(t)).filter((r) => r.kind === "league")).toEqual([]);
  });

  test("a CREATED player still stages its career teams, unchanged", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const glen = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Glen Lang",
      status: "ready",
      enrichment: { careerTeams: GLEN_LANG_CAREER },
      decision: { action: "create" },
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, { reviewRowId: glen });

    expect(added).toBe(1);
    const staged = (await batchRows(t)).filter((r) => r.kind === "team");
    expect(staged.map((r) => r.name)).toEqual(["Columbus Chill"]);
    expect(staged[0].source).toEqual({ kind: "careerTeamOf", playerRowId: glen });
    expect(staged[0].decision).toBeUndefined();
  });

  test("a NEO-332 pick-step row is unaffected: unanswered it stages nothing, and the bulk skip takes it like any row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerIds = await t.run(async (ctx) => {
      const ids: Array<Id<"players">> = [];
      for (const birthYear of [1867, 1937]) {
        ids.push(
          await ctx.db.insert("players", {
            name: "Bob Allen",
            nameNormalized: normalizePlayerName("Bob Allen"),
            sportId,
            birthYear,
            lastUpdated: Date.now(),
          }),
        );
      }
      return ids;
    });
    const bob = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      enrichment: {
        existingCandidates: playerIds.map((playerId, i) => ({
          playerId,
          name: "Bob Allen",
          birthYear: 1867 + i * 70,
          careerSummary: "",
        })),
      },
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    // Unanswered: NEO-332's own refusal, not the skip one.
    expect(await asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, { reviewRowId: bob })).toBe(0);
    await expect(
      asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: bob,
        careerTeamNames: ["Columbus Chill"],
      }),
    ).rejects.toThrow(/Create new/);

    const result = await asAdmin.action(api.entityReviewQueue.recordAllRemainingAsSkip, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });
    expect(result).toMatchObject({ decided: 1, hasMore: false });
    const rows = await batchRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toEqual({ action: "skip" });
    // The pick step's candidates are untouched by the skip.
    expect(rows[0].enrichment?.existingCandidates).toHaveLength(2);
  });
});
