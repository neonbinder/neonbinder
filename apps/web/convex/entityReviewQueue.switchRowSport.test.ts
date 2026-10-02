/**
 * NEO-313 — `switchRowSport`: an operator's escape hatch for a name the
 * automated same-sport lookup got wrong because the checklist and the person
 * are different sports (a football-only "Bo Jackson" on a baseball set).
 *
 * Binding rule (Linear NEO-313): nothing AUTOMATED looks across sports — this
 * mutation is the one place an OPERATOR explicitly does, by hand, per row.
 *
 * Fixture shape follows entityReviewQueue.careerTeamStaging.test.ts: raw
 * `ctx.db.insert("entityReviewQueue", ...)` rows, `ADMIN_IDENTITY` for the
 * public mutation, `source.playerRowId` / `source.teamRowId` for staged rows.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "user_switch_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_switch_001",
  role: "admin",
};

const OTHER_ADMIN = {
  subject: "user_switch_002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_switch_002",
  role: "admin",
};

const BATCH = "batch-switch";

async function seedSport(t: T, value: string): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertRow(
  t: T,
  opts: {
    sportId: Id<"selectorOptions">;
    kind: "player" | "team" | "league";
    name: string;
    createdByUserId?: string;
    status?: "pending" | "ready" | "error";
    decision?: Record<string, unknown>;
    enrichment?: Record<string, unknown>;
    source?:
      | { kind: "careerTeamOf"; playerRowId: Id<"entityReviewQueue"> }
      | { kind: "leagueOf"; teamRowId: Id<"entityReviewQueue"> };
  },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: BATCH,
      createdByUserId: opts.createdByUserId ?? ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized: normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: opts.status ?? "ready",
      ...(opts.decision ? { decision: opts.decision as never } : {}),
      ...(opts.enrichment ? { enrichment: opts.enrichment as never } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    }),
  );
}

const getRow = (t: T, id: Id<"entityReviewQueue">) => t.run((ctx) => ctx.db.get(id));

describe("switchRowSport", () => {
  test("switches the sport, resets status to pending, and re-derives enrichment", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Justin Fields" });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId,
      sportId: football,
    });

    const row = await getRow(t, rowId);
    expect(row?.sportId).toBe(football);
    expect(row?.status).toBe("pending");
  });

  test("a same-sport switch is a no-op — status and lastTouchedAt are untouched", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Mike Trout" });
    const before = await getRow(t, rowId);

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId,
      sportId: baseball,
    });

    const after = await getRow(t, rowId);
    expect(after).toEqual(before);
  });

  test("deletes the staged career-team children of a switched player row", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const playerRowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    const stagedTeamId = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Auburn Tigers",
      source: { kind: "careerTeamOf", playerRowId },
    });
    const stagedLeagueId = await insertRow(t, {
      sportId: baseball,
      kind: "league",
      name: "NCAA",
      source: { kind: "leagueOf", teamRowId: stagedTeamId },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId: playerRowId,
      sportId: football,
    });

    expect(await getRow(t, stagedTeamId)).toBeNull();
    expect(await getRow(t, stagedLeagueId)).toBeNull();
    // The player row itself survives, switched.
    expect((await getRow(t, playerRowId))?.sportId).toBe(football);
  });

  test("refuses a league-kind row — its sport comes from its team", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const teamRowId = await insertRow(t, { sportId: baseball, kind: "team", name: "Some Team" });
    const leagueRowId = await insertRow(t, {
      sportId: baseball,
      kind: "league",
      name: "NCAA",
      source: { kind: "leagueOf", teamRowId },
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
        rowId: leagueRowId,
        sportId: football,
      }),
    ).rejects.toThrow(/takes its sport from its team/);
  });

  test("refuses a staged row — its sport comes from the step that raised it", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const playerRowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    const stagedTeamId = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Auburn Tigers",
      source: { kind: "careerTeamOf", playerRowId },
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
        rowId: stagedTeamId,
        sportId: football,
      }),
    ).rejects.toThrow(/takes its sport from the step that raised it/);
  });

  test("refuses a row that already carries a decision", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const rowId = await insertRow(t, {
      sportId: baseball,
      kind: "player",
      name: "Bo Jackson",
      decision: { action: "skip" },
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
        rowId,
        sportId: football,
      }),
    ).rejects.toThrow(/Undo this decision before changing the sport/);
  });

  test("refuses a non-sport id", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    const notASport = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Refractor",
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }),
    );

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
        rowId,
        sportId: notASport,
      }),
    ).rejects.toThrow(/Pick a sport/);
  });

  test("deletes a staged team step even when it already carries a decision", async () => {
    // Team steps are walked BEFORE their player, so an operator can easily
    // decide the team step first and then realize the player itself needs a
    // sport switch. Refusing the switch there would block the normal walk
    // order, so a decided staged child is deleted along with an undecided
    // one — the decision was about a row that is about to stop applying
    // (wrong sport), not work the switch should force the operator to undo.
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const playerRowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    const stagedTeamId = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Auburn Tigers",
      source: { kind: "careerTeamOf", playerRowId },
      decision: { action: "skip" },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId: playerRowId,
      sportId: football,
    });

    expect(await getRow(t, stagedTeamId)).toBeNull();
    expect((await getRow(t, playerRowId))?.sportId).toBe(football);
  });

  test("a staged team step another batch row still needs is HANDED OVER, decision intact", async () => {
    // Staging dedupes a team step by name across the whole batch, so a step
    // carries only the FIRST row that raised it. If a second player in the
    // SAME batch also needs "Auburn Tigers" (still in the OLD sport), deleting
    // it because the first player switched sports would take it from that
    // second player too. It must be re-pointed instead, with its decision kept.
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const switching = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    const heir = await insertRow(t, {
      sportId: baseball,
      kind: "player",
      name: "Someone Else",
      decision: {
        action: "create",
        manualCareerTeams: [{ name: "Auburn Tigers", fromYear: 2000 }],
      },
    });
    const stagedTeamId = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Auburn Tigers",
      source: { kind: "careerTeamOf", playerRowId: switching },
      decision: { action: "skip" },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId: switching,
      sportId: football,
    });

    const stagedTeam = await getRow(t, stagedTeamId);
    expect(stagedTeam).not.toBeNull();
    expect(stagedTeam?.source).toEqual({ kind: "careerTeamOf", playerRowId: heir });
    // Kept with its decision — the switch itself decides nothing about it.
    expect(stagedTeam?.decision).toEqual({ action: "skip" });
  });

  test("a staged league step under a handed-over team stays with that team; an orphaned league is handed to another team that needs it", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const switching = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });
    // No other player needs this team, so it is deleted — and its league step
    // must find a new team parent rather than being deleted alongside it.
    const orphanTeamId = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Auburn Tigers",
      source: { kind: "careerTeamOf", playerRowId: switching },
    });
    const leagueHeir = await insertRow(t, {
      sportId: baseball,
      kind: "team",
      name: "Some Other Team",
      enrichment: { league: "NCAA" },
    });
    const leagueId = await insertRow(t, {
      sportId: baseball,
      kind: "league",
      name: "NCAA",
      source: { kind: "leagueOf", teamRowId: orphanTeamId },
    });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
      rowId: switching,
      sportId: football,
    });

    // The orphaned team step, needed by nobody, is deleted.
    expect(await getRow(t, orphanTeamId)).toBeNull();
    // Its league step survives, handed to the team that names it.
    const league = await getRow(t, leagueId);
    expect(league).not.toBeNull();
    expect(league?.source).toEqual({ kind: "leagueOf", teamRowId: leagueHeir });
  });

  test("rejects a row owned by a different review session", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const rowId = await insertRow(t, {
      sportId: baseball,
      kind: "player",
      name: "Bo Jackson",
      createdByUserId: OTHER_ADMIN.subject,
    });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.switchRowSport, {
        rowId,
        sportId: football,
      }),
    ).rejects.toThrow(/belongs to a different review session/);
  });

  test("rejects a signed-in non-admin", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Bo Jackson" });

    await expect(
      t
        .withIdentity({ subject: "member", issuer: "x", tokenIdentifier: "x|member" })
        .mutation(api.entityReviewQueue.switchRowSport, { rowId, sportId: football }),
    ).rejects.toThrow(/Admin access required/);
  });
});
