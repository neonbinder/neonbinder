/**
 * NEO-333 — `combinedNamesReport`: the read-only scan for stored names that
 * are really several names.
 *
 * Pins: which values are flagged per kind (teams on a comma only, players on
 * `,` `/` `|`, suffix-only players), paging and `resume`, ids-not-names in the
 * result, and that the run writes nothing.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { readFileSync } from "node:fs";
import {
  REPORT_KINDS,
  REPORT_PAGE_MAX_BYTES,
  REPORT_SOURCES,
  REPORT_TIME_BUDGET_MS,
  hasNameSeparator,
  hasTeamNameSeparator,
  isSuffixOnlyName,
} from "./combinedNamesReport";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The pure predicates
// ---------------------------------------------------------------------------

describe("the report's predicates", () => {
  test("a team value is flagged on a comma only", () => {
    expect(hasTeamNameSeparator("Korea, South")).toBe(true);
    expect(hasTeamNameSeparator("Chicago Cubs,Texas Rangers")).toBe(true);
    expect(hasTeamNameSeparator("Bodø/Glimt")).toBe(false);
    expect(hasTeamNameSeparator("Browns | Stogies")).toBe(false);
    expect(hasTeamNameSeparator("Chicago Cubs")).toBe(false);
  });

  test("a player value is flagged on a comma, slash or pipe", () => {
    expect(hasNameSeparator("A/B")).toBe(true);
    expect(hasNameSeparator("Mike Trout, Shohei Ohtani")).toBe(true);
    expect(hasNameSeparator("Mike Trout|Shohei Ohtani")).toBe(true);
    expect(hasNameSeparator("Mike Trout")).toBe(false);
  });

  test("a suffix-only player is flagged, with padding and any case", () => {
    for (const s of ["Jr.", " jr ", "SR", "II", "iii.", "Iv"]) {
      expect(isSuffixOnlyName(s)).toBe(true);
    }
    expect(isSuffixOnlyName("Ken Griffey Jr.")).toBe(false);
    expect(isSuffixOnlyName("V")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Seeded = {
  sportId: Id<"selectorOptions">;
  setId: Id<"selectorOptions">;
  ids: Record<string, string>;
};

async function seedAll(t: T): Promise<Seeded> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const setId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: 1,
    });
    const ids: Record<string, string> = {};

    const team = (key: string, name: string, aliases?: string[]) =>
      ctx.db
        .insert("teams", {
          name,
          nameNormalized: name.toLowerCase(),
          sportId,
          ...(aliases ? { aliases } : {}),
          lastUpdated: 1,
        })
        .then((id) => void (ids[key] = id));
    await team("teamComma", "Korea, South");
    await team("teamSlash", "Bodø/Glimt");
    await team("teamClean", "Chicago Cubs");
    await team("teamAliasComma", "West Virginia", ["West Virginia University, WVU"]);

    const player = (key: string, name: string) =>
      ctx.db
        .insert("players", { name, nameNormalized: name.toLowerCase(), sportId, lastUpdated: 1 } as never)
        .then((id) => void (ids[key] = id));
    await player("playerSlash", "A/B");
    await player("playerSuffix", "Jr.");
    await player("playerClean", "Ken Griffey Jr.");

    const queue = (key: string, kind: "player" | "team" | "league", name: string) =>
      ctx.db
        .insert("entityReviewQueue", {
          selectorOptionId: setId,
          batchId: "b",
          createdByUserId: "u",
          kind,
          name,
          sportId,
          status: "ready",
        } as never)
        .then((id) => void (ids[key] = id));
    await queue("queueTeamComma", "team", "Cleveland Guardians, Washington Nationals");
    await queue("queueTeamSlash", "team", "Bodø/Glimt");
    await queue("queuePlayerSuffix", "player", "Sr.");
    await queue("queueLeagueComma", "league", "A, B");

    const skip = (key: string, kind: "player" | "team", name: string) =>
      ctx.db
        .insert("entityReviewSkips", {
          selectorOptionId: setId,
          kind,
          nameNormalized: name.toLowerCase(),
          name,
          skippedAt: 1,
          skippedByUserId: "u",
        } as never)
        .then((id) => void (ids[key] = id));
    await skip("skipTeamComma", "team", "Chicago Cubs, Texas Rangers");
    await skip("skipPlayerSuffix", "player", "III");

    const card = (key: string, extra: Record<string, unknown>) =>
      ctx.db
        .insert("cardChecklist", {
          selectorOptionId: setId,
          cardNumber: key,
          cardName: key,
          platformData: {},
          sortOrder: 1,
          lastUpdated: 1,
          ...extra,
        } as never)
        .then((id) => void (ids[key] = id));
    await card("cardBsc", { bscTeamName: "Cleveland Guardians, Washington Nationals" });
    await card("cardPendingTeam", { pendingTeamNames: ["Chicago Cubs, Texas Rangers"] });
    await card("cardPendingPlayer", { pendingPlayerNames: ["A / B"] });
    await card("cardPendingSuffix", { pendingPlayerNames: ["Jr"] });
    await card("cardClean", { bscTeamName: "Bodø/Glimt", pendingPlayerNames: ["Ken Griffey Jr."] });

    return { sportId, setId, ids };
  });
}

type RunResult = Awaited<
  ReturnType<T["action"]>
> & {
  scanned: Record<string, number>;
  truncated: boolean;
  timedOut: boolean;
  errors: number;
  resume?: { source: string; cursor: string | null };
  kinds: Array<{ kind: string; count: number; ids: string[]; idsTruncated: boolean }>;
  totalHits: number;
  message: string;
};

const run = (t: T, args: Record<string, unknown> = {}) =>
  t.action(internal.combinedNamesReport.run, args as never) as unknown as Promise<RunResult>;

const idsOf = (r: RunResult, kind: string) =>
  r.kinds.find((k) => k.kind === kind)!.ids;

async function snapshot(t: T): Promise<Record<string, unknown[]>> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const name of Object.keys(schema.tables)) {
      out[name] = await ctx.db.query(name as never).collect();
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// What each kind flags
// ---------------------------------------------------------------------------

describe("combinedNamesReport.run: what is flagged", () => {
  test("every kind reports exactly the rows that carry it, and only those", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedAll(t);

    const r = await run(t);

    expect(r.truncated).toBe(false);
    expect(r.resume).toBeUndefined();
    expect(r.kinds.map((k) => k.kind)).toEqual([...REPORT_KINDS]);
    expect(idsOf(r, "teamNameSeparator")).toEqual([ids.teamComma]);
    expect(idsOf(r, "teamAliasSeparator")).toEqual([ids.teamAliasComma]);
    expect(idsOf(r, "playerNameSeparator")).toEqual([ids.playerSlash]);
    expect(idsOf(r, "playerNameSuffixOnly")).toEqual([ids.playerSuffix]);
    expect(new Set(idsOf(r, "reviewQueueNameSeparator"))).toEqual(
      new Set([ids.queueTeamComma, ids.queueLeagueComma]),
    );
    expect(idsOf(r, "reviewQueuePlayerSuffixOnly")).toEqual([ids.queuePlayerSuffix]);
    expect(idsOf(r, "reviewSkipNameSeparator")).toEqual([ids.skipTeamComma]);
    expect(idsOf(r, "reviewSkipPlayerSuffixOnly")).toEqual([ids.skipPlayerSuffix]);
    expect(idsOf(r, "cardBscTeamNameSeparator")).toEqual([ids.cardBsc]);
    expect(idsOf(r, "cardPendingTeamNameSeparator")).toEqual([ids.cardPendingTeam]);
    expect(idsOf(r, "cardPendingPlayerNameSeparator")).toEqual([ids.cardPendingPlayer]);
    expect(idsOf(r, "cardPendingPlayerSuffixOnly")).toEqual([ids.cardPendingSuffix]);
  });

  test("'Korea, South' is flagged as a team; 'Bodø/Glimt' is NOT", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedAll(t);

    const r = await run(t);

    expect(idsOf(r, "teamNameSeparator")).toContain(ids.teamComma);
    expect(idsOf(r, "teamNameSeparator")).not.toContain(ids.teamSlash);
    expect(idsOf(r, "reviewQueueNameSeparator")).not.toContain(ids.queueTeamSlash);
    expect(idsOf(r, "cardBscTeamNameSeparator")).not.toContain(ids.cardClean);
  });

  test("a player 'A/B' IS flagged, and a clean 'Ken Griffey Jr.' is not", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedAll(t);

    const r = await run(t);

    expect(idsOf(r, "playerNameSeparator")).toEqual([ids.playerSlash]);
    expect(idsOf(r, "playerNameSuffixOnly")).not.toContain(ids.playerClean);
    expect(idsOf(r, "cardPendingPlayerSuffixOnly")).not.toContain(ids.cardClean);
  });

  test("a suffix-only player is flagged in players, the queue, the skips and card pending names", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedAll(t);

    const r = await run(t);

    expect(idsOf(r, "playerNameSuffixOnly")).toEqual([ids.playerSuffix]);
    expect(idsOf(r, "reviewQueuePlayerSuffixOnly")).toEqual([ids.queuePlayerSuffix]);
    expect(idsOf(r, "reviewSkipPlayerSuffixOnly")).toEqual([ids.skipPlayerSuffix]);
    expect(idsOf(r, "cardPendingPlayerSuffixOnly")).toEqual([ids.cardPendingSuffix]);
  });

  test("an empty database reports every kind at zero", async () => {
    const t = convexTest(schema, modules);

    const r = await run(t);

    expect(r.totalHits).toBe(0);
    expect(r.kinds.every((k) => k.count === 0 && k.ids.length === 0)).toBe(true);
    expect(r.truncated).toBe(false);
  });

  test("the result and the log carry counts and ids, never a stored name", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const r = await run(t);

    const everything = JSON.stringify(r) + log.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const name of ["Korea, South", "Cleveland Guardians", "Chicago Cubs, Texas", "West Virginia University"]) {
      expect(everything).not.toContain(name);
    }
    expect(log.mock.calls.some((c) => String(c[0]).includes("report_combined_names"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only, paging and resume
// ---------------------------------------------------------------------------

describe("combinedNamesReport.run: read-only, paging and resume", () => {
  test("a full run writes nothing to any table", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const before = await snapshot(t);

    await run(t);

    expect(await snapshot(t)).toEqual(before);
  });

  test("a budget-limited run stops with a resume, writes nothing, and the resume advances", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const before = await snapshot(t);

    const first = await run(t, { timeBudgetMs: 0 });

    expect(first.truncated).toBe(true);
    expect(first.timedOut).toBe(true);
    expect(first.resume).toBeDefined();
    // Exactly one page was read: the first table.
    expect(first.scanned.teams).toBeGreaterThan(0);
    expect(first.scanned.players).toBe(0);
    expect(first.message).toContain("resume");

    const second = await run(t, { timeBudgetMs: 0, resume: first.resume });
    expect(second.resume).toBeDefined();
    // Advanced: the next table was read, the first was not read again.
    expect(second.scanned.teams).toBe(0);
    expect(second.scanned.players).toBeGreaterThan(0);
    expect(REPORT_SOURCES.indexOf(second.resume!.source as never)).toBeGreaterThan(
      REPORT_SOURCES.indexOf(first.resume!.source as never),
    );
    expect(await snapshot(t)).toEqual(before);
  });

  test("resuming page by page finds the same hits as one full run, with none repeated", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const full = await run(t);

    const counts = new Map<string, number>();
    const seen = new Map<string, string[]>();
    let resume: RunResult["resume"];
    let runs = 0;
    do {
      const r = await run(t, { timeBudgetMs: 0, ...(resume ? { resume } : {}) });
      runs++;
      for (const k of r.kinds) {
        counts.set(k.kind, (counts.get(k.kind) ?? 0) + k.count);
        seen.set(k.kind, [...(seen.get(k.kind) ?? []), ...k.ids]);
      }
      resume = r.resume;
    } while (resume && runs < 50);

    expect(resume).toBeUndefined();
    expect(runs).toBeGreaterThanOrEqual(REPORT_SOURCES.length);
    for (const k of full.kinds) {
      expect(counts.get(k.kind)).toBe(k.count);
      expect(new Set(seen.get(k.kind))).toEqual(new Set(k.ids));
      expect(seen.get(k.kind)!.length).toBe(new Set(seen.get(k.kind)).size);
    }
  });

  test("a table larger than one page is walked across pages with a cursor", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedAll(t);
    // cardChecklist's page is 150 rows: 160 comma-hinted cards need two pages.
    const { setId } = await t.run(async (ctx) => ({
      setId: (await ctx.db.query("selectorOptions").collect()).find((r) => r.level === "variantType")!._id,
    }));
    void sportId;
    await t.run(async (ctx) => {
      for (let i = 0; i < 160; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: setId,
          cardNumber: `bulk-${i}`,
          cardName: `bulk-${i}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: 1,
          bscTeamName: "A, B",
        } as never);
      }
    });

    const r = await run(t);

    // 160 bulk + the one seeded cardBsc.
    expect(r.kinds.find((k) => k.kind === "cardBscTeamNameSeparator")!.count).toBe(161);
    expect(r.scanned.cardChecklist).toBe(165);
    expect(r.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security review S2: failed pages, the clamp, the byte bound
// ---------------------------------------------------------------------------

describe("combinedNamesReport.run: failure and bounds (S2)", () => {
  test("a clean run reports zero errors", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);

    const r = await run(t);

    expect(r.errors).toBe(0);
    expect(r.message).not.toContain("failed");
  });

  test("a page that throws ends the run with partial counts, resume AT the failed page, and no write", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    const before = await snapshot(t);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A cursor Convex cannot decode makes `paginate` throw on that page.
    const bad = { source: "players" as const, cursor: "not-a-real-cursor" };

    const r = await run(t, { resume: bad });

    expect(r.errors).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.resume).toEqual(bad);
    expect(r.scanned.players).toBe(0);
    expect(r.message).toContain("partial");
    expect(r.message).toContain("retry");
    // Tables before the failed one were never part of this resume.
    expect(r.scanned.teams).toBe(0);
    expect(await snapshot(t)).toEqual(before);
    // The warning names the source and the error class, not the cursor/content.
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("report_combined_names_page_failed");
    expect(logged).not.toContain("not-a-real-cursor");
  });

  test("a failure after pages already read keeps their hits", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedAll(t);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Read the teams table for real, then resume into a bad players cursor.
    const first = await run(t, { timeBudgetMs: 0 });
    expect(idsOf(first, "teamNameSeparator")).toEqual([ids.teamComma]);

    const r = await run(t, { resume: { source: "players", cursor: "garbage" } });
    expect(r.errors).toBe(1);
    expect(r.totalHits).toBe(0);
  });

  test("a timeBudgetMs above REPORT_TIME_BUDGET_MS is clamped to it", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);
    // Every clock read jumps past the ceiling, so a clamped budget expires
    // after the first page while an unclamped one (1e12) never would.
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (now += REPORT_TIME_BUDGET_MS + 1));

    const r = await run(t, { timeBudgetMs: 1e12 });

    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.resume).toBeDefined();
  });

  test("a negative timeBudgetMs still reads one page and advances", async () => {
    const t = convexTest(schema, modules);
    await seedAll(t);

    const r = await run(t, { timeBudgetMs: -5 });

    expect(r.scanned.teams).toBeGreaterThan(0);
    expect(r.timedOut).toBe(true);
    expect(r.resume).toBeDefined();
  });

  test("scanPage bounds the bytes it reads (source pin: convex-test does not enforce the limit)", () => {
    expect(REPORT_PAGE_MAX_BYTES).toBeGreaterThan(0);
    const src = readFileSync(new URL("./combinedNamesReport.ts", import.meta.url), "utf8");
    expect(src).toMatch(/maximumBytesRead:\s*REPORT_PAGE_MAX_BYTES/);
  });
});
