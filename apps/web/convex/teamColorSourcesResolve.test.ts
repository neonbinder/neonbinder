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

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const COLOR_PAGE = `<html><body><article><div class="entry-content">
  <h2>Saitama Seibu Lions&#8217; Primary Colors</h2>
  <div class="colorblock" style="background-color: #ab0008; color: #fff;">Red</div>
  <div class="colorblock" style="background-color: #01214b; color: #fff;">Navy</div>
  <h2>Saitama Seibu Lions Pantone Color Codes</h2>
</div></article></body></html>`;

function stubPageFetch(body: string | null): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    body === null
      ? ({ ok: false, status: 404, text: async () => "" } as unknown as Response)
      : ({ ok: true, status: 200, text: async () => body } as unknown as Response),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function seed(
  t: ReturnType<typeof convexTest>,
  teamName: string,
  sources: Array<{ name: string; nameKey: string; url: string }>,
): Promise<Id<"teams">> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    });
    for (const s of sources) {
      await ctx.db.insert("teamColorSources", { ...s, refreshedAt: 1_700_000_000_000 });
    }
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
// resolveTeamColors
// ---------------------------------------------------------------------------

describe("resolveTeamColors", () => {
  test("a unique match writes colors and provenance", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions", [
      {
        name: "saitama seibu lions",
        nameKey: "saitama seibu lions",
        url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
      },
    ]);
    stubPageFetch(COLOR_PAGE);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("resolved");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toEqual({ primary: "#ab0008", secondary: "#01214b" });
    expect(team!.colorSource!.url).toBe(
      "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
    );
    expect(team!.colorSource!.matchedName).toBe("saitama seibu lions");
  });

  test("matches through the sport suffix our college rows carry", async () => {
    // "UConn Huskies baseball" is a Set Builder artifact. The site has no such
    // name, but the suffix must not be what prevents the match.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "UConn Huskies baseball", [
      {
        name: "uconn huskies",
        nameKey: "uconn huskies",
        url: "https://teamcolorcodes.com/uconn-huskies-colors/",
      },
    ]);
    stubPageFetch(COLOR_PAGE);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("resolved");
  });

  test("several matches park for a human and write NO colors", async () => {
    // The site carries 10+ distinct "Huskies". Picking one would silently
    // print a binder in another school's colors.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies", [
      { name: "huskies", nameKey: "huskies", url: "https://teamcolorcodes.com/a-colors/" },
      { name: "huskies", nameKey: "huskies", url: "https://teamcolorcodes.com/b-colors/" },
    ]);
    const fetchMock = stubPageFetch(COLOR_PAGE);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("ambiguous");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toBeUndefined();
    expect(team!.colorSource).toBeUndefined();
    expect(team!.colorCandidates).toHaveLength(2);
    // Ambiguity is decided from the index alone — no page is fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("no match writes nothing and stays eligible for the next pass", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Estrellas Orientales", []);
    stubPageFetch(COLOR_PAGE);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("no-match");
    const team = await getTeam(t, teamId);
    expect(team!.colors).toBeUndefined();
    expect(team!.colorSource).toBeUndefined();
  });

  test("an already-resolved team is skipped without fetching", async () => {
    // This is what makes repeat backfill passes cheap.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions", [
      {
        name: "saitama seibu lions",
        nameKey: "saitama seibu lions",
        url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
      },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorSource: {
          url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
          matchedName: "saitama seibu lions",
          resolvedAt: 1_700_000_000_000,
        },
      });
    });
    const fetchMock = stubPageFetch(COLOR_PAGE);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an unreadable page does NOT mark the team done", async () => {
    // Otherwise a transient failure would permanently exclude the team from
    // every future backfill pass.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions", [
      {
        name: "saitama seibu lions",
        nameKey: "saitama seibu lions",
        url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
      },
    ]);
    stubPageFetch(null);

    const outcome = await t.action(internal.teamColorSources.resolveTeamColors, {
      teamId,
    });

    expect(outcome).toBe("unreadable");
    const team = await getTeam(t, teamId);
    expect(team!.colorSource).toBeUndefined();
  });

  test("resolving clears a previously parked ambiguity", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions", [
      {
        name: "saitama seibu lions",
        nameKey: "saitama seibu lions",
        url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
      },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorCandidates: [{ name: "old", url: "https://teamcolorcodes.com/old-colors/" }],
      });
    });
    stubPageFetch(COLOR_PAGE);

    await t.action(internal.teamColorSources.resolveTeamColors, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.colorCandidates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enrichTeam — the early-return removal
// ---------------------------------------------------------------------------

describe("enrichTeam colour fallthrough", () => {
  test("resolves colours even when the sport has no enrichment context", async () => {
    // The regression guard for NEO-147's core finding: enrichTeam used to
    // `return null` before colours whenever ESPN/Wikidata could not help, which
    // excluded every NPB, MiLB and Dominican winter league row — the exact
    // population with no colours. The seeded sport row here carries no
    // `sportConfig`, so `getSportEnrichmentContext` yields nothing.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Saitama Seibu Lions", [
      {
        name: "saitama seibu lions",
        nameKey: "saitama seibu lions",
        url: "https://teamcolorcodes.com/saitama-seibu-lions-color-codes/",
      },
    ]);
    stubPageFetch(COLOR_PAGE);

    await t.action(internal.adapters.wikidata.enrichTeam, { teamId });

    const team = await getTeam(t, teamId);
    expect(team!.colors).toEqual({ primary: "#ab0008", secondary: "#01214b" });
  });
});

// ---------------------------------------------------------------------------
// refreshIndex
// ---------------------------------------------------------------------------

describe("refreshIndex", () => {
  test("an unreachable site never empties an existing index", async () => {
    // A transient outage must not destroy every resolved match.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("teamColorSources", {
        name: "milwaukee brewers",
        nameKey: "milwaukee brewers",
        url: "https://teamcolorcodes.com/milwaukee-brewers-color-codes/",
        refreshedAt: 1_700_000_000_000,
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .action(api.teamColorSources.refreshIndex, {});

    // It reports having done nothing, rather than reporting a successful
    // refresh that happened to index zero pages.
    expect(result).toEqual({ indexed: 0, removed: 0 });
    const rows = await t.run(async (ctx) => ctx.db.query("teamColorSources").collect());
    expect(rows).toHaveLength(1);
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" } as unknown as Response)));

    await expect(
      t.withIdentity({ subject: "someone", role: "user" }).action(
        api.teamColorSources.refreshIndex,
        {},
      ),
    ).rejects.toThrow(/admin/i);
  });
});

// ---------------------------------------------------------------------------
// chooseColorSource — the client-supplied URL
// ---------------------------------------------------------------------------

describe("chooseColorSource", () => {
  test("applies a URL the server itself parked on the row", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies", []);
    const url = "https://teamcolorcodes.com/connecticut-huskies-colors/";
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorCandidates: [{ name: "connecticut huskies", url }],
      });
    });
    stubPageFetch(COLOR_PAGE);

    const outcome = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .action(api.teamColorSources.chooseColorSource, { teamId, url });

    expect(outcome).toBe("resolved");
    const team = await getTeam(t, teamId);
    expect(team!.colorSource?.url).toBe(url);
  });

  test("refuses a URL that is not a source this team was offered", async () => {
    // The whole SSRF surface: `url` is client-supplied and fetched from inside
    // Convex's network, so an admin session must not be able to steer it.
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies", []);
    await t.run(async (ctx) => {
      await ctx.db.patch(teamId, {
        colorCandidates: [
          { name: "a", url: "https://teamcolorcodes.com/a-colors/" },
        ],
      });
    });
    const fetchMock = stubPageFetch(COLOR_PAGE);

    await expect(
      t.withIdentity({ subject: "admin", role: "admin" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, url: "https://teamcolorcodes.com/not-offered-colors/" },
      ),
    ).rejects.toThrow(/not a known color source/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses an off-host URL outright", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies", []);
    const fetchMock = stubPageFetch(COLOR_PAGE);

    await expect(
      t.withIdentity({ subject: "admin", role: "admin" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, url: "http://169.254.169.254/latest/meta-data/" },
      ),
    ).rejects.toThrow(/unsupported color source/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    const teamId = await seed(t, "Huskies", []);

    await expect(
      t.withIdentity({ subject: "someone", role: "user" }).action(
        api.teamColorSources.chooseColorSource,
        { teamId, url: "https://teamcolorcodes.com/a-colors/" },
      ),
    ).rejects.toThrow(/admin/i);
  });
});

// ---------------------------------------------------------------------------
// The admin worklist
// ---------------------------------------------------------------------------

describe("teams.listColorReview", () => {
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

  test("splits the work into the two buckets a human handles differently", async () => {
    const t = convexTest(schema, modules);
    await seedReviewFixture(t);

    const review = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .query(api.teams.listColorReview, {});

    expect(review.ambiguous.map((r) => r.name)).toEqual(["Huskies"]);
    expect(review.missing.map((r) => r.name)).toEqual(["Estrellas Orientales"]);
    expect(review.resolvedCount).toBe(1);
    expect(review.totalCount).toBe(3);
  });

  test("does not list an ambiguous team as also missing", async () => {
    // It has no colors, but it needs a CHOICE, not manual entry — showing it
    // in both buckets would invite entering colors that the next pick erases.
    const t = convexTest(schema, modules);
    await seedReviewFixture(t);

    const review = await t
      .withIdentity({ subject: "admin", role: "admin" })
      .query(api.teams.listColorReview, {});

    expect(review.missing.map((r) => r.name)).not.toContain("Huskies");
  });

  test("requires admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity({ subject: "someone", role: "user" })
        .query(api.teams.listColorReview, {}),
    ).rejects.toThrow(/admin/i);
  });
});
