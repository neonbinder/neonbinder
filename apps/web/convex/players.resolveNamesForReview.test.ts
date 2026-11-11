/**
 * PR 451 (NEO-487) — `players.resolveNamesForReview`, the batched form of
 * `resolveNameForReview`.
 *
 * Contract: element i of the answer is EXACTLY what `resolveNameForReview`
 * returns for `{ name: names[i].name, sportId, cardYear, cardTeamNames:
 * names[i].cardTeamNames }`; the answer is aligned with the input; more than
 * 25 names is refused, never truncated.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: { skuCode: "BB", league: "MLB" },
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function insertTeam(t: T, sportId: Id<"selectorOptions">, location: string, name: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      location,
      name,
      nameNormalized: `${location} ${name}`.toLowerCase().split(" ").sort().join(" "),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function insertPlayer(
  t: T,
  sportId: Id<"selectorOptions">,
  name: string,
  normalized: string,
  teamYears?: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("players", {
      name,
      nameNormalized: normalized,
      sportId,
      ...(teamYears ? { teamYears } : {}),
      lastUpdated: Date.now(),
    }),
  );
}

/** Solo (one match), two Bob Allens a card team separates, one rival pair, a stranger. */
async function seed(t: T) {
  const sportId = await seedSport(t);
  const cubs = await insertTeam(t, sportId, "Chicago", "Cubs");
  const padres = await insertTeam(t, sportId, "San Diego", "Padres");
  const solo = await insertPlayer(t, sportId, "Solo Guy", "guy solo");
  const cubAllen = await insertPlayer(t, sportId, "Bob Allen", "allen bob", [
    { teamId: cubs, fromYear: 1988, toYear: 1991 },
  ]);
  await insertPlayer(t, sportId, "Bob Allen", "allen bob", [
    { teamId: padres, fromYear: 1986, toYear: 1994 },
  ]);
  return { sportId, solo, cubAllen };
}

describe("players.resolveNamesForReview", () => {
  test("answers each name exactly as resolveNameForReview does, in input order", async () => {
    const t = convexTest(schema, modules);
    const { sportId, solo, cubAllen } = await seed(t);
    const names = [
      { name: "Nobody Here" },
      { name: "Bob Allen", cardTeamNames: ["Chicago Cubs"] },
      { name: "Solo Guy" },
      { name: "Bob Allen" },
      { name: "..." },
    ];

    const batch = await t.query(internal.players.resolveNamesForReview, {
      sportId,
      cardYear: 1990,
      names,
    });

    const singles = [];
    for (const n of names) {
      singles.push(
        await t.query(internal.players.resolveNameForReview, {
          name: n.name,
          sportId,
          cardYear: 1990,
          ...(n.cardTeamNames ? { cardTeamNames: n.cardTeamNames } : {}),
        }),
      );
    }
    expect(batch).toEqual(singles);
    // And the fixture is not trivially all-empty: the answers differ by name.
    expect(batch[0]).toEqual({ matchCount: 0 });
    expect(batch[1]).toMatchObject({ matchCount: 2, playerId: cubAllen, narrowedByCardYear: true });
    expect(batch[2]).toEqual({ matchCount: 1, playerId: solo });
    expect(batch[3]).toMatchObject({ matchCount: 2 });
    expect(batch[3].playerId).toBeUndefined();
    expect(batch[4]).toEqual({ matchCount: 0 });
  });

  test("the card teams belong to their own name: the same name twice answers differently", async () => {
    const t = convexTest(schema, modules);
    const { sportId, cubAllen } = await seed(t);
    const [withTeam, withoutTeam] = await t.query(internal.players.resolveNamesForReview, {
      sportId,
      cardYear: 1990,
      names: [{ name: "Bob Allen", cardTeamNames: ["Chicago Cubs"] }, { name: "Bob Allen" }],
    });
    expect(withTeam.playerId).toBe(cubAllen);
    expect(withoutTeam.playerId).toBeUndefined();
  });

  test("without a card year nothing is narrowed", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seed(t);
    const [only] = await t.query(internal.players.resolveNamesForReview, {
      sportId,
      names: [{ name: "Bob Allen", cardTeamNames: ["Chicago Cubs"] }],
    });
    expect(only.playerId).toBeUndefined();
    expect(only.narrowedByCardYear).toBeUndefined();
  });

  test("an empty list answers an empty list", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seed(t);
    expect(await t.query(internal.players.resolveNamesForReview, { sportId, names: [] })).toEqual([]);
  });

  test("accepts exactly 25 names and refuses 26, never truncating", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seed(t);
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Stranger ${i}` }));

    const ok = await t.query(internal.players.resolveNamesForReview, { sportId, names: make(25) });
    expect(ok).toHaveLength(25);

    await expect(
      t.query(internal.players.resolveNamesForReview, { sportId, names: make(26) }),
    ).rejects.toThrow(/too_many_names|at most 25/);
  });
});
