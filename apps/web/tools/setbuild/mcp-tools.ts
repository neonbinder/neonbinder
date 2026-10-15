/**
 * NEO-339 — the set-build MCP tools.
 *
 * Eight tools over `SetBuildService` (service.ts):
 *
 * | tool                | kind  | service call               |
 * |---------------------|-------|----------------------------|
 * | nb_inspect          | read  | read.inspect               |
 * | nb_plan             | read  | read.plan                  |
 * | nb_review_items     | read  | read.reviewItems           |
 * | nb_draft_set        | read  | read.draftSet              |
 * | nb_apply            | write | write.apply                |
 * | nb_decide           | write | write.decide               |
 * | nb_build_parallel   | write | write.buildParallel        |
 * | nb_sl_review_apply  | write | write.slReviewApply        |
 *
 * Safety, in order of what it relies on:
 *
 * 1. The read tools are registered with `service.read` ONLY (see
 *    `registerReadTools`); they hold no reference to `write`.
 * 2. Every write tool checks the confirm phrase HERE, before the service is
 *    touched: a missing or wrong phrase returns `isError` naming the expected
 *    phrase and makes zero service calls. The phrase binds the target host AND
 *    the write's content (`BUILD <host> <scope> <digest>`, the per-write
 *    helpers in service.ts), so a phrase the operator saw for one spec or one
 *    set of answers never confirms another. The service checks it again (the
 *    CLI's only lock).
 * 3. The write tools are on no permission allowlist (mcp-allowlist.test.ts),
 *    so Claude Code asks the operator for every write call.
 * 4. Every result and error passes through `scrub` (auth/token-source.ts,
 *    shared with the CLI and the report files): the secret env values and
 *    anything JWT-shaped are redacted, and stack frames never leave.
 * 5. A `specPath` is resolved to its real path and must sit inside the
 *    repository or the directory the server was launched from (`INIT_CWD`):
 *    a symlink or `..` cannot point the server at an arbitrary file.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LeagueDecisionSchema, PlayerDecisionSchema, SlDecisionSchema, TeamDecisionSchema } from "./spec/schema";
import { scrub } from "./auth/token-source";
import { secretValues } from "./client/connect";
import { assertPhrase, ConfirmMismatch, type Target } from "./client/target";
import { parseSpec } from "./spec/schema";
import { compactDraftReport } from "./runner/draft";
import {
  buildParallelConfirmPhrase,
  decideConfirmPhrase,
  MAX_TEAM_LOOKUP_BUDGET,
  ResolveError,
  slReviewConfirmPhrase,
  specConfirmPhrase,
  specScope,
  type NodePath,
  type SetBuildRead,
  type SetBuildService,
  type SetBuildSpecInput,
  type SetBuildWrite,
} from "./service";

export const READ_TOOLS = ["nb_inspect", "nb_plan", "nb_review_items", "nb_draft_set"] as const;
export const WRITE_TOOLS = ["nb_apply", "nb_decide", "nb_build_parallel", "nb_sl_review_apply"] as const;
export type ToolName = (typeof READ_TOOLS)[number] | (typeof WRITE_TOOLS)[number];

export interface RegisterToolsOptions {
  /** Secret values to redact from every result. Default: the secret env vars' values. */
  secrets?: string[];
  /** Base directory for a relative `specPath`. Default: the directory the server was launched from. */
  cwd?: string;
  /** Spec file reader; injectable for tests. */
  readSpecFile?: (absolutePath: string) => Promise<string>;
  /**
   * Turn an absolute `specPath` into the real path to read, refusing one
   * outside the allowed roots. Default: `containedSpecPath` over the repo
   * root and `INIT_CWD`. Injectable for tests.
   */
  resolveSpecPath?: (absolutePath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

const MAX_ERROR_CHARS = 1500;

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

function textResult(body: unknown, secrets: readonly string[], isError = false, indent = 2): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(body, null, indent) ?? "null";
  } catch {
    text = JSON.stringify({ error: "failed", message: "The result could not be serialised." });
    isError = true;
  }
  return { content: [{ type: "text", text: scrub(text, secrets) }], ...(isError ? { isError: true } : {}) };
}

async function run(secrets: readonly string[], fn: () => Promise<unknown>, opts: { indent?: number } = {}): Promise<CallToolResult> {
  try {
    return textResult(await fn(), secrets, false, opts.indent);
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
    "The confirm phrase, exactly: BUILD <convex host> <scope> <digest>. The digest binds it to this call's content. " +
      "Copy it from nb_plan (nb_apply) or from this tool's error when it is missing; never compose it.",
  );

// The answer shapes are the spec's own zod schemas, so an MCP answer and a
// spec's review section are validated by one definition.
const playerDecision = PlayerDecisionSchema;
const teamDecision = TeamDecisionSchema;
const leagueDecision = LeagueDecisionSchema;
const slDecision = SlDecisionSchema;

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

/** The monorepo root: this file is apps/web/tools/setbuild/mcp-tools.ts. */
export const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../..");

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The real path of `absolutePath` (every symlink and `..` resolved), provided
 * it sits inside one of `roots` (themselves real-pathed). Throws otherwise,
 * naming the path as given and never where a symlink pointed.
 */
export async function containedSpecPath(
  absolutePath: string,
  roots: ReadonlyArray<string | undefined>,
  realpathFn: (p: string) => Promise<string> = realpath,
): Promise<string> {
  const real = await realpathFn(absolutePath).catch(() => {
    throw new SpecInputError(`No spec file at ${absolutePath}.`);
  });
  const realRoots = await Promise.all(
    roots.filter((r): r is string => !!r).map((r) => realpathFn(r).catch(() => undefined)),
  );
  if (!realRoots.some((r) => r !== undefined && within(r, real))) {
    throw new SpecInputError(
      `specPath ${absolutePath} is outside the repository and the directory the server was launched from; ` +
        "give a spec inside one of them, or pass the spec object instead.",
    );
  }
  return real;
}

async function loadSpec(
  input: { spec?: Record<string, unknown>; specPath?: string },
  opts: Required<Pick<RegisterToolsOptions, "cwd" | "readSpecFile" | "resolveSpecPath">>,
): Promise<SetBuildSpecInput> {
  if ((input.spec === undefined) === (input.specPath === undefined)) {
    throw new SpecInputError("Give exactly one of spec (an object) or specPath (a .json file).");
  }
  if (input.spec !== undefined) return input.spec;
  const p = input.specPath!;
  if (!p.toLowerCase().endsWith(".json")) throw new SpecInputError("specPath must name a .json file.");
  const absolute = await opts.resolveSpecPath(isAbsolute(p) ? p : resolvePath(opts.cwd, p));
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
  resolveSpecPath: (absolutePath: string) => Promise<string>;
}

const WORKFLOW =
  "Workflow: to build a whole set, nb_draft_set first (read-only on NB data): it drafts the complete spec, " +
  "lists every proposal it filled and every open decision it could not settle, and gives a fill-in template. " +
  "Show the operator the draft, its proposals and open decisions; put the operator's answers into the " +
  "template. Otherwise nb_inspect / nb_plan first (read-only) on a spec you wrote. Then nb_plan the spec, show " +
  "the operator the plan and confirmPhrase, and only once the operator approves call nb_apply with that " +
  "phrase. A draft's or a plan's confirmPhrase is never an approval by itself. nb_apply runs everything it " +
  "can and returns every decision that only appears once it writes (checklist reviews, lookup-staged teams " +
  "and leagues, card conflicts) together with one fill-in template: take them all to the operator at once, " +
  "put the answers in the spec, plan and apply again (a re-run skips what is done). Never guess a decision " +
  "or pick a candidate by position; ambiguity comes back as candidates for the operator to choose from.";

/** The four read tools. Receives `read` only: no path to a write exists here. */
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
        "(names matching zero or several rows, Base candidates, reconcile pairs, Group Parallels entries — a " +
        "named insert that is itself a parallel, a named parallel holding parallels, a row named twice — " +
        "entity-review players / teams / leagues, SportLots review rows, card-number conflicts) with marketplace " +
        "ids and candidates; a fill-in template; and confirmPhrase, the exact string nb_apply needs. A card " +
        'conflict is answered in pairing.conflicts with choose "bsc" or "sportlots", or, when the matched pair is ' +
        "two different cards sharing a number, by listing it in pairing.unlink (both cards are then kept apart). " +
        "Group Parallels' group.topLevel moves a grouped row back out as its own set. It reports " +
        "the moves a variant type's group would make and each insert's parallels to build. Wizard rows for a " +
        "checklist that has not been fetched yet cannot be planned; they appear when nb_apply runs. " +
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

  server.registerTool(
    "nb_draft_set",
    {
      title: "Draft a whole set's build spec",
      description:
        "Read-only on NB data (it reads both marketplaces through the server's previews; an adapter may refresh " +
        "a marketplace session, as any fetch does). Drafts the complete set-build spec for one set: variant types, " +
        "the Base mapping, every Insert/Parallel reconcile pair, Group Parallels nesting, every checklist with its " +
        "Match Cards answers and entity-review proposals, and every parallel build. Returns template (the spec with a " +
        "<…> fill-in per open decision) while anything is open, else spec; proposals (what was filled and why); " +
        "openDecisions (what the operator must answer: Base candidates when there is no sole or pre-selected one, card " +
        "conflicts (a side, or pairing.unlink when the pair is two different cards), any name with existing NB " +
        "candidates, a review name that rides on an unanswered card conflict, a " +
        "checklist the draft could not preview); leftUnasked; notes; marketplaceCalls; and confirmPhrase only when " +
        "nothing is open. Each variant type's sync.pending lists every marketplace set nobody pairs as an explicit " +
        "\"leave\" with the marketplace's name for it, so sets that belong together can be paired from the draft " +
        "(\"own-set\" is never proposed). SportLots lists a whole brand-year: its sets outside the set's SportLots " +
        "filter (other products) and sets another variant type pairs are not listed, only counted in leftUnasked, and " +
        'apply leaves them in Pending. detail "summary" (the default) cuts proposals, steps, notes and the ' +
        'leftUnasked samples to the first few and says what it cut; detail "full" returns every entry (it drafts ' +
        "again). An unknown set comes back as status \"unresolved\" with candidates (and, when the brand's year or " +
        "its Sets were never synced, the prepare spec); nothing is created. Slow on a big set (minutes): it previews " +
        "every checklist. " +
        WORKFLOW,
      inputSchema: {
        path: setPathSchema,
        checklists: z.boolean().optional().describe("Preview every checklist (default true)."),
        builds: z.boolean().optional().describe("Add parallel build entries (default true)."),
        teamLookupBudget: z
          .number()
          .int()
          .min(0)
          .max(MAX_TEAM_LOOKUP_BUDGET)
          .optional()
          .describe("Cards the draft may send to BSC's per-card team lookup in total (default 2000; 0 = none)."),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            'How much the result lists. "summary" (default): the template or spec and every open decision in full, ' +
              'the other lists cut to the first few with complete counts. "full": every entry.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, checklists, builds, teamLookupBudget, detail }) =>
      run(
        ctx.secrets,
        async () =>
          compactDraftReport(
            await read.draftSet(toPath(path) as Parameters<SetBuildRead["draftSet"]>[0], {
              ...(checklists !== undefined ? { checklists } : {}),
              ...(builds !== undefined ? { builds } : {}),
              ...(teamLookupBudget !== undefined ? { teamLookupBudget } : {}),
            }),
            detail ?? "summary",
          ),
        // One line: a big set's draft is mostly structure, and indentation was a third of it.
        { indent: 0 },
      ),
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
        "WRITES to NeonBinder. Runs a set-build spec: syncs, maps Base, reconciles variants, groups parallels, " +
        "fetches, commits and builds (from Base, and each insert's parallels from the insert), skipping every " +
        "step whose state already matches, so a re-run is safe. Requires confirm to equal the confirmPhrase " +
        "nb_plan returned for the same spec; call nb_plan first and let the operator see it. stopAt \"end\" " +
        "(the default) runs every step that does not depend on an unanswered decision and returns ALL of them " +
        "(stops, openDecisions, one template); stopAt \"first\" stops at the first. A parallel build that " +
        "shares no card number with its insert comes back as an open decision (no-shared-numbers): it is probably " +
        "its own insert, and group.topLevel keeps it its own set. Take the decisions to the " +
        "operator, put the answers in the spec, plan and apply again.",
      inputSchema: {
        ...specInputShape,
        confirm,
        stopAt: z
          .enum(["first", "end"])
          .optional()
          .describe(
            'Where to stop at an unanswered decision. "end" (default): carry on with everything that does not ' +
              'depend on it and return every decision together. "first": stop at the first one.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ confirm: given, stopAt, ...input }) =>
      run(ctx.secrets, async () => {
        const spec = await loadSpec(input, ctx);
        if (!specScope(spec)) throw new SpecInputError("The spec declares no scope; nb_plan explains what is wrong with it.");
        // Parsing is local; the phrase carries the parsed spec's digest. stopAt
        // is not in it: it changes how far a run goes, not what the spec allows.
        assertPhrase(specConfirmPhrase(getTarget(), parseSpec(spec)), given);
        return write.apply(spec, given, { stopAt: stopAt ?? "end" });
      }),
  );

  server.registerTool(
    "nb_decide",
    {
      title: "Answer an entity review (writes)",
      description:
        "WRITES. Answers the entity review a checklist is waiting on (see nb_review_items): for each player, " +
        'team or league by its exact name, "create", "skip", or {"link": "<existing NB name>"}. A player link may ' +
        'add "birthYear" to pick one of several NB players sharing the name. Teams may carry ' +
        "location (the place or sponsor the name begins with) and league; a league \"create\" must carry its level (major, minor, college, international, " +
        "independent or other). row names the checklist (variant type + row name); omit it for the Base row. Only " +
        "answers the operator gave; an unanswered item stays open. confirm is BUILD <convex host> " +
        "<sport>/<year>/<manufacturer>/<set> <digest>, the digest binding it to these exact answers; a call " +
        "without it returns the exact phrase to show the operator with the answers.",
      inputSchema: {
        path: setPathSchema,
        row: z
          .object({ type: z.string().min(1), name: z.string().min(1) })
          .strict()
          .optional()
          .describe("The checklist's variant type title and row name. Omit for Base."),
        players: z.array(playerDecision).optional(),
        teams: z.array(teamDecision).optional(),
        leagues: z.array(leagueDecision).optional(),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, confirm: given, row, players, teams, leagues }) =>
      run(ctx.secrets, async () => {
        const setPath = toPath(path) as Parameters<SetBuildWrite["decide"]>[0];
        const decisions = { row, players, teams, leagues };
        assertPhrase(decideConfirmPhrase(getTarget(), setPath, decisions), given);
        return write.decide(setPath, decisions, given);
      }),
  );

  server.registerTool(
    "nb_build_parallel",
    {
      title: "Build a parallel from Base (writes)",
      description:
        "WRITES. Builds one Parallel row's checklist from the set's Base checklist, as the Set Builder's " +
        '"Build from Base" does. name is the exact Parallel row name. A row that already has cards is skipped ' +
        "unless rebuild is true. confirm is BUILD <convex host> <sport>/<year>/<manufacturer>/<set> <digest>, " +
        "the digest binding it to this row and rebuild flag; a call without it returns the exact phrase to show " +
        "the operator.",
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
        const o = rebuild === undefined ? {} : { rebuild };
        assertPhrase(buildParallelConfirmPhrase(getTarget(), setPath, rowName, o), given);
        return write.buildParallel(setPath, rowName, o, given);
      }),
  );

  server.registerTool(
    "nb_sl_review_apply",
    {
      title: "Apply SportLots set review (writes)",
      description:
        "WRITES. Applies SportLots set-review decisions at a brand-year (see nb_review_items). Each row is " +
        'named by its SportLots id: {"slId", "placement": "own-set"} makes it its own set; {"slId", "set", ' +
        '"variantType", "name"?} places it under an existing NB set. Every row in the review must be answered: ' +
        "if any row is unanswered or unknown, nothing is saved and the open rows come back. Nothing is applied " +
        "by position. confirm is BUILD <convex host> <sport>/<year>/<manufacturer> <digest>, the digest binding " +
        "it to these exact decisions; a call without it returns the exact phrase to show the operator.",
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
        assertPhrase(slReviewConfirmPhrase(getTarget(), byPath, decisions), given);
        return write.slReviewApply(byPath, decisions, given);
      }),
  );
}

/** Register all eight tools. */
export function registerTools(server: McpServer, service: SetBuildService, opts: RegisterToolsOptions = {}): void {
  const ctx: Ctx = {
    secrets: opts.secrets ?? secretValues(process.env),
    cwd: opts.cwd ?? process.env.INIT_CWD ?? process.cwd(),
    readSpecFile: opts.readSpecFile ?? defaultReadSpecFile,
    resolveSpecPath:
      opts.resolveSpecPath ?? ((p) => containedSpecPath(p, [REPO_ROOT, process.env.INIT_CWD])),
  };
  registerReadTools(server, service.read, ctx);
  // A getter, not the value: a service whose connection failed to resolve
  // throws from `target`, and that must surface as a tool error, not here.
  registerWriteTools(server, service.write, () => service.target, ctx);
}
