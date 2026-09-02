/**
 * NEO-147: wiring tests for colour resolution against the cached
 * teamcolorcodes.com index (convex/teamColorSources.ts), plus the change to
 * `enrichTeam` that lets colours run when the other sources miss.
 *
 * Lives at the convex/ ROOT rather than beside the adapter for the reason
 * documented in convex/wikidataEnrichTeam.test.ts: convex-test's
 * `import.meta.glob(...)` registry breaks when invoked from inside
 * convex/adapters/, and everything here needs the real action harness. The
 * adapter's pure parsing/matching functions are tested separately, without a
 * Convex runtime, in convex/adapters/teamColorCodes.test.ts.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { normalizeTeamName } from "./teams";
import { MANUAL_COLOR_SOURCE_URL } from "./teamColorSources";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const COLOR_PAGE = `<html><body><article><div class="entry-content">
  <h2>Saitama Seibu Lions&#8217; Primary Colors</h2>
  <div class="colorblock" style="background-color: #ab0008; color: #fff;">Red</div>
  <div class="colorblock" style="background-color: #01214b; color: #fff;">Navy</div>
  <h2>Saitama Seibu Lions Pantone Color Codes</h2>
</div></article></body></html>`;

/**
 * NEO-156: there is no cached index any more, so a test must stand up the
 * whole live path — the sitemap index, the child listing the team, and the
 * team page itself. That is more setup than seeding a table row, and it is the
 * point: these cases now exercise what production actually does.
 */
const SITEMAP_INDEX_URL = "https://teamcolorcodes.com/wp-sitemap.xml";
const CHILD_URL = "https://teamcolorcodes.com/post-sitemap.xml";

function stubSite(opts: {
  /** Team page URLs the sitemap lists. */
  urls?: string[];
  /** Body served for a team page; null makes the page 404. */
  page?: string | null;
  /** Make the whole site unreachable. */
  down?: boolean;
}): ReturnType<typeof vi.fn> {
  const { urls = [], page = COLOR_PAGE, down = false } = opts;
  const mock = vi.fn(async (url: string) => {
    if (down) throw new Error("network down");
    const u = String(url);
    if (u === SITEMAP_INDEX_URL) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          `<sitemapindex><sitemap><loc>${CHILD_URL}</loc></sitemap></sitemapindex>`,
      } as unknown as Response;
    }
    if (u === CHILD_URL) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          `<urlset>${urls.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`,
      } as unknown as Response;
    }
    if (page === null) {
      return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => page } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** How many team PAGES (not sitemaps) a run fetched. */
const pageFetches = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u !== SITEMAP_INDEX_URL && u !== CHILD_URL);

async function seed(
  t: ReturnType<typeof convexTest>,
  teamName: string,
): Promise<Id<"teams">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    });
    return ctx.db.insert("teams", {
      name: teamName,
      nameNormalized: normalizeTeamName(teamName),
      sportId,
      lastUpdated: 1_700_000_000_000,
    });
  });
}

const getTeam = (t: ReturnType<typeof convexTest>, id: Id<"teams">) =>
  t.run(async (ctx) => ctx.db.get(id));

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveTeamColors — now a live search, no cached index
// ---------------------------------------------------------------------------

describe("resolveTeamColors", () => {
  test("a unique match writes colors and provenance", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"] });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("resolved");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toEqual({ primary: "#ab0008", secondary: "#01214b" });
    expect(team!.colorSource!.url).toBe("https://teamcolorcodes.com/saitama-seibu-lions-color-codes/");
    expect(team!.colorSource!.matchedName).toBe("saitama seibu lions");
  });

  test("matches through the sport suffix our college rows carry", async () => {
    // "UConn Huskies baseball" is a Set Builder artifact. The site has no such
    // name, but the suffix must not be what prevents the match.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "UConn Huskies baseball");
    stubSite({ urls: ["https://teamcolorcodes.com/uconn-huskies-colors/"] });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("resolved");
  });

  test("several matches park for a human and write NO colors", async () => {
    // The site carries 10+ distinct "Huskies". Picking one would silently
    // print a binder in another school's colors.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies");
    const fetchMock = stubSite({
      urls: [
        "https://teamcolorcodes.com/huskies-color-codes/",
        "https://teamcolorcodes.com/huskies-colors/",
      ],
    });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("ambiguous");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toBeUndefined();
    expect(team!.colorSource).toBeUndefined();
    expect(team!.colorCandidates).toHaveLength(2);
    // Ambiguity is decided from the sitemap alone — no team page is fetched.
    expect(pageFetches(fetchMock)).toEqual([]);
  });

  test("no match writes nothing and stays eligible for a retry", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Estrellas Orientales");
    stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"] });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("no-match");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toBeUndefined();
    expect(team!.colorSource).toBeUndefined();
  });

  test("a search that now finds nothing clears a stale ambiguity", async () => {
    // Leaving old candidates on screen after the operator asked again would
    // show them a choice that no longer exists.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Estrellas Orientales");
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorCandidates: [
          { name: "stale", url: "https://teamcolorcodes.com/stale-colors/" },
        ],
      });
    });
    stubSite({ urls: [] });

    await t.action(internal.teamColorSources.resolveTeamColors, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.colorCandidates).toBeUndefined();
  });

  test("an already-resolved team is skipped without touching the network", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorSource: {
          url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
          matchedName: "saitama seibu lions",
          resolvedAt: 1_700_000_000_000,
        },
      });
    });
    const fetchMock = stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"] });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("skipped");
    // Not one request — not even the sitemap. A live search is ~1.5MB, so
    // skipping has to happen before any fetch, not after.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("NEO-203: colors an operator hand-entered in Team Management carry manual provenance and survive resolveTeamColors", async () => {
    // Before NEO-203, `saveTeamFields` wrote `colors` alone. Hand-entered
    // colors then carried no `colorSource`, so they failed the "already
    // resolved" check above and were silently overwritten by the very next
    // background enrichment pass — which a checklist commit schedules for
    // every team it touches. `saveTeamFields` now stamps
    // `MANUAL_COLOR_SOURCE_URL` alongside the value for exactly this reason.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");

    await t
      .withIdentity({ subject: "admin", role: "admin" })
      .mutation(api.teams.saveTeamFields, {
        id: teamId,
        colors: { primary: "#112233", secondary: "#445566" },
      });

    const afterSave = await getTeam(t, teamId);
    expect(afterSave!.colorSource!.url).toBe(MANUAL_COLOR_SOURCE_URL);

    // A resync's background enrichment enqueues this with no `force` — same
    // call `resolveTeamColors` above proves is skipped for ANY colorSource.
    // This test pins the SPECIFIC path: a hand-entered value reaches that
    // same protection, not just a scraped one.
    const fetchMock = stubSite({
      urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"],
    });
    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    const team = await getTeam(t, teamId);
    expect(team!.colors).toEqual({ primary: "#112233", secondary: "#445566" });
    expect(team!.colorSource!.url).toBe(MANUAL_COLOR_SOURCE_URL);
  });

  test("force re-searches a team whose match was wrong", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorSource: {
          url: "https://teamcolorcodes.com/wrong-franchise-colors/",
          matchedName: "wrong franchise",
          resolvedAt: 1_700_000_000_000,
        },
      });
    });
    stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"] });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
      force: true,
    });

    expect(outcome).toBe("resolved");
    const team = await getTeam(t, teamId);
    expect(team!.colorSource!.url).toBe("https://teamcolorcodes.com/saitama-seibu-lions-color-codes/");
  });

  test("an unreadable page does NOT mark the team done", async () => {
    // Otherwise a transient failure would permanently exclude the team.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"], page: null });

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("unreadable");
    const team = await getTeam(t, teamId);
    expect(team!.colorSource).toBeUndefined();
  });

  test("an unreachable site is a no-match, not a crash", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    stubSite({ down: true });

    await expect(
      t.action(internal.teamColorSources.resolveTeamColors, { teamId }),
    ).resolves.toBe("no-match");
  });

  test("resolving clears a previously parked ambiguity", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions");
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorCandidates: [{ name: "old", url: "https://teamcolorcodes.com/old-colors/" }],
      });
    });
    stubSite({ urls: ["https://teamcolorcodes.com/saitama-seibu-lions-color-codes/"] });

    await t.action(internal.teamColorSources.resolveTeamColors, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.colorCandidates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// chooseColorSource — takes an index, never a URL
// ---------------------------------------------------------------------------

describe("chooseColorSource", () => {
  const HUSKIES_CANDIDATES = [
    { name: "connecticut huskies", url: "https://teamcolorcodes.com/connecticut-huskies-colors/" },
    { name: "washington huskies", url: "https://teamcolorcodes.com/washington-huskies-color-codes/" },
  ];

  async function seedAmbiguous(t: ReturnType<typeof convexTest>) {
    const teamId = await seed(t, "Huskies");
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, { colorCandidates: HUSKIES_CANDIDATES });
    });
    return teamId;
  }

  test("resolves the candidate at the given index", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seedAmbiguous(t);
    stubSite({ urls: [] });

    const outcome = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .action(api.teamColorSources.chooseColorSource, {
        teamId,
        candidateIndex: 1,
      });

    expect(outcome).toBe("resolved");
    const team = await getTeam(t, teamId);
    expect(team!.colorSource?.url).toBe(HUSKIES_CANDIDATES[1].url);
    // Provenance comes from the stored candidate, so a human resolution is
    // indistinguishable from an automatic one on the next backfill pass.
    expect(team!.colorSource?.matchedName).toBe("washington huskies");
    expect(team!.colorCandidates).toBeUndefined();
  });

  test("accepts no URL at all — the SSRF surface is gone by construction", async () => {
    // A Convex action's fetch runs inside Convex's network, so accepting a
    // caller-supplied URL here would let an admin session aim the backend at
    // an arbitrary host. The argument validator is the guarantee: passing a
    // URL is not a rejected request, it is not a representable one.
    const t = convexTest(schema, modules);
    const teamId = await seedAmbiguous(t);
    const fetchMock = stubSite({ urls: [] });

    await expect(
      t.withIdentity({ subject: "admin", role: "admin" }).action(
        api.teamColorSources.chooseColorSource,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed
        { teamId, url: "http://169.254.169.254/latest/meta-data/" } as any,
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses an index the server never offered", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seedAmbiguous(t);
    const fetchMock = stubSite({ urls: [] });

    await expect(
      t.withIdentity({ subject: "admin", role: "admin" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, candidateIndex: 7 },
      ),
    ).rejects.toThrow(/no such color source/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses when the team has no parked candidates", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies");
    const fetchMock = stubSite({ urls: [] });

    await expect(
      t.withIdentity({ subject: "admin", role: "admin" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, candidateIndex: 0 },
      ),
    ).rejects.toThrow(/no such color source/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seedAmbiguous(t);

    await expect(
      t.withIdentity({ subject: "someone", role: "user" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, candidateIndex: 0 },
      ),
    ).rejects.toThrow(/admin/i);
  });
});

// ---------------------------------------------------------------------------
// The admin worklist
// ---------------------------------------------------------------------------

describe("teams.listForManagement", () => {
  async function seedReviewFixture(t: ReturnType<typeof convexTest>) {
    await t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        platformData: {},
        children: [],
        lastUpdated: 1_700_000_000_000,
      });
      const base = { sportId, lastUpdated: 1_700_000_000_000 };
      await ctx.db.insert("teams", {
        ...base,
        name: "Resolved Team",
        nameNormalized: "resolved team",
        colors: { primary: "#ab0008" },
      });
      await ctx.db.insert("teams", {
        ...base,
        name: "Huskies",
        nameNormalized: "huskies",
        colorCandidates: [
          { name: "a huskies", url: "https://teamcolorcodes.com/a-colors/" },
          { name: "b huskies", url: "https://teamcolorcodes.com/b-colors/" },
        ],
      });
      await ctx.db.insert("teams", {
        ...base,
        name: "Estrellas Orientales",
        nameNormalized: "estrellas orientales",
      });
    });
  }

  test("returns every team, name-sorted, for the master list", async () => {
    // NEO-156 replaced NEO-147's two pre-computed buckets with the rows
    // themselves: the screen is master-detail over all teams and derives
    // "needs a pick" / "needs colors" from colorCandidates and colors.
    const t = convexTest(schema, modules);
    await seedReviewFixture(t);

    const result = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .query(api.teams.listForManagement, {});

    expect(result.teams.map((r) => r.name)).toEqual([
      "Estrellas Orientales",
      "Huskies",
      "Resolved Team",
    ]);
    expect(result.totalCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("carries the facts the screen derives its attention states from", async () => {
    const t = convexTest(schema, modules);
    await seedReviewFixture(t);

    const result = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .query(api.teams.listForManagement, {});

    const byName = new Map(result.teams.map((r) => [r.name, r]));
    // Needs a pick: several sources matched, so nothing was applied.
    expect(byName.get("Huskies")!.colorCandidates).toHaveLength(2);
    expect(byName.get("Huskies")!.colors).toBeUndefined();
    // Needs colors: no candidates and nothing resolved.
    expect(byName.get("Estrellas Orientales")!.colorCandidates).toBeUndefined();
    expect(byName.get("Estrellas Orientales")!.colors).toBeUndefined();
    // Done.
    expect(byName.get("Resolved Team")!.colors?.primary).toBe("#ab0008");
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity({ subject: "someone", role: "user" })
        .query(api.teams.listForManagement, {}),
    ).rejects.toThrow(/admin/i);
  });
});
