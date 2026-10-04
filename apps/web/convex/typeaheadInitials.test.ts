/**
 * NEO-322 — typeaheads that match typed text against STORED KEYS keep working
 * on the keystroke after a run of initials.
 *
 * The key joins "N. C." to "nc" and "J. T." to "jt". Typing the next word's
 * first letter ("N. C. S", "J. T. R") would join that letter too ("ncs",
 * "jtr") and prefix nothing. `teams.search` re-asks with the letter apart when
 * the joined term finds nothing; `players.search`'s multi-sport member leg
 * accepts either reading. See `entityNameQueryReadings`.
 *
 * convex-test prefix-matches every search term (Convex: the final one only),
 * which does not change these cases: each turns on whether ANY stored token
 * starts with the typed term.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeEntityName } from "../lib/entities/normalize-name";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const MEMBER = {
  subject: "user_member_322",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_member_322",
  role: "user",
};

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function seedTeam(t: T, name: string, sportId: Id<"selectorOptions">): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("teams", {
      name,
      nameNormalized: normalizeEntityName(name),
      sportId,
      lastUpdated: 1_700_000_000_000,
    });
  });
}

describe("teams.search: the keystroke after a run of initials", () => {
  test.each(["N. C", "N. C. S", "N. C. St", "NC State"])("%j finds N.C. State", async (query) => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    await seedTeam(t, "N.C. State Wolfpack", football);
    await seedTeam(t, "Boston College Eagles", football);

    const rows = await t.withIdentity(MEMBER).query(api.teams.search, { query });

    expect(rows.map((r) => r.name)).toEqual(["N.C. State Wolfpack"]);
  });

  test("the second reading is asked only when the joined one finds nothing", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    // "ncs" prefixes a token of this row, so the joined reading answers and
    // the split reading ("nc s") — which would also match "N.C. State" — is
    // never asked.
    await seedTeam(t, "NCS Raiders", football);
    await seedTeam(t, "N.C. State Wolfpack", football);

    const rows = await t
      .withIdentity(MEMBER)
      .query(api.teams.search, { query: "N. C. S" });

    expect(rows.map((r) => r.name)).toEqual(["NCS Raiders"]);
  });
});

describe("players.search: the multi-sport member leg reads both", () => {
  test.each(["J. T", "J. T. R", "J. T. Real", "JT Realmuto"])(
    "%j finds a member of the sport stored as jt realmuto",
    async (query) => {
      const t = convexTest(schema, modules);
      const football = await seedSport(t, "Football");
      const baseball = await seedSport(t, "Baseball");
      // Home sport football, so the search index (filtered on the HOME sport)
      // cannot return him for baseball: only the member leg can.
      const playerId = await t.run(async (ctx) =>
        ctx.db.insert("players", {
          name: "J.T. Realmuto",
          nameNormalized: normalizeEntityName("J.T. Realmuto"),
          sportId: football,
          createdByUserId: "user_seed",
          lastUpdated: 1_700_000_000_000,
        }),
      );
      await t.run(async (ctx) => {
        await ctx.db.insert("playerSports", {
          playerId,
          sportId: baseball,
          nameNormalized: normalizeEntityName("J.T. Realmuto"),
        });
      });

      const rows = await t
        .withIdentity(MEMBER)
        .query(api.players.search, { query, sportId: baseball });

      expect(rows.map((r) => r._id)).toEqual([playerId]);
    },
  );
});
