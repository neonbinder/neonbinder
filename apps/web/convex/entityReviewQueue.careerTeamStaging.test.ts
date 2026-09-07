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
      // NEO-248 — the years the operator typed beside the name.
      manualStint?: { fromYear: number; toYear?: number };
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
// NEO-248 — the operator's YEARS travel with the step their name staged
// ===========================================================================

/**
 * The NEO-236 regression this covers.
 *
 * A hand-typed career team is two facts at once: a team the batch may have to
 * create, and a stint with years on it. NEO-236 gave the team half a New Team
 * step of its own — and staging that step is what MOVES the wizard's walk off
 * the player row (`waitingOnStagedTeams`). The years lived only in the wizard's
 * per-row React state, which the presented-row effect wiped on the way. So the
 * ordinary path through the feature — type a name, 2001, 2005, press Add — lost
 * the years before the operator had finished the sentence, and nothing anywhere
 * held them.
 *
 * `source.manualStint` is where they live now: on the step the name staged,
 * written only for a HAND-TYPED entry. A Wikidata proposal deliberately writes
 * none — its years are already on the player row's `enrichment.careerTeams`,
 * and that asymmetry is exactly what lets the wizard rebuild the manual chips
 * and only those.
 */
describe("stageCareerTeamRows: a hand-typed stint's years survive the New Team step", () => {
  test("writes the typed years onto the staged step as source.manualStint", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2001, toYear: 2005 },
        ],
      });
    expect(added).toBe(1);

    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("Sydney Blue Sox");
    expect((staged[0].source as { playerRowId: string }).playerRowId).toBe(
      playerRowId,
    );
    // THE POINT: the years the operator typed are on the row, so the chip can
    // be rebuilt as "Sydney Blue Sox (2001–2005)" after its own step is
    // answered and the walk comes back.
    expect(
      (staged[0].source as { manualStint?: unknown }).manualStint,
    ).toEqual({ fromYear: 2001, toYear: 2005 });
  });

  test("an open-ended stint stores fromYear alone, with no toYear key", async () => {
    // "–present" is the absence of a toYear, not a sentinel. Nothing
    // downstream should have to tell "still there" from "a toYear that is
    // undefined".
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2023 }],
      });

    const stint = (
      (await stagedRows(t))[0].source as {
        manualStint: Record<string, unknown>;
      }
    ).manualStint;
    expect(stint).toEqual({ fromYear: 2023 });
    expect(Object.prototype.hasOwnProperty.call(stint, "toYear")).toBe(false);
  });

  test("a Wikidata proposal stages a step with NO manualStint on it", async () => {
    // The discriminator the wizard's rehydration reads. A P54 label's years are
    // already on the player row, and a second copy here is a second thing to
    // disagree — the chip for it is rendered from `enrichment.careerTeams`.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });

    await landLookup(t, playerRowId, [
      { name: "Sydney Blue Sox", fromYear: 2019, toYear: 2021 },
    ]);

    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(
        staged[0].source as object,
        "manualStint",
      ),
    ).toBe(false);
  });

  test("the name-only call site still stages, and still stores no stint", async () => {
    // `Decide team` on a Wikidata chip stages a NAME and nothing else. That
    // caller is unchanged, and this is the assertion that keeps it that way.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeamNames: ["Sydney Blue Sox"],
      });

    expect(added).toBe(1);
    const staged = await stagedRows(t);
    expect(
      Object.prototype.hasOwnProperty.call(
        staged[0].source as object,
        "manualStint",
      ),
    ).toBe(false);
  });

  test("hand-typing years for a club this player's OWN lookup already staged fills them in, without a second step", async () => {
    // Wikidata knew the club but not the dates (the NEO-235 undated case), so
    // the step exists before the operator types. Staging dedupes by name and
    // would otherwise drop the years on the floor — there would be no row to
    // put them on and the chip could not be rebuilt.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
    });
    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2019 }]);

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2001, toYear: 2005 },
        ],
      });

    // Nothing INSERTED — the step was already there — but the stint landed.
    expect(added).toBe(0);
    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    expect(
      (staged[0].source as { manualStint?: unknown }).manualStint,
    ).toEqual({ fromYear: 2001, toYear: 2005 });
  });

  test("never overwrites a stint already on the step, and never touches another player's", async () => {
    // Two guards in one: the patch is for filling a blank, not for revising an
    // answer, and one player's dates must never be attributed to a step staged
    // for somebody else.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const first = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Player One",
      status: "ready",
    });
    const second = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Player Two",
      status: "ready",
    });

    await asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
      reviewRowId: first,
      careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2001, toYear: 2005 }],
    });
    // The second player shares the club, so the dedup gives them no step of
    // their own — and their dates must not rewrite the first player's.
    await asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
      reviewRowId: second,
      careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2018, toYear: 2020 }],
    });

    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    expect((staged[0].source as { playerRowId: string }).playerRowId).toBe(first);
    expect(
      (staged[0].source as { manualStint?: unknown }).manualStint,
    ).toEqual({ fromYear: 2001, toYear: 2005 });
  });

  test("refuses years that could never reach players.teamYears", async () => {
    // Defense in depth, the same bounds `recordDecision` applies — these years
    // become a `teamYears` entry by way of the chip the wizard rebuilds from
    // them, so they are checked on the way in rather than on the way out.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    await expect(
      asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 1200 }],
      }),
    ).rejects.toThrow(/fromYear/);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeams: [
          { name: "Sydney Blue Sox", fromYear: 2005, toYear: 2001 },
        ],
      }),
    ).rejects.toThrow(/toYear/);

    // A refusal leaves nothing behind — no half-staged step for a stint the
    // batch rejected.
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

describe("recordAllRemainingAsCreate: the bulk never answers the League question", () => {
  /**
   * This block used to pin the bulk path's League PRE-FILL — resolve the
   * enrichment's suggestion to an id when we hold it, carry it as a name when
   * we do not, and write no league row of its own.
   *
   * Jason removed the question rather than the answer: "add all remaining as
   * new should still process teams, it should only apply to players." A league
   * chosen by a suggestion nobody read is the defect this ticket exists to
   * close, and the bulk path was the last place it could still happen. So the
   * contract is now the stronger one — the bulk decides no team row at all, and
   * therefore records no league and creates none.
   */
  test("a team row with a league suggestion is left undecided, and no league row is written", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamRowId = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
      enrichment: { league: "Australian Baseball League" },
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });

    expect(
      await t.run(async (ctx) => (await ctx.db.get(teamRowId))!.decision === undefined),
    ).toBe(true);
    // Reading must not write — and now nothing reads it either.
    expect(await t.run(async (ctx) => ctx.db.query("leagues").collect())).toEqual([]);
  });

  test("an existing league is NOT auto-selected onto a staged career team", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Australian Baseball League",
        nameNormalized: "australian baseball league",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: { careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }] },
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.recordAllRemainingAsCreate, {
        selectorOptionId: sportId,
        batchId: BATCH,
      });

    // The step exists to be answered; the bulk did not answer it.
    const staged = await stagedRows(t);
    expect(staged).toHaveLength(1);
    expect(staged[0].decision).toBeUndefined();
    // The player, on the other hand, IS decided.
    expect(await t.run(async (ctx) => (await ctx.db.get(playerRowId))!.decision)).toEqual({
      action: "create",
    });
  });
});

// ===========================================================================
// NEO-236 security review — the five conditions on a807220
// ===========================================================================

describe("security review 2: an unbounded career-team name never reaches the row or the index", () => {
  /**
   * Both sources are text nobody on our side vetted — a Wikidata P54 label, and
   * the `careerTeamNames` a client hands the public mutation. The over-long one
   * is SKIPPED, not thrown on: one absurd label must not cost the player every
   * other step it was staged alongside.
   */
  const OVER_LONG = "Z".repeat(121);

  test("skips an over-long name from enrichment, and stages the rest of the list", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });

    await landLookup(t, playerRowId, [
      { name: OVER_LONG, fromYear: 2018 },
      { name: "Sydney Blue Sox", fromYear: 2019 },
    ]);

    const staged = await stagedRows(t);
    expect(staged.map((r) => r.name)).toEqual(["Sydney Blue Sox"]);
  });

  test("skips an over-long name handed to the public mutation", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeamNames: [OVER_LONG, "Sydney Blue Sox"],
      });

    expect(added).toBe(1);
    expect((await stagedRows(t)).map((r) => r.name)).toEqual(["Sydney Blue Sox"]);
  });

  test("the boundary itself is allowed — 120 characters composes into a team", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });

    await landLookup(t, playerRowId, [{ name: "Z".repeat(120), fromYear: 2018 }]);

    expect((await stagedRows(t)).length).toBe(1);
  });
});

describe("security review 3: the 64 cap is per PLAYER, not per invocation", () => {
  /**
   * `added.length` alone bounded one call, and three callers can stage for the
   * same player — so N calls could mint 64N steps. The count comes from
   * `by_source_player`, an indexed read rather than a collect of the batch.
   */
  test("a second call cannot push the player past 64 staged steps", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
    });

    const first = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeamNames: Array.from({ length: 64 }, (_, i) => `Club ${i}`),
      });
    expect(first).toBe(64);

    // Entirely NEW names, so nothing is deduped away — only the cap can stop them.
    const second = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: playerRowId,
        careerTeamNames: ["Sydney Blue Sox", "Oregon State Beavers"],
      });

    expect(second).toBe(0);
    expect((await stagedRows(t)).length).toBe(64);
  });

  test("the cap is per player — a second player still gets its own steps", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const a = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana", status: "ready" });
    const b = await insertRow(t, { sportId, kind: "player", name: "Dylan Crews", status: "ready" });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.stageCareerTeamRows, {
      reviewRowId: a,
      careerTeamNames: Array.from({ length: 64 }, (_, i) => `Club ${i}`),
    });
    const forB = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: b,
        careerTeamNames: ["Sydney Blue Sox"],
      });

    expect(forB).toBe(1);
  });
});

describe("security review 4: a staged step whose player was reconciled away is dropped", () => {
  /**
   * The `source` exemption keeps a staged row through reconciliation because
   * its name is never in the incoming list — right while its player is still in
   * the batch, wrong once the player is gone, because the step then blocks
   * "all reviewed" on a team nothing needs.
   */
  test("drops an UNDECIDED staged row when its player leaves the incoming set", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });
    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2018 }]);
    expect((await stagedRows(t)).length).toBe(1);

    // The player is no longer carried by any card, and was never ruled on.
    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: [],
      teamNames: [],
    });

    expect(await stagedRows(t)).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.get(playerRowId))).toBeNull();
  });

  test("KEEPS a staged row whose player is still incoming", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });
    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2018 }]);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Travis Bazzana"],
      teamNames: [],
    });

    expect((await stagedRows(t)).length).toBe(1);
  });

  test("KEEPS a DECIDED staged row even when its player is gone — the operator ruled on it", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });
    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2018 }]);
    const stagedId = (await stagedRows(t))[0]._id as Id<"entityReviewQueue">;
    await t.run(async (ctx) =>
      ctx.db.patch(stagedId, { decision: { action: "create", create: { name: "Blue Sox", location: "Sydney" } } }),
    );

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: [],
      teamNames: [],
    });

    expect((await stagedRows(t)).length).toBe(1);
  });

  test("a DECIDED player keeps its staged step alive too", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerRowId = await insertRow(t, { sportId, kind: "player", name: "Travis Bazzana" });
    await landLookup(t, playerRowId, [{ name: "Sydney Blue Sox", fromYear: 2018 }]);
    await t.run(async (ctx) => ctx.db.patch(playerRowId, { decision: { action: "create" } }));

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: [],
      teamNames: [],
    });

    expect((await stagedRows(t)).length).toBe(1);
  });
});

describe("security review 1: recordDecision refuses a league it cannot stand behind", () => {
  /**
   * `teams.findOrCreate` already refuses a deleted or cross-sport league via
   * `resolveOperatorLeagueId`, so without this the SAME operator answer was
   * accepted on one path and rejected on the other. A throw is right here
   * because the operator is present; the prelude drops instead.
   */
  async function seedOtherSport(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
  }

  test("accepts a league that exists in this sport", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, { sportId, kind: "team", name: "Sydney Blue Sox", status: "ready" });
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Australian Baseball League",
        nameNormalized: "australian baseball league",
        sportId,
        lastUpdated: Date.now(),
      }),
    );

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { location: "Sydney", name: "Blue Sox", leagueId },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect((row!.decision as { create: { leagueId: unknown } }).create.leagueId).toBe(leagueId);
  });

  test("refuses a league that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, { sportId, kind: "team", name: "Sydney Blue Sox", status: "ready" });
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Gone",
        nameNormalized: "gone",
        sportId,
        lastUpdated: Date.now(),
      }),
    );
    await t.run(async (ctx) => ctx.db.delete(leagueId));

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        create: { name: "Blue Sox", leagueId },
      }),
    ).rejects.toThrow(/no longer exists/);

    // The row is left UNDECIDED — the refusal happens before the patch.
    // Asserted as a boolean computed INSIDE `t.run`: a returned `undefined`
    // comes back as `null` through Convex's value encoding, which would make
    // `toBeUndefined()` fail for a reason that has nothing to do with the row.
    expect(
      await t.run(async (ctx) => (await ctx.db.get(rowId))!.decision === undefined),
    ).toBe(true);
  });

  test("refuses a league belonging to another sport", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const otherSportId = await seedOtherSport(t);
    const rowId = await insertRow(t, { sportId, kind: "team", name: "Sydney Blue Sox", status: "ready" });
    const leagueId = await t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "National Football League",
        nameNormalized: "national football league",
        sportId: otherSportId,
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "create",
        create: { name: "Blue Sox", leagueId },
      }),
    ).rejects.toThrow(/National Football League/);
    expect(
      await t.run(async (ctx) => (await ctx.db.get(rowId))!.decision === undefined),
    ).toBe(true);
  });

  test("a deliberate `null` — no league — is still accepted", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, { sportId, kind: "team", name: "Sydney Blue Sox", status: "ready" });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "create",
      create: { name: "Blue Sox", leagueId: null },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect((row!.decision as { create: { leagueId: unknown } }).create.leagueId).toBeNull();
  });
});
