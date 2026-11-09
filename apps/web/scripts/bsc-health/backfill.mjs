#!/usr/bin/env node
/**
 * NEO-475 — backfill the BSC health report from the last N days of PR Pipeline
 * runs.
 *
 *   node backfill.mjs --out <dir> --scratch <dir> [--days 14] [--repo owner/name]
 *
 * For each run it downloads the `convex-logs-*` artifacts with `gh` into
 * `<scratch>/<runId>`, parses them (deduped), appends the records to
 * `<out>/records.jsonl` tagged with the run id, conclusion and PR, deletes the
 * scratch copy, and at the end writes `hourly.csv`, `hourly.json` and
 * `summary.md` into `<out>`.
 *
 * Both directories must be OUTSIDE this repository: downloaded logs are
 * untrusted and may carry anything, and nothing here may be committed. The
 * script refuses a path inside the checkout.
 *
 * Limits: runs older than the artifact retention have none. Runs made before
 * NEO-475 have no bsc_call_* lines, so there are no headers, bodies or
 * card-listing success counts; only the legacy failure lines, adapter_sync_call,
 * bsc_seller_call and action Completions can be recovered.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLogs } from "./parse.mjs";
import { buildReport, writeReport } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

/** Throws when `target` is the repository or inside it. */
export function assertOutsideRepo(target, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(target);
  const rel = path.relative(repoRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`${resolved} is inside the repository; give a directory outside it`);
  }
  return resolved;
}

/** Lines of `gh api` JSON (one run per line) to run descriptors. */
export function parseRunLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r && typeof r.id === "number")
    .map((r) => ({
      id: r.id,
      attempt: r.run_attempt,
      conclusion: r.conclusion ?? "in_progress",
      createdAt: r.created_at,
      pr: r.pr ?? null,
    }));
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function listRuns({ repo, days, run = gh }) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const text = run([
    "api",
    "--paginate",
    `repos/${repo}/actions/workflows/pr-pipeline.yml/runs?created=>=${since}&per_page=100`,
    "--jq",
    ".workflow_runs[] | {id, run_attempt, conclusion, created_at, pr: (.pull_requests[0].number)}",
  ]);
  return parseRunLines(text);
}

async function main(argv) {
  let out;
  let scratch;
  let days = 14;
  let repo = "neonbinder/neonbinder";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--scratch") scratch = argv[++i];
    else if (argv[i] === "--days") days = Number(argv[++i]);
    else if (argv[i] === "--repo") repo = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out || !scratch || !Number.isFinite(days) || days <= 0) {
    console.error("usage: node backfill.mjs --out <dir> --scratch <dir> [--days 14] [--repo owner/name]");
    process.exit(2);
  }
  out = assertOutsideRepo(out);
  scratch = assertOutsideRepo(scratch);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });

  const runs = listRuns({ repo, days });
  console.error(`${runs.length} runs in the last ${days} days`);
  const recordsFile = path.join(out, "records.jsonl");
  fs.writeFileSync(recordsFile, "");
  const all = [];
  const seen = new Set(); // one set across runs: executionIds never repeat between runs
  const totals = { files: 0, lines: 0, badLines: 0, duplicates: 0 };
  let skipped = 0;
  for (const run of runs) {
    const dir = path.join(scratch, String(run.id));
    try {
      gh(["run", "download", String(run.id), "--repo", repo, "--pattern", "convex-logs-*", "--dir", dir]);
    } catch {
      skipped += 1; // expired or no logs artifact
      continue;
    }
    try {
      const { records, stats } = await parseLogs([dir], {
        meta: { env: "ci", runId: run.id, conclusion: run.conclusion, pr: run.pr, createdAt: run.createdAt },
        seen,
      });
      fs.appendFileSync(recordsFile, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
      all.push(...records);
      for (const k of Object.keys(totals)) totals[k] += stats[k];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.error(`${skipped} runs had no downloadable logs`);
  const report = buildReport(all, { env: "ci" });
  console.log(writeReport(report, out, { title: `BSC health, last ${days} days`, stats: totals }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
