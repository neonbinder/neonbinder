/**
 * NEO-254 — `(nameNormalized, sportId)` is a DEDUP key, not a unique one.
 *
 * Every write path in `convex/players.ts` used to read it with `.first()` and
 * treat the answer as *the* player. That was survivable while same-name rows
 * were freakish; the bulk preload (plan decision 3) makes them ordinary — two
 * Bob Allens pitched in the majors, both are real, and both are on file. From
 * then on `.first()` is a coin flip that silently binds one man's cards to
 * another man's row, and the operator's only clue is a career history that
 * grows a team he never played for.
 *
 * The rule pinned here is the card-number invariant's rule (#7) applied to a
 * name: never key logic on a non-unique value without an exactly-one guard.
 *
 *   0 matches → unchanged (create / "unknown, review it")
 *   1 match   → unchanged (adopt / "known, no review")
 *   2 or more → a question only a human can answer
 *
 * The prelude's half of the same rule lives in
 * `convex/commitCardChecklist.entityReview.test.ts`, next to the rest of the
 * commit-path fixtures.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_players_ambiguity_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_players_ambiguity_001",
  name: "Admin User",
  role: "admin",
};

async function seedSport(t: ReturnType<typeof convexTest>) {
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

async function insertPlayer(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  fields: {
    name: string;
    nameNormalized: string;
    birthYear?: number;
    teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
  },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      sportId,
      lastUpdated: Date.now(),
      ...fields,
    }),
  );
}

async function insertTeam(
  t: ReturnType<typeof convexTest>,
  sportId: Id<"selectorOptions">,
  name: string,
  nameNormalized: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name,
      nameNormalized,
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

// ===========================================================================
// findOrCreate / createByAdmin
// ===========================================================================

describe("NEO-254: the write paths refuse to guess between same-name players", () => {
  test("findOrCreate still adopts the single existing row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const existing = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Tony Gwynn",
      sportId,
    });
    expect(id).toBe(existing);
  });

  test("findOrCreate still creates when nothing matches", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Daulton Varsho",
      sportId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.name).toBe("Daulton Varsho");
  });

  test("findOrCreate throws rather than returning the first of two same-name rows", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
    });
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    await expect(
      asAdmin.mutation(api.players.findOrCreate, { name: "Bob Allen", sportId }),
    ).rejects.toThrow(/2 players are already filed under Bob Allen/);

    // And it created nothing on its way out — a refusal that also minted a
    // third row would be worse than the guess it replaced.
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("players").collect()).length,
    );
    expect(count).toBe(2);
  });

  test("findOrCreate resolves the ambiguity when a birthYear picks exactly one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
    });
    const younger = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Bob Allen",
      sportId,
      birthYear: 1937,
    });
    expect(id).toBe(younger);
  });

  test("a birthYear that matches nothing is not evidence of a new person", async () => {
    // The existing rows may simply predate the column. Guessing "then this
    // must be somebody else" would mint a duplicate on the strength of a
    // missing field.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    await expect(
      asAdmin.mutation(api.players.findOrCreate, {
        name: "Bob Allen",
        sportId,
        birthYear: 1937,
      }),
    ).rejects.toThrow(/already filed under Bob Allen/);
  });

  test("a birthYear shared by both candidates is still ambiguous", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    await expect(
      asAdmin.mutation(api.players.findOrCreate, {
        name: "Bob Allen",
        sportId,
        birthYear: 1937,
      }),
    ).rejects.toThrow(/already filed under Bob Allen/);
  });

  test("findOrCreate stores a birthYear on a row it creates", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Bob Allen",
      sportId,
      birthYear: 1937,
    });
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.birthYear).toBe(1937);
  });

  test("createByAdmin carries the same guard", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    await expect(
      asAdmin.mutation(api.players.createByAdmin, { name: "Bob Allen", sportId }),
    ).rejects.toThrow(/2 players are already filed under Bob Allen/);
  });

  test("createByAdmin adopts the single existing row when NO birth year is offered", async () => {
    // The unchanged half: with no tiebreaker, one row is the row.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const existing = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Tony Gwynn",
      sportId,
    });
    expect(result).toEqual({ id: existing, created: false });
  });

  test("createByAdmin adopts the single existing row when the birth year MATCHES", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const existing = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1960,
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Bob Allen",
      sportId,
      birthYear: 1960,
    });
    expect(result).toEqual({ id: existing, created: false });
    expect(
      await t.run(async (ctx) => (await ctx.db.query("players").collect()).length),
    ).toBe(1);
  });
});

// ===========================================================================
// createByAdmin FORKS — the admin form's "Create anyway", made able to
// ===========================================================================

describe("NEO-254: a differing birth year creates the second person", () => {
  test("single row with 1960, create with 1975 → a NEW row, and both are listed", async () => {
    // The bug this replaced: the single-candidate branch returned
    // `created: false` before it ever read `birthYear`, so "Create anyway"
    // silently handed back the first Bob Allen and told the operator the
    // player already existed. Plan decision 3's identity rule was unreachable
    // from the UI — the "Same name, different people" panel could only ever be
    // produced by the preload.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const older = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1960,
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Bob Allen",
      sportId,
      birthYear: 1975,
    });

    expect(result.created).toBe(true);
    expect(result.id).not.toBe(older);
    const created = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(created!.birthYear).toBe(1975);

    // Both stand, and the management list shows both — which is what makes the
    // pair reviewable afterwards.
    const listed = await asAdmin.query(api.players.listForManagement, { sportId });
    expect(listed.players).toHaveLength(2);
    expect(listed.players.map((p) => p.birthYear).sort()).toEqual([1960, 1975]);
  });

  test("single row with NO year, create with 1975 → a new row", async () => {
    // An absent year counts as different: the operator can see the existing
    // row and pressed the button that says "anyway". Reading the gap as
    // "probably the same man, we just never recorded it" would discard an
    // explicit human gesture in favour of a guess about a missing field.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const undated = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Bob Allen",
      sportId,
      birthYear: 1975,
    });

    expect(result.created).toBe(true);
    expect(result.id).not.toBe(undated);
    // The undated row is left exactly as it was — a fork is not a repair.
    expect((await t.run(async (ctx) => ctx.db.get(undated)))!.birthYear).toBeUndefined();
  });

  test("findOrCreate does NOT fork on the same input — pickers link, they do not create people", async () => {
    // The contract that must not move with it. A picker forking a second row
    // because a birth year disagreed would mint duplicates from a typo, in a
    // control used hundreds of times a session.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const existing = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1960,
    });

    const id = await asAdmin.mutation(api.players.findOrCreate, {
      name: "Bob Allen",
      sportId,
      birthYear: 1975,
    });
    expect(id).toBe(existing);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("players").collect()).length),
    ).toBe(1);
  });

  test("TWO dated rivals and a year matching neither → a third row", async () => {
    // Every rival is dated and none of them is this year, so none of them is
    // this man.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
    });
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Bob Allen",
      sportId,
      birthYear: 1975,
    });
    expect(result.created).toBe(true);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("players").collect()).length),
    ).toBe(3);
  });

  test("TWO rivals, one UNDATED, and a year matching neither → still a refusal", async () => {
    // The leniency stops at one candidate. With several rivals the form offers
    // no way to rule on each, and the undated one could be this very man.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
    });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    await expect(
      asAdmin.mutation(api.players.createByAdmin, {
        name: "Bob Allen",
        sportId,
        birthYear: 1975,
      }),
    ).rejects.toThrow(/2 players are already filed under Bob Allen/);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("players").collect()).length),
    ).toBe(2);
  });

  test("TWO rivals sharing the SAME year as the request → a refusal, not a third row", async () => {
    // The tiebreaker does not tie-break, and forking would add a third
    // indistinguishable row.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    await expect(
      asAdmin.mutation(api.players.createByAdmin, {
        name: "Bob Allen",
        sportId,
        birthYear: 1937,
      }),
    ).rejects.toThrow(/already filed under Bob Allen/);
  });

  test("TWO rivals and a year matching exactly one → adopts that one", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
    });
    const younger = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
    });

    const result = await asAdmin.mutation(api.players.createByAdmin, {
      name: "Bob Allen",
      sportId,
      birthYear: 1937,
    });
    expect(result).toEqual({ id: younger, created: false });
  });
});

// ===========================================================================
// The "needs review" gate
// ===========================================================================

describe("NEO-254: resolveNameForReview decides whether the wizard opens", () => {
  test("no match is unknown", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const result = await t.query(internal.players.resolveNameForReview, {
      name: "Bob Allen",
      sportId,
    });
    expect(result).toEqual({ matchCount: 0 });
  });

  test("exactly one match resolves, and names the row", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const only = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });
    const result = await t.query(internal.players.resolveNameForReview, {
      name: "Tony Gwynn",
      sportId,
    });
    expect(result).toEqual({ matchCount: 1, playerId: only });
  });

  test("two matches report the count and NO id — the caller must not link", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    const result = await t.query(internal.players.resolveNameForReview, {
      name: "Bob Allen",
      sportId,
    });
    expect(result.matchCount).toBe(2);
    // Handing back one id out of two is the exact failure this query replaced.
    expect(result.playerId).toBeUndefined();
  });

  test("a name in another sport does not resolve this one", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    await insertPlayer(t, otherSportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
    });

    const result = await t.query(internal.players.resolveNameForReview, {
      name: "Bob Allen",
      sportId,
    });
    expect(result.matchCount).toBe(0);
  });
});

// ===========================================================================
// existingCandidates — what the wizard shows for an ambiguous name
// ===========================================================================

describe("NEO-254: applyLookupResult attaches NB's own candidates", () => {
  async function seedReviewRow(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
    name: string,
  ) {
    const selectorOptionId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: "user_1",
        kind: "player" as const,
        name,
        sportId,
        status: "pending" as const,
      }),
    );
    return rowId;
  }

  test("two same-name rows become candidates, with a birth year and a career line", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const padres = await insertTeam(t, sportId, "Padres", "padres");
    const phillies = await insertTeam(t, sportId, "Phillies", "phillies");
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1867,
      teamYears: [{ teamId: phillies, fromYear: 1890, toYear: 1894 }],
    });
    await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
      birthYear: 1937,
      teamYears: [{ teamId: padres, fromYear: 1961 }],
    });
    const rowId = await seedReviewRow(t, sportId, "Bob Allen");

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { wikidataId: "Q1" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    const candidates = row!.enrichment!.existingCandidates!;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.birthYear).sort()).toEqual([1867, 1937]);
    expect(candidates.map((c) => c.careerSummary).sort()).toEqual([
      "Padres 1961–present",
      "Phillies 1890–1894",
    ]);
    // The lookup's own result is preserved alongside them.
    expect(row!.enrichment!.wikidataId).toBe("Q1");
  });

  test("candidates are attached even when the Wikidata lookup found nothing", async () => {
    // The error branch sends no enrichment at all. A name Wikidata has never
    // heard of is exactly as ambiguous as one it knows, so the candidates have
    // to be minted here rather than merged into a result that never arrives.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    const rowId = await seedReviewRow(t, sportId, "Bob Allen");

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "error",
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.status).toBe("error");
    expect(row!.enrichment!.existingCandidates).toHaveLength(2);
    // A candidate with nothing on file still appears — the operator needs to
    // see that the row exists even when it can say nothing about itself.
    expect(row!.enrichment!.existingCandidates![0].careerSummary).toBe("");
  });

  test("a single match is NOT a choice, and stores no candidates", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Tony Gwynn", nameNormalized: "gwynn tony" });
    const rowId = await seedReviewRow(t, sportId, "Tony Gwynn");

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { wikidataId: "Q1" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.enrichment!.existingCandidates).toBeUndefined();
  });

  test("a team row never gets candidates", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    const selectorOptionId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: "user_1",
        kind: "team" as const,
        name: "Bob Allen",
        sportId,
        status: "pending" as const,
      }),
    );

    await t.mutation(internal.entityReviewQueue.applyLookupResult, {
      id: rowId,
      status: "ready",
      enrichment: { location: "San Diego" },
    });

    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.enrichment!.existingCandidates).toBeUndefined();
  });
});

// ===========================================================================
// The bulk fast-paths and an ambiguous row
// ===========================================================================

describe("NEO-254: 'Add All Remaining as New' will not answer a choice for you", () => {
  async function seedBatch(t: ReturnType<typeof convexTest>) {
    const sportId = await seedSport(t);
    const selectorOptionId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    return { sportId, selectorOptionId };
  }

  async function insertRow(
    t: ReturnType<typeof convexTest>,
    opts: {
      selectorOptionId: Id<"selectorOptions">;
      sportId: Id<"selectorOptions">;
      name: string;
      candidates?: Array<Id<"players">>;
    },
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId: opts.selectorOptionId,
        batchId: "batch-1",
        // `recordAllRemaining*` refuses to rule on another session's batch, so
        // the row has to belong to the identity driving the mutation.
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: opts.name,
        sportId: opts.sportId,
        status: "ready" as const,
        ...(opts.candidates
          ? {
              enrichment: {
                existingCandidates: opts.candidates.map((playerId, i) => ({
                  playerId,
                  name: opts.name,
                  careerSummary: `Team ${i} 1990–1991`,
                })),
              },
            }
          : {}),
      }),
    );
  }

  test("bulk create decides the ordinary rows and leaves the ambiguous one alone", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, selectorOptionId } = await seedBatch(t);
    const plain = await insertRow(t, { selectorOptionId, sportId, name: "Daulton Varsho" });
    const ambiguous = await insertRow(t, {
      selectorOptionId,
      sportId,
      name: "Bob Allen",
      candidates: [
        await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" }),
        await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" }),
      ],
    });

    const decided = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "batch-1" },
    );

    expect(decided).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(plain)))!.decision).toEqual({
      action: "create",
    });
    // Still a question. "Everything else is new" is not an answer to "which of
    // these two Bob Allens is on the card".
    expect((await t.run(async (ctx) => ctx.db.get(ambiguous)))!.decision).toBeUndefined();
  });

  test("bulk SKIP still covers an ambiguous row — skip creates nothing", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, selectorOptionId } = await seedBatch(t);
    const ambiguous = await insertRow(t, {
      selectorOptionId,
      sportId,
      name: "Bob Allen",
      candidates: [
        await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" }),
        await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" }),
      ],
    });

    const decided = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsSkip,
      { selectorOptionId, batchId: "batch-1" },
    );

    expect(decided).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(ambiguous)))!.decision).toEqual({
      action: "skip",
    });
  });
});

// ===========================================================================
// The bulk create asks the INDEX, not the stored marker
// ===========================================================================

describe("NEO-254: bulk create re-reads ambiguity rather than trusting the row", () => {
  test("a row with NO stored candidates is still left alone when the index says two", async () => {
    // The marker is written at enqueue and refreshed at lookup. Neither
    // happens for a row the completion backstop or the stale sweep settled to
    // "error", nor for one queued before this shipped — and a name can become
    // ambiguous after the row was written, when a preload run or a colleague's
    // commit lands. This caller turns "not ambiguous" straight into an INSERT,
    // so it has to ask the index.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    const selectorOptionId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const stranded = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: "Bob Allen",
        sportId,
        // Exactly what the backstop leaves behind: settled, and with no
        // enrichment ever written.
        status: "error" as const,
      }),
    );

    const decided = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "batch-1" },
    );

    expect(decided).toBe(0);
    expect((await t.run(async (ctx) => ctx.db.get(stranded)))!.decision).toBeUndefined();
  });

  test("a TEAM row is left to its own New Team step, not to the player index", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    const selectorOptionId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    const teamRow = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "team" as const,
        // Same string, but it is a team name — the player index says nothing
        // about it.
        name: "Bob Allen",
        sportId,
        status: "ready" as const,
      }),
    );
    // A player nobody shares a name with, so the call has something it IS
    // allowed to decide. Without it a count of zero would prove nothing: it
    // would be the same answer an empty batch gives.
    const playerRow = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: ADMIN_IDENTITY.subject,
        kind: "player" as const,
        name: "Ken Griffey Jr",
        sportId,
        status: "ready" as const,
      }),
    );

    const decided = await asAdmin.mutation(
      api.entityReviewQueue.recordAllRemainingAsCreate,
      { selectorOptionId, batchId: "batch-1" },
    );

    // NEO-236: the bulk create decides PLAYERS ONLY. The team is left
    // undecided for its own New Team step, which is the one place the league
    // question gets answered — and that, not the NEO-254 ambiguity guard, is
    // what held it back. The guard reads `players` by normalized name, so a
    // team row carrying a name two PLAYERS share must never trip it.
    expect(decided).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(playerRow)))!.decision).toEqual({
      action: "create",
    });
    expect((await t.run(async (ctx) => ctx.db.get(teamRow)))!.decision).toBeUndefined();
  });
});

// ===========================================================================
// findByNameAndSport
// ===========================================================================

describe("NEO-254: findByNameAndSport answers null rather than one-of-many", () => {
  test("returns the single match", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const only = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });
    const found = await asAdmin.query(api.players.findByNameAndSport, {
      name: "Tony Gwynn",
      sportId,
    });
    expect(found?._id).toBe(only);
  });

  test("returns null when two rows share the name", async () => {
    // `player | null` cannot express "one of these two", and the shape tells
    // the caller there was nothing to choose between — which is how an
    // ambiguous name got bound to an arbitrary row. Saying "I don't know" is
    // the only honest answer available in this shape.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    expect(
      await asAdmin.query(api.players.findByNameAndSport, {
        name: "Bob Allen",
        sportId,
      }),
    ).toBeNull();
  });

  test("ignores a same-name row in another sport", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const only = await insertPlayer(t, sportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
    });
    const otherSportId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Football",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );
    await insertPlayer(t, otherSportId, {
      name: "Bob Allen",
      nameNormalized: "allen bob",
    });

    const found = await asAdmin.query(api.players.findByNameAndSport, {
      name: "Bob Allen",
      sportId,
    });
    expect(found?._id).toBe(only);
  });
});


// ===========================================================================
// Birth year on the write paths
// ===========================================================================

describe("NEO-254: birth year is validated wherever it is written", () => {
  test("savePlayerFields stores and clears it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });

    await asAdmin.mutation(api.players.savePlayerFields, {
      id: playerId,
      birthYear: 1960,
    });
    expect((await t.run(async (ctx) => ctx.db.get(playerId)))!.birthYear).toBe(1960);

    await asAdmin.mutation(api.players.savePlayerFields, {
      id: playerId,
      birthYear: null,
    });
    // Dropped entirely, so a cleared row is indistinguishable from one that
    // never carried a year.
    expect(
      (await t.run(async (ctx) => ctx.db.get(playerId)))!.birthYear,
    ).toBeUndefined();
  });

  test("refuses a year outside the bounds, on every write path", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    const playerId = await insertPlayer(t, sportId, {
      name: "Tony Gwynn",
      nameNormalized: "gwynn tony",
    });

    for (const bad of [1700, 20999, 1960.5]) {
      await expect(
        asAdmin.mutation(api.players.savePlayerFields, { id: playerId, birthYear: bad }),
      ).rejects.toThrow(/birth year must be a whole year/);
      await expect(
        asAdmin.mutation(api.players.createByAdmin, {
          name: "Bob Allen",
          sportId,
          birthYear: bad,
        }),
      ).rejects.toThrow(/birth year must be a whole year/);
      await expect(
        asAdmin.mutation(api.players.findOrCreate, {
          name: "Bob Allen",
          sportId,
          birthYear: bad,
        }),
      ).rejects.toThrow(/birth year must be a whole year/);
    }
  });

  test("a bad year is refused BEFORE it is used as a tiebreaker", async () => {
    // Otherwise it would silently become "no tiebreaker" and the caller would
    // get an ambiguity error naming the wrong problem.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const sportId = await seedSport(t);
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });
    await insertPlayer(t, sportId, { name: "Bob Allen", nameNormalized: "allen bob" });

    await expect(
      asAdmin.mutation(api.players.findOrCreate, {
        name: "Bob Allen",
        sportId,
        birthYear: 99,
      }),
    ).rejects.toThrow(/birth year must be a whole year/);
  });
});
