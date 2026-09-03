/**
 * NEO-212 — `players.nearMatches`, the "did you mean?" prompt in front of
 * creating a player from the entity review wizard.
 *
 * The player side of the same bug as `teams.nearMatches`: commit-time dedup is
 * normalized-equality only, so a card front printing "OHTANI" and a back
 * printing "Shohei Ohtani" produced two rows and the wizard flagged neither.
 *
 * **What convex-test does and does not model about search indexes** — the same
 * caveats spelled out at the top of `convex/teams.search.test.ts`: search IS
 * supported and honours `filterFields`, but it splits document text on
 * whitespace only (not punctuation), prefix-matches every term rather than the
 * final one, and applies no relevance ranking. Nothing here asserts an order
 * that depends on the search index; the ordering under test belongs to
 * `rankPlayerCandidates`, which is pure and covered in
 * `convex/lib/entityNearMatch.test.ts`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "user_admin_212p",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_admin_212p",
  role: "admin",
};

/** Signed in, but not an admin — the gate this query must reject. */
const MEMBER = {
  subject: "user_member_212p",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_member_212p",
  role: "user",
};

async function seedSport(
  t: ReturnType<typeof convexTest>,
  value: string,
  skuCode: string,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      sportConfig: { skuCode, league: value.toUpperCase() },
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedPlayer(
  t: ReturnType<typeof convexTest>,
  name: string,
  sportId: Id<"selectorOptions">,
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      // Present so a leak of this audit-only field would be visible; the
      // return validator has no slot for it.
      createdByUserId: "user_someone_else",
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

describe("players.nearMatches", () => {
  test("reports the same normalised key as exact", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const troutId = await seedPlayer(t, "Mike Trout", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Trout, Mike", sportId: baseball });

    expect(rows).toEqual([
      { _id: troutId, name: "Mike Trout", confidence: "exact" },
    ]);
  });

  // The ticket, on the player side: a surname-only card front against a
  // full-name row.
  test("finds the full name from a surname alone", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Ohtani", sportId: baseball });

    expect(rows).toEqual([
      { _id: ohtaniId, name: "Shohei Ohtani", confidence: "close" },
    ]);
  });

  test("finds the full name from an initialled first name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "S. Ohtani", sportId: baseball });

    expect(rows.map((r) => r._id)).toEqual([ohtaniId]);
    expect(rows[0].confidence).toBe("close");
  });

  test("returns nothing for an unrelated name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Shohei Ohtani", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Mike Trout",
        sportId: baseball,
      }),
    ).toEqual([]);
  });

  test("a shared surname with different first names is not a match", async () => {
    // Rung 5 of the `lib/pairing/names.ts` ladder: surnames agree, first names
    // genuinely disagree, so these are two people and the wizard says nothing.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Steve Trout", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Mike Trout",
        sportId: baseball,
      }),
    ).toEqual([]);
  });

  test("never crosses sports", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const football = await seedSport(t, "Football", "FB");
    await seedPlayer(t, "Shohei Ohtani", baseball);

    expect(
      await t.withIdentity(ADMIN).query(api.players.nearMatches, {
        name: "Shohei Ohtani",
        sportId: football,
      }),
    ).toEqual([]);
  });

  /**
   * Exercises the SECOND search — the surname fallback that runs only when the
   * full-name query comes back empty.
   *
   * Honest about what stages the miss: convex-test splits document text on
   * whitespace only, so the query term "Ohtani." (with its period) fails to
   * prefix-match the document word "ohtani", and the whole-name search finds
   * nothing. Convex's real tokenizer splits on punctuation and would have
   * matched directly. So this proves the fallback BRANCH runs and returns the
   * right row — not that production reaches it by this route. In production
   * the branch earns its place against BM25 crowding, which convex-test models
   * not at all (see the header).
   */
  test("falls back to the surname when the whole-name search misses", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    const ohtaniId = await seedPlayer(t, "Ohtani", baseball);

    const rows = await t.withIdentity(ADMIN).query(api.players.nearMatches, {
      name: "Shohei Ohtani.",
      sportId: baseball,
    });

    expect(rows).toEqual([
      { _id: ohtaniId, name: "Ohtani", confidence: "close" },
    ]);
  });

  test("puts the exact row first and honours the limit", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Ohtani", baseball);
    const ohtaniId = await seedPlayer(t, "Shohei Ohtani", baseball);
    await seedPlayer(t, "S. Ohtani", baseball);

    const asAdmin = t.withIdentity(ADMIN);
    const all = await asAdmin.query(api.players.nearMatches, {
      name: "Shohei Ohtani",
      sportId: baseball,
    });
    expect(all[0]).toEqual({
      _id: ohtaniId,
      name: "Shohei Ohtani",
      confidence: "exact",
    });
    expect(all).toHaveLength(3);

    const capped = await asAdmin.query(api.players.nearMatches, {
      name: "Shohei Ohtani",
      sportId: baseball,
      limit: 1,
    });
    expect(capped).toHaveLength(1);
    expect(capped[0]._id).toBe(ohtaniId);
  });

  test("returns only _id, name and confidence — never createdByUserId", async () => {
    // `players` rows carry an audit-only `createdByUserId` that must not reach
    // the client; see `toPublicPlayer` at the top of convex/players.ts.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Mike Trout", baseball);

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.players.nearMatches, { name: "Mike Trout", sportId: baseball });

    expect(Object.keys(rows[0]).sort()).toEqual(["_id", "confidence", "name"]);
  });

  test("returns [] for a blank name", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");
    await seedPlayer(t, "Mike Trout", baseball);

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.players.nearMatches, { name: "   ", sportId: baseball }),
    ).toEqual([]);
  });

  test("is admin-gated", async () => {
    // Stricter than `players.search` next to it, deliberately: this query
    // exists to guard a write to globally-shared reference data, and its only
    // caller is admin tooling.
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball", "BB");

    await expect(
      t.query(api.players.nearMatches, { name: "Trout", sportId: baseball }),
    ).rejects.toThrow(/Not authenticated/);

    await expect(
      t
        .withIdentity(MEMBER)
        .query(api.players.nearMatches, { name: "Trout", sportId: baseball }),
    ).rejects.toThrow(/Admin access required/);
  });
});
