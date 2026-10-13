/**
 * NEO-335 — `resolveChecklistEntities` hands the wizard a `titleContext`: the
 * set facts a new card's title reads, and the canonical name behind every
 * printed player/team spelling the resolve gate resolved.
 *
 * The facts must be the ones the commit prelude titles the insert from, and
 * the names must be the gate's own answers — a name the gate sent to the
 * wizard is not in the context, so the step never titles a card with a name
 * the card will not carry.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { normalizePlayerName } from "./players";
import { cancelScheduled } from "../lib/testing/drain-scheduled";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_title_context_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_title_context_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

/** sport › year › manufacturer › setName › variantType, with a set-level team. */
async function seedTree(
  t: T,
  opts: { brandUnknown?: boolean; withSetTeam?: boolean } = {},
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: now,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1988",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: now,
    });
    const manufacturerId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: opts.brandUnknown ? "All Brands" : "Topps",
      platformData: {},
      ...(opts.brandUnknown ? { metadata: { isBrandUnknown: true } } : {}),
      parentId: yearId,
      children: [],
      lastUpdated: now,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps Traded",
      platformData: {},
      parentId: manufacturerId,
      children: [],
      lastUpdated: now,
    });
    const athleticsId = await ctx.db.insert("teams", {
      location: "Oakland",
      name: "Athletics",
      nameNormalized: normalizeTeamName("Oakland Athletics"),
      sportId,
      lastUpdated: now,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { manufacturer: "Topps", season: "1988" },
      ...(opts.withSetTeam ? { teamIds: [athleticsId] } : {}),
      parentId: setNameId,
      children: [],
      lastUpdated: now,
    });
    await ctx.db.patch(setNameId, { children: [leafId] });
    await ctx.db.patch(manufacturerId, { children: [setNameId] });
    await ctx.db.patch(yearId, { children: [manufacturerId] });
    await ctx.db.patch(sportId, { children: [yearId] });
    await ctx.db.insert("players", {
      name: "José Canseco",
      nameNormalized: normalizePlayerName("José Canseco"),
      sportId,
      lastUpdated: now,
    });
    return { sportId, leafId, athleticsId };
  });
}

function previewCard(opts: { players?: string[]; teams?: string[]; team?: string }) {
  return {
    cardNumber: "1T",
    cardName: "Card",
    players: opts.players ?? [],
    teams: opts.teams,
    team: opts.team,
    platformData: {},
  };
}

describe("resolveChecklistEntities — titleContext (NEO-335)", () => {
  test("the set facts are the ones the commit prelude titles an insert from", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, { withSetTeam: true });

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId: leafId, sportId, cards: [previewCard({})] },
    );

    expect(result.titleContext).toMatchObject({
      sportValue: "Baseball",
      setNameValue: "Topps Traded",
      manufacturerBrandUnknown: false,
      inheritedFeatures: { manufacturer: "Topps", season: "1988" },
      setTeamNames: ["Oakland Athletics"],
    });
  });

  test("an unidentified brand is reported as a ROLE, never by its name", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t, { brandUnknown: true });
    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId: leafId, sportId, cards: [previewCard({})] },
    );
    expect(result.titleContext?.manufacturerBrandUnknown).toBe(true);
    expect(result.titleContext?.setTeamNames).toEqual([]);
  });

  test("a printed spelling that resolved maps to the CANONICAL name, verbatim key", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: leafId,
        sportId,
        cards: [
          previewCard({ players: ["Jose Canseco"], teams: ["Oakland Athletics"] }),
          // The legacy singular `team` is read when `teams` is empty, as the
          // commit reads it.
          previewCard({ players: [" jose canseco "], team: "oakland athletics" }),
        ],
      },
    );

    expect(result.unknownPlayers).toEqual([]);
    expect(result.unknownTeams).toEqual([]);
    expect(result.batchId).toBeUndefined();
    expect(result.titleContext?.players).toEqual([
      { printed: "Jose Canseco", name: "José Canseco" },
      { printed: "jose canseco", name: "José Canseco" },
    ]);
    expect(result.titleContext?.teams).toEqual([
      { printed: "Oakland Athletics", name: "Oakland Athletics" },
      { printed: "oakland athletics", name: "Oakland Athletics" },
    ]);
  });

  test("a name the gate sends to the wizard is NOT in the context", async () => {
    const t = convexTest(schema, modules);
    const { sportId, leafId } = await seedTree(t);

    const result = await t.withIdentity(ADMIN_IDENTITY).action(
      api.selectorOptions.resolveChecklistEntities,
      {
        selectorOptionId: leafId,
        sportId,
        cards: [previewCard({ players: ["Nobody Known"], teams: ["Gotham Knights"] })],
      },
    );
    expect(result.unknownPlayers).toEqual(["Nobody Known"]);
    expect(result.unknownTeams).toEqual(["Gotham Knights"]);
    expect(result.titleContext?.players).toEqual([]);
    expect(result.titleContext?.teams).toEqual([]);
    // The batch schedules its background lookups; none may run at teardown.
    await cancelScheduled(t);
  });
});

describe("listingTitleContext internals", () => {
  test("playerNamesByIds refuses more than one page", async () => {
    const t = convexTest(schema, modules);
    const ids = Array.from(
      { length: 201 },
      () => "k17bad00000000000000000000000000" as unknown as Id<"players">,
    );
    await expect(
      t.query(internal.listingTitleContext.playerNamesByIds, { ids }),
    ).rejects.toThrow();
  });

  test.each(["titleSetFacts", "playerNamesByIds"])(
    "%s is declared internalQuery (it trusts its arguments)",
    (fn) => {
      const src = readFileSync(join(__dirname, "listingTitleContext.ts"), "utf8");
      expect(src).toContain(`export const ${fn} = internalQuery({`);
      for (const other of ["query", "mutation", "action", "internalMutation", "internalAction"]) {
        expect(src).not.toContain(`export const ${fn} = ${other}({`);
      }
    },
  );
});
