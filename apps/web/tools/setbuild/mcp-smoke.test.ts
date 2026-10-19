/**
 * NEO-339 §7.2 — the mcp-smoke sequence, driven over an in-memory MCP pair
 * against a fake service (the CI job runs the same sequence over stdio
 * against the PR preview).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseTarget } from "./client/target";
import { registerTools } from "./mcp-tools";
import { inspectMismatches, runSmokeSequence, smokeExpectSchema, variationParentProblems, type SmokeExpect, type VariationCheckCard } from "./mcp-smoke";
import { specConfirmPhrase, type InspectReport, type InspectRow, type OpenDecisions, type SetBuildService } from "./service";
import { parseSpec } from "./spec/schema";
import { APP, CHAIN, knownResolver, linkAt, SET_LINK, SET_LINK_ABS } from "./link-checks.fixture";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const SCOPE = "Baseball/2024/Topps/Topps Chrome";
const SMOKE_SPEC = { version: 1, scope: SCOPE, steps: [] };
/** What `setbuild confirm-phrase` prints for the smoke spec, and what CI passes as --confirm. */
const PHRASE = specConfirmPhrase(TARGET, parseSpec(SMOKE_SPEC));
const CHROME = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const BIG_LEAGUE = { ...CHROME, set: "Big League" };

/** A row of the fixture world: the Base type row (five ids deep). */
const ROW_LINK = linkAt(5);

const linked = { buysportscards: ["bsc-1"], sportlots: ["sl-1"] };
const unlinked = { buysportscards: [], sportlots: [] };
const row = (name: string, cards: number, extra: Partial<InspectRow> = {}): InspectRow => ({
  name,
  cards,
  isBase: false,
  links: linked,
  link: ROW_LINK,
  ...extra,
});

function chrome(builtCards: number): InspectReport {
  const base = row("Base", 335, { isBase: true });
  return {
    target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
    path: CHROME,
    pathText: SCOPE,
    found: true,
    link: SET_LINK,
    base,
    variantTypes: [
      { type: "Base", link: ROW_LINK, rows: [base] },
      { type: "Insert", link: ROW_LINK, rows: [row("Future Stars", 20)] },
      {
        type: "Parallel",
        link: ROW_LINK,
        rows: Array.from({ length: 41 }, (_, i) =>
          i === 40 ? row("Seed Built Refractors", builtCards) : row(`Parallel ${i}`, 0),
        ),
      },
    ],
  };
}

const bigLeague: InspectReport = {
  target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
  path: BIG_LEAGUE,
  pathText: "Baseball/2024/Topps/Big League",
  found: true,
  link: SET_LINK,
  base: row("Base", 0, { isBase: true }),
  variantTypes: [{ type: "Base", link: ROW_LINK, rows: [row("Base", 0, { isBase: true })] }],
};

function none(): OpenDecisions {
  return { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [], grouping: [] };
}

const EXPECT: SmokeExpect = smokeExpectSchema.parse({
  before: [
    {
      path: CHROME,
      base: { cards: 335 },
      rows: [{ type: "Insert", name: "Future Stars", cards: 20 }],
      rowCounts: [{ type: "Parallel", count: 41 }],
    },
    { path: { ...BIG_LEAGUE, year: 2024 }, base: { cards: 0, mapped: true } },
  ],
  apply: { counts: { built: 300 } },
  after: [{ path: CHROME, rows: [{ type: "Parallel", name: "Seed Built Refractors", cards: 300 }] }],
  variationParents: [{ path: CHROME, cardNumber: "122", slOnlyVariations: 1 }],
});

const ATTENTION = {
  pathText: SCOPE,
  totals: { cards: 1, byKind: { missingTeam: 1 }, awaitingTeamLookup: 0, namesToCheck: 2, slSetsToSort: 0, autographRows: 0 },
  summary: "1 card needs you on Topps Chrome; 2 names to check.",
  cards: [{ cardNumber: "1" }],
  autographs: [],
  names: [{ sides: [{ side: "bsc", label: "Chrome", foldEqual: false }, { side: "sportlots", label: "Chrome!", foldEqual: false }] }],
  notices: [],
};

function fakeService(
  o: {
    open?: OpenDecisions;
    built?: number;
    attention?: unknown;
    noAttentionLine?: boolean;
    setLinks?: Array<{ path: string; link: string }>;
    inspect?: (p: { set?: string }, applied: boolean) => InspectReport;
  } = {},
) {
  let applied = false;
  const service = {
    target: TARGET,
    read: {
      inspect: vi.fn(async (p: { set?: string }) => (o.inspect ? o.inspect(p, applied) : p.set === "Big League" ? bigLeague : chrome(applied ? 300 : 0))),
      plan: vi.fn(async () => ({ scope: SCOPE, confirmPhrase: PHRASE, steps: [{}], openDecisions: o.open ?? none() })),
      reviewItems: vi.fn(),
      attention: vi.fn(async () => o.attention ?? ATTENTION),
    },
    write: {
      apply: vi.fn(async () => {
        applied = true;
        return {
          counts: { built: o.built ?? 300, committed: 0, skipped: 3 },
          durationMs: 4200,
          setLinks: o.setLinks ?? [{ path: SCOPE, link: SET_LINK }],
          ...(o.noAttentionLine ? {} : { attentionLine: "Built and all clear." }),
        };
      }),
      decide: vi.fn(),
      buildParallel: vi.fn(),
      slReviewApply: vi.fn(),
      fix: vi.fn(),
    },
  };
  return service;
}

/** #122 as the seeded Chrome holds it: one plain card (BSC + SL), its BSC-only 122b, SportLots' bare VAR hanging off the plain one. */
const CARDS_122: VariationCheckCard[] = [
  { _id: "c122", cardNumber: "122", platformData: { bsc: {}, sportlots: {} } },
  { _id: "c122b", cardNumber: "122b", variationOfCardId: "c122", platformData: { bsc: {} } },
  { _id: "c122var", cardNumber: "122", variationOfCardId: "c122", platformData: { sportlots: {} } },
  { _id: "c123", cardNumber: "123", platformData: { bsc: {}, sportlots: {} } },
];

/** What the command injects: the page's resolver and the card read, here over the fixture world. */
const WORLD = {
  resolveDrill: knownResolver(),
  readCards: async () => CARDS_122,
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function connect(service: unknown, spec: unknown = SMOKE_SPEC) {
  const server = new McpServer({ name: "nb-setbuild", version: "0.0.0" });
  registerTools(server, service as SetBuildService, {
    secrets: [],
    cwd: "/",
    readSpecFile: async () => JSON.stringify(spec),
    resolveSpecPath: async (p) => p,
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(c);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("runSmokeSequence", () => {
  test("passes the whole sequence and applies once with the plan's phrase", async () => {
    const service = fakeService();
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual([
      "tools/list",
      `before nb_inspect ${SCOPE}`,
      "before nb_inspect Baseball/2024/Topps/Big League",
      "nb_plan",
      "nb_apply",
      `after nb_inspect ${SCOPE}`,
      `variation parent ${SCOPE} #122`,
      `nb_attention ${SCOPE}`,
    ]);
    expect(service.write.apply).toHaveBeenCalledTimes(1);
    expect(service.write.apply.mock.calls[0]).toContain(PHRASE);
    // Listing only: the seed's sets have many readers.
    expect(service.write.fix).not.toHaveBeenCalled();
    expect(checks.at(-1)!.detail).toBe(ATTENTION.summary);
  });

  test("nb_attention: totals that disagree with the lists fail; an apply with no attentionLine fails", async () => {
    const lying = { ...ATTENTION, totals: { ...ATTENTION.totals, namesToCheck: 5 } };
    const checks = await runSmokeSequence(await connect(fakeService({ attention: lying })), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(checks.at(-1)).toMatchObject({ ok: false, label: `nb_attention ${SCOPE}` });
    expect(checks.at(-1)!.detail).toMatch(/2 name sides listed, totals.namesToCheck says 5/);

    // NEO-345: the autograph rows must agree with their count too.
    const autographLie = { ...ATTENTION, totals: { ...ATTENTION.totals, autographRows: 1 } };
    const au = await runSmokeSequence(await connect(fakeService({ attention: autographLie })), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(au.at(-1)!.detail).toMatch(/0 autograph rows listed, totals.autographRows says 1/);

    const quiet = await runSmokeSequence(await connect(fakeService({ noAttentionLine: true })), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(quiet.find((c) => c.label === "nb_apply")).toMatchObject({ ok: false, detail: "the report has no attentionLine" });
  });

  test("stops before applying when --confirm is not the plan's phrase", async () => {
    const service = fakeService();
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE.replace(TARGET.host, "prod-thing.convex.cloud"),
      ...WORLD,
    });
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_plan" });
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("a phrase computed for another spec (same host and scope, other content) stops before applying", async () => {
    const service = fakeService();
    const edited = specConfirmPhrase(
      TARGET,
      parseSpec({
        version: 1,
        scope: SCOPE,
        steps: [{ kind: "brand-year", path: { sport: "Baseball", year: "2025", manufacturer: "Bowman" }, syncSets: true }],
      }),
    );
    expect(edited).not.toBe(PHRASE);
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: edited,
      ...WORLD,
    });
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_plan" });
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("stops before applying when the plan has open decisions", async () => {
    const open = none();
    open.review.players.push({ at: "steps[0]", row: null, name: "J.T. Realmuto", reason: "unanswered", candidates: [] });
    const service = fakeService({ open });
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_plan" });
    expect(checks.at(-1)!.detail).toMatch(/1 open decision, expected 0/);
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("fails on a count mismatch and does not run the after checks", async () => {
    const service = fakeService({ built: 299 });
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(checks.at(-1)).toMatchObject({ ok: false, label: "nb_apply" });
    expect(checks.at(-1)!.detail).toMatch(/counts\.built is 299, expected 300/);
  });

  test("a tool error is a failed check carrying the tool's message", async () => {
    const service = fakeService();
    service.read.inspect.mockRejectedValueOnce(new Error("Convex is down"));
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: { ...EXPECT, before: [EXPECT.before[0]] },
      confirm: PHRASE,
      ...WORLD,
      ...WORLD,
    });
    expect(checks[1]).toMatchObject({ ok: false });
    expect(checks[1].detail).toMatch(/Convex is down/);
  });
});

describe("runSmokeSequence — live link and variation assertions", () => {
  const go = async (service: ReturnType<typeof fakeService>, extra: Record<string, unknown> = {}) =>
    runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE,
      ...WORLD,
      ...extra,
    });
  const by = (checks: Awaited<ReturnType<typeof go>>, label: string) => checks.find((c) => c.label === label)!;

  test("the attentionLine is required even when the report carries no setLinks; so are the links", async () => {
    const checks = await go(fakeService({ noAttentionLine: true, setLinks: [] }));
    const apply = by(checks, "nb_apply");
    expect(apply.ok).toBe(false);
    expect(apply.detail).toContain("the report has no attentionLine");
    expect(apply.detail).toContain("the report has no setLinks");
  });

  test("a set link that is the bare Set Builder root fails nb_apply", async () => {
    const checks = await go(fakeService({ setLinks: [{ path: SCOPE, link: "/admin/set-builder" }] }));
    expect(by(checks, "nb_apply")).toMatchObject({ ok: false, detail: expect.stringContaining("opens the Set Builder at its root") });
  });

  test("a set link whose ids the page's resolver does not open fails, saying how far it got", async () => {
    const stale = linkAt(4, undefined, ["sp1", "yr1", "gone", "set1"]);
    const checks = await go(fakeService({ setLinks: [{ path: SCOPE, link: stale }] }));
    expect(by(checks, "nb_apply").detail).toMatch(/answered 2 of 4 levels, so the link does not open the row/);
  });

  test("with an app origin, links must be absolute on it: relative inspect links and set links fail", async () => {
    const rel = await go(fakeService(), { appOrigin: APP });
    expect(by(rel, "nb_apply").ok).toBe(false);
    expect(by(rel, `before nb_inspect ${SCOPE}`).ok).toBe(false);
    expect(by(rel, `before nb_inspect ${SCOPE}`).detail).toMatch(/is not absolute/);
  });

  test("with an app origin, absolute links that open their rows pass", async () => {
    const abs = <T,>(r: T): T => JSON.parse(JSON.stringify(r).replaceAll("/admin/set-builder?", `${APP}/admin/set-builder?`)) as T;
    const checks = await go(
      fakeService({
        setLinks: [{ path: SCOPE, link: SET_LINK_ABS }],
        inspect: (p, applied) => abs(p.set === "Big League" ? bigLeague : chrome(applied ? 300 : 0)),
      }),
      { appOrigin: APP },
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  test("an inspect link of a row the resolver cannot open fails that inspect", async () => {
    const checks = await go(fakeService(), { resolveDrill: knownResolver(CHAIN.slice(0, 4)) });
    expect(by(checks, `before nb_inspect ${SCOPE}`).detail).toMatch(/answered 4 of 5 levels/);
  });

  test("#122: one plain card with SportLots' bare VAR hanging off it passes", async () => {
    const checks = await go(fakeService());
    expect(by(checks, `variation parent ${SCOPE} #122`)).toMatchObject({ ok: true });
  });

  test("#122: the SportLots VAR saved as a second plain #122 fails (the pre-fix state)", async () => {
    const regressed = CARDS_122.map((c) => (c._id === "c122var" ? { ...c, variationOfCardId: undefined } : c));
    const checks = await go(fakeService(), { readCards: async () => regressed });
    expect(by(checks, `variation parent ${SCOPE} #122`)).toMatchObject({ ok: false, detail: expect.stringContaining("2 plain cards numbered #122") });
  });

  test("#122: reads the Base row's cards by the id its link ends in", async () => {
    const readCards = vi.fn(async () => CARDS_122);
    await go(fakeService(), { readCards });
    expect(readCards).toHaveBeenCalledWith(CHAIN[4]);
  });
});

describe("variationParentProblems", () => {
  test("zero plain cards of the number fails", () => {
    expect(variationParentProblems([{ _id: "a", cardNumber: "9", variationOfCardId: "x" }], "122", 1)).toEqual([
      "0 plain cards numbered #122 (0 in all), expected exactly one",
    ]);
  });

  test("a SportLots-only card pointing at some other card fails", () => {
    const cards = CARDS_122.map((c) => (c._id === "c122var" ? { ...c, variationOfCardId: "c123" } : c));
    expect(variationParentProblems(cards, "122", 1)).toEqual(["1 SportLots-only #122 card(s) are not a variation of the plain #122"]);
  });

  test("a different count of SportLots-only variations fails", () => {
    expect(variationParentProblems(CARDS_122, "122", 2)).toEqual(["1 SportLots-only cards numbered #122, expected 2"]);
  });

  test("the BSC-only 122b is a different number and is not counted", () => {
    expect(variationParentProblems(CARDS_122, "122", 1)).toEqual([]);
  });
});

describe("inspectMismatches", () => {
  test("reports every difference", () => {
    const report = chrome(0);
    expect(
      inspectMismatches(report, {
        path: CHROME,
        base: { cards: 300, mapped: false, linked: { sportlots: false } },
        rows: [
          { type: "Insert", name: "Future Stars", cards: 21 },
          { type: "Insert", name: "Missing", cards: 1 },
        ],
        rowCounts: [{ type: "Parallel", count: 40 }],
      }),
    ).toEqual([
      "Base has 335 cards, expected 300",
      "Base is linked, expected unlinked",
      "Base has a sportlots link",
      "Insert › Future Stars has 20 cards, expected 21",
      "Insert › Missing: no such row",
      "Parallel has 41 rows, expected 40",
    ]);
  });

  test("two rows sharing a name are never resolved by position", () => {
    const report = chrome(0);
    report.variantTypes![1].rows.push(row("Future Stars", 20));
    expect(inspectMismatches(report, { path: CHROME, rows: [{ type: "Insert", name: "Future Stars", cards: 20 }] })).toEqual([
      "Insert › Future Stars: 2 rows share the name",
    ]);
  });

  test("an unlinked Base fails mapped: true", () => {
    const report = { ...bigLeague, base: row("Base", 0, { isBase: true, links: unlinked }) };
    expect(inspectMismatches(report, { path: BIG_LEAGUE, base: { mapped: true } })).toEqual([
      "Base is not linked to any marketplace",
    ]);
  });
});
