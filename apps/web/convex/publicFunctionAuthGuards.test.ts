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
