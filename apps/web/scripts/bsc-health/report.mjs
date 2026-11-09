#!/usr/bin/env node
/**
 * NEO-475 — hourly BSC health report from parsed records.
 *
 *   node report.mjs --in <logs-file-or-dir>... [--records records.jsonl]
 *                   --out <dir> [--env label]
 *
 * Writes `hourly.csv`, `hourly.json` and `summary.md` (suitable for
 * `$GITHUB_STEP_SUMMARY`) into `--out`.
 *
 * Rows are keyed hour x env x source x op. Sources are never merged with each
 * other (a call can appear both as a `bsc_call_summary` and as an
 * `adapter_sync_call`), so nothing is double counted:
 *   summary            the NEO-475 per-invocation summaries (authoritative)
 *   adapter_sync_call  BSC selector fetches, one call per line
 *   seller_call        the seller client, one call per line
 *   completion         BSC action Completions (executionTime, whole action)
 *   legacy             failure lines older code wrote (count only)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo } from "./paths.mjs";
import { parseLogs } from "./parse.mjs";
import { addObservation, emptySummary, mergeSummaries, percentile } from "./histogram.mjs";

const HOUR_MS = 3_600_000;

export const hourOf = (ms) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13) + ":00Z";

/** Max number of overlapping [start, end] intervals. */
export function peakOverlap(intervals) {
  const events = [];
  for (const [s, e] of intervals) {
    events.push([s, 1], [Math.max(e, s), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at the same instant
  let cur = 0;
  let peak = 0;
  let at = 0;
  for (const [t, d] of events) {
    cur += d;
    if (cur > peak) {
      peak = cur;
      at = t;
    }
  }
  return { peak, at };
}

/** Records to rows, failures, legacy counts and concurrency. */
export function buildReport(records, { env = "ci" } = {}) {
  const rows = new Map();
  const failures = new Map();
  const intervals = new Map(); // env -> intervals of fetchBscCardTeamNames
  let first = Infinity;
  let last = 0;

  const rowFor = (ts, e, source, op) => {
    const hour = hourOf(ts);
    const key = `${hour}|${e}|${source}|${op}`;
    let row = rows.get(key);
    if (!row) {
      row = { hour, env: e, source, op, summary: emptySummary(op, ts) };
      rows.set(key, row);
    }
    return row;
  };

  for (const r of records) {
    const e = r.meta?.env ?? env;
    const ts = r.ts || 0;
    if (ts > 0) {
      first = Math.min(first, ts);
      last = Math.max(last, ts);
    }
    switch (r.type) {
      case "call_summary": {
        const row = rowFor(ts, e, "summary", r.op);
        row.summary = row.summary.calls === 0 ? { ...r, op: r.op } : mergeSummaries(row.summary, r);
        break;
      }
      case "call_failed": {
        const k = `${e}|${r.kind}|${r.status ?? ""}|${r.errCode ?? ""}|${r.pathTemplate ?? ""}`;
        const f = failures.get(k) ?? { env: e, kind: r.kind, status: r.status, errCode: r.errCode, path: r.pathTemplate, count: 0 };
        f.count += 1;
        failures.set(k, f);
        break;
      }
      case "adapter_sync_call":
        addObservation(rowFor(ts, e, "adapter_sync_call", r.operation).summary, {
          durationMs: r.durationMs,
          ok: r.success,
          status: r.statusCode,
          kind: r.errorClass ?? "failed",
          at: ts,
        });
        break;
      case "seller_call":
        addObservation(rowFor(ts, e, "seller_call", r.operation).summary, {
          durationMs: r.durationMs,
          ok: r.outcome === "ok",
          status: r.httpStatus,
          kind: r.outcome ?? "failed",
          at: ts,
        });
        break;
      case "completion":
        addObservation(rowFor(ts, e, "completion", r.identifier).summary, {
          durationMs: r.executionMs,
          ok: !r.failed,
          kind: "error",
          at: ts,
        });
        if (/fetchBscCardTeamNames$/.test(r.identifier) && typeof r.executionMs === "number") {
          const list = intervals.get(e) ?? [];
          list.push([ts - r.executionMs, ts]);
          intervals.set(e, list);
        }
        break;
      case "legacy_card_listing_failed":
        addLegacy(rowFor(ts, e, "legacy", `card_listing_failed:${r.status}`).summary, ts);
        break;
      case "legacy_api_status":
        addLegacy(rowFor(ts, e, "legacy", `${r.fn}:http_${r.status}`).summary, ts);
        break;
      case "legacy_timeout":
        addLegacy(rowFor(ts, e, "legacy", `${r.fn}:timeout_${r.timeoutS}s`).summary, ts);
        break;
      case "legacy_timeout_error":
        addLegacy(rowFor(ts, e, "legacy", "timeout_error").summary, ts);
        break;
      case "limiter":
        if (r.outcome !== "released" || (r.waitedMs ?? 0) > 0) {
          addObservation(rowFor(ts, e, "limiter", `${r.limiter}:${r.outcome}`).summary, {
            durationMs: r.waitedMs,
            ok: true,
            at: ts,
          });
        }
        break;
      default:
    }
  }

  const concurrency = [];
  for (const [e, list] of intervals) {
    const { peak, at } = peakOverlap(list);
    concurrency.push({ env: e, peak, hour: at ? hourOf(at) : null, calls: list.length });
  }

  const out = [...rows.values()]
    .map((r) => {
      const s = r.summary;
      const lat = s.lat;
      return {
        hour: r.hour,
        env: r.env,
        source: r.source,
        op: r.op,
        calls: s.calls,
        ok: s.ok,
        fail: s.calls - s.ok,
        p50Ms: percentile(lat, 0.5),
        p95Ms: percentile(lat, 0.95),
        maxMs: lat.buckets.some((n) => n > 0) ? lat.max : null,
        byKind: s.byKind,
        byStatus: s.byStatus,
        maxInflight: s.maxInflight,
        suppressed: s.suppressed,
      };
    })
    .sort((a, b) => a.hour.localeCompare(b.hour) || a.env.localeCompare(b.env) || a.source.localeCompare(b.source) || a.op.localeCompare(b.op));

  return {
    window: Number.isFinite(first) ? { from: new Date(first).toISOString(), to: new Date(last).toISOString() } : null,
    rows: out,
    summaries: [...rows.values()].map((r) => ({ source: r.source, op: r.op, summary: r.summary })),
    failures: [...failures.values()].sort((a, b) => b.count - a.count),
    concurrency,
  };
}

function addLegacy(summary, ts) {
  addObservation(summary, { ok: false, at: ts });
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_COLUMNS = ["hour", "env", "source", "op", "calls", "ok", "fail", "p50Ms", "p95Ms", "maxMs", "byKind", "byStatus", "maxInflight", "suppressed"];

export function renderCsv(report) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of report.rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

const md = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const MAX_MD_ROWS = 60;

/** Collapse hours: one line per source x op for the markdown table. */
function totalsBySourceOp(report) {
  const acc = new Map();
  for (const r of report.summaries) {
    const k = `${r.source}|${r.op}`;
    const cur = acc.get(k);
    acc.set(k, cur ? { ...cur, summary: mergeSummaries(cur.summary, r.summary) } : { source: r.source, op: r.op, summary: r.summary });
  }
  return [...acc.values()].map((t) => ({
    source: t.source,
    op: t.op,
    calls: t.summary.calls,
    ok: t.summary.ok,
    latency: {
      p50: percentile(t.summary.lat, 0.5),
      p95: percentile(t.summary.lat, 0.95),
      max: t.summary.lat.buckets.some((n) => n > 0) ? t.summary.lat.max : null,
    },
  }));
}

export function renderMarkdown(report, { title = "BSC health", stats, hourlyAvailable = true } = {}) {
  const out = [`## ${title}`, ""];
  if (report.window) out.push(`Window: ${report.window.from} to ${report.window.to} (UTC).`);
  if (stats) out.push(`Parsed ${stats.lines} log lines from ${stats.files} files; ${stats.duplicates} duplicates dropped.`);
  out.push("");
  const totals = totalsBySourceOp(report);
  out.push("### Calls by source and operation", "", "| source | op | calls | ok | fail | p50 ms | p95 ms | max ms |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const t of totals.slice(0, MAX_MD_ROWS)) {
    const total = t.latency;
    out.push(
      `| ${md(t.source)} | ${md(t.op)} | ${t.calls} | ${t.ok} | ${t.calls - t.ok} | ${total.p50 ?? ""} | ${total.p95 ?? ""} | ${total.max ?? ""} |`,
    );
  }
  if (totals.length > MAX_MD_ROWS) out.push("", `(${totals.length - MAX_MD_ROWS} more rows in hourly.csv)`);
  out.push("");
  if (report.failures.length > 0) {
    out.push("### Failures (bsc_call_failed)", "", "| kind | status | errCode | path | count |", "|---|---:|---|---|---:|");
    for (const f of report.failures.slice(0, 20)) {
      out.push(`| ${md(f.kind)} | ${md(f.status)} | ${md(f.errCode)} | ${md(f.path)} | ${f.count} |`);
    }
    out.push("");
  } else {
    out.push("### Failures (bsc_call_failed)", "", "None recorded.", "");
  }
  if (report.concurrency.length > 0) {
    out.push("### Peak concurrent fetchBscCardTeamNames", "", "Deployment-wide, from overlapping action Completions.", "", "| env | peak | at hour | actions |", "|---|---:|---|---:|");
    for (const c of report.concurrency) out.push(`| ${md(c.env)} | ${c.peak} | ${md(c.hour)} | ${c.calls} |`);
    out.push("");
  }
  if (hourlyAvailable) out.push("Hourly detail: hourly.csv / hourly.json.");
  return out.join("\n") + "\n";
}

/**
 * A deployment name identifies a live deployment and never leaves the log
 * files: the `env` label replaces it. Drops the key at any depth.
 */
export function stripDeployment(value) {
  if (Array.isArray(value)) return value.map(stripDeployment);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== "deployment") out[k] = stripDeployment(v);
    return out;
  }
  return value;
}

export function writeReport(report, outDir, mdOptions) {
  fs.mkdirSync(outDir, { recursive: true });
  const clean = stripDeployment({ ...report });
  fs.writeFileSync(path.join(outDir, "hourly.csv"), renderCsv(clean));
  fs.writeFileSync(path.join(outDir, "hourly.json"), JSON.stringify({ window: clean.window, rows: clean.rows, failures: clean.failures, concurrency: clean.concurrency }, null, 2) + "\n");
  const markdown = renderMarkdown(clean, mdOptions);
  fs.writeFileSync(path.join(outDir, "summary.md"), markdown);
  return markdown;
}

function readRecords(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main(argv) {
  const inputs = [];
  let recordsFile;
  let out;
  let env = "ci";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") inputs.push(argv[++i]);
    else if (argv[i] === "--records") recordsFile = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--env") env = argv[++i];
    else {
      console.error(`unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!out || (inputs.length === 0 && !recordsFile)) {
    console.error("usage: node report.mjs (--in <logs>... | --records records.jsonl) --out <dir> [--env label]");
    process.exit(2);
  }
  out = assertOutsideRepo(out);
  let records = [];
  let stats;
  if (recordsFile) records = readRecords(recordsFile);
  if (inputs.length > 0) {
    const parsed = await parseLogs(inputs, { meta: { env } });
    records = records.concat(parsed.records);
    stats = parsed.stats;
  }
  const report = buildReport(records, { env });
  const markdown = writeReport(report, out, { stats });
  console.log(markdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
