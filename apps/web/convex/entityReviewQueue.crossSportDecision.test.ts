/**
 * NEO-313 — `recordDecision`'s cross-sport surface: a "link" is validated
 * against the ROW's sport (which `switchRowSport` may have moved away from
 * the set's sport), and `addSetSport` — "also add {sport} to his sports" —
 * is player-kind-only, and a no-op that is silently dropped rather than
 * stored when the row was never switched.
 *
 * Fixture shape matches entityReviewQueue.switchRowSport.test.ts.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

const ADMIN_IDENTITY = {
  subject: "user_link_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_link_001",
  role: "admin",
};

const BATCH = "batch-link";

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
  opts: { sportId: Id<"selectorOptions">; kind: "player" | "team"; name: string },
): Promise<Id<"entityReviewQueue">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewQueue", {
      selectorOptionId: opts.sportId,
      batchId: BATCH,
      createdByUserId: ADMIN_IDENTITY.subject,
      kind: opts.kind,
      name: opts.name,
      nameNormalized: normalizeTeamName(opts.name),
      sportId: opts.sportId,
      status: "ready",
    }),
  );
}

async function insertPlayer(
  t: T,
  opts: { name: string; sportId: Id<"selectorOptions"> },
): Promise<Id<"players">> {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name: opts.name,
      nameNormalized: normalizePlayerName(opts.name),
      sportId: opts.sportId,
      lastUpdated: Date.now(),
    }),
  );
}

const getRow = (t: T, id: Id<"entityReviewQueue">) => t.run((ctx) => ctx.db.get(id));

describe("recordDecision: link validated against the row's (possibly switched) sport", () => {
  test("a link to a player who does not belong to the row's sport is rejected", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    // Row still on baseball; player is football-only.
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Justin Fields" });
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: rowId,
        action: "link",
        linkedPlayerId: fields,
      }),
    ).rejects.toThrow(/doesn't match/);
  });

  test("after the row is switched to the player's sport, the same link succeeds", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Justin Fields" });
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);

    await asAdmin.mutation(api.entityReviewQueue.switchRowSport, { rowId, sportId: football });
    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: fields,
    });

    const row = await getRow(t, rowId);
    expect(row?.decision).toMatchObject({ action: "link", linkedPlayerId: fields });
  });

  test("addSetSport on a TEAM row throws — the box only exists on a player step", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const football = await seedSport(t, "Football");
    const teamRowId = await insertRow(t, { sportId: baseball, kind: "team", name: "Some Team" });
    const team = await t.run(async (ctx) =>
      ctx.db.insert("teams", {
        name: "Some Team",
        nameNormalized: "some team",
        sportId: baseball,
        lastUpdated: Date.now(),
      }),
    );
    void football;

    await expect(
      t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
        reviewRowId: teamRowId,
        action: "link",
        linkedTeamId: team,
        addSetSport: true,
      }),
    ).rejects.toThrow(/Only a player can be added to the set's sport/);
  });

  test("addSetSport on an UNSWITCHED player row is silently dropped, not stored", async () => {
    const t = convexTest(schema, modules);
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Mike Trout" });
    const trout = await insertPlayer(t, { name: "Mike Trout", sportId: baseball });

    await t.withIdentity(ADMIN_IDENTITY).mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: trout,
      addSetSport: true,
    });

    const row = await getRow(t, rowId);
    // Never stored — the row's sport already equals the set's, so ticking the
    // box would add a sport the player already has.
    expect(row?.decision).toEqual({ action: "link", linkedPlayerId: trout });
    expect((row?.decision as { addSetSport?: boolean })?.addSetSport).toBeUndefined();
  });

  test("addSetSport on a SWITCHED player row IS kept on the decision", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const rowId = await insertRow(t, { sportId: baseball, kind: "player", name: "Justin Fields" });
    const fields = await insertPlayer(t, { name: "Justin Fields", sportId: football });
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    await asAdmin.mutation(api.entityReviewQueue.switchRowSport, { rowId, sportId: football });

    await asAdmin.mutation(api.entityReviewQueue.recordDecision, {
      reviewRowId: rowId,
      action: "link",
      linkedPlayerId: fields,
      addSetSport: true,
    });

    const row = await getRow(t, rowId);
    expect(row?.decision).toMatchObject({ addSetSport: true });
  });
});
