/**
 * NEO-254 — franchises: the operator-made thread through a team's renames.
 *
 * ## What this file is defending
 *
 * A franchise is pure linkage. It carries a name and a sport, and its only
 * effect is that `teams.franchiseId` points at it. Three things about that are
 * worth pinning, because all three are silent when they break:
 *
 *  1. **One thread per name per sport.** The dedup key is `normalizeTeamName`'s
 *     — token-sorted — so "Titans Oilers" and "Oilers Titans" are one row. A
 *     writer that skipped the key would give a sport two threads for one
 *     franchise, with the teams split arbitrarily between them and no error.
 *  2. **A rename never touches the teams.** That indirection is the entire
 *     reason the table exists rather than a string on `teams`.
 *  3. **Cross-sport linkage is refused.** The `v.id("franchises")` validator
 *     proves the id is a franchise, not that it is a franchise in THIS team's
 *     sport, and a football franchise on a baseball team is a row the franchise
 *     view would render under the wrong sport with nothing saying so.
 *
 * The ordering test is here rather than as a pure unit test of
 * `orderFranchiseTeams` because the thing being asserted is what an operator
 * SEES on the franchise view, and that runs through the query.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "admin", role: "admin" };
const SIGNED_IN = { subject: "user" };

type T = ReturnType<typeof convexTest>;

async function seedSport(t: T, value = "Football"): Promise<Id<"selectorOptions">> {
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

async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: { location?: string; name: string; from?: number; to?: number },
): Promise<Id<"teams">> {
  const full = parts.location ? `${parts.location} ${parts.name}` : parts.name;
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      name: parts.name,
      ...(parts.location ? { location: parts.location } : {}),
      nameNormalized: normalizeTeamName(full),
      sportId,
      ...(parts.from !== undefined
        ? { yearsActive: { from: parts.from, ...(parts.to !== undefined ? { to: parts.to } : {}) } }
        : {}),
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

/**
 * The team's franchise slot, read back as `null` when it is unset.
 *
 * `t.run`'s return value crosses the Convex value boundary, where an absent
 * optional arrives as `null` rather than `undefined` — so an assertion written
 * as `toBeUndefined()` fails for a reason that has nothing to do with the code
 * under test.
 */
async function franchiseOf(t: T, teamId: Id<"teams">) {
  return t.run(async (ctx) => (await ctx.db.get(teamId))?.franchiseId ?? null);
}

describe("franchises.findOrCreate", () => {
  test("creates once, then returns the same row for any spelling of the key", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    const first = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    expect(first.created).toBe(true);

    // Token-sorted key, and whitespace collapsed: the same thread.
    const second = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Oilers   Titans", sportId });
    expect(second).toEqual({ id: first.id, created: false });

    const rows = await t.run(async (ctx) => ctx.db.query("franchises").collect());
    expect(rows).toHaveLength(1);
    // The stored spelling is the FIRST operator's, never re-written by a later
    // caller passing the same name in a different order.
    expect(rows[0].name).toBe("Titans Oilers");
  });

  test("is admin-only", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(SIGNED_IN)
        .mutation(api.franchises.findOrCreate, { name: "Titans", sportId }),
    ).rejects.toThrow();
    expect(
      await t.run(async (ctx) => ctx.db.query("franchises").collect()),
    ).toHaveLength(0);
  });

  test("refuses a franchise hung off something that is not a sport row", async () => {
    const t = convexTest(schema, modules);
    const notASport = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "year",
        value: "1990",
        platformData: {},
        children: [],
        lastUpdated: 1,
      }),
    );

    await expect(
      t.withIdentity(ADMIN).mutation(api.franchises.findOrCreate, {
        name: "Titans",
        sportId: notASport,
      }),
    ).rejects.toThrow(/under a sport/);
  });

  test("refuses a name with nothing matchable in it", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.franchises.findOrCreate, { name: "—", sportId }),
    ).rejects.toThrow(/letter or digit/);
  });
});

describe("franchises.save", () => {
  test("renames the thread and leaves every team on it untouched", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { id } = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    const teamId = await seedTeam(t, sportId, {
      location: "Houston",
      name: "Oilers",
      from: 1960,
    });
    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: teamId,
      franchiseId: id,
    });

    await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.save, { id, name: "Tennessee Titans" });

    const franchise = await t.run(async (ctx) => ctx.db.get(id));
    expect(franchise?.name).toBe("Tennessee Titans");
    expect(franchise?.nameNormalized).toBe(normalizeTeamName("Tennessee Titans"));

    const team = await t.run(async (ctx) => ctx.db.get(teamId));
    expect(team?.name).toBe("Oilers");
    expect(team?.location).toBe("Houston");
    expect(team?.franchiseId).toBe(id);
  });

  test("refuses a rename onto another franchise in the same sport", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const a = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Ravens Browns", sportId });

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.franchises.save, { id: a.id, name: "Browns Ravens" }),
    ).rejects.toThrow(/already called/);

    const still = await t.run(async (ctx) => ctx.db.get(a.id));
    expect(still?.name).toBe("Titans Oilers");
  });

  test("the same name in the same sport is fine for a DIFFERENT sport", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");

    const a = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Cardinals", sportId: football });
    const b = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Cardinals", sportId: baseball });

    expect(a.id).not.toBe(b.id);
    expect(b.created).toBe(true);
  });
});

describe("franchises.get", () => {
  test("lists the thread's teams earliest first, with the undated ones last", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { id } = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });

    const titans = await seedTeam(t, sportId, {
      location: "Tennessee",
      name: "Titans",
      from: 1999,
    });
    const houston = await seedTeam(t, sportId, {
      location: "Houston",
      name: "Oilers",
      from: 1960,
      to: 1996,
    });
    const undated = await seedTeam(t, sportId, {
      location: "Tennessee",
      name: "Oilers",
    });

    for (const teamId of [titans, houston, undated]) {
      await t
        .withIdentity(ADMIN)
        .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: id });
    }

    const view = await t.withIdentity(ADMIN).query(api.franchises.get, { id });
    expect(view?.franchise.name).toBe("Titans Oilers");
    expect(view?.teams.map((team) => team._id)).toEqual([houston, titans, undated]);
    expect(view?.truncated).toBe(false);
  });

  test("a param that is not an id reads as 'no such franchise' rather than throwing", async () => {
    // The id arrives from `?franchise=` in the URL. A throw here would unmount
    // the whole screen into the error boundary.
    const t = convexTest(schema, modules);
    await seedSport(t);

    await expect(
      t.withIdentity(ADMIN).query(api.franchises.get, { id: "not-an-id" }),
    ).resolves.toBeNull();
  });
});

describe("franchises.list", () => {
  test("counts the teams on each thread and sorts by name", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const titans = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Ravens", sportId });

    const teamId = await seedTeam(t, sportId, { location: "Houston", name: "Oilers" });
    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: titans.id });

    const listed = await t
      .withIdentity(ADMIN)
      .query(api.franchises.list, { sportId, withTeamCounts: true });
    expect(listed.franchises.map((f) => [f.name, f.teamCount])).toEqual([
      ["Ravens", 0],
      ["Titans Oilers", 1],
    ]);
    expect(listed.truncated).toBe(false);
  });

  test("skips the team scan — and reports 0 — unless counts were asked for", () => {
    // Not a micro-optimisation: Team Management reads this list for NAMES on a
    // screen that re-renders on every keystroke, and the counts cost a scan of
    // every team in scope. Pinned so nobody makes the scan unconditional again
    // once `teams` is large.
    const src = readFileSync(join(__dirname, "franchises.ts"), "utf8");
    expect(src).toContain("const teamRows = !args.withTeamCounts");
  });

  test("returns nothing at all when signed out", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans", sportId });

    const listed = await t.query(api.franchises.list, {});
    expect(listed.franchises).toEqual([]);
    expect(listed.truncated).toBe(false);
  });
});

describe("teams.saveTeamFields — the franchise slot", () => {
  test("assigns and then clears the franchise", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { id } = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    const teamId = await seedTeam(t, sportId, { location: "Houston", name: "Oilers" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: id });
    expect(await franchiseOf(t, teamId)).toBe(id);

    // `null` is the "remove from franchise" control on the franchise view.
    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: null });
    expect(await franchiseOf(t, teamId)).toBeNull();
  });

  test("omitting the field leaves the franchise alone", async () => {
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const { id } = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId });
    const teamId = await seedTeam(t, sportId, { location: "Houston", name: "Oilers" });
    await t
      .withIdentity(ADMIN)
      .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: id });

    // A save that only touches the years must not detach the thread.
    await t.withIdentity(ADMIN).mutation(api.teams.saveTeamFields, {
      id: teamId,
      yearsActive: { from: 1960, to: 1996 },
    });
    expect(await franchiseOf(t, teamId)).toBe(id);
  });

  test("refuses a franchise from another sport", async () => {
    const t = convexTest(schema, modules);
    const football = await seedSport(t, "Football");
    const baseball = await seedSport(t, "Baseball");
    const { id } = await t
      .withIdentity(ADMIN)
      .mutation(api.franchises.findOrCreate, { name: "Titans Oilers", sportId: football });
    const teamId = await seedTeam(t, baseball, { location: "San Diego", name: "Padres" });

    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.teams.saveTeamFields, { id: teamId, franchiseId: id }),
    ).rejects.toThrow(/another sport/);
    expect(await franchiseOf(t, teamId)).toBeNull();
  });
});

/**
 * NEO-254 — the list window, and the bug it hid.
 *
 * `list` caps at 500. It used to `.take(501)` in TABLE order, so past the cap
 * the window held the OLDEST rows and a franchise created a second ago was
 * outside it — invisible to the screen that had just created it. Two CI flows
 * died on it once the load put 202 franchises per sport into the table.
 */
describe("franchises.list — which rows survive the cap", () => {
  const manyFranchises = async (t: T, sportId: Id<"selectorOptions">, n: number) => {
    const ids: Id<"franchises">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i += 1) {
        ids.push(
          await ctx.db.insert("franchises", {
            name: `Franchise ${String(i).padStart(4, "0")}`,
            nameNormalized: `franchise ${i}`,
            sportId,
            lastUpdated: 1,
          }),
        );
      }
    });
    return ids;
  };

  test("the GLOBAL listing keeps the newest rows, not the oldest", async () => {
    // The fix. An operator asks for this list right after creating a row, and
    // the row they just made is the one they are looking for.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ids = await manyFranchises(t, sportId, 505);
    const newest = ids[ids.length - 1];

    const listed = await t.withIdentity(ADMIN).query(api.franchises.list, {});
    expect(listed.truncated).toBe(true);
    expect(listed.franchises.map((f) => f._id)).toContain(newest);
    // …and the oldest are the ones that fall off, which is the inverse of the
    // behaviour that broke.
    expect(listed.franchises.map((f) => f._id)).not.toContain(ids[0]);
  });

  test("a SPORT-scoped listing fits inside the cap, so nothing falls off", async () => {
    // 202 franchises per sport is what the load produces; the cap is 500. The
    // scoped read is an indexed walk of that sport alone, so the window cannot
    // bite and insertion order is honest.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const other = await seedSport(t, "Baseball");
    await manyFranchises(t, other, 300);
    const ids = await manyFranchises(t, sportId, 202);

    const listed = await t
      .withIdentity(ADMIN)
      .query(api.franchises.list, { sportId });
    expect(listed.truncated).toBe(false);
    expect(listed.franchises).toHaveLength(202);
    expect(listed.franchises.map((f) => f._id)).toContain(ids[0]);
    expect(listed.franchises.map((f) => f._id)).toContain(ids[ids.length - 1]);
  });

  test("`get` reaches a row the list window does not hold", async () => {
    // The other half of the fix: the detail panel resolves by ID, so it opens
    // whatever `select(id)` names — including a row outside the list.
    const t = convexTest(schema, modules);
    const sportId = await seedSport(t);
    const ids = await manyFranchises(t, sportId, 505);

    const listed = await t.withIdentity(ADMIN).query(api.franchises.list, {});
    const missing = ids.find((id) => !listed.franchises.some((f) => f._id === id))!;
    expect(missing).toBeDefined();

    const view = await t
      .withIdentity(ADMIN)
      .query(api.franchises.get, { id: missing });
    expect(view?.franchise._id).toBe(missing);
  });
});
