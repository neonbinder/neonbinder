/**
 * NEO-339 §7.1 — the MCP tools over a real McpServer + Client pair, linked
 * in memory, with a fake service whose every method is a spy.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fakeJwt } from "./auth/test-helpers";
import { ConfirmMismatch, parseTarget } from "./client/target";
import { READ_TOOLS, registerTools, WRITE_TOOLS, type RegisterToolsOptions } from "./mcp-tools";
import { ResolveError, type OpenDecisions, type SetBuildService } from "./service";

const TARGET = parseTarget("https://happy-otter-123.convex.cloud");
const HOST = "happy-otter-123.convex.cloud";
const SECRET = "tes_SECRET_value_0123456789";
const JWT = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });

const TOPPS_CHROME = { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" };
const BOWMAN = { sport: "Baseball", year: "2025", manufacturer: "Bowman" };
const SPEC = { version: 1, scope: "e2e-baseline", steps: [] };

const PHRASE = {
  apply: `BUILD ${HOST} e2e-baseline`,
  set: `BUILD ${HOST} Baseball/2024/Topps/Topps Chrome`,
  brandYear: `BUILD ${HOST} Baseball/2025/Bowman`,
};

function noDecisions(): OpenDecisions {
  return {
    names: [],
    baseCandidates: [],
    reconcile: [],
    review: { players: [], teams: [], leagues: [] },
    slReview: [],
    conflicts: [],
  };
}

function fakeService() {
  const read = {
    inspect: vi.fn(async () => ({ found: true, pathText: "x" })),
    plan: vi.fn(async () => ({ confirmPhrase: PHRASE.apply, openDecisions: noDecisions(), steps: [] })),
    reviewItems: vi.fn(async () => ({ review: noDecisions().review, slReview: [] })),
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

async function connect(service: SetBuildService, opts: RegisterToolsOptions = { secrets: [SECRET] }) {
  const server = new McpServer({ name: "nb-setbuild-test", version: "0.0.0" });
  registerTools(server, service, opts);
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
    args: {
      path: TOPPS_CHROME,
      row: { type: "Insert", name: "Future Stars" },
      players: [{ name: "Shohei Ohtani", decision: "create" }],
    },
    phrase: PHRASE.set,
    spy: "decide",
  },
  nb_build_parallel: { args: { path: TOPPS_CHROME, name: "Gold Wave Refractors" }, phrase: PHRASE.set, spy: "buildParallel" },
  nb_sl_review_apply: {
    args: { path: BOWMAN, decisions: [{ slId: "sl-123", placement: "own-set" }] },
    phrase: PHRASE.brandYear,
    spy: "slReviewApply",
  },
};

describe("tool list", () => {
  test("exactly seven tools: three read-only, four writes taking an optional confirm", async () => {
    const client = await connect(fakeService().service);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(tools).toHaveLength(7);
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

  test("a relative specPath resolves against the launch directory", async () => {
    const f = fakeService();
    const readSpecFile = vi.fn(async () => JSON.stringify(SPEC));
    const client = await connect(f.service, { secrets: [SECRET], cwd: "/repo/root", readSpecFile });
    await callTool(client, "nb_plan", { specPath: "apps/web/.maestro/seed/parallel.spec.json" });
    expect(readSpecFile).toHaveBeenCalledWith("/repo/root/apps/web/.maestro/seed/parallel.spec.json");
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
    await callTool(client, "nb_decide", {
      ...WRITE_CALLS.nb_decide.args,
      teams: [{ name: "Seattle Mariners", decision: { link: "Seattle Mariners" }, league: "MLB" }],
      confirm: PHRASE.set,
    });
    expect(f.write.decide).toHaveBeenCalledWith(
      TOPPS_CHROME,
      {
        row: { type: "Insert", name: "Future Stars" },
        players: [{ name: "Shohei Ohtani", decision: "create" }],
        teams: [{ name: "Seattle Mariners", decision: { link: "Seattle Mariners" }, league: "MLB" }],
        leagues: undefined,
      },
      PHRASE.set,
    );
    await callTool(client, "nb_build_parallel", {
      path: { ...TOPPS_CHROME, year: 2024 },
      name: "Gold Wave Refractors",
      rebuild: true,
      confirm: PHRASE.set,
    });
    expect(f.write.buildParallel).toHaveBeenCalledWith(TOPPS_CHROME, "Gold Wave Refractors", { rebuild: true }, PHRASE.set);
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
    const r = await callTool(client, "nb_build_parallel", {
      path: { ...TOPPS_CHROME, set: "Big League" },
      name: "Gold",
      confirm: PHRASE.set,
    });
    expect(r.isError).toBe(true);
    expect(r.json()).toMatchObject({ expected: `BUILD ${HOST} Baseball/2024/Topps/Big League` });
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
