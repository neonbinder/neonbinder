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

  test("teams.findOrCreate still works for a signed-in caller", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const id = await t
      .withIdentity(SIGNED_IN)
      .mutation(api.teams.findOrCreate, { name: "Real FC", sportId });
    expect(id).toBeDefined();
  });

  test.each([
    ["players.list", (t: ReturnType<typeof convexTest>) => t.query(api.players.list, {})],
    ["teams.list", (t: ReturnType<typeof convexTest>) => t.query(api.teams.list, {})],
    ["teams.getManyByIds", (t: ReturnType<typeof convexTest>) => t.query(api.teams.getManyByIds, { ids: [] })],
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
