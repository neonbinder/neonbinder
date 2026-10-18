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
import { inspectMismatches, runSmokeSequence, smokeExpectSchema, type SmokeExpect } from "./mcp-smoke";
import { specConfirmPhrase, type InspectReport, type InspectRow, type OpenDecisions, type SetBuildService } from "./service";
import { parseSpec } from "./spec/schema";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const SCOPE = "Baseball/2024/Topps/Topps Chrome";
const SMOKE_SPEC = { version: 1, scope: SCOPE, steps: [] };
/** What `setbuild confirm-phrase` prints for the smoke spec, and what CI passes as --confirm. */
const PHRASE = specConfirmPhrase(TARGET, parseSpec(SMOKE_SPEC));
const CHROME = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const BIG_LEAGUE = { ...CHROME, set: "Big League" };

const linked = { buysportscards: ["bsc-1"], sportlots: ["sl-1"] };
const unlinked = { buysportscards: [], sportlots: [] };
const row = (name: string, cards: number, extra: Partial<InspectRow> = {}): InspectRow => ({
  name,
  cards,
  isBase: false,
  links: linked,
  link: "/admin/set-builder",
  ...extra,
});

function chrome(builtCards: number): InspectReport {
  const base = row("Base", 335, { isBase: true });
  return {
    target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
    path: CHROME,
    pathText: SCOPE,
    found: true,
    base,
    variantTypes: [
      { type: "Base", link: "/admin/set-builder", rows: [base] },
      { type: "Insert", link: "/admin/set-builder", rows: [row("Future Stars", 20)] },
      {
        type: "Parallel",
        link: "/admin/set-builder",
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
  base: row("Base", 0, { isBase: true }),
  variantTypes: [{ type: "Base", link: "/admin/set-builder", rows: [row("Base", 0, { isBase: true })] }],
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
});

function fakeService(o: { open?: OpenDecisions; built?: number } = {}) {
  let applied = false;
  const service = {
    target: TARGET,
    read: {
      inspect: vi.fn(async (p: { set?: string }) => (p.set === "Big League" ? bigLeague : chrome(applied ? 300 : 0))),
      plan: vi.fn(async () => ({ scope: SCOPE, confirmPhrase: PHRASE, steps: [{}], openDecisions: o.open ?? none() })),
      reviewItems: vi.fn(),
    },
    write: {
      apply: vi.fn(async () => {
        applied = true;
        return { counts: { built: o.built ?? 300, committed: 0, skipped: 3 }, durationMs: 4200 };
      }),
      decide: vi.fn(),
      buildParallel: vi.fn(),
      slReviewApply: vi.fn(),
    },
  };
  return service;
}

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
    });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual([
      "tools/list",
      `before nb_inspect ${SCOPE}`,
      "before nb_inspect Baseball/2024/Topps/Big League",
      "nb_plan",
      "nb_apply",
      `after nb_inspect ${SCOPE}`,
    ]);
    expect(service.write.apply).toHaveBeenCalledTimes(1);
    expect(service.write.apply.mock.calls[0]).toContain(PHRASE);
  });

  test("stops before applying when --confirm is not the plan's phrase", async () => {
    const service = fakeService();
    const checks = await runSmokeSequence(await connect(service), {
      specPath: "/seed/parallel.spec.json",
      expect: EXPECT,
      confirm: PHRASE.replace(TARGET.host, "prod-thing.convex.cloud"),
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
    });
    expect(checks[1]).toMatchObject({ ok: false });
    expect(checks[1].detail).toMatch(/Convex is down/);
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
