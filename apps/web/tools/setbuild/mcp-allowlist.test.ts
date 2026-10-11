/**
 * NEO-339 §7.3 — the MCP write tools stay behind a human prompt.
 *
 * Reads the committed monorepo-root `.claude/settings.json` and `.mcp.json`:
 *
 * - no `permissions.allow` rule may cover an nb-setbuild WRITE tool (exact
 *   name, the server-wide `mcp__nb-setbuild` form, or any wildcard), so Claude
 *   Code asks the operator before every write call;
 * - every `.mcp.json` env value is a `${VAR}` reference to a variable of the
 *   same name, so no value (secret or not) is committed;
 * - WRITE_TOOLS is exactly the set of registered tools that are not
 *   read-only, so a new write tool cannot slip past the first check.
 *
 * The CLI path (NEO-339 J1, option C) is closed in code, not here: a
 * `Bash(*)` allow rule lets Bash run `npm run setbuild -- apply`, but with
 * `--auth machine` (production) apply ignores --confirm and refuses without
 * an interactive terminal (runner/cli-commands.ts, MACHINE_NEEDS_TTY). Testing
 * auth, which cannot reach production, stays gated by the confirm phrase.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseTarget } from "./client/target";
import { READ_TOOLS, registerTools, WRITE_TOOLS } from "./mcp-tools";
import type { SetBuildService } from "./service";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_DIR, "../..");
const SERVER = "nb-setbuild";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Does a Claude Code permission rule cover `mcp__<server>__<tool>`? */
function ruleCoversTool(rule: string, server: string, tool: string): boolean {
  const r = rule.trim();
  if (r === `mcp__${server}`) return true; // server-wide form
  if (!r.startsWith("mcp")) return false;
  const pattern = new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return pattern.test(`mcp__${server}__${tool}`);
}

describe("ruleCoversTool", () => {
  test.each([
    ["mcp__nb-setbuild__nb_apply", true],
    ["mcp__nb-setbuild", true],
    ["mcp__nb-setbuild__*", true],
    ["mcp__nb-setbuild__nb_*", true],
    ["mcp__*", true],
    ["mcp__nb-setbuild__nb_plan", false],
    ["mcp__other__nb_apply", false],
    ["Bash(*)", false],
  ])("%s → %s", (rule, covers) => {
    expect(ruleCoversTool(rule, SERVER, "nb_apply")).toBe(covers);
  });
});

describe(".claude/settings.json", () => {
  const path = resolve(REPO_ROOT, ".claude/settings.json");

  test("exists at the monorepo root", () => {
    expect(existsSync(path), path).toBe(true);
  });

  test("allows no nb-setbuild write tool", () => {
    const settings = readJson(path) as { permissions?: { allow?: unknown } };
    const allow = settings.permissions?.allow ?? [];
    expect(Array.isArray(allow)).toBe(true);
    const offending = (allow as unknown[])
      .filter((r): r is string => typeof r === "string")
      .flatMap((rule) => WRITE_TOOLS.filter((t) => ruleCoversTool(rule, SERVER, t)).map((t) => `${rule} → ${t}`));
    expect(offending).toEqual([]);
  });
});

describe(".mcp.json", () => {
  const path = resolve(REPO_ROOT, ".mcp.json");
  const config = () => readJson(path) as { mcpServers?: Record<string, Record<string, unknown>> };

  test("declares nb-setbuild, started through the package's setbuild:mcp script", () => {
    const server = config().mcpServers?.[SERVER];
    expect(server).toBeDefined();
    const args = (server!.args ?? []) as string[];
    expect(server!.command).toBe("npm");
    expect(args).toEqual(["--prefix", "apps/web", "run", "--silent", "setbuild:mcp"]);
    // --silent matters: npm's "> pkg@ver script" banner on stdout would corrupt the protocol.
    const pkg = readJson(resolve(APP_DIR, "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["setbuild:mcp"]).toBe("tsx tools/setbuild/mcp.ts");
  });

  test("every env value of every server is a ${VAR} reference to its own name", () => {
    for (const [name, server] of Object.entries(config().mcpServers ?? {})) {
      const env = (server.env ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(env)) {
        expect(value, `${name}.env.${key}`).toMatch(new RegExp(`^\\$\\{${key}(:-)?\\}$`));
      }
      for (const arg of (server.args ?? []) as unknown[]) {
        expect(String(arg), `${name}.args`).not.toMatch(/\$\{|=/);
      }
      expect(server.headers, `${name}.headers`).toBeUndefined();
    }
  });
});

describe("WRITE_TOOLS is the complete write set", () => {
  test("matches the registered tools that are not read-only", async () => {
    const fail = async () => {
      throw new Error("not called");
    };
    const service = {
      target: parseTarget("https://happy-otter-123.convex.cloud"),
      read: { inspect: fail, plan: fail, reviewItems: fail },
      write: { apply: fail, decide: fail, buildParallel: fail, slReviewApply: fail },
    } as SetBuildService;
    const server = new McpServer({ name: SERVER, version: "0.0.0" });
    registerTools(server, service, { secrets: [] });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "allowlist-test", version: "0.0.0" });
    await client.connect(c);
    try {
      const { tools } = await client.listTools();
      const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
      const reads = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
      expect(writes.sort()).toEqual([...WRITE_TOOLS].sort());
      expect(reads.sort()).toEqual([...READ_TOOLS].sort());
    } finally {
      await client.close();
      await server.close();
    }
  });
});
