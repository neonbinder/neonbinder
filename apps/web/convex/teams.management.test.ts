/**
 * NEO-253 (audit) — the rename collision guard on `teams.saveTeamFields`.
 *
 * `savePlayerFields` and `saveLeagueFields` have always refused a rename onto
 * an existing (normalized name, sport) key with `NAME_TAKEN:<id>`. The team
 * side rewrote `nameNormalized` with no guard at all, which was survivable
 * while only an exact re-typing could collide.
 *
 * Folding diacritics ended that. "Montreal Expos" renamed to "Montréal Expos"
 * beside an existing "Montréal Expos" now keys identically — and correcting a
 * franchise's spelling is the single most likely edit anybody makes on that
 * page, so the fold turned a theoretical collision into the expected one. Two
 * rows sharing a key can never be told apart again by any lookup:
 * `by_name_normalized_and_sport_id` reads take `.first()`, so half the sync
 * results land on one row and half on the other, silently.
 *
 * Fixtures are raw `ctx.db.insert` rows, per the minimal-fixture convention in
 * `players.management.test.ts`, whose shape this file mirrors deliberately —
 * the two guards are the same guard and should read the same way.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "user_team_admin",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_team_admin",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      sportConfig: { skuCode: value.slice(0, 2).toUpperCase(), league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertTeam(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions"> },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: opts.name,
      nameNormalized: normalizeTeamName(opts.name),
      sportId: opts.sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function getTeam(t: T, id: Id<"teams">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

/** The rejection's message, or a failure if the call unexpectedly resolved. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("saveTeamFields refuses a rename onto an existing key (NEO-253)", () => {
  test("an ACCENT-ONLY rename collides — the case the fold created", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const keep = await insertTeam(t, { name: "Montréal Expos", sportId });
    const editing = await insertTeam(t, { name: "Montreal Expos", sportId });

    const message = await rejectionMessage(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.saveTeamFields, {
        id: editing,
        name: "Montréal Expos",
      }),
    );

    expect(message).toBe(`NAME_TAKEN:${keep}`);
    // An id and nothing else — the message reaches Sentry and the browser
    // console, and the name the operator typed is the only other thing they
    // could learn from it. Same convention `savePlayerFields` set.
    expect(message).not.toContain("Montr");

    // Nothing was written on the rejected path — the operator's row still
    // carries its own name and its own key.
    const after = await getTeam(t, editing);
    expect(after?.name).toBe("Montreal Expos");
    expect(after?.nameNormalized).toBe(normalizeTeamName("Montreal Expos"));
  });

  test("a plain rename onto an existing name collides too", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const keep = await insertTeam(t, { name: "New York Yankees", sportId });
    const editing = await insertTeam(t, { name: "New York Yankess", sportId });

    const message = await rejectionMessage(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.saveTeamFields, {
        id: editing,
        name: "New York Yankees",
      }),
    );
    expect(message).toBe(`NAME_TAKEN:${keep}`);
  });

  test("re-saving a team under its own name is not a collision", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertTeam(t, { name: "Chicago Cubs", sportId });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.saveTeamFields, {
        id: teamId,
        name: "Chicago Cubs",
        city: "Chicago",
      }),
    ).resolves.toBeNull();

    expect((await getTeam(t, teamId))?.city).toBe("Chicago");
  });

  test("adding the accents to the ONLY row carrying that name is allowed", async () => {
    // The whole point of the edit. A guard that refused this would make the
    // fold a reason an operator cannot correct a spelling — the opposite of
    // what NEO-253 is for.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const teamId = await insertTeam(t, { name: "Montreal Expos", sportId });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.saveTeamFields, {
        id: teamId,
        name: "Montréal Expos",
      }),
    ).resolves.toBeNull();

    const after = await getTeam(t, teamId);
    expect(after?.name).toBe("Montréal Expos");
    expect(after?.nameNormalized).toBe("expos montreal");
  });

  test("the same name under another sport is not a collision", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const basketball = await seedSport(t, "Basketball");
    await insertTeam(t, { name: "Chicago Bulls", sportId: basketball });
    const editing = await insertTeam(t, { name: "Chicago Cubs", sportId: baseball });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.teams.saveTeamFields, {
        id: editing,
        name: "Chicago Bulls",
      }),
    ).resolves.toBeNull();
  });
});
