/**
 * NEO-154 — the public Convex surface, pinned.
 *
 * ## Why this file exists
 * A Convex function declared with `query` / `mutation` / `action` is callable
 * by anyone who can reach the deployment URL. The NEO-154 audit found 23 with
 * no identity check at all — an SSRF action, an unauthenticated write
 * primitive, and a set of taxonomy reads that were only ever *called* from
 * behind `ProtectedLayout`, which is not the same thing as being protected.
 *
 * Each of those 23 got a decision: deleted, made internal, guarded, or public
 * by intent. A decision recorded only in a ticket is a decision that quietly
 * comes undone the next time someone adds a function by copying its neighbour.
 * So the decisions live here as assertions.
 *
 * ## What this does NOT do
 * It does not enumerate the whole API and fail on anything unguarded. That
 * sounds stronger and is worse: `publicProfile` is legitimately anonymous, so
 * such a test needs an allowlist, and an allowlist is where a genuinely-new
 * hole gets parked to make CI green. This pins the specific decisions instead.
 *
 * ## Hand-maintained, on purpose
 *
 * A new public function does NOT fail this file by existing — there is no
 * enumeration to trip. Adding the entry is part of adding the function, and
 * the NEO-212 audit's INFO finding was exactly that: ten public functions
 * shipped on that branch without one. They are pinned in the NEO-212 block at
 * the bottom.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SIGNED_IN = { subject: "user" };
/** NEO-208: `teams.findOrCreate` is admin-only now — see its test below. */
const ADMIN = { subject: "admin", role: "admin" };

async function seedSport(t: ReturnType<typeof convexTest>): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

describe("NEO-154: deleted modules stay deleted", () => {
  // `resolveRedirect` fetched an attacker-supplied URL from our backend and
  // followed up to 10 redirects, unauthenticated — server-side request
  // forgery. It was deleted rather than fixed: it never fired for our own QRs
  // (/print/qr encodes `amt` directly in the URL, which the scanner parses
  // without a round trip) and existed only for foreign QRs hiding an amount
  // behind a redirect, which is not a case we ship.
  //
  // `myFunctions` was Convex template boilerplate that had grown real
  // `setSelections` writes. All of it was unauthenticated and none of it was
  // called from anywhere; `addNumber` was a live unauthenticated write
  // primitive against a real prod table.
  test.each(["resolveRedirect.ts", "myFunctions.ts"])(
    "%s is not back",
    (file) => {
      expect(existsSync(join(__dirname, file))).toBe(false);
    },
  );
});

describe("NEO-154: adapter actions are internal, not public", () => {
  // All seven were public actions with no identity check, and none had a UI
  // caller — they are reached only from other Convex functions. Made
  // `internalAction`, which is strictly better than adding a guard: there is
  // no check to get wrong. `testCredentials` mattered most (a
  // credential-probing oracle, reachable without a token); the search fan-outs
  // were cost amplifiers against paid marketplace APIs.
  //
  // ## Why this reads the source instead of attempting the call
  // The obvious test — call it and expect "not found" — does not work and,
  // worse, passes for the wrong reason. `convex-test` resolves a function by
  // its module path and does NOT enforce the public/internal boundary, so
  // `t.action(api.adapters.ebay.searchEbay, {})` happily runs an
  // `internalAction` and fails on ARGUMENT VALIDATION instead. A regex loose
  // enough to accept that error accepts a genuinely-public function too.
  //
  // The boundary is enforced by the declaration keyword (Convex derives the
  // public `api` from it via `FilterApi`), so the declaration is the honest
  // thing to assert.
  test.each([
    ["adapters/ebay.ts", "searchEbay"],
    ["adapters/ebay.ts", "testCredentials"],
    ["adapters/index.ts", "searchAllCardPlatforms"],
    ["adapters/index.ts", "getAvailableSetParameters"],
    ["adapters/mycardpost.ts", "searchMyCardPost"],
    ["adapters/myslabs.ts", "searchMySlabs"],
    ["adapters/testBscSetParameters.ts", "testBscSetParameters"],
  ])("%s :: %s is declared internalAction", (file, fn) => {
    const src = readFileSync(join(__dirname, file), "utf8");
    expect(src).toContain(`export const ${fn} = internalAction({`);
    expect(src).not.toContain(`export const ${fn} = action({`);
  });
});

describe("NEO-154: taxonomy reads and writes require a signed-in caller", () => {
  // Every UI caller of these sits inside ProtectedLayout, so requiring auth
  // costs nothing a real user notices. `teams.findOrCreate` is the one that
  // was an actual write primitive — its `players.findOrCreate` twin had the
  // guard all along, which is how the gap stayed invisible.

  test("teams.findOrCreate rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.mutation(api.teams.findOrCreate, { name: "Anon FC", sportId }),
    ).rejects.toThrow(/Not authenticated/);
  });

  /**
   * NEO-208 raised this one gate from signed-in to ADMIN, on this ticket's
   * security review, and the reason is a change in what the mutation costs
   * rather than a change of mind about taxonomy reads.
   *
   * Its insert branch now schedules a pooled Wikidata enrichment
   * (`wikidataPool.enqueueEnrichment`), and that pool caps CONCURRENCY, not
   * total queued work. Sign-up is open, so "signed in" is not a bound on who
   * may create globally-shared `teams` rows, let alone on how much outbound
   * lookup work they can enqueue. Every caller is admin tooling already
   * (`TeamPicker`, and so every screen under `components/SetSelector/`), so
   * nothing legitimate lost access.
   *
   * `players.findOrCreate` deliberately stayed at signed-in: it gained no
   * enqueue, so it gained no cost vector. See the comment at its handler.
   */
  test("teams.findOrCreate rejects a signed-in NON-ADMIN caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t
        .withIdentity(SIGNED_IN)
        .mutation(api.teams.findOrCreate, { name: "Real FC", sportId }),
    ).rejects.toThrow(/Admin access required/);
  });

  test("teams.findOrCreate works for an admin caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await t
      .withIdentity(ADMIN)
      .mutation(api.teams.findOrCreate, { name: "Real FC", sportId });
    expect(id).toBeDefined();
  });

  test.each([
    ["players.list", (t: ReturnType<typeof convexTest>) => t.query(api.players.list, {})],
    ["teams.list", (t: ReturnType<typeof convexTest>) => t.query(api.teams.list, {})],
    ["teams.getManyByIds", (t: ReturnType<typeof convexTest>) => t.query(api.teams.getManyByIds, { ids: [] })],
    // NEO-235. Signed-in, like the `players.get` it wraps — it is a read of one
    // row of signed-in-readable reference data, by an id that came out of a URL.
    // Called with a string that is deliberately NOT an id: this function takes
    // `v.string()` precisely so a malformed id is a `null` rather than a throw,
    // so the throw asserted here can only be the identity gate.
    ["players.getByIdParam", (t: ReturnType<typeof convexTest>) => t.query(api.players.getByIdParam, { id: "not-an-id" })],
  ])("%s rejects an anonymous caller", async (_name, call) => {
    const t = convexTest(schema, modules);
    await expect(call(t)).rejects.toThrow(/Not authenticated/);
  });

  test("players.findByNameAndSport and teams.findByNameAndSport reject anonymously", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(
      t.query(api.players.findByNameAndSport, { name: "Mike Trout", sportId }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.query(api.teams.findByNameAndSport, { name: "Yankees", sportId }),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("NEO-154: public by intent stays public", () => {
  // The other half of the decision. These two are anonymous ON PURPOSE and a
  // future sweep should not "fix" them: the buyer standing at a card-show
  // table who scanned a seller's QR will never sign in, and the signup form
  // has to check a username before an account exists to authenticate as.
  test("checkUsernameAvailable answers an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.publicProfile.checkUsernameAvailable, { username: "nobody" }),
    ).resolves.toBeDefined();
  });

  test("getPublicProfileByUsername answers an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.publicProfile.getPublicProfileByUsername, { username: "nobody" }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-212 — the entity review wizard's public surface
// ---------------------------------------------------------------------------

describe("NEO-212: the entity review + player management surface is admin-gated", () => {
  /**
   * Ten public functions arrived with the review wizard and the Player
   * Management page, and none was recorded here. Every one of them reads or
   * writes GLOBALLY-SHARED reference data (players, teams, and the per-set
   * skip list that decides which names an operator is ever shown again), so
   * "admin" is the intended gate for all ten and signed-in is not enough.
   *
   * Called with arguments that are valid but inert — the gate runs before any
   * of them is used, so a refusal here cannot be argument validation wearing a
   * guard's clothes. The two that need a real id get a seeded row.
   *
   * `teams.search` is the deliberate exception and is pinned separately below:
   * it is signed-in, not admin, and it RETURNS EMPTY rather than throwing.
   */
  const ADMIN_GATED: Array<
    [string, (t: ReturnType<typeof convexTest>, sportId: Id<"selectorOptions">) => Promise<unknown>]
  > = [
    ["players.nearMatches", (t, sportId) => t.query(api.players.nearMatches, { name: "Trout", sportId })],
    ["players.listForManagement", (t) => t.query(api.players.listForManagement, {})],
    ["players.createByAdmin", (t, sportId) => t.mutation(api.players.createByAdmin, { name: "Nobody", sportId })],
    ["teams.resolveNames", (t, sportId) => t.query(api.teams.resolveNames, { names: [], sportId })],
    ["teams.nearMatches", (t, sportId) => t.query(api.teams.nearMatches, { name: "Yankees", sportId })],
    [
      "entityReviewQueue.recordAllRemainingAsSkip",
      (t, sportId) =>
        t.mutation(api.entityReviewQueue.recordAllRemainingAsSkip, {
          selectorOptionId: sportId,
          batchId: "no-such-batch",
        }),
    ],
    [
      "entityReviewSkips.listForSet",
      (t, sportId) => t.query(api.entityReviewSkips.listForSet, { selectorOptionId: sportId }),
    ],
  ];

  test.each(ADMIN_GATED)("%s rejects an anonymous caller", async (_name, call) => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(call(t, sportId)).rejects.toThrow(/Not authenticated/);
  });

  test.each(ADMIN_GATED)("%s rejects a signed-in non-admin", async (_name, call) => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await expect(call(t.withIdentity(SIGNED_IN), sportId)).rejects.toThrow(
      /Admin access required/,
    );
  });

  // The two that need a real row of their own, kept out of the table above so
  // the table stays readable rather than growing a per-entry seed hook.
  test("players.savePlayerFields rejects anonymous and signed-in non-admin callers", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const playerId = await t.run(async (ctx) =>
      ctx.db.insert("players", {
        name: "Mike Trout",
        nameNormalized: "mike trout",
        sportId,
        createdByUserId: "seed",
        lastUpdated: 1_700_000_000_000,
      }),
    );

    await expect(
      t.mutation(api.players.savePlayerFields, { id: playerId, isHallOfFame: true }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t
        .withIdentity(SIGNED_IN)
        .mutation(api.players.savePlayerFields, { id: playerId, isHallOfFame: true }),
    ).rejects.toThrow(/Admin access required/);

    // The refusal is only meaningful if nothing was written on the way to it.
    const doc = await t.run(async (ctx) => ctx.db.get(playerId));
    expect(doc?.isHallOfFame).toBeUndefined();
  });

  test("entityReviewSkips.clearSkip rejects anonymous and signed-in non-admin callers, and deletes nothing", async () => {
    // The one DESTRUCTIVE function of the ten. A skip row is what keeps a name
    // out of the review wizard for a set, so an ungated delete would let any
    // caller silently re-open decisions an operator had already made.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const skipId = await t.run(async (ctx) =>
      ctx.db.insert("entityReviewSkips", {
        selectorOptionId: sportId,
        kind: "player" as const,
        name: "CHECKLIST",
        nameNormalized: "checklist",
        skippedAt: 1_700_000_000_000,
        skippedByUserId: "seed",
      }),
    );

    await expect(
      t.mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).rejects.toThrow(/Not authenticated/);
    await expect(
      t.withIdentity(SIGNED_IN).mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).rejects.toThrow(/Admin access required/);

    expect(
      await t.run(async (ctx) => ctx.db.query("entityReviewSkips").collect()),
    ).toHaveLength(1);
  });

  test("teams.search is signed-in, not admin, and answers empty rather than throwing", async () => {
    // Deliberately the softer gate, and recorded so a future sweep does not
    // "fix" it upward. `teams` are signed-in-readable reference data with no
    // per-user fields; the gate is about COST (search is the most expensive
    // query class Convex offers and a deployment URL ships in the client
    // bundle), not confidentiality — the same decision `players.search` made.
    // Returning [] rather than throwing keeps a signed-out render a quiet
    // no-op instead of unmounting the calling component.
    const t = convexTest(schema, modules);
    await seedSport(t);

    expect(await t.query(api.teams.search, { query: "Yankees" })).toEqual([]);
    expect(
      await t.withIdentity(SIGNED_IN).query(api.teams.search, { query: "Yankees" }),
    ).toEqual([]);
    expect(
      await t.withIdentity(ADMIN).query(api.teams.search, { query: "Yankees" }),
    ).toEqual([]);
  });
});
