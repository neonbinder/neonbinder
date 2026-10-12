/**
 * NEO-339 part B — the oneshot-smoke sequence over an in-memory MCP pair and a
 * fake service (CI runs it over stdio against the PR preview), and the
 * command's refusal of an unmeasured fixture.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { main, type CliIO } from "./cli";
import { parseTarget } from "./client/target";
import { registerTools } from "./mcp-tools";
import { differingPaths, NOT_MEASURED, oneshotExpectSchema, runOneshotSequence, type OneshotExpect } from "./mcp-oneshot";
import { specConfirmPhrase, type InspectReport, type OpenDecisions, type SetBuildService } from "./service";
import { parseSpec } from "./spec/schema";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const PATH = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome Black" };
const SCOPE = "Baseball/2024/Topps/Topps Chrome Black";

/** The committed spec: the draft's spec, its pending set a `leave` proposal. */
const ANSWERS = {
  version: 1,
  scope: SCOPE,
  steps: [
    {
      kind: "set",
      path: PATH,
      variantTypes: { sync: true },
      variants: [
        {
          type: "Insert",
          sync: { pairs: [{ name: "Future Stars", bsc: ["fs"] }], pending: [{ side: "sportlots", id: "sl-x", decision: "leave" }] },
        },
      ],
    },
  ],
};
/** The draft settles everything: no template, just the spec. */
const DRAFTED = structuredClone(ANSWERS);
const PHRASE = specConfirmPhrase(TARGET, parseSpec(ANSWERS));

function none(): OpenDecisions {
  return { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [], grouping: [] };
}
const ONE_OPEN: OpenDecisions = {
  ...none(),
  baseCandidates: [{ at: "steps[0].base.map.sportlots", path: SCOPE, side: "sportlots", candidates: [{ id: "a", name: "A" }, { id: "b", name: "A" }] }],
};

const built: InspectReport = {
  target: { convexUrl: TARGET.convexUrl, host: TARGET.host },
  path: PATH,
  pathText: SCOPE,
  found: true,
  base: { name: "Base", cards: 100, isBase: true, links: { buysportscards: ["b"], sportlots: ["s"] } },
  variantTypes: [
    {
      type: "Insert",
      rows: [
        {
          name: "Future Stars",
          cards: 10,
          isBase: false,
          links: { buysportscards: ["fs"], sportlots: [] },
          parallels: [{ name: "Future Stars Gold", cards: 10, isBase: false, links: { buysportscards: ["fsg"], sportlots: [] } }],
        },
      ],
    },
    { type: "Parallel", rows: [{ name: "Gold", cards: 100, isBase: false, links: { buysportscards: ["g"], sportlots: [] } }] },
  ],
};

const EXPECT: OneshotExpect = oneshotExpectSchema.parse({
  path: PATH,
  apply: { counts: { reconciled: 2, grouped: 1, committed: 110, built: 110 } },
});

function fakeService(o: { spec?: unknown; open?: OpenDecisions; counts?: Record<string, number> } = {}) {
  return {
    target: TARGET,
    read: {
      inspect: vi.fn(async () => built),
      plan: vi.fn(async () => ({ scope: SCOPE, confirmPhrase: PHRASE, steps: [{}], openDecisions: none() })),
      reviewItems: vi.fn(),
      draftSet: vi.fn(async () => ({
        status: "drafted",
        spec: o.spec ?? DRAFTED,
        template: null,
        openDecisions: o.open ?? none(),
        proposals: [],
        marketplaceCalls: 12,
        durationMs: 3000,
      })),
    },
    write: {
      apply: vi.fn(async () => ({ counts: o.counts ?? { reconciled: 2, grouped: 1, committed: 110, built: 110, skipped: 0 }, durationMs: 9000 })),
      decide: vi.fn(),
      buildParallel: vi.fn(),
      slReviewApply: vi.fn(),
    },
  };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function connect(service: unknown) {
  const server = new McpServer({ name: "nb-setbuild", version: "0.0.0" });
  registerTools(server, service as SetBuildService, {
    secrets: [],
    cwd: "/",
    readSpecFile: async () => JSON.stringify(ANSWERS),
    resolveSpecPath: async (p) => p,
  });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "oneshot-test", version: "0.0.0" });
  await client.connect(c);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const run = (service: ReturnType<typeof fakeService>, expect: OneshotExpect = EXPECT) =>
  connect(service).then((client) =>
    runOneshotSequence(client, { answersPath: "/oneshot.spec.json", answers: ANSWERS, expect, confirm: PHRASE }),
  );

describe("runOneshotSequence", () => {
  test("draft → merge → plan → apply (stopAt end) → inspect, all green", async () => {
    const service = fakeService();
    const checks = await run(service);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual([
      "tools/list",
      "nb_draft_set",
      "draft + answers",
      "nb_plan",
      "nb_apply",
      "insert with a built parallel",
      "Parallel rows built from Base",
    ]);
    expect(service.read.draftSet).toHaveBeenCalledWith(PATH, {});
    expect(service.write.apply).toHaveBeenCalledTimes(1);
    expect(service.write.apply.mock.calls[0]).toEqual([ANSWERS, PHRASE, { stopAt: "end" }]);
  });

  test("drift: a draft that no longer merges to the committed spec stops before any write, naming where", async () => {
    const drifted = structuredClone(DRAFTED);
    drifted.steps[0].variants[0].sync.pairs.push({ name: "New Insert", bsc: ["new"] });
    const service = fakeService({ spec: drifted });
    const checks = await run(service);
    const merge = checks.find((c) => c.label === "draft + answers")!;
    expect(merge.ok).toBe(false);
    expect(merge.detail).toMatch(/steps\[0\]\.variants\[0\]\.sync\.pairs\[1\]/);
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("any open decision in the draft fails, naming where, and nothing is applied", async () => {
    const service = fakeService({ open: ONE_OPEN });
    const checks = await run(service);
    const draft = checks.find((c) => c.label === "nb_draft_set")!;
    expect(draft.ok).toBe(false);
    expect(draft.detail).toContain("1 open decision(s) (Base sportlots at steps[0].base.map.sportlots), expected none");
    expect(service.write.apply).not.toHaveBeenCalled();
  });

  test("a count that differs fails the apply check", async () => {
    const checks = await run(fakeService({ counts: { reconciled: 2, grouped: 0, committed: 110, built: 110 } }));
    expect(checks.find((c) => c.label === "nb_apply")).toMatchObject({ ok: false, detail: "counts.grouped is 0, expected 1" });
  });

  test("differingPaths names leaf paths", () => {
    expect(differingPaths({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }], c: 1 })).toEqual(["a[1].b", "c"]);
  });
});

describe("setbuild oneshot-smoke (command)", () => {
  function io(): CliIO & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, env: {}, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  }

  test("an unmeasured fixture fails loudly, before anything connects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-oneshot-"));
    const spec = join(dir, "oneshot.spec.json");
    const exp = join(dir, "oneshot.expect.json");
    await writeFile(spec, JSON.stringify({ measured: false, note: "placeholder" }));
    await writeFile(exp, JSON.stringify({ measured: false, note: "placeholder" }));
    const a = io();
    expect(await main(["oneshot-smoke", "--answers", spec, "--expect", exp, "--confirm", PHRASE], a)).toBe(1);
    expect(a.err.join("\n")).toContain(NOT_MEASURED);

    // A real answers file with a placeholder expectations file fails the same way.
    await writeFile(spec, JSON.stringify(ANSWERS));
    const b = io();
    expect(await main(["oneshot-smoke", "--answers", spec, "--expect", exp, "--confirm", PHRASE], b)).toBe(1);
    expect(b.err.join("\n")).toContain(NOT_MEASURED);
  });
});
