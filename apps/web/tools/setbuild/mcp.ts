/**
 * NEO-339 — the set-build MCP server (stdio).
 *
 * Started by Claude Code from the monorepo-root `.mcp.json` (server
 * `nb-setbuild`), or by `setbuild mcp-smoke`. Configuration is environment
 * only, the same variables the CLI reads (client/connect.ts):
 *
 *   NB_SETBUILD_CONVEX_URL, NB_SETBUILD_AUTH, NB_SETBUILD_APP_URL,
 *   NB_SETBUILD_WORKER, NB_SETBUILD_TRANSPORT, NB_SETBUILD_CONVEX_SITE_URL,
 *   VITE_CLERK_PUBLISHABLE_KEY,
 *   and the secrets NB_SETBUILD_API_KEY | TESTING_ENDPOINT_SECRET
 *   (+ VERCEL_AUTOMATION_BYPASS_SECRET).
 *   NB_SETBUILD_ENV_FILE optionally names a dotenv file loaded first.
 *
 * stdout IS the protocol. Nothing else may write to it, so console.log/info
 * /debug are rerouted to stderr at start-up. A module that captured
 * `console.log` at import time would bypass that: runner code must log
 * through `console.*` at call time (or stderr), never `process.stdout`.
 *
 * The server starts even when the configuration is incomplete: every tool
 * then returns the configuration error, which is more useful to an agent than
 * a server that never connected. The Convex connection (and the Clerk sign-in
 * behind it) is made on the first tool call, not at start-up.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "./auth/token-source";
import { resolveConnection, secretValues, type Connection } from "./client/connect";
import { makeClient, type NbClient } from "./client/convex-client";
import type { Target } from "./client/target";
import { registerTools } from "./mcp-tools";
import { createSetBuildService } from "./runner/service";
import type { SetBuildService } from "./service";

export const SERVER_NAME = "nb-setbuild";
export const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS =
  "Builds NeonBinder sets through the same admin functions the Set Builder UI calls. " +
  "Read tools (nb_inspect, nb_plan, nb_review_items) never write. Write tools (nb_apply, nb_decide, " +
  "nb_build_parallel, nb_sl_review_apply) need confirm = BUILD <convex host> <scope>; take it from nb_plan " +
  "or from the write tool's own error, and only after the operator has seen what will be written and where. " +
  "Never guess a decision: unknown or ambiguous names come back with candidates for the operator to choose.";

function rerouteConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/**
 * A service that connects on first use. `target` is known up front (parsing
 * the URL needs no network), so write tools can check the phrase without
 * signing in; the client and its Clerk session are created on the first call.
 */
export function lazyService(
  conn: Connection,
  factory: (client: NbClient, target: Target) => SetBuildService,
): { service: SetBuildService; close: () => Promise<void> } {
  let client: NbClient | undefined;
  let inner: SetBuildService | undefined;
  const get = (): SetBuildService => {
    if (!inner) {
      client = makeClient(conn.target, conn.tokens, { transport: conn.transport });
      inner = factory(client, conn.target);
    }
    return inner;
  };
  const service: SetBuildService = {
    target: conn.target,
    read: {
      inspect: (path) => get().read.inspect(path),
      plan: (spec) => get().read.plan(spec),
      reviewItems: (path) => get().read.reviewItems(path),
    },
    write: {
      apply: (spec, confirm) => get().write.apply(spec, confirm),
      decide: (path, decisions, confirm) => get().write.decide(path, decisions, confirm),
      buildParallel: (path, name, opts, confirm) => get().write.buildParallel(path, name, opts, confirm),
      slReviewApply: (path, decisions, confirm) => get().write.slReviewApply(path, decisions, confirm),
    },
  };
  return { service, close: async () => client?.close() };
}

/** A service whose every call fails with `err` (configuration could not be resolved). */
export function unavailableService(err: unknown): SetBuildService {
  const fail = async (): Promise<never> => {
    throw err;
  };
  return {
    get target(): Target {
      throw err;
    },
    read: { inspect: fail, plan: fail, reviewItems: fail },
    write: { apply: fail, decide: fail, buildParallel: fail, slReviewApply: fail },
  };
}

/** `.mcp.json` passes an unset variable as "" (`${VAR:-}`); treat that as unset. */
function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v;
}

/**
 * Load a dotenv file into `env`, filling keys that are unset OR empty.
 * (`process.loadEnvFile` never overrides an existing key, and `.mcp.json`
 * hands the server every listed variable, set or not, as at least "".)
 */
export function loadEnvFileInto(env: NodeJS.ProcessEnv, path: string): void {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined && nonEmpty(env[k]) === undefined) env[k] = v;
  }
}

export function buildServer(env: NodeJS.ProcessEnv): { server: McpServer; close: () => Promise<void> } {
  let service: SetBuildService;
  let close = async () => {};
  try {
    const conn = resolveConnection(
      {
        transport: nonEmpty(env.NB_SETBUILD_TRANSPORT),
        worker: nonEmpty(env.NB_SETBUILD_WORKER),
        convexSiteUrl: nonEmpty(env.NB_SETBUILD_CONVEX_SITE_URL),
      },
      env,
    );
    ({ service, close } = lazyService(conn, createSetBuildService));
  } catch (err) {
    service = unavailableService(err);
  }
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, service, { secrets: secretValues(env) });
  return { server, close };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  rerouteConsoleToStderr();
  const envFile = nonEmpty(env.NB_SETBUILD_ENV_FILE);
  if (envFile) {
    try {
      loadEnvFileInto(env, envFile);
    } catch {
      process.stderr.write("nb-setbuild: could not read NB_SETBUILD_ENV_FILE; continuing without it.\n");
    }
  }
  const { server, close } = buildServer(env);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  server.server.onclose = () => void shutdown();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nb-setbuild: ${redact(message, secretValues(process.env))}\n`);
    process.exitCode = 1;
  });
}
