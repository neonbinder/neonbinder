/**
 * NEO-339 — `npm run setbuild -- <command> [flags]`.
 *
 * A thin shell over the set-build library. Each command is one entry in
 * `COMMANDS`; a builder adding a command adds an entry there (and its own
 * options), and gets the shared connection flags, `--env-file`, `--json` and
 * secret-redacted error output for free.
 *
 * Exit codes: 0 ok, 1 the command failed, 2 usage error.
 */

import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { api } from "../../convex/_generated/api";
import { decodeJwtClaims, scrub } from "./auth/token-source";
import {
  resolveConnection,
  secretValues,
  type Connection,
} from "./client/connect";
import { makeClient } from "./client/convex-client";
import { mcpSmokeCommand } from "./mcp-smoke";
import { oneshotSmokeCommand } from "./mcp-oneshot";
import { RUNNER_COMMANDS } from "./runner/cli-commands";

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /**
   * Ask the operator a question and return what they typed. Present ONLY when
   * stdin is an interactive terminal; absent, a command that needs a person
   * (`apply --auth machine`) refuses rather than reading a pipe.
   */
  prompt?: (question: string) => Promise<string>;
}

export type FlagValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface CommandContext {
  values: FlagValues;
  positionals: string[];
  io: CliIO;
  /** Resolve the target + token source from the shared flags and env. */
  connect(): Connection;
  json: boolean;
}

export interface CommandSpec {
  summary: string;
  usage: string;
  /** Command-specific flags, merged with `GLOBAL_OPTIONS`. */
  options?: ParseArgsOptionsConfig;
  run(ctx: CommandContext): Promise<number>;
}

/** Flags every command accepts. Secrets are never flags (see client/connect.ts). */
export const GLOBAL_OPTIONS = {
  auth: { type: "string" },
  "convex-url": { type: "string" },
  "convex-site-url": { type: "string" },
  "app-url": { type: "string" },
  worker: { type: "string" },
  "publishable-key": { type: "string" },
  transport: { type: "string" },
  "env-file": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const GLOBAL_USAGE = `Connection flags (or env):
  --convex-url <url>        NB_SETBUILD_CONVEX_URL   https://<deployment>.convex.cloud
  --auth machine|testing    NB_SETBUILD_AUTH
  --app-url <url>           NB_SETBUILD_APP_URL      testing: SPA serving /api/auth/testing;
                                                     any auth: origin of Set Builder links
  --worker <n>              testing: per-worker test account (default 0)
  --publishable-key <pk>    VITE_CLERK_PUBLISHABLE_KEY
  --transport ws|http       default ws
  --convex-site-url <url>   only for a custom Convex domain
  --env-file <path>         load variables from a dotenv file first
  --json                    machine-readable output
Secrets come from env only: NB_SETBUILD_API_KEY, TESTING_ENDPOINT_SECRET,
VERCEL_AUTOMATION_BYPASS_SECRET.`;

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

/** The admin-gated query whoami calls: cheap, read-only, `requireAdmin` first. */
export const WHOAMI_PROBE = "leagues:listForManagement";

export interface WhoamiReport {
  target: { convexUrl: string; host: string };
  auth: string;
  subject: string | null;
  role: string | null;
  expiresInSeconds: number | null;
  admin: { ok: boolean; probe: string; detail: string };
}

export async function whoami(conn: Connection, now: () => number = Date.now): Promise<WhoamiReport> {
  const token = await conn.tokens.getToken();
  const claims = decodeJwtClaims(token);
  const client = makeClient(conn.target, conn.tokens, { transport: conn.transport });
  let admin: WhoamiReport["admin"];
  try {
    const result = await client.query(api.leagues.listForManagement, {});
    admin = {
      ok: true,
      probe: WHOAMI_PROBE,
      detail: `returned ${result.totalCount} league${result.totalCount === 1 ? "" : "s"}`,
    };
  } catch (err) {
    admin = {
      ok: false,
      probe: WHOAMI_PROBE,
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  } finally {
    await client.close();
  }
  return {
    target: { convexUrl: conn.target.convexUrl, host: conn.target.host },
    auth: conn.tokens.describe(),
    subject: typeof claims.sub === "string" ? claims.sub : null,
    role: typeof claims.role === "string" ? claims.role : null,
    expiresInSeconds: typeof claims.exp === "number" ? Math.round(claims.exp - now() / 1000) : null,
    admin,
  };
}

const whoamiCommand: CommandSpec = {
  summary: "Sign in, print the JWT subject and role, and prove an admin-only query succeeds.",
  usage: "setbuild whoami [connection flags]",
  async run(ctx) {
    const report = await whoami(ctx.connect());
    if (ctx.json) {
      ctx.io.stdout(JSON.stringify(report, null, 2));
    } else {
      ctx.io.stdout(`target   ${report.target.convexUrl}`);
      ctx.io.stdout(`auth     ${report.auth}`);
      ctx.io.stdout(`subject  ${report.subject ?? "(none)"}`);
      ctx.io.stdout(`role     ${report.role ?? "(none)"}`);
      ctx.io.stdout(
        `expires  ${report.expiresInSeconds === null ? "(no exp claim)" : `in ${report.expiresInSeconds}s`}`,
      );
      ctx.io.stdout(`admin    ${report.admin.ok ? "ok" : "FAILED"}: ${report.admin.probe} ${report.admin.detail}`);
    }
    return report.admin.ok ? 0 : 1;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every command: whoami (here), mcp-smoke and oneshot-smoke (MCP), and the
 * runner's inspect, plan, apply, decisions-template, schema, confirm-phrase,
 * draft-set and build-set (runner/cli-commands.ts).
 */
export const COMMANDS: Record<string, CommandSpec> = {
  whoami: whoamiCommand,
  "mcp-smoke": mcpSmokeCommand,
  "oneshot-smoke": oneshotSmokeCommand,
  ...RUNNER_COMMANDS,
};

function usage(): string {
  const names = Object.keys(COMMANDS).sort();
  const width = Math.max(...names.map((n) => n.length));
  return [
    "Usage: npm run setbuild -- <command> [flags]",
    "",
    "Commands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${COMMANDS[n].summary}`),
    "",
    GLOBAL_USAGE,
  ].join("\n");
}

function str(v: FlagValues[string]): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    io.stdout(usage());
    return name ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr(`setbuild: unknown command "${name}".\n\n${usage()}`);
    return 2;
  }

  let values: FlagValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) },
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    io.stderr(`setbuild ${name}: ${err instanceof Error ? err.message : String(err)}\n\n${command.usage}\n\n${GLOBAL_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(`${command.usage}\n\n${command.summary}\n\n${GLOBAL_USAGE}`);
    return 0;
  }

  const envFile = str(values["env-file"]);
  if (envFile) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      io.stderr(`setbuild: could not read --env-file ${envFile}.`);
      return 2;
    }
  }

  const ctx: CommandContext = {
    values,
    positionals,
    io,
    json: values.json === true,
    connect: () =>
      resolveConnection(
        {
          auth: str(values.auth),
          convexUrl: str(values["convex-url"]),
          convexSiteUrl: str(values["convex-site-url"]),
          appUrl: str(values["app-url"]),
          worker: str(values.worker),
          publishableKey: str(values["publishable-key"]),
          transport: str(values.transport),
        },
        io.env,
      ),
  };

  try {
    return await command.run(ctx);
  } catch (err) {
    // Last line of defence: every module already keeps secrets out of its
    // messages, and this strips any that slipped through anyway (secret env
    // values and anything JWT-shaped — the scrub the MCP layer uses). No
    // stack — a stack repeats the message and adds nothing an operator acts on.
    const message = err instanceof Error ? `${err.name === "Error" ? "" : `${err.name}: `}${err.message}` : String(err);
    io.stderr(`setbuild ${name}: ${scrub(message, secretValues(io.env))}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

/** A readline prompt on the terminal (question on stderr, so stdout stays the command's output). */
async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

if (invokedDirectly) {
  main(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    ...(process.stdin.isTTY ? { prompt: terminalPrompt } : {}),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`setbuild: ${scrub(String(err), secretValues(process.env))}\n`);
      process.exitCode = 1;
    },
  );
}
