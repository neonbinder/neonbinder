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
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

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
