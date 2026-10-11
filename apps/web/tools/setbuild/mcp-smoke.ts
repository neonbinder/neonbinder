/**
 * NEO-339 — `setbuild mcp-smoke`: prove the MCP server works end to end.
 *
 * Spawns `mcp.ts` over stdio with the same environment the CLI resolved, then
 * runs the plan §7.2 sequence as an MCP client would:
 *
 *   1. tools/list has all seven tools;
 *   2. nb_inspect for each `before` expectation;
 *   3. nb_plan on --spec: open decisions as expected, and its confirmPhrase is
 *      exactly --confirm (the smoke stops before writing otherwise). CI
 *      computes --confirm offline with `setbuild confirm-phrase`, so this
 *      proves the server and the CLI bind the same host, scope and spec
 *      digest;
 *   4. nb_apply with that phrase: no stop, and every expected count matches;
 *   5. nb_inspect for each `after` expectation.
 *
 * Exits 0 when every check passed, 1 on any mismatch. Prints one line per
 * check. The server's stderr is captured and shown (redacted) only on failure;
 * no token ever passes through this process — the server mints its own.
 * `--paused-platforms` (default: env PAUSED_PLATFORMS) reaches the server as
 * its PAUSED_PLATFORMS, exactly as `apply` reads it.
 *
 * Expectations file (--expect), e.g. for the seeded Topps Chrome:
 *
 *   {
 *     "before": [
 *       { "path": { "sport": "Baseball", "year": "2024", "manufacturer": "Topps", "set": "Topps Chrome" },
 *         "base": { "cards": 335 },
 *         "rows": [{ "type": "Insert", "name": "Future Stars", "cards": 20 }],
 *         "rowCounts": [{ "type": "Parallel", "count": 41 }] },
 *       { "path": { "sport": "Baseball", "year": "2024", "manufacturer": "Topps", "set": "Big League" },
 *         "base": { "cards": 0, "mapped": true } }
 *     ],
 *     "plan": { "openDecisions": 0 },
 *     "apply": { "counts": { "built": 300 } },
 *     "after": [
 *       { "path": { … "Topps Chrome" }, "rows": [{ "type": "Parallel", "name": "<row>", "cards": 300 }] }
 *     ]
 *   }
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { CommandSpec } from "./cli";
import { scrub } from "./auth/token-source";
import { secretValues } from "./client/connect";
import { READ_TOOLS, WRITE_TOOLS } from "./mcp-tools";
import {
  countOpenDecisions,
  formatPath,
  type ApplyReport,
  type InspectReport,
  type InspectRow,
  type NodePath,
  type PlanReport,
} from "./service";

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

const pathSchema = z
  .object({
    sport: z.string().min(1),
    year: z.union([z.string().min(1), z.number().int()]).transform(String),
    manufacturer: z.string().min(1),
    set: z.string().min(1).optional(),
  })
  .strict();

const inspectExpectSchema = z
  .object({
    path: pathSchema,
    base: z
      .object({
        cards: z.number().int().min(0).optional(),
        /** Linked to at least one marketplace. */
        mapped: z.boolean().optional(),
        /** Per side: linked (true) or not (false). */
        linked: z
          .object({ buysportscards: z.boolean().optional(), sportlots: z.boolean().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    rows: z
      .array(z.object({ type: z.string().min(1), name: z.string().min(1), cards: z.number().int().min(0) }).strict())
      .optional(),
    rowCounts: z.array(z.object({ type: z.string().min(1), count: z.number().int().min(0) }).strict()).optional(),
  })
  .strict();

export const smokeExpectSchema = z
  .object({
    before: z.array(inspectExpectSchema).default([]),
    plan: z.object({ openDecisions: z.number().int().min(0).default(0) }).strict().default({}),
    apply: z.object({ counts: z.record(z.string(), z.number()) }).strict(),
    after: z.array(inspectExpectSchema).default([]),
  })
  .strict();

export type SmokeExpect = z.infer<typeof smokeExpectSchema>;
type InspectExpect = z.infer<typeof inspectExpectSchema>;

export interface SmokeCheck {
  ok: boolean;
  label: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Checks (pure)
// ---------------------------------------------------------------------------

function isLinked(row: InspectRow): boolean {
  return row.links.buysportscards.length > 0 || row.links.sportlots.length > 0;
}

/** Mismatches between an inspect report and its expectation; empty = pass. */
export function inspectMismatches(report: InspectReport, exp: InspectExpect): string[] {
  const out: string[] = [];
  if (!report.found) return [`${report.pathText} was not found`];
  if (exp.base) {
    const base = report.base;
    if (!base) {
      out.push("no Base row");
    } else {
      if (exp.base.cards !== undefined && base.cards !== exp.base.cards) {
        out.push(`Base has ${base.cards} cards, expected ${exp.base.cards}`);
      }
      if (exp.base.mapped !== undefined && isLinked(base) !== exp.base.mapped) {
        out.push(exp.base.mapped ? "Base is not linked to any marketplace" : "Base is linked, expected unlinked");
      }
      for (const side of ["buysportscards", "sportlots"] as const) {
        const want = exp.base.linked?.[side];
        if (want !== undefined && base.links[side].length > 0 !== want) {
          out.push(`Base ${want ? "has no" : "has a"} ${side} link`);
        }
      }
    }
  }
  const types = report.variantTypes ?? [];
  for (const r of exp.rows ?? []) {
    const hits = types.filter((t) => t.type === r.type).flatMap((t) => t.rows.filter((row) => row.name === r.name));
    if (hits.length !== 1) {
      out.push(`${r.type} › ${r.name}: ${hits.length === 0 ? "no such row" : `${hits.length} rows share the name`}`);
    } else if (hits[0].cards !== r.cards) {
      out.push(`${r.type} › ${r.name} has ${hits[0].cards} cards, expected ${r.cards}`);
    }
  }
  for (const c of exp.rowCounts ?? []) {
    const n = types.filter((t) => t.type === c.type).reduce((sum, t) => sum + t.rows.length, 0);
    if (n !== c.count) out.push(`${c.type} has ${n} rows, expected ${c.count}`);
  }
  return out;
}

function inspectSummary(report: InspectReport, exp: InspectExpect): string {
  const parts: string[] = [];
  if (exp.base && report.base) parts.push(`Base ${report.base.cards}${isLinked(report.base) ? " linked" : " unlinked"}`);
  for (const r of exp.rows ?? []) parts.push(`${r.type} › ${r.name} ${r.cards}`);
  for (const c of exp.rowCounts ?? []) parts.push(`${c.type} rows ${c.count}`);
  return parts.join(", ") || "found";
}

// ---------------------------------------------------------------------------
// The sequence (transport-agnostic, so a test can drive it in memory)
// ---------------------------------------------------------------------------

/** nb_apply builds cards; the MCP SDK's 60 s default request timeout is far too short. */
export const APPLY_TIMEOUT_MS = 20 * 60_000;
const READ_TIMEOUT_MS = 2 * 60_000;

class ToolCallFailed extends Error {}

async function call<T>(client: Client, tool: string, args: Record<string, unknown>, timeout: number): Promise<T> {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
  if (result.isError) throw new ToolCallFailed(`${tool} returned an error: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolCallFailed(`${tool} returned text that is not JSON.`);
  }
}

export async function runSmokeSequence(
  client: Client,
  o: { specPath: string; expect: SmokeExpect; confirm: string; onCheck?: (c: SmokeCheck) => void },
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const record = (ok: boolean, label: string, detail: string) => {
    const c = { ok, label, detail };
    checks.push(c);
    o.onCheck?.(c);
    return ok;
  };
  const attempt = async (label: string, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn();
    } catch (err) {
      return record(false, label, err instanceof Error ? err.message : String(err));
    }
  };

  // 1. tools/list
  const listed = await attempt("tools/list", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = [...READ_TOOLS, ...WRITE_TOOLS].filter((n) => !names.has(n));
    return record(
      missing.length === 0,
      "tools/list",
      missing.length === 0 ? `${names.size} tools` : `missing ${missing.join(", ")}`,
    );
  });
  if (!listed) return checks;

  const inspectAll = async (phase: string, list: InspectExpect[]) => {
    for (const exp of list) {
      const path = exp.path as NodePath;
      const label = `${phase} nb_inspect ${formatPath(path)}`;
      await attempt(label, async () => {
        const report = await call<InspectReport>(client, "nb_inspect", { path }, READ_TIMEOUT_MS);
        const bad = inspectMismatches(report, exp);
        return record(bad.length === 0, label, bad.length === 0 ? inspectSummary(report, exp) : bad.join("; "));
      });
    }
  };

  // 2. before
  await inspectAll("before", o.expect.before);

  // 3. plan
  let phrase: string | undefined;
  const planned = await attempt("nb_plan", async () => {
    const plan = await call<PlanReport>(client, "nb_plan", { specPath: o.specPath }, READ_TIMEOUT_MS);
    const open = countOpenDecisions(plan.openDecisions);
    const okOpen = open === o.expect.plan.openDecisions;
    const okPhrase = plan.confirmPhrase === o.confirm;
    phrase = plan.confirmPhrase;
    const problems = [
      !okOpen && `${open} open decision${open === 1 ? "" : "s"}, expected ${o.expect.plan.openDecisions}`,
      !okPhrase && `confirmPhrase is "${plan.confirmPhrase}", --confirm is "${o.confirm}"`,
    ].filter(Boolean);
    return record(
      okOpen && okPhrase,
      "nb_plan",
      problems.length === 0 ? `${plan.steps.length} steps, ${open} open decisions` : problems.join("; "),
    );
  });
  if (!planned || !phrase) return checks;

  // 4. apply
  const applied = await attempt("nb_apply", async () => {
    const report = await call<ApplyReport>(
      client,
      "nb_apply",
      { specPath: o.specPath, confirm: phrase },
      APPLY_TIMEOUT_MS,
    );
    const problems: string[] = [];
    if (report.stoppedAt) problems.push(`stopped at step ${report.stoppedAt.step}: ${report.stoppedAt.reason}`);
    for (const [key, want] of Object.entries(o.expect.apply.counts)) {
      const got = report.counts?.[key];
      if (got !== want) problems.push(`counts.${key} is ${got ?? "missing"}, expected ${want}`);
    }
    const shown = Object.keys(o.expect.apply.counts)
      .map((k) => `${k} ${report.counts?.[k]}`)
      .join(", ");
    return record(
      problems.length === 0,
      "nb_apply",
      problems.length === 0 ? `${shown} in ${Math.round((report.durationMs ?? 0) / 1000)}s` : problems.join("; "),
    );
  });
  if (!applied) return checks;

  // 5. after
  await inspectAll("after", o.expect.after);
  return checks;
}

// ---------------------------------------------------------------------------
// Spawning the server
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
/** apps/web — where `tsx` resolves from. */
const APP_DIR = resolvePath(HERE, "../..");
const MCP_ENTRY = resolvePath(HERE, "mcp.ts");

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

export async function connectToSpawnedServer(env: NodeJS.ProcessEnv): Promise<{
  client: Client;
  stderrTail: () => string[];
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP_ENTRY],
    cwd: APP_DIR,
    env: stringEnv(env),
    stderr: "pipe",
  });
  const tail: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    tail.push(...String(chunk).split("\n").filter(Boolean));
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  });
  const client = new Client({ name: "setbuild-mcp-smoke", version: "0.1.0" });
  await client.connect(transport);
  return { client, stderrTail: () => [...tail], close: () => client.close() };
}

// ---------------------------------------------------------------------------
// The CLI command
// ---------------------------------------------------------------------------

function abs(p: string): string {
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

export const mcpSmokeCommand: CommandSpec = {
  summary: "Spawn the MCP server over stdio and run inspect → plan → apply → inspect against expectations.",
  usage:
    'setbuild mcp-smoke --spec <spec.json> --expect <expectations.json> --confirm "BUILD <host> <scope> <digest>" [--paused-platforms <keys>] [connection flags]',
  options: {
    spec: { type: "string" },
    expect: { type: "string" },
    confirm: { type: "string" },
    "paused-platforms": { type: "string" },
  },
  async run(ctx) {
    const specArg = typeof ctx.values.spec === "string" ? ctx.values.spec : undefined;
    const expectArg = typeof ctx.values.expect === "string" ? ctx.values.expect : undefined;
    const confirm = typeof ctx.values.confirm === "string" ? ctx.values.confirm : undefined;
    if (!specArg || !expectArg || !confirm) {
      ctx.io.stderr(`setbuild mcp-smoke: --spec, --expect and --confirm are all required.\n\n${mcpSmokeCommand.usage}`);
      return 2;
    }

    let expect: SmokeExpect;
    try {
      const raw: unknown = JSON.parse(await readFile(abs(expectArg), "utf8"));
      const parsed = smokeExpectSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.io.stderr(
          `setbuild mcp-smoke: --expect is not a valid expectations file: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
            .join("; ")}`,
        );
        return 2;
      }
      expect = parsed.data;
    } catch {
      ctx.io.stderr(`setbuild mcp-smoke: could not read --expect ${expectArg} as JSON.`);
      return 2;
    }

    // Resolve here first: a config error fails fast, and the server is given
    // the same answers through env (it reads env only).
    const conn = ctx.connect();
    const flagEnv: Record<string, string | undefined> = {
      NB_SETBUILD_CONVEX_URL: conn.target.convexUrl,
      NB_SETBUILD_CONVEX_SITE_URL:
        typeof ctx.values["convex-site-url"] === "string" ? ctx.values["convex-site-url"] : undefined,
      NB_SETBUILD_AUTH: conn.auth,
      NB_SETBUILD_TRANSPORT: conn.transport,
      NB_SETBUILD_APP_URL: typeof ctx.values["app-url"] === "string" ? ctx.values["app-url"] : undefined,
      NB_SETBUILD_WORKER: typeof ctx.values.worker === "string" ? ctx.values.worker : undefined,
      VITE_CLERK_PUBLISHABLE_KEY:
        typeof ctx.values["publishable-key"] === "string" ? ctx.values["publishable-key"] : undefined,
      // Unset flag: the server inherits env PAUSED_PLATFORMS with the rest of the env.
      PAUSED_PLATFORMS:
        typeof ctx.values["paused-platforms"] === "string" ? ctx.values["paused-platforms"] : undefined,
    };
    const env: NodeJS.ProcessEnv = { ...ctx.io.env };
    for (const [k, v] of Object.entries(flagEnv)) if (v !== undefined) env[k] = v;
    const secrets = secretValues(env);
    const say = (line: string) => ctx.io.stdout(scrub(line, secrets));

    if (!ctx.json) say(`mcp-smoke  ${conn.target.host}  spec ${specArg}`);
    const server = await connectToSpawnedServer(env);
    let checks: SmokeCheck[];
    try {
      checks = await runSmokeSequence(server.client, {
        specPath: abs(specArg),
        expect,
        confirm,
        onCheck: ctx.json ? undefined : (c) => say(`${c.ok ? "ok  " : "FAIL"}  ${c.label}: ${c.detail}`),
      });
    } finally {
      await server.close().catch(() => {});
    }
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    if (ctx.json) {
      say(JSON.stringify({ ok, target: conn.target.host, checks }, null, 2));
    } else {
      say(ok ? `mcp-smoke passed (${checks.length} checks).` : "mcp-smoke FAILED.");
      if (!ok && server.stderrTail().length > 0) {
        ctx.io.stderr(scrub(["server stderr (last lines):", ...server.stderrTail()].join("\n"), secrets));
      }
    }
    return ok ? 0 : 1;
  },
};
