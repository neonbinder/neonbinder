/**
 * NEO-236 — a career team the batch would have to CREATE becomes its own
 * review step, walked before the player who needs it.
 *
 * Jason, 2026-09-05, looking at the wizard showing three cramped Location/Name
 * pairs under Travis Bazzana's career list: "How does this dialog know which
 * League the new team is in? I think we need to show a new team dialog instead
 * of that inline thing. So for this example I think we should show 3 modals in
 * the walker: 1. New Team: Sydney Blue Sox 2. New Team: Oregon State Beavers
 * 3. New Player Travis Bazzana which can now use the 2 new teams that were
 * created."
 *
 * Two mechanisms make that sequence happen, and this file covers both:
 *
 *   1. **Staging** (`stageCareerTeamRowsImpl`, reached from
 *      `applyLookupResult` when a player's enrichment lands, from
 *      `decideAllRemaining`'s create branch, and from the public
 *      `stageCareerTeamRows` mutation). Every accepted career team we do not
 *      already hold gets a `team` row in the SAME batch carrying
 *      `source.kind === "careerTeamOf"`.
 *   2. **Ordering** (`walkOrder`, applied by `getBatch`). Insertion order puts
 *      a staged row AFTER its player — its player's lookup is what created it
 *      — so the walk order is composed rather than stored.
 *
 * The bulk "Add All Remaining as New" pre-fill's League half
 * (`prefilledTeamCreate`) is covered here too: it must resolve an existing
 * league to an ID, offer a league we do not hold as a NAME, and create no
 * league row of its own, because reading must not write.
 *
 * Fixture conventions follow convex/entityReviewQueue.test.ts: raw
 * `ctx.db.insert("entityReviewQueue", ...)` rows rather than routing through
 * the real fetch action, `ADMIN_IDENTITY` for the public surface, bare
 * `t.mutation` for the internal one. The scheduled pool enqueue is ASSERTED
 * off `_scheduled_functions` and never drained — `wikidataPool.enqueueAction`
 * reaches the workpool component, which convex-test does not mount.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { teamFullName } from "../lib/teams/team-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_stage_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_stage_001",
  role: "admin",
};

/** A second operator, for the ownership boundary. */
const OTHER_ADMIN = {
  subject: "user_stage_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_stage_002",
  role: "admin",
};

const BATCH = "batch-stage";

async function seedSport(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

/**
 * A review row as `startBatch` writes one — `nameNormalized` included, because
 * that column IS the dedup key staging reads through
 * `by_batch_and_kind_and_name`. A fixture that omitted it would make every
 * "already in the batch" assertion vacuously pass.
 */
async function insertRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    sportId: Id<"selectorOptions">;
    kind: "player" | "team";
    name: string;
    batchId?: string;
    createdByUserId?: string;
    status?: "pending" | "ready" | "error";
    enrichment?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    source?: {
      kind: "careerTeamOf";
      playerRowId: Id<"entityReviewQueue">;
      wikidataId?: string;
    };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: opts.batchId ?? BATCH,
      createdByUserId: opts.createdByUserId ?? ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized: normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: opts.status ?? "pending",
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.decision ? { decision: opts.decision as never } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    }),
  );
}

/** A `teams` row keyed exactly as `teamRowFields` would key it. */
async function insertTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  parts: { name: string; location?: string },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      nameNormalized: normalizeTeamName(teamFullName(parts)),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function stagedRows(
  t: ReturnType<typeof convexTest>,
): Promise<Array<Record<string, unknown>>> {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("entityReviewQueue").collect();
    return rows.filter(
      (r) => (r as { source?: { kind?: string } }).source?.kind === "careerTeamOf",
    ) as unknown as Array<Record<string, unknown>>;
  });
}

const ENQUEUE_FN = "wikidataPool:enqueueEntityReviewLookups";

async function scheduledEnqueueArgs(
  t: ReturnType<typeof convexTest>,
): Promise<Array<{ rowIds: Array<Id<"entityReviewQueue">> }>> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<
                Array<{
                  name: string;
                  args: Array<{ rowIds: Array<Id<"entityReviewQueue">> }>;
                }>
              >;
            };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.filter((r) => r.name === ENQUEUE_FN).map((r) => r.args[0]);
  });
}

/** The lookup landing on a player row — the ordinary staging trigger. */
async function landLookup(
  t: ReturnType<typeof convexTest>,
  id: Id<"entityReviewQueue">,
  careerTeams: Array<{
    name: string;
    fromYear: number;
    toYear?: number;
    wikidataId?: string;
  }>,
) {
  await t.mutation(internal.entityReviewQueue.applyLookupResult, {
    id,
    status: "ready",
    enrichment: { careerTeams },
  });
}

// ===========================================================================
// Staging
// ===========================================================================

describe("stageCareerTeamRows: a career team we do not hold becomes its own step", () => {
  test("stages one pending team row per accepted career team, pointing back at the player", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [
      { name: "Sydney Blue Sox", fromYear: 2019, wikidataId: "Q111" },
      { name: "Oregon State Beavers", fromYear: 2022, wikidataId: "Q222" },
    ]);

    const staged = await stagedRows(t);
    expect(staged.map((r) => r.name)).toEqual([
      "Sydney Blue Sox",
      "Oregon State Beavers",
    ]);
    for (const row of staged) {
      // Same batch, same sport, same owner — a row stamped with anyone else
      // would be unanswerable by the very operator it was staged for.
      expect(row.batchId).toBe(BATCH);
      expect(row.selectorOptionId).toBe(sportId);
      expect(row.createdByUserId).toBe(ADMIN_IDENTITY.subject);
      expect(row.kind).toBe("team");
      // Pending, not ready: its own Wikidata lookup has not run yet, and that
      // lookup is what supplies the League suggestion its New Team step
      // pre-fills from.
      expect(row.status).toBe("pending");
      expect(row.decision).toBeUndefined();
      expect((row.source as { playerRowId: string }).playerRowId).toBe(playerRowId);
    }
  });

  test("carries the P54 team QID onto source.wikidataId, and omits the key when Wikidata gave none", async () => {
    // Linkage, not truth: the QID selects WHICH upstream record the staged
    // row's own lookup reads (`lookupTeamEnrichment(name, sport, knownQid)`),
    // instead of guessing from an English label that EntitySearch routinely
    // misses for club and college sides.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [
      { name: "Sydney Blue Sox", fromYear: 2019, wikidataId: "Q7660066" },
      { name: "Oregon State Beavers", fromYear: 2022 },
    ]);

    const staged = await stagedRows(t);
    const byName = new Map(staged.map((r) => [r.name as string, r]));
    expect(
      (byName.get("Sydney Blue Sox")!.source as { wikidataId?: string }).wikidataId,
    ).toBe("Q7660066");
    // Absent rather than undefined-valued — nothing downstream should have to
    // tell "no QID" from "a QID that is undefined".
    expect(
      Object.prototype.hasOwnProperty.call(
        byName.get("Oregon State Beavers")!.source as object,
        "wikidataId",
      ),
    ).toBe(false);
  });

  test("two players proposing the same club stage exactly ONE row", async () => {
    // The dedup that keeps the walker from asking the same New Team question
    // twice. Read through `by_batch_and_kind_and_name`, so it works across
    // players without either lookup having to see the other's rows.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const first = await insertRow(t, { sportId, kind: "player", name: "Player One" });
    const second = await insertRow(t, { sportId, kind: "player", name: "Player Two" });

    await landLookup(t, first, [{ name: "Sydney Blue Sox", fromYear: 2019 }]);
    await landLookup(t, second, [{ name: "Sydney Blue Sox", fromYear: 2021 }]);

    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    // The FIRST player to propose it owns the step — whoever asked first is
    // who the step says it is needed by.
    expect((staged[0].source as { playerRowId: string }).playerRowId).toBe(first);
  });

  test("a checklist team row already in the batch is not staged a second time", async () => {
    // The other direction of the same dedup: the club is on a card too, so it
    // already has a step of its own with no `source`.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const checklistRowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
    });
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2019 }]);

    expect(await stagedRows(t)).toHaveLength(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("entityReviewQueue").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r._id)).toContain(checklistRowId);
  });

  test("a career team we already hold is a link, not a question — including a SPLIT row", async () => {
    // "San Diego Padres" is the Wikidata label; the row we hold is
    // ("San Diego", "Padres"). `findTeamByFullName` keys on the COMPOSED name
    // and `normalizeTeamName` token-sorts, so the two are the same key and
    // nothing is staged. Asking the operator to re-create a team they already
    // have is how the duplicate franchise gets made.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertTeam(t, sportId, { location: "San Diego", name: "Padres" });
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Tony Gwynn",
    });

    await landLookup(t, playerRowId, [
      { name: "San Diego Padres", fromYear: 1982 },
      { name: "San Diego State Aztecs", fromYear: 1979 },
    ]);

    const staged = await stagedRows(t);
    // Only the side we do NOT hold.
    expect(staged.map((r) => r.name)).toEqual(["San Diego State Aztecs"]);
  });

  test("a career team the operator UNCHECKED is not staged", async () => {
    // An exclusion is the operator saying "he never played there". Staging a
    // step for it would ask them again in a form they cannot decline.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Tony Gwynn",
      status: "ready",
      enrichment: {
        careerTeams: [
          { name: "San Diego Padres", fromYear: 1982 },
          { name: "Some Wrong Team", fromYear: 1990 },
        ],
      },
      decision: {
        action: "create",
        excludedCareerTeamNames: ["Some Wrong Team"],
      },
    });

    // The row is already decided, so the lookup path is closed to it — the
    // wizard's own belt-and-braces call is what reaches staging here.
    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
      });

    const staged = await stagedRows(t);
    expect(staged.map((r) => r.name)).toEqual(["San Diego Padres"]);
  });

  test("is idempotent — a second call adds nothing and schedules nothing", async () => {
    // Three callers reach staging and every one of them can fire more than
    // once per player, so "already staged" is the ONLY thing keeping the batch
    // from growing a duplicate step per re-entry.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [
      { name: "Sydney Blue Sox", fromYear: 2019 },
      { name: "Oregon State Beavers", fromYear: 2022 },
    ]);
    const afterFirst = await stagedRows(t);
    expect(afterFirst).toHaveLength(2);
    const enqueuesAfterFirst = (await scheduledEnqueueArgs(t)).length;

    const addedSecond = await asAdmin.mutation(
      api.entityReviewQueue.stageCareerTeamRows,
      { reviewRowId: playerRowId },
    );

    // "Nothing to do" is distinguishable from "did nothing" — the mutation
    // returns how many rows THIS call added.
    expect(addedSecond).toBe(0);
    const afterSecond = await stagedRows(t);
    expect(afterSecond.map((r) => r._id)).toEqual(afterFirst.map((r) => r._id));
    // No rows added means no lookup enqueued: a re-entry must never re-run a
    // lookup that already ran.
    expect(await scheduledEnqueueArgs(t)).toHaveLength(enqueuesAfterFirst);
  });

  test("schedules a pool lookup for ONLY the rows this call inserted", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2019 }]);
    const firstStaged = await stagedRows(t);

    // A hand-typed career team the enrichment knows nothing about, added later
    // — the wizard's second staging moment.
    const added = await asAdmin.mutation(
      api.entityReviewQueue.stageCareerTeamRows,
      { reviewRowId: playerRowId, careerTeamNames: ["Oregon State Beavers"] },
    );
    expect(added).toBe(1);

    const allStaged = await stagedRows(t);
    const beavers = allStaged.find((r) => r.name === "Oregon State Beavers")!;

    const enqueues = await scheduledEnqueueArgs(t);
    expect(enqueues).toHaveLength(2);
    expect(enqueues[0].rowIds).toEqual([firstStaged[0]._id]);
    // The second enqueue carries the NEW row alone — not the one whose lookup
    // is already in flight.
    expect(enqueues[1].rowIds).toEqual([beavers._id]);
  });

  test("merges hand-typed career teams with the enrichment's rather than replacing them", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeamNames: ["Oregon State Beavers"],
      });

    expect((await stagedRows(t)).map((r) => r.name)).toEqual([
      "Sydney Blue Sox",
      "Oregon State Beavers",
    ]);
  });

  test("a TEAM row stages nothing, so a staged row can never stage further rows", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });
    const teamRowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
      source: { kind: "careerTeamOf", playerRowId },
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: teamRowId,
        careerTeamNames: ["Oregon State Beavers"],
      });

    expect(added).toBe(0);
    expect(await stagedRows(t)).toHaveLength(1);
  });

  test("caps the rows one player can stage at MAX_CAREER_TEAM_CREATES (64)", async () => {
    // A guard rail on an unbounded write, not a security boundary — the same
    // bound the per-decision create list carries.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Journeyman",
    });

    await landLookup(
      t,
      playerRowId,
      Array.from({ length: 70 }, (_, i) => ({
        name: `Club Number ${i}`,
        fromYear: 1990 + i,
      })),
    );

    const staged = await stagedRows(t);
    expect(staged).toHaveLength(64);
    // The first 64 proposals, in order — the cap truncates, it does not sample.
    expect(staged[0].name).toBe("Club Number 0");
    expect(staged[63].name).toBe("Club Number 63");
  });

  test("refuses a row belonging to another operator's review session, staging nothing", async () => {
    // Same gate as `recordDecision`: staging into someone else's session would
    // put steps in front of them that they never asked for.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });

    await expect(
      t
        .withIdentity(OTHER_ADMIN)
        .mutation(api.entityReviewQueue.stageCareerTeamRows, {
          reviewRowId: playerRowId,
        }),
    ).rejects.toThrow(/different review session/);

    expect(await stagedRows(t)).toHaveLength(0);
  });
});

// ===========================================================================
// Walk order (getBatch)
// ===========================================================================

describe("getBatch walk order: a staged career team is walked BEFORE its player", () => {
  test("emits each staged row immediately ahead of the player it belongs to, everything else in insertion order", async () => {
    // Insertion order alone would show Travis Bazzana FIRST — his lookup is
    // what created the two club rows — which is the opposite of what was
    // asked for.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const bazzana = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });
    await insertRow(t, { sportId, kind: "player", name: "Mike Trout" });
    await insertRow(t, { sportId, kind: "team", name: "Cleveland Guardians" });

    await landLookup(t, bazzana, [
      { name: "Sydney Blue Sox", fromYear: 2019 },
      { name: "Oregon State Beavers", fromYear: 2022 },
    ]);

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });

    expect(rows.map((r) => r.name)).toEqual([
      // Jason's sequence, exactly: two New Team steps, then the player who can
      // now use both.
      "Sydney Blue Sox",
      "Oregon State Beavers",
      "Travis Bazzana",
      "Mike Trout",
      "Cleveland Guardians",
    ]);
    // `source` is projected onto the public row, not stripped — the step needs
    // `playerRowId` to say who the team is needed by.
    expect(rows[0].source).toMatchObject({
      kind: "careerTeamOf",
      playerRowId: bazzana,
    });
    expect(rows[2].source).toBeUndefined();
  });

  test("a staged row whose player is gone keeps its own insertion position", async () => {
    // A resume can reconcile the player's name away. The staged row is still a
    // real question about a real team and the prelude will still consume its
    // answer, so it must not vanish from the walk.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const bazzana = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });
    await insertRow(t, { sportId, kind: "player", name: "Mike Trout" });

    await landLookup(t, bazzana, [{ name: "Sydney Blue Sox", fromYear: 2019 }]);
    await t.run(async (ctx) => ctx.db.delete(bazzana));

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });
    expect(rows.map((r) => r.name)).toEqual([
      "Mike Trout",
      // Inserted last, so last — no player to be hoisted ahead of.
      "Sydney Blue Sox",
    ]);
  });

  test("a batch with no staged rows is returned in plain insertion order", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    for (const name of ["Aaron Judge", "Mike Trout"])
      await insertRow(t, { sportId, kind: "player", name, status: "ready" });
    await insertRow(t, {
      sportId,
      kind: "team",
      name: "New York Yankees",
      status: "ready",
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });
    expect(rows.map((r) => r.name)).toEqual([
      "Aaron Judge",
      "Mike Trout",
      "New York Yankees",
    ]);
  });
});

// ===========================================================================
// recordAllRemainingAsCreate — the League half of the pre-fill (NEO-236)
// ===========================================================================

describe("recordAllRemainingAsCreate: the bulk pre-fill resolves the League without writing one", () => {
  test("records the ID of a league we already hold", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Australian Baseball League",
        nameNormalized: "australian baseball league",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
      enrichment: { location: "Sydney", league: "Australian Baseball League" },
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // Exactly what the operator picking that league off the New Team step's
    // list would have recorded.
    expect(row!.decision).toEqual({
      action: "create",
      create: { location: "Sydney", name: "Blue Sox", leagueId },
    });
  });

  test("records a NAME for a league we do not hold, and creates no league row", async () => {
    // `findLeagueByName`, not `findOrCreateLeague`: reading must not write. A
    // batch the operator cancels would otherwise leave a league row behind for
    // a team that was never created.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
      enrichment: { location: "Sydney", league: "Australian Baseball League" },
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.decision).toEqual({
      action: "create",
      create: {
        location: "Sydney",
        name: "Blue Sox",
        leagueName: "Australian Baseball League",
      },
    });
    expect(await t.run(async (ctx) => ctx.db.query("leagues").collect())).toEqual([]);
  });

  test("a lookup that found no league leaves the create payload with neither half", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Orix Buffaloes",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
      selectorOptionId: sportId,
      batchId: BATCH,
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    // No `leagueId` key at all — absent means "not answered", which is the one
    // state that still lets the prelude's own fallbacks apply.
    expect(row!.decision).toEqual({
      action: "create",
      create: { name: "Orix Buffaloes" },
    });
  });

  test("stages a confirmed player's career teams, so a bulk create still produces their New Team steps", async () => {
    // Belt-and-braces for the cases NEO-221's "don't decide a pending row"
    // rule does not cover — a batch whose lookups landed before this shipped,
    // and a row that errored and was given career teams by hand. The player is
    // decided EITHER WAY: its stints resolve by NAME in the prelude, against
    // teams the staged rows create first.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: {
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2019 },
          { name: "Oregon State Beavers", fromYear: 2022 },
        ],
      },
    });

    const decided = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId: sportId, batchId: BATCH },
    );
    expect(decided).toBe(1);

    const staged = await stagedRows(t);
    expect(staged.map((r) => r.name)).toEqual([
      "Sydney Blue Sox",
      "Oregon State Beavers",
    ]);
    // Staged rows are pending and undecided — the bulk create ruled on the
    // rows that were open when it ran, not on the ones it created.
    expect(staged.every((r) => r.decision === undefined)).toBe(true);
    const player = await t.run(async (ctx) => ctx.db.get(playerRowId));
    expect(player!.decision).toEqual({ action: "create" });
  });
});
