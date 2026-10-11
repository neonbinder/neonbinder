/**
 * NEO-339 — the set-build MCP tools.
 *
 * Seven tools over `SetBuildService` (service.ts):
 *
 * | tool                | kind  | service call               |
 * |---------------------|-------|----------------------------|
 * | nb_inspect          | read  | read.inspect               |
 * | nb_plan             | read  | read.plan                  |
 * | nb_review_items     | read  | read.reviewItems           |
 * | nb_apply            | write | write.apply                |
 * | nb_decide           | write | write.decide               |
 * | nb_build_parallel   | write | write.buildParallel        |
 * | nb_sl_review_apply  | write | write.slReviewApply        |
 *
 * Safety, in order of what it relies on:
 *
 * 1. The read tools are registered with `service.read` ONLY (see
 *    `registerReadTools`); they hold no reference to `write`.
 * 2. Every write tool checks the target-bound confirm phrase HERE, before the
 *    service is touched: a missing or wrong phrase returns `isError` naming
 *    the expected phrase and makes zero service calls. The service checks it
 *    again (the CLI's only lock).
 * 3. The write tools are on no permission allowlist (mcp-allowlist.test.ts),
 *    so Claude Code asks the operator for every write call.
 * 4. Every result and error passes through `scrub`: the secret env values and
 *    anything JWT-shaped are redacted, and stack frames never leave.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { redact } from "./auth/token-source";
import { secretValues } from "./client/connect";
import { assertConfirm, ConfirmMismatch, type Target } from "./client/target";
import {
  formatPath,
  ResolveError,
  specScope,
  type NodePath,
  type SetBuildRead,
  type SetBuildService,
  type SetBuildSpecInput,
  type SetBuildWrite,
} from "./service";

export const READ_TOOLS = ["nb_inspect", "nb_plan", "nb_review_items"] as const;
export const WRITE_TOOLS = ["nb_apply", "nb_decide", "nb_build_parallel", "nb_sl_review_apply"] as const;
export type ToolName = (typeof READ_TOOLS)[number] | (typeof WRITE_TOOLS)[number];

export interface RegisterToolsOptions {
  /** Secret values to redact from every result. Default: the secret env vars' values. */
  secrets?: string[];
  /** Base directory for a relative `specPath`. Default: the directory the server was launched from. */
  cwd?: string;
  /** Spec file reader; injectable for tests. */
  readSpecFile?: (absolutePath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;
const MAX_ERROR_CHARS = 1500;

/** Redact secret values and anything JWT-shaped. */
export function scrub(text: string, secrets: readonly string[]): string {
  return redact(text, secrets).replace(JWT_RE, "[redacted-token]");
}

/** An error's message with stack frames removed and its length bounded. */
function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split("\n").filter((l) => !/^\s+at\s/.test(l));
  const msg = lines.join("\n").trim() || "The call failed with no message.";
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS)}…` : msg;
}

/** The structured body of a tool error. Never carries a stack. */
export function describeError(err: unknown): Record<string, unknown> {
  const message = cleanMessage(err);
  if (err instanceof ConfirmMismatch) {
    return {
      error: "confirm_mismatch",
      message,
      expected: err.expected,
      hint: "Show the operator this phrase and the target it names; call again with confirm set to it exactly.",
    };
  }
  if (err instanceof ResolveError) {
    return {
      error: "resolve",
      message,
      kind: err.kind,
      query: err.query,
      ...(err.at ? { at: err.at } : {}),
      candidates: err.candidates,
      hint:
        err.candidates.length === 0
          ? "No row has this name. Check the spelling with nb_inspect, or ask the operator."
          : "Ask the operator which candidate is meant and name it exactly; never pick by position.",
    };
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "ConfigError" || name === "TargetError") return { error: "config", message };
  if (name === "SetbuildAuthError") {
    const e = err as Error & { stage?: string; status?: number; code?: string };
    return { error: "auth", message, stage: e.stage, status: e.status, code: e.code };
  }
  if (name === "WaitTimeout") return { error: "timeout", message };
  return { error: "failed", message };
}

function textResult(body: unknown, secrets: readonly string[], isError = false): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(body, null, 2) ?? "null";
  } catch {
    text = JSON.stringify({ error: "failed", message: "The result could not be serialised." });
    isError = true;
  }
  return { content: [{ type: "text", text: scrub(text, secrets) }], ...(isError ? { isError: true } : {}) };
}

async function run(secrets: readonly string[], fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await fn(), secrets);
  } catch (err) {
    return textResult(describeError(err), secrets, true);
  }
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const name = (what: string) => z.string().trim().min(1).describe(what);
const year = z
  .union([z.string().trim().min(1), z.number().int()])
  .describe('Year as NB names it, e.g. "2024".');

const brandYearShape = {
  sport: name('Sport, e.g. "Baseball".'),
  year,
  manufacturer: name('Manufacturer, e.g. "Topps".'),
};
const setPathSchema = z
  .object({ ...brandYearShape, set: name('Set, e.g. "Topps Chrome".') })
  .strict()
  .describe("A set: sport › year › manufacturer › set, each the exact NB name.");
const brandYearPathSchema = z
  .object(brandYearShape)
  .strict()
  .describe("A brand-year: sport › year › manufacturer, each the exact NB name.");
const nodePathSchema = z
  .object({ ...brandYearShape, set: name("Set name; omit to address the brand-year.").optional() })
  .strict()
  .describe("A set (with `set`) or a brand-year (without it). Exact NB names.");

type RawPath = { sport: string; year: string | number; manufacturer: string; set?: string };

function toPath(p: RawPath): NodePath {
  const base = { sport: p.sport, year: String(p.year), manufacturer: p.manufacturer };
  return p.set === undefined ? base : { ...base, set: p.set };
}

const specInputShape = {
  spec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The set-build spec as a JSON object (version, scope, steps). Give this or specPath."),
  specPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Path to a spec .json file. Absolute is safest; relative resolves against where the server was launched."),
};

const confirm = z
  .string()
  .optional()
  .describe(
    "The confirm phrase, exactly: BUILD <convex host> <scope>. Copy it from nb_plan (or from this tool's error when it is missing); never compose it.",
  );

const namedDecision = z
  .object({
    name: z.string().min(1),
    decision: z.union([z.literal("create"), z.literal("skip"), z.object({ link: z.string().min(1) }).strict()]),
  })
  .strict();
const teamDecision = namedDecision
  .extend({ location: z.string().optional(), league: z.string().optional() })
  .strict();

// TODO(NEO-339): swap for the zod schemas in spec/schema.ts once it exports them.
const slDecision = z.union([
  z.object({ slId: z.string().min(1), placement: z.literal("own-set") }).strict(),
  z
    .object({
      slId: z.string().min(1),
      set: z.string().min(1),
      variantType: z.string().min(1),
      name: z.string().min(1).optional(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

const MAX_SPEC_BYTES = 1_000_000;

class SpecInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecInputError";
  }
}

async function defaultReadSpecFile(absolutePath: string): Promise<string> {
  const info = await stat(absolutePath).catch(() => null);
  if (!info || !info.isFile()) throw new SpecInputError(`No spec file at ${absolutePath}.`);
  if (info.size > MAX_SPEC_BYTES) throw new SpecInputError("The spec file is larger than 1 MB.");
  return readFile(absolutePath, "utf8");
}

async function loadSpec(
  input: { spec?: Record<string, unknown>; specPath?: string },
  opts: Required<Pick<RegisterToolsOptions, "cwd" | "readSpecFile">>,
): Promise<SetBuildSpecInput> {
  if ((input.spec === undefined) === (input.specPath === undefined)) {
    throw new SpecInputError("Give exactly one of spec (an object) or specPath (a .json file).");
  }
  if (input.spec !== undefined) return input.spec;
  const p = input.specPath!;
  if (!p.toLowerCase().endsWith(".json")) throw new SpecInputError("specPath must name a .json file.");
  const absolute = isAbsolute(p) ? p : resolvePath(opts.cwd, p);
  const text = await opts.readSpecFile(absolute);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // JSON.parse's own message quotes the file; never echo file contents.
    throw new SpecInputError(`The spec file at ${absolute} is not valid JSON.`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface Ctx {
  secrets: string[];
  cwd: string;
  readSpecFile: (absolutePath: string) => Promise<string>;
}

const WORKFLOW =
  "Workflow: nb_inspect / nb_plan first (read-only) → show the operator the plan and its open decisions → " +
  "edit the spec with the operator's answers and plan again until openDecisions is empty → nb_apply with " +
  "nb_plan's confirmPhrase. Never guess a decision or pick a candidate by position; ambiguity comes back as " +
  "candidates for the operator to choose from.";

/** The three read tools. Receives `read` only: no path to a write exists here. */
export function registerReadTools(server: McpServer, read: SetBuildRead, ctx: Ctx): void {
  server.registerTool(
    "nb_inspect",
    {
      title: "Inspect an NB set or brand-year",
      description:
        "Read-only. Shows what NeonBinder holds at a node. For a set path: every variant type with its rows, " +
        "card counts and attached marketplace ids, plus the Base row. For a brand-year path (no set): the sets " +
        "under it. Names must match NB rows exactly; an unknown or ambiguous name returns an error listing " +
        "candidates. " +
        WORKFLOW,
      inputSchema: { path: nodePathSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => run(ctx.secrets, () => read.inspect(toPath(path))),
  );

  server.registerTool(
    "nb_plan",
    {
      title: "Plan a set-build spec",
      description:
        "Read-only; always call before nb_apply. Validates a set-build spec against the target and returns: " +
        "the steps apply would run (done / todo / blocked); every open decision the spec does not answer " +
        "(names matching zero or several rows, Base candidates, reconcile pairs, entity-review players / teams / " +
        "leagues, SportLots review rows, card-number conflicts) with marketplace ids and candidates; a fill-in " +
        "template; and confirmPhrase, the exact string nb_apply needs. Wizard rows for a checklist that has not " +
        "been fetched yet cannot be planned; they appear when nb_apply stops. " +
        WORKFLOW,
      inputSchema: specInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => run(ctx.secrets, async () => read.plan(await loadSpec(input, ctx))),
  );

  server.registerTool(
    "nb_review_items",
    {
      title: "List waiting review items",
      description:
        "Read-only. For a set path: the entity-review items (players, teams, leagues) waiting on its " +
        "checklists, each with candidates. For a brand-year path: the SportLots review rows waiting there, by " +
        "SportLots id. Use it after nb_apply stops at a review, to see exactly what nb_decide or " +
        "nb_sl_review_apply must answer. " +
        WORKFLOW,
      inputSchema: { path: nodePathSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => run(ctx.secrets, () => read.reviewItems(toPath(path))),
  );
}

/** The four write tools. Each checks the confirm phrase before touching `write`. */
export function registerWriteTools(
  server: McpServer,
  write: SetBuildWrite,
  getTarget: () => Target,
  ctx: Ctx,
): void {
  server.registerTool(
    "nb_apply",
    {
      title: "Apply a set-build spec (writes)",
      description:
        "WRITES to NeonBinder. Runs a set-build spec: syncs, maps Base, reconciles variants, fetches, " +
        "commits and builds, skipping every step whose state already matches, so a re-run is safe. Requires " +
        "confirm to equal the confirmPhrase nb_plan returned for the same spec; call nb_plan first and let the " +
        "operator see it. Stops at the first decision the spec does not answer and returns it (stoppedAt, " +
        "openDecisions, template): take it to the operator, put the answer in the spec, plan and apply again.",
      inputSchema: { ...specInputShape, confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ confirm: given, ...input }) =>
      run(ctx.secrets, async () => {
        const spec = await loadSpec(input, ctx);
        const scope = specScope(spec);
        if (!scope) throw new SpecInputError("The spec declares no scope; nb_plan explains what is wrong with it.");
        assertConfirm(getTarget(), scope, given);
        return write.apply(spec, given);
      }),
  );

  server.registerTool(
    "nb_decide",
    {
      title: "Answer an entity review (writes)",
      description:
        "WRITES. Answers the entity review a checklist is waiting on (see nb_review_items): for each player, " +
        'team or league by its exact name, "create", "skip", or {"link": "<existing NB name>"}. Teams may carry ' +
        "location and league. row names the checklist (variant type + row name); omit it for the Base row. Only " +
        "answers the operator gave; an unanswered item stays open. confirm is BUILD <convex host> " +
        "<sport>/<year>/<manufacturer>/<set>; a call without it returns the exact phrase to show the operator.",
      inputSchema: {
        path: setPathSchema,
        row: z
          .object({ type: z.string().min(1), name: z.string().min(1) })
          .strict()
          .optional()
          .describe("The checklist's variant type title and row name. Omit for Base."),
        players: z.array(namedDecision).optional(),
        teams: z.array(teamDecision).optional(),
        leagues: z.array(namedDecision).optional(),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, confirm: given, row, players, teams, leagues }) =>
      run(ctx.secrets, async () => {
        const setPath = toPath(path) as Parameters<SetBuildWrite["decide"]>[0];
        assertConfirm(getTarget(), formatPath(setPath), given);
        return write.decide(setPath, { row, players, teams, leagues }, given);
      }),
  );

  server.registerTool(
    "nb_build_parallel",
    {
      title: "Build a parallel from Base (writes)",
      description:
        "WRITES. Builds one Parallel row's checklist from the set's Base checklist, as the Set Builder's " +
        '"Build from Base" does. name is the exact Parallel row name. A row that already has cards is skipped ' +
        "unless rebuild is true. confirm is BUILD <convex host> <sport>/<year>/<manufacturer>/<set>; a call " +
        "without it returns the exact phrase to show the operator.",
      inputSchema: {
        path: setPathSchema,
        name: name("The exact Parallel row name."),
        rebuild: z.boolean().optional().describe("Rebuild a row that already has cards."),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, name: rowName, rebuild, confirm: given }) =>
      run(ctx.secrets, async () => {
        const setPath = toPath(path) as Parameters<SetBuildWrite["buildParallel"]>[0];
        assertConfirm(getTarget(), formatPath(setPath), given);
        return write.buildParallel(setPath, rowName, rebuild === undefined ? {} : { rebuild }, given);
      }),
  );

  server.registerTool(
    "nb_sl_review_apply",
    {
      title: "Apply SportLots set review (writes)",
      description:
        "WRITES. Applies SportLots set-review decisions at a brand-year (see nb_review_items). Each row is " +
        'named by its SportLots id: {"slId", "placement": "own-set"} makes it its own set; {"slId", "set", ' +
        '"variantType", "name"?} places it under an existing NB set. Rows not listed stay waiting; nothing is ' +
        "applied by position. confirm is BUILD <convex host> <sport>/<year>/<manufacturer>; a call without it " +
        "returns the exact phrase to show the operator.",
      inputSchema: {
        path: brandYearPathSchema,
        decisions: z.array(slDecision).min(1).max(200),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, decisions, confirm: given }) =>
      run(ctx.secrets, async () => {
        const byPath = toPath(path);
        assertConfirm(getTarget(), formatPath(byPath), given);
        return write.slReviewApply(byPath, decisions, given);
      }),
  );
}

/** Register all seven tools. */
export function registerTools(server: McpServer, service: SetBuildService, opts: RegisterToolsOptions = {}): void {
  const ctx: Ctx = {
    secrets: opts.secrets ?? secretValues(process.env),
    cwd: opts.cwd ?? process.env.INIT_CWD ?? process.cwd(),
    readSpecFile: opts.readSpecFile ?? defaultReadSpecFile,
  };
  registerReadTools(server, service.read, ctx);
  // A getter, not the value: a service whose connection failed to resolve
  // throws from `target`, and that must surface as a tool error, not here.
  registerWriteTools(server, service.write, () => service.target, ctx);
}
