/**
 * NEO-202 — the identity guard on public Convex functions.
 *
 * ## The defect
 *
 * `selectorOptions.fetchCardChecklist` was a public `action` with no identity
 * check, in a file where 41 sibling functions call `requireAdmin`. Its handler
 * derived the candidate batch's owner as `(await getCurrentUserId(ctx)) ??
 * "unknown"` — a fallback whose only reason to exist is a caller that might be
 * anonymous, which is precisely the state that should have been impossible.
 *
 * Unauthenticated, the action was already a marketplace-credential abuse
 * primitive: it performs authenticated fetches against BuySportsCards and
 * SportLots with OUR stored session credentials, from OUR Cloud Run egress IP,
 * driven by one `selectorOptions` document id. That much predates this branch.
 *
 * What did NOT predate it is `checklistCandidates`, added on this branch, which
 * turned the same unauthenticated call into a ~900-row-per-call WRITE. That is
 * the escalation these tests pin.
 *
 * ## Why the tests are shaped this way
 *
 * A test that only asserts "it throws" would still pass if the guard moved
 * INSIDE the handler's `try`, where the catch converts every throw into
 * `{ success: false, message }` — the call would be refused, but so would a
 * marketplace outage, and the two would be indistinguishable. So the rejection
 * is asserted as a rejected promise, and separately the candidate table is
 * asserted empty, because "did not write" is the property that actually
 * matters and it holds independently of how the refusal is reported.
 *
 * The last block is a REGRESSION guard in the opposite direction: two queries
 * in `publicProfile.ts` are anonymous-callable by intent, and a future sweep
 * that blanket-applies a guard would silently break the only feature the
 * landing page markets. They are pinned as callable-while-anonymous so that
 * breakage is loud.
 *
 * ## NEO-212
 *
 * The same two shapes, applied to the ten public functions the entity review
 * wizard and the Player Management page added. This file is hand-maintained —
 * nothing enumerates the API, so a new public function is recorded here as
 * part of writing it, and the NEO-212 audit's INFO finding was that ten had
 * not been.
 *
 * `convex/publicFunctionAuth.test.ts` pins WHICH gate each of the ten carries.
 * This file pins the two properties that survive however the refusal is
 * reported: a refused write persisted nothing, and an admin-gated read still
 * does not ship an audit field to the client. Admin-gating is not a licence to
 * leak `createdByUserId` / `skippedByUserId` — the returns validator is what
 * enforces the omission, and the validator is public.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN = {
  subject: "admin_neo202",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo202",
  role: "admin",
};

// Signed in, but no admin role. The distinction matters: `fetchCardChecklist`
// drives the admin-only global taxonomy, so signed-in alone is NOT enough.
const MEMBER = {
  subject: "member_neo202",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|member_neo202",
  role: "member",
};

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
      // Custom so the handler's marketplace branch is never reached even if the
      // guard were absent — the test must not make real BSC/SportLots calls to
      // prove the guard works. An unguarded build still reaches the candidate
      // write, which is what the row-count assertion inspects.
      isCustom: true,
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

describe("NEO-202 — fetchCardChecklist requires an admin identity", () => {
  test("rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);

    await expect(
      t.action(api.selectorOptions.fetchCardChecklist, { selectorOptionId }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("rejects a signed-in caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);

    await expect(
      t
        .withIdentity(MEMBER)
        .action(api.selectorOptions.fetchCardChecklist, { selectorOptionId }),
    ).rejects.toThrow(/admin access required/i);
  });

  test("an anonymous call writes no checklistCandidates rows", async () => {
    // The NEO-195 escalation, stated directly. Before the guard this action was
    // an unauthenticated bulk-insert primitive; the refusal is only meaningful
    // if nothing was persisted on the way to it.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);

    await expect(
      t.action(api.selectorOptions.fetchCardChecklist, { selectorOptionId }),
    ).rejects.toThrow();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("checklistCandidates").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("no candidate batch is ever owned by the literal 'unknown' user", async () => {
    // The removed `?? "unknown"` fallback did not merely paper over the missing
    // guard — it was itself a bug. `startCandidateBatch` clears prior rows
    // scoped to (selectorOption, createdByUserId), so every anonymous run
    // shared one owner and deleted the previous one's work. Pinning the
    // sentinel out of the schema keeps a future defensive `?? "..."` from
    // quietly reintroducing a shared owner.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);

    const result = await t
      .withIdentity(ADMIN)
      .action(api.selectorOptions.fetchCardChecklist, { selectorOptionId });
    expect(result.success).toBe(true);

    const owners = await t.run(async (ctx) =>
      (await ctx.db.query("checklistCandidates").collect()).map(
        (r) => r.createdByUserId,
      ),
    );
    expect(owners).not.toContain("unknown");
  });
});

describe("NEO-202 — players.getManyByIds requires a signed-in caller", () => {
  async function seedPlayer(t: ReturnType<typeof convexTest>) {
    const sportId = await seedSport(t);
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ronald Acuna Jr",
        nameNormalized: "acuna jr ronald",
        sportId,
        createdByUserId: ADMIN.subject,
        lastUpdated: Date.now(),
      }),
    );
    return playerId;
  }

  test("rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const playerId = await seedPlayer(t);

    await expect(
      t.query(api.players.getManyByIds, { ids: [playerId] }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("still resolves rows for a signed-in non-admin, and omits createdByUserId", async () => {
    // Signed-in, not admin, on purpose: `players` is reference data and the
    // guard chosen was `requireSignedIn`. If someone later upgrades this to
    // `requireAdmin`, PlayerPicker breaks for every non-admin and this test is
    // what says so.
    const t = convexTest(schema, modules);
    const playerId = await seedPlayer(t);

    const rows = await t
      .withIdentity(MEMBER)
      .query(api.players.getManyByIds, { ids: [playerId] });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Ronald Acuna Jr");
    expect(rows[0]).not.toHaveProperty("createdByUserId");
  });
});

describe("NEO-235 — players.getByIdParam is guarded, and stays a throw", () => {
  /**
   * The registry entry for the deep-link read. `convex/players.management.test.ts`
   * covers what it RESOLVES; this pins the one property that is easy to lose
   * here, because this function's whole point is answering `null` instead of
   * throwing: `null` is its answer for "no such player", so a signed-out caller
   * must get the throw rather than be quietly told the row is not there. If the
   * guard ever moved below the `normalizeId`, the refusal and the miss would
   * become the same response and nothing else in the suite would notice.
   */
  test("refuses an anonymous caller rather than answering null", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ronald Acuna Jr",
        nameNormalized: "acuna jr ronald",
        sportId,
        createdByUserId: "clerk_some_operator",
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      t.query(api.players.getByIdParam, { id: playerId }),
    ).rejects.toThrow(/not authenticated/i);

    // Signed-in, not admin: `players` is reference data, and every screen that
    // deep-links a player sits behind ProtectedLayout. The row comes back
    // without the audit field — the returns validator enforces it, and the
    // validator is public.
    const doc = await t
      .withIdentity(MEMBER)
      .query(api.players.getByIdParam, { id: playerId });
    expect(doc?.name).toBe("Ronald Acuna Jr");
    expect(doc).not.toHaveProperty("createdByUserId");
  });
});

describe("NEO-202 — the deliberately anonymous queries stay anonymous", () => {
  // Not an oversight and not a finding: reviewed under NEO-154, re-confirmed
  // here. Guarding either one would break signup and the /u/<username> buyer
  // page respectively. Pinned so a future sweep has to argue with a red test
  // rather than a comment.
  async function seedProfile(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) =>
      ctx.db.insert("publicProfiles", {
        userId: "some_other_user",
        username: "cardshark",
        displayName: "Card Shark",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("checkUsernameAvailable answers an anonymous signup form", async () => {
    const t = convexTest(schema, modules);
    await seedProfile(t);

    expect(
      await t.query(api.publicProfile.checkUsernameAvailable, {
        username: "cardshark",
      }),
    ).toBe(false);
    expect(
      await t.query(api.publicProfile.checkUsernameAvailable, {
        username: "unclaimed",
      }),
    ).toBe(true);
  });

  test("getPublicProfileByUsername serves an anonymous buyer without leaking userId", async () => {
    const t = convexTest(schema, modules);
    await seedProfile(t);

    const profile = await t.query(
      api.publicProfile.getPublicProfileByUsername,
      { username: "cardshark" },
    );

    expect(profile?.username).toBe("cardshark");
    // The omission of `userId` is what makes anonymous exposure safe. If it
    // ever reappears in the returns validator, this fails.
    expect(profile).not.toHaveProperty("userId");
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — the review wizard + Player Management surface
// ---------------------------------------------------------------------------

describe("NEO-212 — a refused write to shared reference data persists nothing", () => {
  test("players.createByAdmin refuses a non-admin without inserting a player", async () => {
    // `players` is globally shared: a row created here is visible to, and
    // reused by, every commit on every set. An ungated create is a write
    // primitive against reference data, not a per-user record.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(MEMBER)
        .mutation(api.players.createByAdmin, { name: "Ghost Player", sportId }),
    ).rejects.toThrow(/admin access required/i);

    expect(await t.run(async (ctx) => ctx.db.query("players").collect())).toEqual([]);
  });

  test("entityReviewQueue.recordAllRemainingAsSkip refuses a non-admin without deciding a row", async () => {
    // The BULK one: a single call marks every undecided name in a batch as
    // "not an entity", and commit then makes each of those a durable per-set
    // suppression. Ungated, one call could retire an operator's whole review.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewQueue", {
        selectorOptionId,
        batchId: "batch-1",
        createdByUserId: ADMIN.subject,
        kind: "player" as const,
        name: "CHECKLIST",
        sportId: selectorOptionId,
        status: "ready" as const,
      }),
    );

    await expect(
      t.withIdentity(MEMBER).mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
        selectorOptionId,
        batchId: "batch-1",
      }),
    ).rejects.toThrow(/admin access required/i);

    expect((await t.run(async (ctx) => ctx.db.get(rowId)))?.decision).toBeUndefined();
  });

  test("entityReviewSkips.clearSkip refuses a non-admin without deleting the row", async () => {
    // The only destructive one of the ten. Deleting a skip re-opens a decision
    // the operator already made — the name re-enters the wizard on the next
    // sync — so the delete has to be as gated as the write that created it.
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);
    const skipId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewSkips", {
        selectorOptionId,
        kind: "player" as const,
        name: "CHECKLIST",
        nameNormalized: "checklist",
        skippedAt: Date.now(),
        skippedByUserId: ADMIN.subject,
      }),
    );

    await expect(
      t.withIdentity(MEMBER).mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).rejects.toThrow(/admin access required/i);

    expect(await t.run(async (ctx) => ctx.db.get(skipId))).not.toBeNull();
  });
});

describe("NEO-212 — admin-gated reads still omit their audit fields", () => {
  test("entityReviewSkips.listForSet answers an admin without shipping skippedByUserId", async () => {
    const t = convexTest(schema, modules);
    const selectorOptionId = await seedSport(t);
    await t.run(async (ctx) =>
      ctx.db.insert("entityReviewSkips", {
        selectorOptionId,
        kind: "player" as const,
        name: "CHECKLIST",
        nameNormalized: "checklist",
        skippedAt: Date.now(),
        skippedByUserId: "clerk_some_operator",
        batchId: "batch-1",
      }),
    );

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId });

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("skippedByUserId");
    // `batchId` is what the operator gets instead: enough to find the review
    // session in the logs, and it names a batch rather than a person.
    expect(rows[0].batchId).toBe("batch-1");
  });

  test("players.listForManagement and players.nearMatches answer an admin without shipping createdByUserId", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Ronald Acuna Jr",
        nameNormalized: "acuna jr ronald",
        sportId,
        createdByUserId: "clerk_some_operator",
        lastUpdated: Date.now(),
      }),
    );
    const asAdmin = t.withIdentity(ADMIN);

    const listed = await asAdmin.query(api.players.listForManagement, {});
    expect(listed.players).toHaveLength(1);
    expect(listed.players[0]).not.toHaveProperty("createdByUserId");

    const near = await asAdmin.query(api.players.nearMatches, {
      name: "Ronald Acuna Jr",
      sportId,
    });
    expect(near).toHaveLength(1);
    expect(near[0]).not.toHaveProperty("createdByUserId");
  });
});

// ---------------------------------------------------------------------------
// NEO-240 — the League Management surface
// ---------------------------------------------------------------------------

describe("NEO-240 — a refused write to a league persists nothing", () => {
  async function seedLeague(
    t: ReturnType<typeof convexTest>,
    sportId: Id<"selectorOptions">,
  ): Promise<Id<"leagues">> {
    return t.run(async (ctx) =>
      ctx.db.insert("leagues", {
        name: "Major League Baseball",
        abbreviation: "MLB",
        nameNormalized: "major league baseball",
        sportId,
        level: "major" as const,
        aliases: ["MLB"],
        lastUpdated: Date.now(),
      }),
    );
  }

  test("leagues.createByAdmin refuses a non-admin without inserting a league", async () => {
    // `leagues` is globally shared: a row created here is the row every team
    // in that league points at, and `findOrCreateLeague` will hand it to every
    // future writer. An ungated create is a write primitive against reference
    // data, not a per-user record.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(MEMBER)
        .mutation(api.leagues.createByAdmin, { name: "Ghost League", sportId }),
    ).rejects.toThrow(/admin access required/i);

    expect(await t.run(async (ctx) => ctx.db.query("leagues").collect())).toEqual([]);
  });

  test("leagues.saveLeagueFields refuses a non-admin without touching the row", async () => {
    // The refusal is only meaningful if nothing was written on the way to it —
    // and a rename here is the one edit that could make a league invisible to
    // every lookup that resolves a league name onto it.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await seedLeague(t, sportId);

    await expect(
      t.mutation(api.leagues.saveLeagueFields, { id: leagueId, name: "Nonsense League" }),
    ).rejects.toThrow(/not authenticated/i);
    await expect(
      t
        .withIdentity(MEMBER)
        .mutation(api.leagues.saveLeagueFields, { id: leagueId, name: "Nonsense League" }),
    ).rejects.toThrow(/admin access required/i);

    const doc = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(doc?.name).toBe("Major League Baseball");
    expect(doc?.nameNormalized).toBe("major league baseball");
  });

  test("leagues.enrichFromWikidata refuses a non-admin without enqueueing a lookup", async () => {
    // The COST one: this action spends an outbound SPARQL round-trip from the
    // deployment's single egress IP, on the pool that Wikidata rate-limits us
    // by. Ungated it is a free amplifier for anyone holding the deployment URL.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await seedLeague(t, sportId);

    await expect(
      t.action(api.leagues.enrichFromWikidata, { id: leagueId }),
    ).rejects.toThrow(/not authenticated/i);
    await expect(
      t.withIdentity(MEMBER).action(api.leagues.enrichFromWikidata, { id: leagueId }),
    ).rejects.toThrow(/admin access required/i);

    expect(
      await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()),
    ).toHaveLength(0);
  });

  test("leagues.getByIdParam refuses an anonymous caller rather than answering null", async () => {
    // Same property `players.getByIdParam` is pinned for above: `null` is this
    // function's answer for "no such league", so a signed-out caller must get
    // the throw instead. If the guard ever moved below the `normalizeId`, the
    // refusal and the miss would become the same response and nothing else in
    // the suite would notice.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const leagueId = await seedLeague(t, sportId);

    await expect(
      t.query(api.leagues.getByIdParam, { id: leagueId }),
    ).rejects.toThrow(/not authenticated/i);

    const doc = await t
      .withIdentity(ADMIN)
      .query(api.leagues.getByIdParam, { id: leagueId });
    expect(doc?.name).toBe("Major League Baseball");
  });
});
