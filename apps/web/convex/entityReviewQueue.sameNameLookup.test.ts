/**
 * NEO-332 — a same-name player row is not looked up until the operator presses
 * Create new.
 *
 * Jason, 2026-10-10: "we shouldn't even be querying wikidata at all in this
 * scenerio because there is no new player to query the data for." A review
 * row that two or more players on file answer to (the row carries
 * `enrichment.existingCandidates`) opens the wizard's pick step. Its usual
 * answer is one of the people we already hold, so:
 *
 *   1. it is inserted settled (`ready`, candidates only) and is NOT enqueued
 *      for a Wikidata lookup — by `startBatch` (fresh and resume) and by
 *      `switchRowSport` — and nothing stages career-team steps for it;
 *   2. `requestPlayerLookup` (the Create new button) starts that lookup,
 *      once, after which the row behaves like any unknown name;
 *   3. linking or skipping it lets go of the undecided New Team steps its
 *      lookup staged, so they are not walked as orphans.
 *
 * Fixture conventions follow entityReviewQueue.careerTeamStaging.test.ts: raw
 * `ctx.db.insert` rows, `ADMIN_IDENTITY` for the public surface, bare
 * `t.mutation` for the internal one. The scheduled pool enqueue is ASSERTED
 * off `_scheduled_functions` and never drained — `wikidataPool.enqueueAction`
 * reaches the workpool component, which convex-test does not mount.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "user_samename_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_samename_001",
  role: "admin",
};

const OTHER_ADMIN = {
  subject: "user_samename_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_samename_002",
  role: "admin",
};

const BATCH = "batch-samename";
const ENQUEUE_FN = "wikidataPool:enqueueEntityReviewLookups";

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  birthYear: number,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      birthYear,
      lastUpdated: Date.now(),
    }),
  );
}

/** Two "Bob Allen"s on file — the ambiguity this ticket is about. */
async function seedTwoBobAllens(t: T, sportId: Id<"selectorOptions">) {
  const elder = await insertPlayer(t, sportId, "Bob Allen", 1867);
  const younger = await insertPlayer(t, sportId, "Bob Allen", 1937);
  return { elder, younger };
}

/** The stored marker, shaped as `buildExistingPlayerCandidates` writes it. */
function candidatesFor(ids: Array<Id<"players">>) {
  return ids.map((playerId, i) => ({
    playerId,
    name: "Bob Allen",
    birthYear: 1867 + i * 70,
    careerSummary: "",
  }));
}

async function insertRow(
  t: T,
  opts: {
    sportId: Id<"selectorOptions">;
    kind: "player" | "team" | "league";
    name: string;
    createdByUserId?: string;
    status?: "pending" | "ready" | "error";
    enrichment?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    source?:
      | { kind: "careerTeamOf"; playerRowId: Id<"entityReviewQueue"> }
      | { kind: "leagueOf"; teamRowId: Id<"entityReviewQueue"> };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: BATCH,
      createdByUserId: opts.createdByUserId ?? ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized:
        opts.kind === "player" ? normalizePlayerName(opts.name) : normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: opts.status ?? "ready",
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.decision ? { decision: opts.decision as never } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    }),
  );
}

/** A same-name row exactly as `startBatch` now writes one. */
async function insertDeferredBobAllen(
  t: T,
  sportId: Id<"selectorOptions">,
  candidates: Array<Id<"players">>,
): Promise<Id<"entityReviewQueue">> {
  return insertRow(t, {
    sportId,
    kind: "player",
    name: "Bob Allen",
    status: "ready",
    enrichment: { existingCandidates: candidatesFor(candidates) },
  });
}

/** The ARGUMENTS of every scheduled pool enqueue, in schedule order. */
async function scheduledEnqueueArgs(
  t: T,
): Promise<Array<{ rowIds: Array<Id<"entityReviewQueue">> }>> {
  return t.run(async (ctx) => {
    const rows = await (
      ctx as unknown as {
        db: {
          system: {
            query: (n: string) => {
              collect: () => Promise<
                Array<{ name: string; args: Array<{ rowIds: Array<Id<"entityReviewQueue">> }> }>
              >;
            };
          };
        };
      }
    ).db.system.query("_scheduled_functions").collect();
    return rows.filter((r) => r.name === ENQUEUE_FN).map((r) => r.args[0]);
  });
}

/** Every row id the pool has been asked to look up, across every enqueue. */
async function enqueuedIds(t: T): Promise<string[]> {
  return (await scheduledEnqueueArgs(t)).flatMap((a) => a.rowIds as string[]);
}

const getRow = (t: T, id: Id<"entityReviewQueue">) => t.run((ctx) => ctx.db.get(id));

async function rowsStagedFor(t: T, playerRowId: Id<"entityReviewQueue">) {
  return t.run((ctx) =>
    ctx.db
      .query("entityReviewQueue")
      .withIndex("by_source_player", (q) => q.eq("source.playerRowId", playerRowId))
      .collect(),
  );
}

/** What the pool's work item lands for a player Wikidata knows. */
const LOOKUP_WITH_CAREER = {
  wikidataId: "Q4930001",
  careerTeams: [
    { name: "Sydney Blue Sox", fromYear: 2019, wikidataId: "Q7659522" },
    { name: "Oregon State Beavers", fromYear: 2021 },
  ],
};

// ===========================================================================
// 1. Enqueue: a same-name row is born settled and is not looked up
// ===========================================================================

describe("NEO-332: startBatch holds a same-name row's lookup back", () => {
  test("fresh batch: the same-name row is ready with its candidates, and only the other rows are enqueued", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTwoBobAllens(t, sportId);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Bob Allen", "Travis Bazzana"],
      teamNames: ["Padres"],
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", sportId).eq("batchId", batchId),
        )
        .collect(),
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    const bob = byName.get("Bob Allen")!;
    expect(bob.status).toBe("ready");
    expect(bob.enrichment?.existingCandidates).toHaveLength(2);
    expect(bob.enrichment?.wikidataId).toBeUndefined();
    expect(byName.get("Travis Bazzana")!.status).toBe("pending");
    expect(byName.get("Padres")!.status).toBe("pending");

    const enqueued = await enqueuedIds(t);
    expect(enqueued).not.toContain(bob._id);
    expect(enqueued.sort()).toEqual(
      [byName.get("Travis Bazzana")!._id, byName.get("Padres")!._id].sort(),
    );
  });

  test("fresh batch of ONLY same-name rows schedules no pool enqueue at all", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTwoBobAllens(t, sportId);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Bob Allen"],
      teamNames: [],
    });

    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("resume: a same-name name ADDED by a re-Confirm is ready and left out of the enqueue", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTwoBobAllens(t, sportId);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Travis Bazzana"],
      teamNames: [],
    });
    const before = (await scheduledEnqueueArgs(t)).length;

    const resumed = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Travis Bazzana", "Bob Allen", "Jackson Holliday"],
      teamNames: [],
    });
    expect(resumed).toBe(batchId);

    const rows = await t.run((ctx) => ctx.db.query("entityReviewQueue").collect());
    const bob = rows.find((r) => r.name === "Bob Allen")!;
    const holliday = rows.find((r) => r.name === "Jackson Holliday")!;
    expect(bob.status).toBe("ready");
    expect(bob.enrichment?.existingCandidates).toHaveLength(2);

    const enqueues = await scheduledEnqueueArgs(t);
    expect(enqueues).toHaveLength(before + 1);
    expect(enqueues[enqueues.length - 1].rowIds).toEqual([holliday._id]);
  });

  test("a name the caller proved matches nothing is still enqueued as before (NEO-296 path)", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: sportId,
      createdByUserId: ADMIN_IDENTITY.subject,
      sportId,
      playerNames: ["Travis Bazzana"],
      teamNames: [],
      playersWithNoExistingMatch: ["Travis Bazzana"],
    });

    const row = await t.run((ctx) => ctx.db.query("entityReviewQueue").first());
    expect(row!.status).toBe("pending");
    expect(await enqueuedIds(t)).toEqual([row!._id]);
  });
});

describe("NEO-332: switchRowSport into a sport where the name is a same-name choice", () => {
  test("the row settles with the new sport's candidates and no lookup is enqueued", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    await seedTwoBobAllens(t, football);
    const rowId = await insertRow(t, {
      sportId: baseball,
      kind: "player",
      name: "Bob Allen",
      status: "error",
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId,
      sportId: football,
    });

    const row = await getRow(t, rowId);
    expect(row!.sportId).toBe(football);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.existingCandidates).toHaveLength(2);
    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("and switching to a sport where it is NOT a choice still enqueues the lookup", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const [a, b] = [
      await insertPlayer(t, baseball, "Bob Allen", 1867),
      await insertPlayer(t, baseball, "Bob Allen", 1937),
    ];
    const rowId = await insertDeferredBobAllen(t, baseball, [a, b]);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId,
      sportId: football,
    });

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("pending");
    expect(row!.enrichment).toBeUndefined();
    expect(await enqueuedIds(t)).toEqual([rowId]);
  });
});

describe("NEO-332: nothing stages career teams for a row still waiting on its pick", () => {
  test("the belt-and-braces stageCareerTeamRows call stages nothing and returns 0", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    // A hostile shape: candidates AND career teams on a row with no
    // `wikidataId`. No lookup writes this, but the guard must not depend on
    // `careerTeams` being absent.
    const rowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      enrichment: {
        existingCandidates: candidatesFor([elder, younger]),
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }],
      },
    });

    const added = await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.stageCareerTeamRows, { reviewRowId: rowId });

    expect(added).toBe(0);
    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);
    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("hand-typed career teams on a row still waiting are refused, not silently dropped", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.stageCareerTeamRows, {
        reviewRowId: rowId,
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }],
      }),
    ).rejects.toThrow(/Create new/);
    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);
  });

  test("once Create new has been pressed, hand-typed career teams stage as usual", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    const added = await asAdmin.mutation(api.entityReviewQueue.stageCareerTeamRows, {
      reviewRowId: rowId,
      careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2019 }],
    });

    expect(added).toBe(1);
    const staged = await rowsStagedFor(t, rowId);
    expect(staged.map((r) => r.name)).toEqual(["Sydney Blue Sox"]);
  });
});

// ===========================================================================
// 2. requestPlayerLookup — Create new
// ===========================================================================

describe("NEO-332: requestPlayerLookup", () => {
  test("starts the held-back lookup: pending, one enqueue of exactly this row, proof of life stamped", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("pending");
    expect(row!.lastTouchedAt).toBeTypeOf("number");
    // The candidates stay: the lookup refreshes them when it lands.
    expect(row!.enrichment?.existingCandidates).toHaveLength(2);
    expect(await scheduledEnqueueArgs(t)).toEqual([{ rowIds: [rowId] }]);
  });

  test("is idempotent: a second press while the lookup is in flight enqueues nothing more", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    expect(await scheduledEnqueueArgs(t)).toHaveLength(1);
    expect((await getRow(t, rowId))!.status).toBe("pending");
  });

  test("then behaves like any unknown name: the lookup lands, the row settles, its career teams are staged", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: LOOKUP_WITH_CAREER,
      sportId,
    });

    const row = await getRow(t, rowId);
    expect(row!.status).toBe("ready");
    expect(row!.enrichment?.wikidataId).toBe("Q4930001");
    // Refreshed live by the lookup, as for every player row.
    expect(row!.enrichment?.existingCandidates).toHaveLength(2);
    const staged = await rowsStagedFor(t, rowId);
    expect(staged.map((r) => r.name).sort()).toEqual(
      ["Oregon State Beavers", "Sydney Blue Sox"].sort(),
    );
  });

  test("after the lookup has run, a press does not ask the pool again", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const answered = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      enrichment: { wikidataId: "Q4930001", existingCandidates: candidatesFor([elder, younger]) },
    });
    const noMatch = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "error",
      enrichment: { existingCandidates: candidatesFor([elder, younger]) },
    });

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: answered });
    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: noMatch });

    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
    expect((await getRow(t, answered))!.status).toBe("ready");
    expect((await getRow(t, noMatch))!.status).toBe("error");
  });

  test("a row with NO stored marker (the wizard's live fallback) has had its lookup and is never re-asked", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await seedTwoBobAllens(t, sportId);
    const rowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      enrichment: { wikidataId: "Q4930001" },
    });

    await t
      .withIdentity(ADMIN_IDENTITY)
      .mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
    expect((await getRow(t, rowId))!.status).toBe("ready");
  });

  test("refuses a decided row, a team row, and another operator's row — and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { elder, younger } = await seedTwoBobAllens(t, sportId);
    const decided = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      enrichment: { existingCandidates: candidatesFor([elder, younger]) },
      decision: { action: "link", linkedPlayerId: elder },
    });
    const team = await insertRow(t, { sportId, kind: "team", name: "Padres" });
    const theirs = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Bob Allen",
      status: "ready",
      createdByUserId: OTHER_ADMIN.subject,
      enrichment: { existingCandidates: candidatesFor([elder, younger]) },
    });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await expect(
      asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: decided }),
    ).rejects.toThrow(/decision/);
    await expect(
      asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: team }),
    ).rejects.toThrow(/player/);
    await expect(
      asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: theirs }),
    ).rejects.toThrow(/different review session/);

    expect((await getRow(t, decided))!.status).toBe("ready");
    expect((await getRow(t, theirs))!.status).toBe("ready");
    expect(await scheduledEnqueueArgs(t)).toHaveLength(0);
  });

  test("refuses a row that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const rowId = await insertRow(t, { sportId, kind: "player", name: "Bob Allen" });
    await t.run((ctx) => ctx.db.delete(rowId));

    await expect(
      t
        .withIdentity(ADMIN_IDENTITY)
        .mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId }),
    ).rejects.toThrow(/not found/);
  });
});

// ===========================================================================
// 3. Link or skip after Create new: the staged steps go
// ===========================================================================

/**
 * Create new → the lookup lands and stages the two career teams → the operator
 * goes "Back to the list". Returns the player row and its staged steps.
 */
async function createNewThenBack(t: T) {
  const sportId = await seedSport(t);
  const { elder, younger } = await seedTwoBobAllens(t, sportId);
  const rowId = await insertDeferredBobAllen(t, sportId, [elder, younger]);
  await t
    .withIdentity(ADMIN_IDENTITY)
    .mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });
  await t.mutation(internal.entityReviewQueue.applyLookupResult, {
    id: rowId,
    status: "ready",
    enrichment: LOOKUP_WITH_CAREER,
    sportId,
  });
  const staged = await rowsStagedFor(t, rowId);
  expect(staged).toHaveLength(2);
  const blueSox = staged.find((r) => r.name === "Sydney Blue Sox")!;
  const beavers = staged.find((r) => r.name === "Oregon State Beavers")!;
  return { sportId, elder, younger, rowId, blueSox, beavers };
}

describe("NEO-332: linking or skipping a same-name row releases the steps staged for it", () => {
  test("a link deletes its undecided career-team steps and the league steps under them", async () => {
    const t = convexTest(schema, modules);
    const { sportId, elder, rowId, blueSox } = await createNewThenBack(t);
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "Australian Baseball League",
      source: { kind: "leagueOf", teamRowId: blueSox._id },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: elder,
    });

    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);
    expect(await getRow(t, league)).toBeNull();
    expect((await getRow(t, rowId))!.decision).toEqual({
      action: "link",
      linkedPlayerId: elder,
    });
  });

  test("a skip does the same", async () => {
    const t = convexTest(schema, modules);
    const { rowId } = await createNewThenBack(t);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "skip",
    });

    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);
  });

  test("a step the operator already ANSWERED is kept, with its league", async () => {
    const t = convexTest(schema, modules);
    const { sportId, elder, rowId, blueSox, beavers } = await createNewThenBack(t);
    await t.run((ctx) =>
      ctx.db.patch(blueSox._id, {
        decision: { action: "create", create: { location: "Sydney", name: "Blue Sox" } },
      }),
    );
    const league = await insertRow(t, {
      sportId,
      kind: "league",
      name: "Australian Baseball League",
      source: { kind: "leagueOf", teamRowId: blueSox._id },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: elder,
    });

    const left = await rowsStagedFor(t, rowId);
    expect(left.map((r) => r._id)).toEqual([blueSox._id]);
    expect(await getRow(t, beavers._id)).toBeNull();
    expect(await getRow(t, league)).not.toBeNull();
  });

  test("a step another player in the batch still needs is handed to that player, not deleted", async () => {
    const t = convexTest(schema, modules);
    const { sportId, elder, rowId, blueSox, beavers } = await createNewThenBack(t);
    const teammate = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: {
        wikidataId: "Q1",
        careerTeams: [{ name: "Sydney Blue Sox", fromYear: 2020 }],
      },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: elder,
    });

    const handed = await getRow(t, blueSox._id);
    expect(handed!.source).toMatchObject({ kind: "careerTeamOf", playerRowId: teammate });
    expect(await getRow(t, beavers._id)).toBeNull();
  });

  test("Change decision → Create new again re-stages the steps the link released, without a second lookup", async () => {
    const t = convexTest(schema, modules);
    const { elder, rowId } = await createNewThenBack(t);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: elder,
    });
    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);
    await asAdmin.mutation(api.entityReviewQueue.clearDecision, { reviewRowId: rowId });
    // Back on the pick step: nothing was re-staged by the un-decide.
    expect(await rowsStagedFor(t, rowId)).toHaveLength(0);

    await asAdmin.mutation(api.entityReviewQueue.requestPlayerLookup, { reviewRowId: rowId });

    const staged = await rowsStagedFor(t, rowId);
    expect(staged.map((r) => r.name).sort()).toEqual(
      ["Oregon State Beavers", "Sydney Blue Sox"].sort(),
    );
    // The player row was enqueued exactly once — the first Create new.
    expect((await enqueuedIds(t)).filter((id) => id === rowId)).toHaveLength(1);
    expect((await getRow(t, rowId))!.status).toBe("ready");
  });

  test("an ordinary (not same-name) player's link leaves its staged steps alone — scope pin", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const existing = await insertPlayer(t, sportId, "Travis Bazzana", 2002);
    const rowId = await insertRow(t, {
      sportId,
      kind: "player",
      name: "Travis Bazzana",
      status: "ready",
      enrichment: LOOKUP_WITH_CAREER,
    });
    const step = await insertRow(t, {
      sportId,
      kind: "team",
      name: "Sydney Blue Sox",
      status: "ready",
      source: { kind: "careerTeamOf", playerRowId: rowId },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: existing,
    });

    expect(await getRow(t, step)).not.toBeNull();
  });
});
