/**
 * NEO-296 — the bound on `teams.getManyByIds` / `players.getManyByIds`.
 *
 * Both were `v.array(v.id(...))` with no server-side cap and one `ctx.db.get`
 * per ELEMENT, duplicates included, so one execution cost exactly the length of
 * the array the caller happened to build. The entity-review wizard built one
 * entry per link-decided review row, which put a 754-row batch at ~754 system
 * ops inside a live `useQuery` subscription — and a failing QUERY blanks the
 * screen rather than refusing a click.
 *
 * The two halves of the fix, and what each case here pins:
 *
 *   1. Distinct ids only, so a duplicate-heavy list costs what a deduped one
 *      costs. Ops are not observable from `convex-test`, so the proxy is the
 *      ANSWER: a list of N copies returns exactly what the one-entry list
 *      returns.
 *   2. At most `GET_MANY_BY_IDS_MAX` distinct ids, TRUNCATED to the first that
 *      many in input order rather than refused — see `lib/batchIdReads.ts` for
 *      why this one truncates where `teams.resolveNames` throws.
 *
 * Fixtures are raw `ctx.db.insert` rows, per the minimal-fixture convention in
 * `players.management.test.ts`: 513 teams through `findOrCreate` would be 513
 * mutations to observe one slice.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { teamRowFields } from "./lib/teamRow";
import { GET_MANY_BY_IDS_MAX } from "./lib/batchIdReads";
import { normalizePlayerName } from "./players";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const SIGNED_IN = {
  subject: "user_batch_reads_296",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_batch_reads_296",
};

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Baseball"): Promise<Id<"selectorOptions">> {
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

/** `count` teams, in insertion order, so a prefix is checkable. */
async function insertTeams(
  t: T,
  sportId: Id<"selectorOptions">,
  count: number,
): Promise<Array<Id<"teams">>> {
  return t.run(async (ctx) => {
    const ids: Array<Id<"teams">> = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await ctx.db.insert("teams", {
          ...teamRowFields({ name: `Team ${i}`, location: "Testville" }),
          sportId,
          lastUpdated: Date.now(),
        }),
      );
    }
    return ids;
  });
}

async function insertPlayers(
  t: T,
  sportId: Id<"selectorOptions">,
  count: number,
): Promise<Array<Id<"players">>> {
  return t.run(async (ctx) => {
    const ids: Array<Id<"players">> = [];
    for (let i = 0; i < count; i += 1) {
      const name = `Player ${i}`;
      ids.push(
        await ctx.db.insert("players", {
          name,
          nameNormalized: normalizePlayerName(name),
          sportId,
          lastUpdated: Date.now(),
        }),
      );
    }
    return ids;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NEO-296: teams.getManyByIds is deduped and bounded", () => {
  test("a duplicate-heavy list answers exactly what the deduped one answers", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const [teamId] = await insertTeams(t, sportId, 1);
    const asUser = t.withIdentity(SIGNED_IN);

    const once = await asUser.query(api.teams.getManyByIds, { ids: [teamId] });
    const threeHundred = await asUser.query(api.teams.getManyByIds, {
      ids: Array.from({ length: 300 }, () => teamId),
    });

    // One row, not 300 — and one `db.get`, which is the part that mattered.
    expect(threeHundred).toEqual(once);
    expect(threeHundred).toHaveLength(1);
  });

  test("answers the first GET_MANY_BY_IDS_MAX distinct ids and says so in the log", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ids = await insertTeams(t, sportId, GET_MANY_BY_IDS_MAX + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = await t
      .withIdentity(SIGNED_IN)
      .query(api.teams.getManyByIds, { ids });

    expect(rows).toHaveLength(GET_MANY_BY_IDS_MAX);
    // A prefix in INPUT order, so a caller that sorts its ids gets a stable
    // answer rather than an arbitrary one.
    expect(rows.map((row) => row._id)).toEqual(
      ids.slice(0, GET_MANY_BY_IDS_MAX),
    );
    // Truncated, not refused — but never silently: the counts reach the
    // function log, and never the ids themselves.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("teams.getManyByIds");
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      String(GET_MANY_BY_IDS_MAX + 1),
    );
  });

  test("a list inside the bound is untouched, and an id that resolves to nothing is still dropped", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ids = await insertTeams(t, sportId, 3);
    const asUser = t.withIdentity(SIGNED_IN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const gone = ids[1];
    await t.run(async (ctx) => ctx.db.delete(gone));

    const rows = await asUser.query(api.teams.getManyByIds, { ids });

    expect(rows.map((row) => row._id)).toEqual([ids[0], ids[2]]);
    // The orphaned link is a soft data error, as it always was — no warning,
    // because nothing was truncated.
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("NEO-296: players.getManyByIds is bounded the same way", () => {
  test("a duplicate-heavy list answers exactly what the deduped one answers", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const [playerId] = await insertPlayers(t, sportId, 1);
    const asUser = t.withIdentity(SIGNED_IN);

    const once = await asUser.query(api.players.getManyByIds, {
      ids: [playerId],
    });
    const threeHundred = await asUser.query(api.players.getManyByIds, {
      ids: Array.from({ length: 300 }, () => playerId),
    });

    expect(threeHundred).toEqual(once);
    expect(threeHundred).toHaveLength(1);
  });

  test("answers the first GET_MANY_BY_IDS_MAX distinct ids", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ids = await insertPlayers(t, sportId, GET_MANY_BY_IDS_MAX + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = await t
      .withIdentity(SIGNED_IN)
      .query(api.players.getManyByIds, { ids });

    expect(rows).toHaveLength(GET_MANY_BY_IDS_MAX);
    expect(rows.map((row) => row._id)).toEqual(
      ids.slice(0, GET_MANY_BY_IDS_MAX),
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain("players.getManyByIds");
  });
});
