/**
 * NEO-339 — the runner's CLI commands: inspect, plan, apply,
 * decisions-template, schema. Registered in `cli.ts`'s `COMMANDS`.
 *
 * Exit codes (beside cli.ts's 0 / 1 / 2): `apply` exits 3 when it stopped at a
 * decision the spec does not answer — the run is resumable, the template is
 * printed, and nothing is wrong with the tool.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { CommandContext, CommandSpec } from "../cli";
import { makeClient, type NbClient } from "../client/convex-client";
import { confirmPhrase } from "../client/target";
import { countOpenDecisions, specScope, type NodePath, type PlanReport } from "../service";
import { specJsonSchema } from "../spec/schema";
import { applySpec, confirmedSpec, publicApplyReport } from "./apply";
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

function printReport(ctx: CommandContext, r: PlanReport): void {
  ctx.io.stdout(ctx.json ? reportJson(r).trimEnd() : reportMarkdown(r).trimEnd());
}

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
        for (const r of t.rows) ctx.io.stdout(`    ${r.isBase ? "[Base] " : ""}${r.name}: ${r.cards} cards (${links(r.links)})`);
      }
      return 0;
    }),
};

export const planCommand: CommandSpec = {
  summary: "Read-only: every step of a spec, what is done, and every decision it still has to make.",
  usage: "setbuild plan --spec <file.json> [--report <out.json>] [--json] [connection flags]",
  options: { spec: { type: "string" }, report: { type: "string" } },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const spec = await readSpecFile(str(ctx.values.spec));
      const report = await withClient(ctx, (client, conn) => planSpec(client, conn.target, spec));
      const out = str(ctx.values.report);
      if (out) await writeReportFiles(out, report);
      printReport(ctx, report);
      return 0;
    }),
};

async function promptConfirm(ctx: CommandContext, expected: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    ctx.io.stderr(`This run WRITES. Type the confirm phrase to go on:\n  ${expected}`);
    return (await rl.question("> ")).trim();
  } finally {
    rl.close();
  }
}

export const applyCommand: CommandSpec = {
  summary: "WRITES: run a spec. Needs --confirm \"BUILD <convex host> <scope>\". Stops (exit 3) at the first unanswered decision.",
  usage: 'setbuild apply --spec <file.json> --confirm "BUILD <host> <scope>" [--report <out.json>] [--json] [connection flags]',
  options: { spec: { type: "string" }, confirm: { type: "string" }, report: { type: "string" } },
  run: (ctx) =>
    usageGuard(ctx, async () => {
      const spec = await readSpecFile(str(ctx.values.spec));
      const conn = ctx.connect();
      const scope = specScope(spec);
      let confirm = str(ctx.values.confirm);
      if (confirm === undefined && scope) confirm = await promptConfirm(ctx, confirmPhrase(conn.target, scope));
      if (confirm === undefined) {
        throw new UsageError(
          scope
            ? `apply writes; pass --confirm "${confirmPhrase(conn.target, scope)}".`
            : "The spec declares no scope; run plan to see what is wrong with it.",
        );
      }
      const out = str(ctx.values.report);
      // The phrase is checked BEFORE the client exists: creating it starts the
      // token mint, which is already a network call.
      confirmedSpec(conn.target, spec, confirm);
      const client = makeClient(conn.target, conn.tokens, { transport: conn.transport });
      try {
        const report = publicApplyReport(await applySpec(client, conn.target, spec, confirm));
        if (out) await writeReportFiles(out, report);
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
        if (err instanceof RunFailed && out) {
          // The report so far, so the CI artifact shows how far the run got.
          const { sessions: _sessions, ...partial } = err.report as typeof err.report & { sessions?: unknown };
          void _sessions;
          await writeReportFiles(out, {
            ...partial,
            counts: partial.counts ?? { built: 0, committed: 0, skipped: 0 },
            durationMs: partial.durationMs ?? 0,
            stoppedAt: { step: -1, reason: `failed: ${err.message}` },
          });
        }
        throw err;
      } finally {
        await client.close();
      }
    }),
};

export const decisionsTemplateCommand: CommandSpec = {
  summary: "Print a spec with every open decision as a fill-in: from a plan (--spec) or from an apply report (--from-report).",
  usage: "setbuild decisions-template (--spec <file.json> | --from-report <report.json>) [connection flags]",
  options: { spec: { type: "string" }, "from-report": { type: "string" } },
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
        report = await withClient(ctx, (client, conn) => planSpec(client, conn.target, spec));
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

export const RUNNER_COMMANDS: Record<string, CommandSpec> = {
  inspect: inspectCommand,
  plan: planCommand,
  apply: applyCommand,
  "decisions-template": decisionsTemplateCommand,
  schema: schemaCommand,
};
