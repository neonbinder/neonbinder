/**
 * NEO-426 — `resolveChecklistEntities` hands the wizard `teamlessPlayerNames`:
 * the printed spellings whose RESOLVED player's HOME sport is flagged "no
 * teams". A fact about the players, never a block; extra sports never count.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizePlayerName } from "./players";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_teamless_names_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_teamless_names_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

async function seedTree(t: T, flagged: boolean) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Pokemon",
      platformData: {},
      children: [],
      lastUpdated: now,
      ...(flagged ? { hasNoTeams: true } : {}),
    });
    const baseballId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: now,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Wizards", season: "1999" },
      parentId: sportId,
      children: [],
      lastUpdated: now,
    });
    return { sportId, baseballId, leafId };
  });
}

async function seedPlayer(t: T, sportId: Id<"selectorOptions">, name: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalizePlayerName(name),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

const printed = (cardNumber: string, players: string[]) => ({
  cardNumber,
  cardName: `Card ${cardNumber}`,
  players,
  platformData: {},
});

async function resolve(t: T, sportId: Id<"selectorOptions">, leafId: Id<"selectorOptions">, cards: ReturnType<typeof printed>[]) {
  const out = await t
    .withIdentity(ADMIN_IDENTITY)
    .action(api.selectorOptions.resolveChecklistEntities, { selectorOptionId: leafId, sportId, cards });
  await cancelScheduled(t);
  return out;
}

describe("resolveChecklistEntities — teamlessPlayerNames (NEO-426)", () => {
  test("lists exactly the resolved players whose home sport is flagged, spellings verbatim and deduped", async () => {
    const t = convexTest(schema, modules);
    const { sportId, baseballId, leafId } = await seedTree(t, true);
    await seedPlayer(t, sportId, "Pika Chu");
    const bench = await seedPlayer(t, baseballId, "Johnny Bench");
    // Resolvable in this set through an extra sport, but his HOME sport has teams.
    await t.run(async (ctx) =>
      ctx.db.insert("playerSports", {
        playerId: bench,
        sportId,
        nameNormalized: normalizePlayerName("Johnny Bench"),
      }),
    );

    const out = await resolve(t, sportId, leafId, [
      printed("1", ["Pika Chu", " pika chu "]),
      printed("2", ["pika chu", "Johnny Bench"]),
    ]);

    expect(out.unknownPlayers).toEqual([]);
    expect([...(out.teamlessPlayerNames ?? [])].sort()).toEqual(["pika chu", "Pika Chu"].sort());
  });

  test("is empty (and always sent) when no sport is flagged", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, false);
    await seedPlayer(t, sportId, "Pika Chu");
    const out = await resolve(t, sportId, leafId, [printed("1", ["Pika Chu"])]);
    expect(out.teamlessPlayerNames).toEqual([]);
  });

  test("a name the gate left unknown is never listed", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, true);
    await seedPlayer(t, sportId, "Pika Chu");
    const out = await resolve(t, sportId, leafId, [printed("1", ["Pika Chu", "Totally Unknown"])]);
    expect(out.unknownPlayers).toEqual(["Totally Unknown"]);
    expect(out.teamlessPlayerNames).toEqual(["Pika Chu"]);
  });

  test("a card with no players contributes nothing", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, true);
    await seedPlayer(t, sportId, "Pika Chu");
    const out = await resolve(t, sportId, leafId, [printed("1", [])]);
    expect(out.teamlessPlayerNames).toEqual([]);
  });
});
