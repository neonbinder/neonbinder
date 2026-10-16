/**
 * NEO-339 — the runner's CLI commands: inspect, plan, apply,
 * decisions-template, schema, confirm-phrase, draft-set, build-set.
 * Registered in `cli.ts`'s `COMMANDS`.
 *
 * Exit codes (beside cli.ts's 0 / 1 / 2): `apply` exits 3 when it stopped at a
 * decision the spec does not answer — the run is resumable, the template is
 * printed, and nothing is wrong with the tool.
 *
 * `apply` with `--auth machine` (production) never takes `--confirm`: the
 * operator types the phrase at an interactive prompt, and without a terminal
 * the command refuses. A script or an agent's shell therefore cannot write to
 * production through the CLI; the MCP tools, which Claude Code asks the
 * operator about on every call, are the only unattended path.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { CommandContext, CommandSpec } from "../cli";
import { scrub } from "../auth/token-source";
import { secretValues } from "../client/connect";
import { makeClient, type NbClient } from "../client/convex-client";
import { contentDigest, parseTarget } from "../client/target";
import {
  countOpenDecisions,
  isSetPath,
  MAX_TEAM_LOOKUP_BUDGET,
  specConfirmPhrase,
  type ApplyReport,
  type DraftedReport,
  type DraftOptions,
  type DraftReport,
  type NodePath,
  type PlanReport,
  type SetPath,
} from "../service";
import { parseSpec, specJsonSchema } from "../spec/schema";
import { applySpec, confirmedSpec, publicApplyReport } from "./apply";
import { compactDraftReport, draftSet, placeholdersIn, type CompactDraftReport, type DraftDetail } from "./draft";
import { RunFailed } from "./engine";
import { inspectPath } from "./inspect";
import { planSpec } from "./plan";
import { reportJson, reportMarkdown, writeReportFiles } from "./report";

/** Exit code: apply stopped at an open decision. */
export const EXIT_STOPPED = 3;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** `Baseball/2024/Topps/Topps Chrome` → a path. A set name may itself hold "/": everything after the third is the set. */
export function parsePathArg(raw: string): NodePath {
  const parts = raw.split("/");
  const [sport, year, manufacturer] = parts.slice(0, 3).map((p) => p.trim());
  if (parts.length < 3 || !sport || !year || !manufacturer) {
    throw new UsageError(`"${raw}" is not a path: give Sport/Year/Manufacturer or Sport/Year/Manufacturer/Set.`);
  }
  const set = parts.slice(3).join("/").trim();
  return set ? { sport, year, manufacturer, set } : { sport, year, manufacturer };
}

async function readSpecFile(path: string | undefined): Promise<unknown> {
  if (!path) throw new UsageError("Pass --spec <file.json>.");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`Could not read --spec ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--spec ${path} is not JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
}

async function withClient<T>(ctx: CommandContext, run: (client: NbClient, conn: ReturnType<CommandContext["connect"]>) => Promise<T>): Promise<T> {
  const conn = ctx.connect();
  const client = makeClient(conn.target, conn.tokens, { transport: conn.transport });
  try {
    return await run(client, conn);
  } finally {
    await client.close();
  }
}

async function usageGuard(ctx: CommandContext, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.io.stderr(`setbuild: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

/** The secret values to scrub from anything this command prints or writes. */
function secretsOf(ctx: CommandContext): string[] {
  return secretValues(ctx.io.env);
}

function printReport(ctx: CommandContext, r: PlanReport): void {
  ctx.io.stdout(scrub(ctx.json ? reportJson(r).trimEnd() : reportMarkdown(r).trimEnd(), secretsOf(ctx)));
}

/** `--paused-platforms`, else env `PAUSED_PLATFORMS`. An explicit "" means nothing is paused. */
function pausedPlatforms(ctx: CommandContext): string | undefined {
  const flag = ctx.values["paused-platforms"];
  return typeof flag === "string" ? flag : ctx.io.env.PAUSED_PLATFORMS;
}

const PAUSED_OPTION = { "paused-platforms": { type: "string" } } as const;

// ---------------------------------------------------------------------------

export const inspectCommand: CommandSpec = {
  summary: "Show what a path holds: sets under a brand-year, or a set's Base and variant rows with card counts.",
  usage: "setbuild inspect <Sport/Year/Manufacturer[/Set]> [--json] [connection flags]",
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const raw = ctx.positionals[0];
      if (!raw) throw new UsageError("inspect needs a path, e.g. Baseball/2024/Topps/Topps Chrome.");
      const path = parsePathArg(raw);
      const report = await withClient(ctx, (client, conn) => inspectPath(client, conn.target, path));
      if (ctx.json) {
        ctx.io.stdout(JSON.stringify(report, null, 2));
        return report.found ? 0 : 1;
      }
      if (!report.found) {
        ctx.io.stdout(`${report.pathText}: not found`);
        return 1;
      }
      const links = (l: { buysportscards: string[]; sportlots: string[] }) =>
        `BSC ${l.buysportscards.length ? l.buysportscards.join(",") : "-"} · SL ${l.sportlots.length ? l.sportlots.join(",") : "-"}`;
      ctx.io.stdout(report.pathText);
      for (const s of report.sets ?? []) ctx.io.stdout(`  ${s.name}  (${links(s.links)})`);
      for (const t of report.variantTypes ?? []) {
        ctx.io.stdout(`  ${t.type}${t.rows.length === 1 && t.rows[0].isBase ? "" : ` — ${t.rows.length} rows`}`);
        for (const r of t.rows) {
          ctx.io.stdout(`    ${r.isBase ? "[Base] " : ""}${r.name}: ${r.cards} cards (${links(r.links)})`);
          for (const p of r.parallels ?? []) ctx.io.stdout(`      ↳ ${p.name}: ${p.cards} cards (${links(p.links)})`);
        }
      }
      return 0;
    }),
};

export const planCommand: CommandSpec = {
  summary: "Read-only: every step of a spec, what is done, and every decision it still has to make.",
  usage:
    "setbuild plan --spec <file.json> [--paused-platforms <keys>] [--report <out.json>] [--json] [connection flags]",
  options: { spec: { type: "string" }, report: { type: "string" }, ...PAUSED_OPTION },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const spec = await readSpecFile(str(ctx.values.spec));
      const report = await withClient(ctx, (client, conn) =>
        planSpec(client, conn.target, spec, { pausedPlatforms: pausedPlatforms(ctx) }),
      );
      const out = str(ctx.values.report);
      if (out) await writeReportFiles(out, report, secretsOf(ctx));
      printReport(ctx, report);
      return 0;
    }),
};

/** Ask for the phrase at the terminal. Undefined when stdin is not interactive. */
async function promptConfirm(ctx: CommandContext, expected: string, host: string): Promise<string | undefined> {
  if (!ctx.io.prompt) return undefined;
  ctx.io.stderr(`This run WRITES to ${host}. Type the confirm phrase to go on:\n  ${expected}`);
  return (await ctx.io.prompt("> ")).trim();
}

/** The message `apply --auth machine` refuses with when there is no terminal to prompt on. */
export const MACHINE_NEEDS_TTY =
  "apply with --auth machine (production) runs only in an interactive terminal: it ignores --confirm and asks " +
  "for the confirm phrase at a prompt. Production writes are run by the operator in a terminal, or through the " +
  "MCP tools (nb_apply), which ask the operator on every call.";

export const applyCommand: CommandSpec = {
  summary:
    'WRITES: run a spec. Needs --confirm "BUILD <host> <scope> <digest>" (setbuild confirm-phrase prints it); with --auth machine, a terminal prompt instead. Stops (exit 3) at the first unanswered decision; with --collect, runs everything that does not depend on one and stops (exit 3) with all of them.',
  usage:
    'setbuild apply --spec <file.json> --confirm "BUILD <host> <scope> <digest>" [--collect] [--paused-platforms <keys>] [--report <out.json>] [--json] [connection flags]',
  options: {
    spec: { type: "string" },
    confirm: { type: "string" },
    report: { type: "string" },
    collect: { type: "boolean" },
    ...PAUSED_OPTION,
  },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const spec = await readSpecFile(str(ctx.values.spec));
      const conn = ctx.connect();
      // Parsing is local; the phrase carries the parsed spec's digest.
      const expected = specConfirmPhrase(conn.target, parseSpec(spec));
      let confirm: string | undefined;
      if (conn.auth === "machine") {
        if (str(ctx.values.confirm) !== undefined) {
          ctx.io.stderr("setbuild: --confirm is ignored with --auth machine; the phrase is typed at the prompt.");
        }
        if (!ctx.io.prompt) throw new UsageError(MACHINE_NEEDS_TTY);
        confirm = await promptConfirm(ctx, expected, conn.target.host);
      } else {
        confirm = str(ctx.values.confirm);
        if (confirm === undefined) confirm = await promptConfirm(ctx, expected, conn.target.host);
        if (confirm === undefined) throw new UsageError(`apply writes; pass --confirm "${expected}".`);
      }
      const out = str(ctx.values.report);
      // The phrase is checked BEFORE the client exists: creating it starts the
      // token mint, which is already a network call.
      confirmedSpec(conn.target, spec, confirm);
      const client = makeClient(conn.target, conn.tokens, { transport: conn.transport });
      try {
        const report = publicApplyReport(
          await applySpec(client, conn.target, spec, confirm, {
            pausedPlatforms: pausedPlatforms(ctx),
            // The phrase does not cover it: it changes how far the run goes, not what the spec allows.
            stopAt: ctx.values.collect === true ? "end" : "first",
          }),
        );
        if (out) await writeReportFiles(out, report, secretsOf(ctx));
        printReport(ctx, report);
        if (report.stoppedAt) {
          if (!ctx.json && report.template) {
            ctx.io.stdout("\nFill-in spec (answer every <…> and run again):");
            ctx.io.stdout(JSON.stringify(report.template, null, 2));
          }
          return EXIT_STOPPED;
        }
        return 0;
      } catch (err) {
        if (err instanceof RunFailed) {
          // The report so far, so the operator (and the CI artifact) sees how
          // far the run got before the error, which is then reported as usual.
          const { sessions: _sessions, ...partial } = err.report as typeof err.report & { sessions?: unknown };
          void _sessions;
          const report = {
            ...partial,
            counts: partial.counts ?? { built: 0, committed: 0, skipped: 0 },
            durationMs: partial.durationMs ?? 0,
            stoppedAt: { step: -1, reason: `failed: ${err.message}` },
          };
          if (out) await writeReportFiles(out, report, secretsOf(ctx));
          printReport(ctx, report);
        }
        throw err;
      } finally {
        await client.close();
      }
    }),
};

export const decisionsTemplateCommand: CommandSpec = {
  summary: "Print a spec with every open decision as a fill-in: from a plan (--spec) or from an apply report (--from-report).",
  usage:
    "setbuild decisions-template (--spec <file.json> | --from-report <report.json>) [--paused-platforms <keys>] [connection flags]",
  options: { spec: { type: "string" }, "from-report": { type: "string" }, ...PAUSED_OPTION },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const fromReport = str(ctx.values["from-report"]);
      let report: Pick<PlanReport, "template" | "openDecisions">;
      if (fromReport) {
        report = (await readSpecFile(fromReport)) as PlanReport;
        if (!report || typeof report !== "object" || !("openDecisions" in report)) {
          throw new UsageError(`${fromReport} is not a setbuild plan/apply report.`);
        }
      } else {
        const spec = await readSpecFile(str(ctx.values.spec));
        report = await withClient(ctx, (client, conn) =>
          planSpec(client, conn.target, spec, { pausedPlatforms: pausedPlatforms(ctx) }),
        );
      }
      const n = countOpenDecisions(report.openDecisions);
      if (n === 0 || !report.template) {
        ctx.io.stderr("No open decisions: the spec answers everything this run could see.");
        return 0;
      }
      ctx.io.stderr(`${n} open decision${n === 1 ? "" : "s"}; fill in every <…>:`);
      ctx.io.stdout(JSON.stringify(report.template, null, 2));
      return 0;
    }),
};

export const schemaCommand: CommandSpec = {
  summary: "Print the spec's JSON Schema.",
  usage: "setbuild schema",
  async run(ctx) {
    ctx.io.stdout(JSON.stringify(specJsonSchema(), null, 2));
    return 0;
  },
};

export const confirmPhraseCommand: CommandSpec = {
  summary: "Offline: print the confirm phrase apply / nb_apply need for a spec on a deployment. No network call.",
  usage: "setbuild confirm-phrase --spec <file.json> --convex-url <url> [--json]",
  options: { spec: { type: "string" } },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const raw = await readSpecFile(str(ctx.values.spec));
      const convexUrl = str(ctx.values["convex-url"]) ?? str(ctx.io.env.NB_SETBUILD_CONVEX_URL);
      if (!convexUrl) throw new UsageError("Pass --convex-url <https://<deployment>.convex.cloud>.");
      // parseTarget and parseSpec are pure; nothing here signs in or connects.
      const target = parseTarget(convexUrl);
      const spec = parseSpec(raw);
      const phrase = specConfirmPhrase(target, spec);
      ctx.io.stdout(
        ctx.json
          ? JSON.stringify({ phrase, host: target.host, scope: spec.scope, digest: contentDigest(spec) }, null, 2)
          : phrase,
      );
      return 0;
    }),
};

// ---------------------------------------------------------------------------
// draft-set / build-set (NEO-339 part B)
// ---------------------------------------------------------------------------

const DRAFT_OPTIONS = {
  path: { type: "string" },
  "skip-checklists": { type: "boolean" },
  "skip-builds": { type: "boolean" },
  "team-lookup-budget": { type: "string" },
  detail: { type: "string" },
} as const;

function setPathFlag(ctx: CommandContext): SetPath {
  const raw = str(ctx.values.path);
  if (!raw) throw new UsageError("Pass --path Sport/Year/Manufacturer/Set.");
  const path = parsePathArg(raw);
  if (!isSetPath(path)) throw new UsageError(`--path ${raw} names a brand-year; a draft needs a set (Sport/Year/Manufacturer/Set).`);
  return path;
}

/** `--detail summary|full` (default summary): how much the printed draft lists, as nb_draft_set's `detail`. */
function draftDetail(ctx: CommandContext): DraftDetail {
  const raw = str(ctx.values.detail);
  if (raw === undefined) return "summary";
  if (raw !== "summary" && raw !== "full") throw new UsageError('--detail must be "summary" or "full".');
  return raw;
}

function draftOptions(ctx: CommandContext): DraftOptions {
  const budgetRaw = str(ctx.values["team-lookup-budget"]);
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 0 || budget > MAX_TEAM_LOOKUP_BUDGET)) {
    throw new UsageError(`--team-lookup-budget must be an integer from 0 to ${MAX_TEAM_LOOKUP_BUDGET}.`);
  }
  return {
    ...(ctx.values["skip-checklists"] === true ? { checklists: false } : {}),
    ...(ctx.values["skip-builds"] === true ? { builds: false } : {}),
    ...(budget !== undefined ? { teamLookupBudget: budget } : {}),
  };
}

/** A draft for a person: the plan-style report, then the proposals and notes. */
export function draftMarkdown(r: DraftReport | CompactDraftReport): string {
  if (r.status === "unresolved") {
    const lines = [
      `## setbuild draft-set: ${r.pathText}`,
      "",
      `**Not found.** ${r.message}`,
      ...(r.candidates.length ? ["", "Did you mean:", ...r.candidates.map((c) => `- ${c.name}`)] : []),
      ...(r.prepare ? ["", r.prepare.reason, "", "```json", JSON.stringify(r.prepare.spec, null, 2), "```"] : []),
    ];
    return `${lines.join("\n")}\n`;
  }
  const head = reportMarkdown({
    target: r.target,
    scope: r.scope,
    confirmPhrase: r.confirmPhrase ?? "(none yet: answer the open decisions first)",
    steps: r.steps,
    openDecisions: r.openDecisions,
    template: r.template,
  }).replace(/^## setbuild plan:/, "## setbuild draft-set:");
  const total = r.summary ? Object.values(r.summary.proposalCounts).reduce((n, c) => n + c, 0) : r.proposals.length;
  const out = [head.trimEnd(), "", `### ${total} proposal${total === 1 ? "" : "s"} (filled by the draft; read them before approving)`, ""];
  for (const p of r.proposals) out.push(`- \`${p.at}\` ${p.kind}: ${p.detail}`);
  if (r.summary && r.summary.omitted.proposals > 0) {
    const counts = Object.entries(r.summary.proposalCounts).map(([k, n]) => `${k} ${n}`).join(", ");
    out.push(`- … and ${r.summary.omitted.proposals} more (${counts})`);
  }
  for (const l of r.leftUnasked ?? []) {
    const sample = l.outsideScopeSets.map((o) => `${o.id} ${o.name}`).join("; ");
    out.push(
      `- \`${l.at}\` not asked: ${l.outsideScope} SportLots set(s) outside this set's SportLots filter` +
        `${sample ? ` (${sample}${l.outsideScopeSets.length < l.outsideScope ? "; …" : ""})` : ""}, ${l.pairedElsewhere} another variant type pairs`,
    );
  }
  if (r.notes.length) out.push("", "### Notes", "", ...r.notes.map((n) => `- ${n}`));
  if (r.summary) out.push("", r.summary.hint);
  out.push("", `Marketplace requests: ${r.marketplaceCalls} · ${(r.durationMs / 1000).toFixed(1)}s`);
  return `${out.join("\n")}\n`;
}

/** What an operator edits or applies: the template while anything is open, else the spec. */
function draftFile(r: DraftedReport): Record<string, unknown> {
  return r.template ?? r.spec;
}

export const draftSetCommand: CommandSpec = {
  summary:
    "Read-only on NB data: draft a whole set's spec from the server previews. Writes the spec (or, with open decisions, its fill-in template) to --out. Exit 3 when something needs an answer.",
  usage:
    "setbuild draft-set --path <Sport/Year/Manufacturer/Set> --out <file.json> [--skip-checklists] [--skip-builds] [--team-lookup-budget <n>] [--detail summary|full] [--report <draft.json>] [--json] [connection flags]",
  options: { ...DRAFT_OPTIONS, out: { type: "string" }, report: { type: "string" } },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const path = setPathFlag(ctx);
      const out = str(ctx.values.out);
      if (!out) throw new UsageError("Pass --out <file.json> for the drafted spec.");
      const opts = draftOptions(ctx);
      const detail = draftDetail(ctx);
      const report = await withClient(ctx, (client, conn) => draftSet(client, conn.target, path, opts));
      const secrets = secretsOf(ctx);
      const reportPath = str(ctx.values.report);
      // The files are always whole; what is printed follows --detail, as nb_draft_set's result does.
      if (reportPath) await writeFile(reportPath, scrub(`${JSON.stringify(report, null, 2)}\n`, secrets), "utf8");
      if (report.status === "drafted") await writeFile(out, scrub(`${JSON.stringify(draftFile(report), null, 2)}\n`, secrets), "utf8");
      const shown = compactDraftReport(report, detail);
      ctx.io.stdout(scrub(ctx.json ? JSON.stringify(shown, null, 2) : draftMarkdown(shown).trimEnd(), secrets));
      if (report.status === "drafted" && !ctx.json) {
        ctx.io.stdout(
          report.openCount > 0
            ? `\nWrote the fill-in template to ${out}: answer every <…>, then plan and apply it.`
            : `\nWrote the spec to ${out}.`,
        );
      }
      return report.status === "drafted" && report.openCount === 0 ? 0 : EXIT_STOPPED;
    }),
};

/** The message `build-set` refuses with when there is no terminal. */
export const BUILD_SET_NEEDS_TTY =
  "build-set runs only in an interactive terminal: it shows the draft and asks for the confirm phrase before each " +
  "write. Without a terminal, use draft-set, then plan and apply (or the MCP tools, which ask the operator on every write).";

/** Wait for the operator to answer every <…> in `file`; undefined when they stop. */
async function answeredSpec(ctx: CommandContext, file: string): Promise<unknown | undefined> {
  for (;;) {
    const answer = (await ctx.io.prompt!(`Answer every <…> in ${file}, save it, then press Enter (q to stop): `)).trim();
    if (answer.toLowerCase() === "q") return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      ctx.io.stderr(`${file} is not JSON yet.`);
      continue;
    }
    const left = placeholdersIn(raw);
    if (left.length > 0) {
      ctx.io.stderr(`${left.length} fill-in(s) still open: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ", …" : ""}`);
      continue;
    }
    try {
      parseSpec(raw);
    } catch (err) {
      ctx.io.stderr(err instanceof Error ? err.message : String(err));
      continue;
    }
    return raw;
  }
}

export const buildSetCommand: CommandSpec = {
  summary:
    "WRITES, interactively: draft a set, show the draft, ask for the confirm phrase, apply --collect, then ask for the answers to anything only the run could see and apply again. Terminal only.",
  usage:
    "setbuild build-set --path <Sport/Year/Manufacturer/Set> [--out <file.json>] [--skip-checklists] [--skip-builds] [--team-lookup-budget <n>] [--detail summary|full] [--paused-platforms <keys>] [connection flags]",
  options: { ...DRAFT_OPTIONS, out: { type: "string" }, ...PAUSED_OPTION },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      // A person approves every write here: refuse before anything connects.
      if (!ctx.io.prompt) throw new UsageError(BUILD_SET_NEEDS_TTY);
      const path = setPathFlag(ctx);
      const opts = draftOptions(ctx);
      const detail = draftDetail(ctx);
      const file = str(ctx.values.out) ?? `${formatSlug(path)}.build.json`;
      const secrets = secretsOf(ctx);
      return withClient(ctx, async (client, conn) => {
        const draft = await draftSet(client, conn.target, path, opts);
        ctx.io.stdout(scrub(draftMarkdown(compactDraftReport(draft, detail)).trimEnd(), secrets));
        if (draft.status === "unresolved") return EXIT_STOPPED;
        await writeFile(file, scrub(`${JSON.stringify(draftFile(draft), null, 2)}\n`, secrets), "utf8");
        let spec: unknown = draft.spec;
        if (draft.openCount > 0) {
          ctx.io.stderr(`\n${draft.openCount} open decision(s); the fill-in template is in ${file}.`);
          spec = await answeredSpec(ctx, file);
          if (spec === undefined) return EXIT_STOPPED;
        } else {
          ctx.io.stderr(`\nThe drafted spec is in ${file}.`);
        }
        for (;;) {
          const expected = specConfirmPhrase(conn.target, parseSpec(spec));
          const confirm = await promptConfirm(ctx, expected, conn.target.host);
          confirmedSpec(conn.target, spec, confirm);
          const report: ApplyReport = publicApplyReport(
            await applySpec(client, conn.target, spec, confirm, { pausedPlatforms: pausedPlatforms(ctx), stopAt: "end" }),
          );
          printReport(ctx, report);
          if (!report.stoppedAt) return 0;
          if (!report.template) return EXIT_STOPPED;
          await writeFile(file, scrub(`${JSON.stringify(report.template, null, 2)}\n`, secrets), "utf8");
          ctx.io.stderr(`\nThe run collected ${countOpenDecisions(report.openDecisions)} decision(s) it could only see once it wrote; the fill-in template is in ${file}.`);
          spec = await answeredSpec(ctx, file);
          if (spec === undefined) return EXIT_STOPPED;
        }
      });
    }),
};

function formatSlug(p: SetPath): string {
  return [p.sport, p.year, p.manufacturer, p.set].join("-").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

export const RUNNER_COMMANDS: Record<string, CommandSpec> = {
  inspect: inspectCommand,
  plan: planCommand,
  apply: applyCommand,
  "decisions-template": decisionsTemplateCommand,
  schema: schemaCommand,
  "confirm-phrase": confirmPhraseCommand,
  "draft-set": draftSetCommand,
  "build-set": buildSetCommand,
};
