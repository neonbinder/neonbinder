/**
 * NEO-339 §7.1 — the MCP tools over a real McpServer + Client pair, linked
 * in memory, with a fake service whose every method is a spy.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fakeJwt } from "./auth/test-helpers";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfirmMismatch, parseTarget } from "./client/target";
import {
  containedSpecPath,
  READ_TOOLS,
  registerTools,
  REPO_ROOT,
  WRITE_TOOLS,
  type RegisterToolsOptions,
} from "./mcp-tools";
import {
  buildParallelConfirmPhrase,
  decideConfirmPhrase,
  ResolveError,
  slReviewConfirmPhrase,
  specConfirmPhrase,
  type OpenDecisions,
  type SetBuildService,
} from "./service";
import { parseSpec } from "./spec/schema";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const HOST = "happy-otter-123.convex.cloud";
const SECRET = "tes_SECRET_value_0123456789";
const JWT = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });

const TOPPS_CHROME = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const BOWMAN = { sport: "Baseball", year: "2025", manufacturer: "Bowman" };
const SPEC = { version: 1, scope: "e2e-baseline", steps: [] };

const DECIDE_ARGS = {
  row: { type: "Insert", name: "Future Stars" },
  players: [{ name: "Shohei Ohtani", decision: "create" as const }],
};
const SL_DECISIONS = [{ slId: "sl-123", placement: "own-set" as const }];

/** Each write's phrase, from the same helpers the server and the runner use. */
const PHRASE = {
  apply: specConfirmPhrase(TARGET, parseSpec(SPEC)),
  decide: decideConfirmPhrase(TARGET, TOPPS_CHROME, DECIDE_ARGS),
  buildParallel: buildParallelConfirmPhrase(TARGET, TOPPS_CHROME, "Gold Wave Refractors", {}),
  slReview: slReviewConfirmPhrase(TARGET, BOWMAN, SL_DECISIONS),
};

function noDecisions(): OpenDecisions {
  return {
    names: [],
    baseCandidates: [],
    reconcile: [],
    review: { players: [], teams: [], leagues: [] },
    slReview: [],
    conflicts: [],
    grouping: [],
  };
}

function fakeService() {
  const read = {
    inspect: vi.fn(async () => ({ found: true, pathText: "x" })),
    plan: vi.fn(async () => ({ confirmPhrase: PHRASE.apply, openDecisions: noDecisions(), steps: [] })),
    reviewItems: vi.fn(async () => ({ review: noDecisions().review, slReview: [] })),
    draftSet: vi.fn(async () => ({ status: "drafted", openCount: 0, confirmPhrase: null as string | null, openDecisions: noDecisions() })),
  };
  const write = {
    apply: vi.fn(async () => ({ counts: { built: 300, committed: 0, skipped: 0 } })),
    decide: vi.fn(async () => ({ applied: { players: 1, teams: 0, leagues: 0 } })),
    buildParallel: vi.fn(async () => ({ outcome: "built", cards: 300 })),
    slReviewApply: vi.fn(async () => ({ applied: 1, remaining: 0 })),
  };
  const spies = [...Object.values(read), ...Object.values(write)];
  const service = { read, write, target: TARGET } as unknown as SetBuildService;
  return { service, read, write, totalCalls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0) };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
  vi.unstubAllEnvs();
});

/** Fake spec paths in these tests are taken as real and allowed. */
const anyPath = async (p: string) => p;

async function connect(service: SetBuildService, opts: RegisterToolsOptions = { secrets: [SECRET] }) {
  const server = new McpServer({ name: "nb-setbuild-test", version: "0.0.0" });
  registerTools(server, service, { resolveSpecPath: anyPath, ...opts });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? "").join("");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

/** A valid call for each write tool, minus `confirm`, and the phrase it needs. */
const WRITE_CALLS: Record<(typeof WRITE_TOOLS)[number], { args: Record<string, unknown>; phrase: string; spy: string }> = {
  nb_apply: { args: { spec: SPEC }, phrase: PHRASE.apply, spy: "apply" },
  nb_decide: {
    args: { path: TOPPS_CHROME, ...DECIDE_ARGS },
    phrase: PHRASE.decide,
    spy: "decide",
  },
  nb_build_parallel: {
    args: { path: TOPPS_CHROME, name: "Gold Wave Refractors" },
    phrase: PHRASE.buildParallel,
    spy: "buildParallel",
  },
  nb_sl_review_apply: {
    args: { path: BOWMAN, decisions: SL_DECISIONS },
    phrase: PHRASE.slReview,
    spy: "slReviewApply",
  },
};

describe("tool list", () => {
  test("exactly eight tools: four read-only, four writes taking an optional confirm", async () => {
    const client = await connect(fakeService().service);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(tools).toHaveLength(8);
    expect([...READ_TOOLS]).toEqual(["nb_inspect", "nb_plan", "nb_review_items", "nb_draft_set"]);
    expect(WRITE_TOOLS as readonly string[]).not.toContain("nb_draft_set");
    for (const t of tools) {
      const isWrite = (WRITE_TOOLS as readonly string[]).includes(t.name);
      expect(t.annotations?.readOnlyHint, t.name).toBe(!isWrite);
      expect(t.description, t.name).toBeTruthy();
      const props = Object.keys(t.inputSchema.properties ?? {});
      if (isWrite) {
        expect(props, t.name).toContain("confirm");
        // Optional at the schema level so a missing phrase reaches the handler
        // and comes back naming the phrase, not as a bare validation error.
        expect(t.inputSchema.required ?? [], t.name).not.toContain("confirm");
        expect(t.description, t.name).toMatch(/^WRITES/);
      } else {
        expect(props, t.name).not.toContain("confirm");
        expect(t.description, t.name).toMatch(/^Read-only/);
      }
    }
  });

  test("descriptions teach the workflow: plan first, phrase from the plan, never guess", async () => {
    const client = await connect(fakeService().service);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.nb_plan).toMatch(/before nb_apply/);
    expect(byName.nb_plan).toMatch(/confirmPhrase/);
    expect(byName.nb_apply).toMatch(/confirmPhrase nb_plan returned/);
    expect(byName.nb_inspect).toMatch(/candidates/);
    expect(byName.nb_inspect).toMatch(/Never guess/);
  });
});

describe("read tools", () => {
  test("each calls its read method once and never touches a write", async () => {
    const f = fakeService();
    const client = await connect(f.service, {
      secrets: [SECRET],
      cwd: "/specs",
      readSpecFile: async () => JSON.stringify(SPEC),
    });

    expect((await callTool(client, "nb_inspect", { path: TOPPS_CHROME })).isError).toBe(false);
    expect(f.read.inspect).toHaveBeenCalledWith(TOPPS_CHROME);

    expect((await callTool(client, "nb_inspect", { path: { ...BOWMAN, year: 2025 } })).isError).toBe(false);
    expect(f.read.inspect).toHaveBeenLastCalledWith(BOWMAN);

    expect((await callTool(client, "nb_plan", { spec: SPEC })).isError).toBe(false);
    expect(f.read.plan).toHaveBeenCalledWith(SPEC);

    expect((await callTool(client, "nb_plan", { specPath: "seed/parallel.spec.json" })).isError).toBe(false);
    expect(f.read.plan).toHaveBeenCalledTimes(2);

    expect((await callTool(client, "nb_review_items", { path: TOPPS_CHROME })).isError).toBe(false);
    expect(f.read.reviewItems).toHaveBeenCalledWith(TOPPS_CHROME);

    for (const spy of Object.values(f.write)) expect(spy).not.toHaveBeenCalled();
  });

  test("nb_draft_set calls read.draftSet once with the path and options, and never a write", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    expect((await callTool(client, "nb_draft_set", { path: TOPPS_CHROME })).isError).toBe(false);
    expect(f.read.draftSet).toHaveBeenLastCalledWith(TOPPS_CHROME, {});
    await callTool(client, "nb_draft_set", { path: { ...TOPPS_CHROME, year: 2024 }, checklists: false, builds: true, teamLookupBudget: 0 });
    expect(f.read.draftSet).toHaveBeenLastCalledWith(TOPPS_CHROME, { checklists: false, builds: true, teamLookupBudget: 0 });
    expect(f.read.draftSet).toHaveBeenCalledTimes(2);
    // A brand-year path is not a set: refused by the schema, the service is not called.
    expect((await callTool(client, "nb_draft_set", { path: BOWMAN })).isError).toBe(true);
    // The budget is bounded.
    expect((await callTool(client, "nb_draft_set", { path: TOPPS_CHROME, teamLookupBudget: 10_000_000 })).isError).toBe(true);
    expect(f.read.draftSet).toHaveBeenCalledTimes(2);
    for (const spy of Object.values(f.write)) expect(spy).not.toHaveBeenCalled();
  });

  test("nb_draft_set is registered with the read half only: a write-only service cannot reach it", async () => {
    // registerTools hands the read tools `service.read` and nothing else; a
    // draft's result never reaches a write, whatever it returns.
    const f = fakeService();
    f.read.draftSet.mockResolvedValueOnce({ status: "drafted", openCount: 0, confirmPhrase: PHRASE.apply, openDecisions: noDecisions() });
    const client = await connect(f.service);
    const r = await callTool(client, "nb_draft_set", { path: TOPPS_CHROME });
    expect(r.json().confirmPhrase).toBe(PHRASE.apply);
    expect(f.write.apply).not.toHaveBeenCalled();
  });

  test("nb_draft_set returns a summary by default and every entry with detail full; the template is whole either way", async () => {
    const big = {
      status: "drafted",
      openCount: 1,
      confirmPhrase: null,
      openDecisions: noDecisions(),
      spec: { version: 1, scope: "x", steps: [] },
      template: { version: 1, scope: "x", steps: [], fill: "<answer>" },
      proposals: Array.from({ length: 200 }, (_, i) => ({ at: `steps[0].p${i}`, kind: "build", detail: "build" })),
      steps: [],
      notes: [],
      leftUnasked: [
        {
          at: "steps[0].variants[0].sync.pending",
          type: "Insert",
          outsideScope: 970,
          pairedElsewhere: 3,
          outsideScopeSets: Array.from({ length: 970 }, (_, i) => ({ id: `9${i}`, name: `Heritage ${i}` })),
        },
      ],
    };
    const f = fakeService();
    f.read.draftSet.mockResolvedValue(big as never);
    const client = await connect(f.service);
    const summary = await callTool(client, "nb_draft_set", { path: TOPPS_CHROME });
    const s = summary.json() as Record<string, any>;
    expect(s.proposals).toHaveLength(5);
    expect(s.summary).toMatchObject({ proposalCounts: { build: 200 }, omitted: { proposals: 195, outsideScopeSets: 965 }, specInTemplate: true });
    expect(s.summary.hint).toContain('detail "full"');
    expect(s.leftUnasked[0]).toMatchObject({ outsideScope: 970, pairedElsewhere: 3 });
    expect(s.leftUnasked[0].outsideScopeSets).toHaveLength(5);
    expect(s.template).toEqual(big.template);
    expect(s.spec).toBeUndefined();
    // One line of JSON: no indentation.
    expect(summary.text).not.toContain("\n");
    // The service is never told about `detail`: it always drafts in full.
    expect(f.read.draftSet).toHaveBeenLastCalledWith(TOPPS_CHROME, {});

    const full = (await callTool(client, "nb_draft_set", { path: TOPPS_CHROME, detail: "full" })).json() as Record<string, any>;
    expect(full.proposals).toHaveLength(200);
    expect(full.leftUnasked[0].outsideScopeSets).toHaveLength(970);
    expect(full.spec).toEqual(big.spec);
    expect(full.summary).toBeUndefined();
    expect(f.read.draftSet).toHaveBeenLastCalledWith(TOPPS_CHROME, {});
    expect((await callTool(client, "nb_draft_set", { path: TOPPS_CHROME, detail: "everything" })).isError).toBe(true);
  });

  test("a relative specPath resolves against the launch directory", async () => {
    const f = fakeService();
    const readSpecFile = vi.fn(async () => JSON.stringify(SPEC));
    const client = await connect(f.service, { secrets: [SECRET], cwd: "/repo/root", readSpecFile });
    await callTool(client, "nb_plan", { specPath: "apps/web/playwright/seed/parallel.spec.json" });
    expect(readSpecFile).toHaveBeenCalledWith("/repo/root/apps/web/playwright/seed/parallel.spec.json");
    await callTool(client, "nb_plan", { specPath: "/abs/parallel.spec.json" });
    expect(readSpecFile).toHaveBeenLastCalledWith("/abs/parallel.spec.json");
  });

  test("spec input errors: neither, both, not .json, bad JSON (contents never echoed)", async () => {
    const f = fakeService();
    const client = await connect(f.service, {
      secrets: [SECRET],
      cwd: "/specs",
      readSpecFile: async () => `{"scope": "private-looking-content", oops`,
    });
    const neither = await callTool(client, "nb_plan", {});
    expect(neither.isError).toBe(true);
    expect(neither.text).toMatch(/exactly one of spec/);
    const both = await callTool(client, "nb_plan", { spec: SPEC, specPath: "a.json" });
    expect(both.isError).toBe(true);
    const notJson = await callTool(client, "nb_plan", { specPath: "/etc/passwd" });
    expect(notJson.isError).toBe(true);
    expect(notJson.text).toMatch(/\.json file/);
    const bad = await callTool(client, "nb_plan", { specPath: "broken.json" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not valid JSON/);
    expect(bad.text).not.toContain("private-looking-content");
    expect(f.totalCalls()).toBe(0);
  });
});

describe("specPath containment (security audit item 10)", () => {
  async function tree() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "setbuild-specpath-")));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(join(root, "seed"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "seed", "ok.spec.json"), JSON.stringify(SPEC));
    await writeFile(join(outside, "secret.json"), JSON.stringify(SPEC));
    await symlink(join(outside, "secret.json"), join(root, "seed", "link.json"));
    return { root, outside };
  }

  test("a file under a root resolves to its real path; outside, via a symlink, or via .. is refused", async () => {
    const { root, outside } = await tree();
    await expect(containedSpecPath(join(root, "seed", "ok.spec.json"), [root])).resolves.toBe(
      join(root, "seed", "ok.spec.json"),
    );
    for (const p of [
      join(outside, "secret.json"),
      join(root, "seed", "link.json"),
      join(root, "seed", "..", "..", "outside", "secret.json"),
    ]) {
      const err = await containedSpecPath(p, [root]).catch((e: unknown) => e);
      expect(err, p).toBeInstanceOf(Error);
      expect((err as Error).message, p).toMatch(/outside the repository/);
      // The symlink's target is never named.
      if (p.endsWith("link.json")) expect((err as Error).message).not.toContain("secret.json");
    }
    await expect(containedSpecPath(join(root, "missing.json"), [root])).rejects.toThrow(/No spec file/);
    // No root at all (INIT_CWD unset) allows nothing.
    await expect(containedSpecPath(join(root, "seed", "ok.spec.json"), [undefined])).rejects.toThrow(/outside/);
  });

  test("the default resolver allows the repo root and INIT_CWD, and nothing else", async () => {
    const { root, outside } = await tree();
    vi.stubEnv("INIT_CWD", root);
    const f = fakeService();
    // No resolveSpecPath or readSpecFile override: the server's own defaults.
    const client = await connect(f.service, { secrets: [SECRET], cwd: root, resolveSpecPath: undefined });
    expect((await callTool(client, "nb_plan", { specPath: "seed/ok.spec.json" })).isError).toBe(false);
    const viaLink = await callTool(client, "nb_plan", { specPath: "seed/link.json" });
    expect(viaLink.isError).toBe(true);
    expect(viaLink.text).toMatch(/outside the repository/);
    const abs = await callTool(client, "nb_plan", { specPath: join(outside, "secret.json") });
    expect(abs.isError).toBe(true);
    expect(f.read.plan).toHaveBeenCalledTimes(1);
    // REPO_ROOT is the monorepo root: the app's own package.json sits under it.
    await expect(containedSpecPath(join(REPO_ROOT, "apps", "web", "package.json"), [REPO_ROOT])).resolves.toMatch(
      /apps[/\\]web[/\\]package\.json$/,
    );
  });
});

describe("write tools: the confirm phrase", () => {
  test.each(WRITE_TOOLS)("%s without confirm: isError naming the phrase, zero service calls", async (tool) => {
    const f = fakeService();
    const client = await connect(f.service);
    const { args, phrase } = WRITE_CALLS[tool];
    const r = await callTool(client, tool, args);
    expect(r.isError).toBe(true);
    expect(r.json()).toMatchObject({ error: "confirm_mismatch", expected: phrase });
    expect(r.text).toContain(phrase);
    expect(f.totalCalls()).toBe(0);
  });

  test.each(WRITE_TOOLS)("%s with a wrong phrase: isError naming the phrase, zero service calls", async (tool) => {
    const f = fakeService();
    const client = await connect(f.service);
    const { args, phrase } = WRITE_CALLS[tool];
    for (const wrong of [
      phrase.replace(HOST, "prod-deployment-1.convex.cloud"),
      phrase.toLowerCase(),
      `${phrase} `,
      `${phrase.slice(0, -8)}00000000`,
      phrase.slice(0, -9),
      "BUILD",
    ]) {
      const r = await callTool(client, tool, { ...args, confirm: wrong });
      expect(r.isError, wrong).toBe(true);
      expect(r.json(), wrong).toMatchObject({ error: "confirm_mismatch", expected: phrase });
    }
    expect(f.totalCalls()).toBe(0);
  });

  test.each(WRITE_TOOLS)("%s with the right phrase: exactly one call, to its own method", async (tool) => {
    const f = fakeService();
    const client = await connect(f.service);
    const { args, phrase, spy } = WRITE_CALLS[tool];
    const r = await callTool(client, tool, { ...args, confirm: phrase });
    expect(r.isError).toBe(false);
    expect(f.totalCalls()).toBe(1);
    const method = f.write[spy as keyof typeof f.write];
    expect(method).toHaveBeenCalledTimes(1);
    // The phrase is passed through so the service can check it again.
    expect(method.mock.calls[0]).toContain(phrase);
  });

  test("arguments reach the service as the contract types", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const decisions = {
      ...DECIDE_ARGS,
      teams: [{ name: "Seattle Mariners", decision: { link: "Seattle Mariners" }, league: "MLB" }],
    };
    const decidePhrase = decideConfirmPhrase(TARGET, TOPPS_CHROME, decisions);
    const decided = await callTool(client, "nb_decide", { path: TOPPS_CHROME, ...decisions, confirm: decidePhrase });
    expect(decided.isError, decided.text).toBe(false);
    expect(f.write.decide).toHaveBeenCalledWith(TOPPS_CHROME, { ...decisions, leagues: undefined }, decidePhrase);
    const rebuildPhrase = buildParallelConfirmPhrase(TARGET, TOPPS_CHROME, "Gold Wave Refractors", { rebuild: true });
    await callTool(client, "nb_build_parallel", {
      path: { ...TOPPS_CHROME, year: 2024 },
      name: "Gold Wave Refractors",
      rebuild: true,
      confirm: rebuildPhrase,
    });
    expect(f.write.buildParallel).toHaveBeenCalledWith(TOPPS_CHROME, "Gold Wave Refractors", { rebuild: true }, rebuildPhrase);
  });

  test("each phrase is bound to its call's content: other arguments need another phrase", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["nb_apply", { spec: { ...SPEC, steps: [{ kind: "brand-year", path: BOWMAN, syncSets: true }] } }, PHRASE.apply],
      ["nb_decide", { path: TOPPS_CHROME, ...DECIDE_ARGS, players: [{ name: "Shohei Ohtani", decision: "skip" }] }, PHRASE.decide],
      ["nb_build_parallel", { path: TOPPS_CHROME, name: "Gold Wave Refractors", rebuild: true }, PHRASE.buildParallel],
      ["nb_build_parallel", { path: TOPPS_CHROME, name: "Sepia Refractors" }, PHRASE.buildParallel],
      ["nb_sl_review_apply", { path: BOWMAN, decisions: [{ slId: "sl-124", placement: "own-set" }] }, PHRASE.slReview],
      // One write's phrase never confirms another write on the same scope.
      ["nb_build_parallel", { path: TOPPS_CHROME, name: "Gold Wave Refractors" }, PHRASE.decide],
    ];
    for (const [tool, args, stale] of cases) {
      const r = await callTool(client, tool, { ...args, confirm: stale });
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      const body = r.json();
      expect(body.error).toBe("confirm_mismatch");
      expect(body.expected).not.toBe(stale);
      expect(String(body.expected).slice(0, -8), "same host and scope, other digest").toBe(stale.slice(0, -8));
    }
    expect(f.totalCalls()).toBe(0);
  });

  test("key order in the spec is not content", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const r = await callTool(client, "nb_apply", { spec: { steps: [], scope: "e2e-baseline", version: 1 }, confirm: PHRASE.apply });
    expect(r.isError, r.text).toBe(false);
    expect(f.write.apply).toHaveBeenCalledTimes(1);
  });

  test("nb_apply on a spec with no scope is refused before the service", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const r = await callTool(client, "nb_apply", { spec: { version: 1, steps: [] }, confirm: PHRASE.apply });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no scope/);
    expect(f.totalCalls()).toBe(0);
  });

  test("a phrase for one scope does not unlock another", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const bigLeague = { ...TOPPS_CHROME, set: "Big League" };
    const r = await callTool(client, "nb_build_parallel", {
      path: bigLeague,
      name: "Gold Wave Refractors",
      confirm: PHRASE.buildParallel,
    });
    expect(r.isError).toBe(true);
    expect(r.json()).toMatchObject({
      expected: buildParallelConfirmPhrase(TARGET, bigLeague, "Gold Wave Refractors", {}),
    });
    expect(String(r.json().expected)).toMatch(new RegExp(`^BUILD ${HOST} Baseball/2024/Topps/Big League [0-9a-f]{8}$`));
    expect(f.totalCalls()).toBe(0);
  });

  test("the service's own ConfirmMismatch (second lock) maps the same way", async () => {
    const f = fakeService();
    f.write.apply.mockRejectedValueOnce(new ConfirmMismatch("BUILD other scope", PHRASE.apply));
    const client = await connect(f.service);
    const r = await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply });
    expect(r.isError).toBe(true);
    expect(r.json()).toMatchObject({ error: "confirm_mismatch", expected: "BUILD other scope" });
  });
});

describe("nb_apply stopAt", () => {
  test('defaults to "end", passes "first" through, and is optional in the schema', async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const { tools } = await client.listTools();
    const apply = tools.find((t) => t.name === "nb_apply")!;
    expect(Object.keys(apply.inputSchema.properties ?? {})).toContain("stopAt");
    expect(apply.inputSchema.required ?? []).not.toContain("stopAt");

    expect((await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply })).isError).toBe(false);
    expect(f.write.apply).toHaveBeenLastCalledWith(SPEC, PHRASE.apply, { stopAt: "end" });

    expect((await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply, stopAt: "first" })).isError).toBe(false);
    expect(f.write.apply).toHaveBeenLastCalledWith(SPEC, PHRASE.apply, { stopAt: "first" });

    expect((await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply, stopAt: "end" })).isError).toBe(false);
    expect(f.write.apply).toHaveBeenLastCalledWith(SPEC, PHRASE.apply, { stopAt: "end" });
    expect(f.write.apply).toHaveBeenCalledTimes(3);
  });

  test("the phrase is the same whatever stopAt says, and a wrong phrase is refused before the service either way", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    for (const stopAt of ["first", "end"]) {
      const r = await callTool(client, "nb_apply", { spec: SPEC, stopAt });
      expect(r.isError).toBe(true);
      expect(r.json()).toMatchObject({ error: "confirm_mismatch", expected: PHRASE.apply });
    }
    expect(f.totalCalls()).toBe(0);
  });

  test("an unknown stopAt is a validation error and reaches no service method", async () => {
    const f = fakeService();
    const client = await connect(f.service);
    const r = await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply, stopAt: "middle" });
    expect(r.isError).toBe(true);
    expect(f.totalCalls()).toBe(0);
  });

  test("the description and the workflow say decisions come back together", async () => {
    const client = await connect(fakeService().service);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.nb_apply).toMatch(/stopAt "end"/);
    expect(byName.nb_apply).toMatch(/returns ALL of them/);
    expect(byName.nb_inspect).toMatch(/together with one fill-in template/);
    expect(byName.nb_plan).toMatch(/Group Parallels/);
  });
});

describe("errors", () => {
  test("a ResolveError comes back structured, with its candidates", async () => {
    const f = fakeService();
    const candidates = [
      { id: "p1", name: "Julio Rodriguez", detail: "Seattle Mariners" },
      { id: "p2", name: "Julio Rodriguez", detail: "Texas Rangers, 1980s" },
    ];
    f.read.inspect.mockRejectedValueOnce(
      new ResolveError({ kind: "player", query: "Julio Rodriguez", candidates, at: "steps[1].base.checklist" }),
    );
    const client = await connect(f.service);
    const r = await callTool(client, "nb_inspect", { path: TOPPS_CHROME });
    expect(r.isError).toBe(true);
    expect(r.json()).toMatchObject({
      error: "resolve",
      kind: "player",
      query: "Julio Rodriguez",
      at: "steps[1].base.checklist",
      candidates,
    });
    expect(r.text).toMatch(/never pick by position/);
  });

  test("a zero-candidate ResolveError says there is no match", async () => {
    const f = fakeService();
    f.read.inspect.mockRejectedValueOnce(new ResolveError({ kind: "set", query: "Topps Chrom", candidates: [] }));
    const client = await connect(f.service);
    const r = await callTool(client, "nb_inspect", { path: TOPPS_CHROME });
    expect(r.json()).toMatchObject({ error: "resolve", candidates: [] });
    expect(r.text).toMatch(/No set named/);
  });

  test("a configuration failure (no target) surfaces as a config error from read and write tools", async () => {
    const configErr = Object.assign(new Error("No target: pass --convex-url or set NB_SETBUILD_CONVEX_URL."), {
      name: "ConfigError",
    });
    const f = fakeService();
    const broken = {
      read: f.service.read,
      write: f.service.write,
      get target(): never {
        throw configErr;
      },
    } as unknown as SetBuildService;
    f.read.inspect.mockRejectedValueOnce(configErr);
    const client = await connect(broken);
    const read = await callTool(client, "nb_inspect", { path: TOPPS_CHROME });
    expect(read.json()).toMatchObject({ error: "config", message: configErr.message });
    const write = await callTool(client, "nb_apply", { spec: SPEC, confirm: PHRASE.apply });
    expect(write.json()).toMatchObject({ error: "config" });
    expect(Object.values(f.write).every((s) => s.mock.calls.length === 0)).toBe(true);
  });
});

describe("nothing secret leaves", () => {
  test("tokens, secret values and stacks are scrubbed from errors", async () => {
    const f = fakeService();
    const err = new Error(
      `Clerk said no to ${SECRET} with Authorization: Bearer ${JWT}\n    at handler (../convex/selectorOptions.ts:12:3)\n    at async run (tools/setbuild/runner/apply.ts:4:1)`,
    );
    f.read.plan.mockRejectedValueOnce(err);
    const client = await connect(f.service);
    const r = await callTool(client, "nb_plan", { spec: SPEC });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(JWT);
    expect(r.text).not.toContain(JWT.split(".")[1]);
    expect(r.text).not.toMatch(/\bat handler\b|\.ts:\d+:\d+/);
    expect(r.text).not.toContain(err.stack!.split("\n")[1].trim());
    expect(r.text).toContain("[redacted]");
  });

  test("tokens and secret values are scrubbed from successful results", async () => {
    const f = fakeService();
    f.read.inspect.mockResolvedValueOnce({ found: true, note: `token ${JWT} key ${SECRET}` } as never);
    const client = await connect(f.service);
    const r = await callTool(client, "nb_inspect", { path: TOPPS_CHROME });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(JWT);
  });

  test("by default the secret env vars' values are what gets scrubbed", async () => {
    vi.stubEnv("TESTING_ENDPOINT_SECRET", "env_testing_secret_value_42");
    vi.stubEnv("NB_SETBUILD_API_KEY", "sk_env_api_key_value_77");
    const f = fakeService();
    f.read.reviewItems.mockRejectedValueOnce(
      new Error("leaked env_testing_secret_value_42 and sk_env_api_key_value_77"),
    );
    const client = await connect(f.service, {});
    const r = await callTool(client, "nb_review_items", { path: TOPPS_CHROME });
    expect(r.text).not.toContain("env_testing_secret_value_42");
    expect(r.text).not.toContain("sk_env_api_key_value_77");
  });
});
