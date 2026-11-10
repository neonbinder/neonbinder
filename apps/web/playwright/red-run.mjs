#!/usr/bin/env node
// Line up a red E2E run's browser and server sides, per failed test (NEO-398).
//
//   node playwright/red-run.mjs <run-id> [--out <dir>] [--window <seconds>]
//
// Downloads the run's `pw-report-*` and `convex-logs-*` artifacts through
// `gh api` (the artifacts zip endpoint works where `gh run download` does
// not), then prints, for every failed test: its title and file, the tail of
// the browser's `client-wire.log` (support/wire-log.ts), and the Convex
// completions the preview recorded in the test's last seconds, slowest
// first. Read-only; nothing is re-run or posted.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "neonbinder/neonbinder";
const args = process.argv.slice(2);
const runId = args.find((a) => /^\d+$/.test(a));
if (!runId) {
  console.error("usage: node playwright/red-run.mjs <run-id> [--out <dir>] [--window <seconds>]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const out = opt("--out", join(tmpdir(), `red-run-${runId}`));
const windowS = Number(opt("--window", "20"));
mkdirSync(out, { recursive: true });

const gh = (path, binary = false) =>
  execFileSync("gh", ["api", path], { maxBuffer: 1 << 30, encoding: binary ? "buffer" : "utf8" });

// 1. Artifacts of the run.
const list = JSON.parse(gh(`repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
const wanted = list.filter((a) => /^(pw-report-|convex-logs-)/.test(a.name) && !a.expired);
if (wanted.length === 0) {
  console.error(`run ${runId}: no pw-report-* / convex-logs-* artifacts (expired, or not an E2E run)`);
  process.exit(1);
}
const unzip = (zipPath, dir) => {
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-oq", zipPath, "-d", dir]);
};
for (const a of wanted) {
  const dir = join(out, a.name);
  try {
    if (readdirSync(dir).length > 0) continue; // already fetched
  } catch {}
  const zip = join(out, `${a.name}.zip`);
  writeFileSync(zip, gh(`repos/${REPO}/actions/artifacts/${a.id}/zip`, true));
  unzip(zip, dir);
}

// 2. Walk every blob report: test titles, failed results, their attachments.
const walk = (dir, acc = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};
const failures = [];
for (const a of wanted.filter((a) => a.name.startsWith("pw-report-"))) {
  const dir = join(out, a.name);
  for (const blob of walk(dir).filter((p) => /blob\/report-.*\.zip$/.test(p))) {
    const bdir = `${blob}.d`;
    unzip(blob, bdir);
    const titles = new Map(); // testId -> { title, file, project }
    const visit = (suite, project, chain) => {
      const here = suite.title && suite.title !== suite.location?.file ? [...chain, suite.title] : chain;
      for (const e of suite.entries ?? []) {
        if (e.testId) titles.set(e.testId, { title: [...here, e.title].join(" › "), file: suite.location?.file ?? "", project });
        else visit(e, project, here);
      }
    };
    const results = new Map(); // resultId -> { testId, startTime, attachments[] }
    for (const line of readFileSync(join(bdir, "report.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.method === "onProject") visit(e.params.project.suites ? { entries: e.params.project.suites } : e.params.project, e.params.project.name, []);
      if (e.method === "onTestBegin") results.set(e.params.result.id, { testId: e.params.testId, startTime: e.params.result.startTime, attachments: [] });
      if (e.method === "onAttach") results.get(e.params.resultId)?.attachments.push(...e.params.attachments);
      if (e.method === "onTestEnd" && e.params.result.status !== "passed" && e.params.result.status !== "skipped") {
        const r = results.get(e.params.result.id);
        if (!r) continue;
        const t = titles.get(r.testId) ?? { title: r.testId, file: "", project: "" };
        const text = (att) => (att.base64 ? Buffer.from(att.base64, "base64").toString("utf8") : att.path ? readFileSync(join(bdir, att.path), "utf8") : "");
        const wire = r.attachments.find((x) => x.name === "client-wire.log");
        failures.push({
          artifact: a.name,
          ...t,
          status: e.params.result.status,
          start: r.startTime,
          end: r.startTime + e.params.result.duration,
          error: (e.params.result.errors?.[0]?.message ?? "").split("\n").slice(0, 6).join("\n"),
          wire: wire ? text(wire).split("\n") : null,
        });
      }
    }
  }
}

// 3. Server completions (every shard's capture of the same preview, de-duplicated).
const completions = [];
const seen = new Set();
for (const a of wanted.filter((a) => a.name.startsWith("convex-logs-"))) {
  for (const f of walk(join(out, a.name)).filter((p) => /\.jsonl(\.gz)?$/.test(p))) {
    const raw = f.endsWith(".gz") ? gunzipSync(readFileSync(f)).toString("utf8") : readFileSync(f, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.startsWith("{")) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.kind !== "Completion" || !e.executionId || seen.has(e.executionId)) continue;
      seen.add(e.executionId);
      completions.push(e);
    }
  }
}
completions.sort((x, y) => x.timestamp - y.timestamp);

// 4. Report.
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 23);
console.log(`run ${runId}: ${failures.length} failed test result(s); ${completions.length} server completions captured`);
for (const f of failures) {
  console.log(`\n${"=".repeat(100)}\n${f.status.toUpperCase()}  ${f.title}\n  ${f.file} (${f.project}, ${f.artifact})  ${hhmmss(f.start)} → ${hhmmss(f.end)} UTC`);
  if (f.error) console.log(`  ${f.error.replace(/\n/g, "\n  ")}`);
  console.log(`\n  browser (client-wire.log, last 40 lines):`);
  if (!f.wire) console.log("    (none attached: the run predates NEO-398)");
  else for (const l of f.wire.slice(-40)) console.log(`    ${l}`);
  const lo = f.end / 1000 - windowS;
  const hi = f.end / 1000 + 1;
  const inWin = completions.filter((c) => c.timestamp >= lo && c.timestamp <= hi);
  const slow = [...inWin].sort((x, y) => (y.executionTime ?? 0) - (x.executionTime ?? 0)).slice(0, 15);
  console.log(`\n  server (last ${windowS} s of the test, ${inWin.length} completions on the preview; slowest 15, all users):`);
  if (completions.length === 0) console.log("    (no convex-logs-* artifacts in this run)");
  for (const c of slow) {
    console.log(
      `    ${hhmmss(c.executionTimestamp * 1000)} ${String((c.executionTime ?? 0).toFixed(3)).padStart(8)}s ${String(c.udfType).padEnd(8)} ${c.identifier}` +
        `  reads=${c.readDocs ?? 0} writes=${c.writeDocs ?? 0}${c.occInfo ? " OCC" : ""}${c.willRetry ? " RETRY" : ""}${c.error ? " ERROR" : ""}`,
    );
  }
  const errs = inWin.filter((c) => c.error || c.willRetry);
  if (errs.length) console.log(`    errors/retries in window: ${errs.map((c) => c.identifier).join(", ")}`);
}
console.log(`\nartifacts kept under ${out}`);
