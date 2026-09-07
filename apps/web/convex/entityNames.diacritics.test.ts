/**
 * NEO-253 — one accented name, one NB row, at every key that decides identity.
 *
 * `lib/entities/normalize-name.test.ts` pins the function. This file pins the
 * places that USE it, because the defect was never in one function: the same
 * regex chain had been transcribed by hand into six modules, and the copies had
 * to agree for a name to survive the round trip from an adapter, through the
 * review wizard, into `players`/`teams` and back out again. Each `describe`
 * below is a separate crossing of that round trip, and each was separately
 * capable of splitting one person into two rows:
 *
 *  - `players.findByNameAndSport` / `teams.findByNameAndSport` — the lookup the
 *    unknown-entity pass makes before it declares a name new.
 *  - `entityReviewQueue.startBatch` — the resume key. A batch keyed one way and
 *    resumed the other re-asks a question the operator already answered.
 *  - `entityReviewSkips` — the durable skip. Keyed one way at write and the
 *    other at read, a skipped name comes back on every re-fetch, forever.
 *
 * Jason, 2026-09-04: "if a card says Jose but the player in the database is
 * José we should just link that player, not consider them new."
 *
 * NO BACKFILL ships with this. Production has no players yet and Jason intends
 * to wipe and reload before it does; dev and preview data is reseeded from the
 * UI on every run. See the module note on `lib/entities/normalize-name.ts`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
// NEO-236's key derivation — the ONE place a team row's identity fields are
// built. Exercised directly so the fold is pinned at the derivation and not
// only at the query that happens to call it today.
import { teamRowFields } from "./lib/teamRow";
import { drainScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

/**
 * NEO-253 (audit) — this file must not reach the network, and must not leave
 * work running past the end of a test.
 *
 * Two of the paths under test schedule Wikidata work on their INSERT branch and
 * only on that branch, which is precisely the branch these tests are about:
 * `players.findOrCreate` schedules `wikidataPool:enqueueEnrichment`, and
 * `entityReviewQueue.startBatch` schedules
 * `wikidataPool:enqueueEntityReviewLookups`. `convex-test` starts scheduled
 * work in the background without waiting for it, so a test that returns
 * immediately leaves it racing the worker's teardown — a failure that reports
 * green locally and fails the JOB in CI, which is the worst shape a failure can
 * have. See `lib/testing/drain-scheduled.ts`.
 *
 * Both are `runAfter(0)`, so `drainScheduled` (not `cancelScheduled`) settles
 * them: actually running the work is always preferable to discarding it, and
 * the delay that forces a cancel elsewhere does not exist here.
 *
 * A THROWING stub rather than a canned 200, for the reason
 * `cardChecklist.bscTeamEnrichment.test.ts` gives: the enrichment path already
 * handles "network unavailable", and inventing a Wikidata response shape is how
 * a stub starts asserting things nobody meant to assert. Nothing in this file
 * is about enrichment — every test here is about a KEY.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    (async (url: string | URL) => {
      throw new Error(
        `NEO-253: this test file must not reach the network: ${String(url)}`,
      );
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = {
  subject: "user_neo253",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_neo253",
  name: "Signed In User",
  role: "admin",
};

async function seedSport(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

describe("players.findByNameAndSport folds accents (NEO-253)", () => {
  test("an ASCII query finds the accented row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "José Ramírez",
        nameNormalized: normalizePlayerName("José Ramírez"),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.players.findByNameAndSport, {
        name: "Jose Ramirez",
        sportId,
      });
    expect(found?.name).toBe("José Ramírez");
  });

  test("an accented query finds the ASCII row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("players", {
        name: "Jose Ramirez",
        nameNormalized: normalizePlayerName("Jose Ramirez"),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.players.findByNameAndSport, {
        name: "José Ramírez",
        sportId,
      });
    expect(found?.name).toBe("Jose Ramirez");
  });

  test("findOrCreate returns the existing row rather than minting a second person", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asUser = t.withIdentity(USER);

    const first = await asUser.mutation(api.players.findOrCreate, {
      name: "José Ramírez",
      sportId,
    });
    const second = await asUser.mutation(api.players.findOrCreate, {
      name: "Jose Ramirez",
      sportId,
    });
    expect(second).toBe(first);

    const rows = await t.run(async (ctx) => ctx.db.query("players").collect());
    expect(rows).toHaveLength(1);
    // The row keeps the spelling it was CREATED with. The fold decides
    // identity; it never rewrites what NB stores and renders.
    expect(rows[0].name).toBe("José Ramírez");

    // `findOrCreate`'s INSERT branch scheduled `wikidataPool:enqueueEnrichment`
    // — settle it here rather than letting it race teardown. See the file note.
    await drainScheduled(t);
  });
});

describe("teams.findByNameAndSport folds accents (NEO-253)", () => {
  test("an ASCII query finds the accented franchise", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Montréal Expos",
        nameNormalized: normalizeTeamName("Montréal Expos"),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.teams.findByNameAndSport, {
        name: "Montreal Expos",
        sportId,
      });
    expect(found?.name).toBe("Montréal Expos");
  });

  test("an accented query finds the ASCII franchise", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        name: "Montreal Expos",
        nameNormalized: normalizeTeamName("Montreal Expos"),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.teams.findByNameAndSport, {
        name: "Montréal Expos",
        sportId,
      });
    expect(found?.name).toBe("Montreal Expos");
  });
});

/**
 * NEO-236 introduced a SECOND shape for the same key: a team row stores `name`
 * ("Expos") and an optional `location` ("Montréal") separately, and
 * `nameNormalized` is derived from the two COMPOSED. The fold has to survive
 * that composition, or the split reintroduces exactly the duplicate this ticket
 * closed — a source spelling "Montreal Expos" would miss the split row and the
 * wizard would offer to create a franchise NB already holds, this time with the
 * accent sitting in a field the old lookup never even read.
 *
 * The equivalence pinned here is two-dimensional and both axes matter:
 *
 *   ("Montréal", "Expos")  ≡  ("Montreal", "Expos")   — the fold
 *   ("Montreal", "Expos")  ≡  (—, "Montreal Expos")   — the split (NEO-236)
 *
 * so all four spellings are one row. The second axis is main's own invariant
 * (`normalizeTeamName` token-sorts, so moving a word between the fields cannot
 * change the key); it is asserted here alongside the fold because it is the
 * composition of the two that a caller actually depends on.
 */
describe("the location-composed team key folds accents (NEO-236 + NEO-253)", () => {
  test("teamRowFields derives one key from all four spellings", () => {
    const keys = [
      teamRowFields({ name: "Expos", location: "Montréal" }),
      teamRowFields({ name: "Expos", location: "Montreal" }),
      teamRowFields({ name: "Montréal Expos" }),
      teamRowFields({ name: "Montreal Expos" }),
    ].map((f) => f.nameNormalized);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(normalizeTeamName("Montreal Expos"));

    // The fold decides identity and never rewrites what NB stores: each row
    // keeps the halves it was given, accents included.
    expect(teamRowFields({ name: "Expos", location: "Montréal" })).toMatchObject(
      { name: "Expos", location: "Montréal" },
    );
  });

  test("an ASCII full name finds the accented SPLIT row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        ...teamRowFields({ name: "Expos", location: "Montréal" }),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.teams.findByNameAndSport, {
        name: "Montreal Expos",
        sportId,
      });
    expect(found?.location).toBe("Montréal");
    expect(found?.name).toBe("Expos");
  });

  test("an accented full name finds the ASCII split row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("teams", {
        ...teamRowFields({ name: "Expos", location: "Montreal" }),
        sportId,
        lastUpdated: Date.now(),
      });
    });

    const found = await t
      .withIdentity(USER)
      .query(api.teams.findByNameAndSport, {
        name: "Montréal Expos",
        sportId,
      });
    expect(found?.location).toBe("Montreal");
  });

  test("findOrCreate on the accented halves returns the row the ASCII full name made", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const asUser = t.withIdentity(USER);

    const first = await asUser.mutation(api.teams.findOrCreate, {
      name: "Montreal Expos",
      sportId,
    });
    const second = await asUser.mutation(api.teams.findOrCreate, {
      name: "Expos",
      location: "Montréal",
      sportId,
    });
    expect(second).toBe(first);

    const rows = await t.run(async (ctx) => ctx.db.query("teams").collect());
    expect(rows).toHaveLength(1);
    // Created from a full name, so that is what it still stores — the second
    // call resolved onto it and did not re-split or re-spell it.
    expect(rows[0].name).toBe("Montreal Expos");
    expect(rows[0].location).toBeUndefined();

    // `findOrCreate`'s INSERT branch schedules enrichment work; settle it here
    // rather than letting it race teardown. See the file note.
    await drainScheduled(t);
  });
});

describe("the review-queue resume key agrees across accents (NEO-253)", () => {
  /**
   * A resume reconciles the batch against the incoming names by
   * `kind` + normalized name. The names come back from a re-fetch or a second
   * pairing session, so their SPELLING can legitimately change between the two
   * Confirms — SportLots supplies accents, BSC does not, and which side won a
   * given merge is not stable. Keyed unfolded, the second Confirm dropped the
   * operator's decision on the ground and inserted a fresh `pending` row
   * alongside it.
   */
  test("resuming with the other spelling keeps the row and its decision", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(USER);
    const selectorOptionId = await seedSport(t);

    const batchId = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: USER.subject,
      sportId: selectorOptionId,
      playerNames: ["José Ramírez"],
      teamNames: ["Montréal Expos"],
    });

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    expect(rows).toHaveLength(2);
    const playerRow = rows.find((r) => r.kind === "player")!;
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: playerRow._id,
      action: "create",
    });

    const resumed = await t.mutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId,
      createdByUserId: USER.subject,
      sportId: selectorOptionId,
      playerNames: ["Jose Ramirez"],
      teamNames: ["Montreal Expos"],
    });
    expect(resumed).toBe(batchId);

    const after = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId,
    });
    // Still two rows, the SAME two rows, and the decision survived.
    expect(after).toHaveLength(2);
    expect(after.map((r) => r._id).sort()).toEqual(
      rows.map((r) => r._id).sort(),
    );
    expect(
      after.find((r) => r.kind === "player")?.decision,
    ).toEqual({ action: "create" });

    // Both `startBatch` calls scheduled
    // `wikidataPool:enqueueEntityReviewLookups`. See the file note.
    await drainScheduled(t);
  });
});

describe("the entityReviewSkips key agrees across accents (NEO-253)", () => {
  /**
   * The skip is written by `commitCardChecklistPrelude` (its own `norm`) and
   * read by `findSkippedEntityNames` (keys built with `normalizePlayerName` /
   * `normalizeTeamName`). Two hand copies, two chances to disagree — and a
   * disagreement here is invisible: the name simply reappears in the wizard on
   * the next fetch of the set, forever, with nothing anywhere saying why.
   */
  test("a skip recorded under one spelling suppresses the other", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);

    await t.run(async (ctx) => {
      await ctx.db.insert("entityReviewSkips", {
        selectorOptionId,
        kind: "player",
        nameNormalized: normalizePlayerName("José Ramírez"),
        name: "José Ramírez",
        skippedAt: Date.now(),
        skippedByUserId: USER.subject,
      });
      await ctx.db.insert("entityReviewSkips", {
        selectorOptionId,
        kind: "team",
        nameNormalized: normalizeTeamName("Montréal Expos"),
        name: "Montréal Expos",
        skippedAt: Date.now(),
        skippedByUserId: USER.subject,
      });
    });

    const skipped = await t.query(
      internal.selectorOptions.findSkippedEntityNames,
      {
        selectorOptionId,
        candidates: [
          { kind: "player", nameNormalized: normalizePlayerName("Jose Ramirez") },
          { kind: "team", nameNormalized: normalizeTeamName("Montreal Expos") },
        ],
      },
    );
    expect(skipped.sort()).toEqual(
      ["player:jose ramirez", "team:expos montreal"].sort(),
    );
  });
});
