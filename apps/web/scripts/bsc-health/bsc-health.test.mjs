/**
 * NEO-475 — parse.mjs, report.mjs and backfill.mjs, on small SYNTHETIC logs
 * (no deployment names, ids or URLs). The structured lines are produced by the
 * real recorder, so the parser is proven to read what the emitter writes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { createBscRecorder } from "../../convex/lib/bscCallTelemetry";
import { assertOutsideRepo, listRuns, parseRunLines } from "./backfill.mjs";
import { collectLogFiles, parseLogs, recordsFromText, unwrapMessage } from "./parse.mjs";
import { buildReport, hourOf, peakOverlap, quantile, renderCsv, renderMarkdown, sheetJobStats, writeReport } from "./report.mjs";

const made = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "neo475-bsc-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 0, 2, 3, 15, 0);

const progress = (executionId, ts, text, level = "LOG") => ({
  identifier: "adapters/buysportscards:fetchBscCardTeamNames",
  udfType: "Action",
  executionId,
  kind: "Progress",
  logLines: [{ messages: [`'${text}'`], isTruncated: false, timestamp: ts, level }],
});
const completion = (executionId, endSec, execSec, identifier = "adapters/buysportscards:fetchBscCardTeamNames", error = null) => ({
  identifier,
  udfType: "Action",
  executionId,
  kind: "Completion",
  timestamp: endSec,
  executionTime: execSec,
  error,
  logLines: [],
});

async function emitted() {
  const lines = { log: [], warn: [] };
  const rec = createBscRecorder("fetchBscCardTeamNames", { log: { log: (l) => lines.log.push(l), warn: (l) => lines.warn.push(l) }, deployment: "dep" });
  rec.respond(rec.start({ pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 1 }), new Response("ok", { status: 200 }));
  rec.respond(rec.start({ pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 2 }), new Response("<title>503</title>", { status: 503, headers: { server: "CloudFront" } }));
  rec.fail(rec.start({ pathTemplate: "marketplace/card/:id/card-listing", bscCardId: 3, timeoutMs: 5000 }), { error: Object.assign(new Error("t"), { name: "TimeoutError" }) });
  await rec.flush();
  return lines;
}

function writeShard(dir, name, entries, gz = true) {
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const file = path.join(dir, gz ? `${name}.jsonl.gz` : `${name}.jsonl`);
  fs.writeFileSync(file, gz ? zlib.gzipSync(text) : text);
}

test("unwrapMessage undoes Convex's quoting", () => {
  expect(unwrapMessage("'{\"a\":1}'")).toBe('{"a":1}');
  expect(unwrapMessage("plain")).toBe("plain");
});

test("round trip: what the recorder emits, the parser reads", async () => {
  const lines = await emitted();
  const dir = tmp();
  const entries = [
    ...lines.warn.map((l, i) => progress(`e${i}`, T0 + i, l, "WARN")),
    ...lines.log.map((l) => progress("eS", T0 + 10, l)),
  ];
  writeShard(dir, "convex-logs-a", entries);
  const { records } = await parseLogs([dir]);
  const failed = records.filter((r) => r.type === "call_failed");
  const summary = records.filter((r) => r.type === "call_summary");
  expect(failed.map((r) => r.kind).sort()).toEqual(["http", "timeout"]);
  expect(failed.find((r) => r.kind === "http")).toMatchObject({ status: 503, bscCardId: "2" });
  expect(summary).toHaveLength(1);
  expect(summary[0]).toMatchObject({ op: "fetchBscCardTeamNames", calls: 3, ok: 1 });
});

test("dedupes the same execution across shard copies, lines and completions alike", async () => {
  const dir = tmp();
  const entries = [
    progress("e1", T0, JSON.stringify({ msg: "bsc_seller_call", platform: "bsc", operation: "token", outcome: "ok", durationMs: 100 })),
    completion("c1", T0 / 1000, 0.5),
    // The same two lines, plus a different line from the same execution.
    progress("e1", T0 + 5, JSON.stringify({ msg: "bsc_seller_call", platform: "bsc", operation: "token", outcome: "ok", durationMs: 100 })),
  ];
  for (const shard of ["a", "b", "c"]) writeShard(dir, `convex-logs-${shard}`, entries);
  const { records, stats } = await parseLogs([dir]);
  expect(records.filter((r) => r.type === "seller_call")).toHaveLength(2);
  expect(records.filter((r) => r.type === "completion")).toHaveLength(1);
  expect(stats.duplicates).toBe(6);
});

test("reads plain and gzipped files, skips junk lines, ignores non-BSC completions", async () => {
  const dir = tmp();
  writeShard(dir, "one", [completion("c1", T0 / 1000, 1), completion("c2", T0 / 1000, 1, "other:thing")], false);
  fs.appendFileSync(path.join(dir, "one.jsonl"), "not json\n");
  writeShard(dir, "two", [completion("c3", T0 / 1000, 2, "adapters/bscSeller:x")]);
  expect(collectLogFiles([dir])).toHaveLength(2);
  const { records, stats } = await parseLogs([dir]);
  expect(records.map((r) => r.identifier).sort()).toEqual(["adapters/bscSeller:x", "adapters/buysportscards:fetchBscCardTeamNames"]);
  expect(stats.badLines).toBe(1);
});

test("legacy failure lines are recognised", () => {
  expect(recordsFromText("[fetchBscCardTeamNameRaw] card-listing fetch failed status=503 bscCardId=9", 1)).toEqual([
    { type: "legacy_card_listing_failed", ts: 1, status: 503 },
  ]);
  expect(recordsFromText("[fetchBscSelectorOptions] BSC API request timed out after 10s (attempt 2/3)", 1)[0]).toMatchObject({ type: "legacy_timeout", fn: "fetchBscSelectorOptions", attempt: 2 });
  expect(recordsFromText("[fetchBscSelectorOptions] BSC API 503 (attempt 1/3): <html>", 1)[0]).toMatchObject({ type: "legacy_api_status", status: 503 });
  expect(recordsFromText("x error=TimeoutError y", 1)[0].type).toBe("legacy_timeout_error");
  expect(recordsFromText("nothing to see", 1)).toEqual([]);
  expect(recordsFromText('{"msg":"adapter_sync_call","platform":"sportlots"}', 1)).toEqual([]);
});

test("peakOverlap counts concurrent intervals; touching ends do not overlap", () => {
  expect(peakOverlap([[0, 10], [5, 15], [8, 9], [20, 30]]).peak).toBe(3);
  expect(peakOverlap([[0, 10], [10, 20]]).peak).toBe(1);
  expect(peakOverlap([]).peak).toBe(0);
});

test("the report buckets by hour and keeps sources apart", async () => {
  const lines = await emitted();
  const meta = { env: "ci" };
  const sum = JSON.parse(lines.log[0]);
  const records = [
    { type: "call_summary", ts: sum.startedAt, ...sum, msg: undefined, meta },
    { type: "call_failed", ts: T0, kind: "http", status: 503, pathTemplate: "p", meta },
    { type: "call_failed", ts: T0, kind: "http", status: 503, pathTemplate: "p", meta },
    { type: "seller_call", ts: T0, operation: "sheetRead", outcome: "http_error", httpStatus: 503, durationMs: 30034, meta },
    { type: "seller_call", ts: T0 + 3_600_000, operation: "sheetRead", outcome: "ok", httpStatus: 200, durationMs: 400, meta },
    { type: "adapter_sync_call", ts: T0, operation: "fetchBscSelectorOptions", durationMs: 300, success: true, statusCode: 200, meta },
    { type: "legacy_card_listing_failed", ts: T0, status: 503, meta },
    { type: "completion", ts: T0, identifier: "adapters/buysportscards:fetchBscCardTeamNames", executionMs: 4000, failed: false, meta },
    { type: "completion", ts: T0 + 1000, identifier: "adapters/buysportscards:fetchBscCardTeamNames", executionMs: 4000, failed: false, meta },
  ];
  const report = buildReport(records);
  const seller = report.rows.filter((r) => r.source === "seller_call");
  expect(seller.map((r) => [r.hour, r.calls, r.ok])).toEqual([
    [hourOf(T0), 1, 0],
    [hourOf(T0 + 3_600_000), 1, 1],
  ]);
  expect(seller[0].byKind).toEqual({ http_error: 1 });
  expect(report.rows.find((r) => r.source === "summary")).toMatchObject({ calls: 3, ok: 1 });
  expect(report.rows.find((r) => r.source === "legacy")).toMatchObject({ op: "card_listing_failed:503", calls: 1, fail: 1 });
  expect(report.failures[0]).toMatchObject({ kind: "http", status: 503, count: 2 });
  expect(report.concurrency[0].peak).toBe(2);

  const csv = renderCsv(report);
  expect(csv.split("\n")[0]).toBe("hour,env,source,op,calls,ok,fail,p50Ms,p95Ms,maxMs,byKind,byStatus,maxInflight,suppressed");
  const md = renderMarkdown(report, { stats: { lines: 9, files: 1, duplicates: 0 } });
  expect(md).toContain("### Calls by source and operation");
  expect(md).toContain("| seller_call | sheetRead | 2 | 1 | 1 |");
  expect(md).toContain("Peak concurrent fetchBscCardTeamNames");
});

test("an empty report renders", () => {
  const r = buildReport([]);
  expect(r.window).toBeNull();
  expect(renderMarkdown(r)).toContain("None recorded.");
});

test("backfill refuses directories inside the repository", () => {
  const repo = tmp();
  expect(() => assertOutsideRepo(path.join(repo, "out"), repo)).toThrow(/inside the repository/);
  expect(() => assertOutsideRepo(repo, repo)).toThrow();
  expect(assertOutsideRepo(tmp(), repo)).toBeTruthy();
});

test("backfill reads gh's run lines", () => {
  const runs = parseRunLines(
    '{"id":5,"run_attempt":2,"conclusion":"failure","created_at":"2026-01-01T00:00:00Z","pr":448}\n{"id":6,"run_attempt":1,"conclusion":null,"created_at":"x","pr":null}\nnoise\n'.replace("noise\n", ""),
  );
  expect(runs).toEqual([
    { id: 5, attempt: 2, conclusion: "failure", createdAt: "2026-01-01T00:00:00Z", pr: 448 },
    { id: 6, attempt: 1, conclusion: "in_progress", createdAt: "x", pr: null },
  ]);
});

test("assertOutsideRepo: sibling '..x' dirs are outside; '..' escapes and symlinks into the repo are not", () => {
  const base = tmp();
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  // A directory literally named "..cache" is OUTSIDE, and was wrongly refused by startsWith("..").
  expect(assertOutsideRepo(path.join(base, "..cache", "out"), repo)).toBeTruthy();
  // A path that climbs back in.
  expect(() => assertOutsideRepo(path.join(base, "elsewhere", "..", "repo", "x"), repo)).toThrow(/inside/);
  // A symlink outside that points into the repo, with a non-existing leaf.
  const link = path.join(base, "link");
  fs.symlinkSync(repo, link);
  expect(() => assertOutsideRepo(path.join(link, "new", "deep"), repo)).toThrow(/inside/);
  expect(() => assertOutsideRepo(link, repo)).toThrow(/inside/);
});

test("listRuns drops runs whose head repository is not --repo (fork PRs)", () => {
  const lines = [
    { id: 1, run_attempt: 1, conclusion: "success", created_at: "a", pr: 1, head_repo: "neonbinder/neonbinder-app" },
    { id: 2, run_attempt: 1, conclusion: "success", created_at: "a", pr: 2, head_repo: "evil/neonbinder" },
    { id: 3, run_attempt: 1, conclusion: "success", created_at: "a", pr: 3, head_repo: null },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  const runs = listRuns({ repo: "neonbinder/neonbinder-app", days: 1, run: () => lines });
  expect(runs.map((r) => r.id)).toEqual([1]);
  expect(runs[0]).not.toHaveProperty("headRepo");
});

test("report output never carries a deployment name", () => {
  const meta = { env: "ci" };
  const records = [
    { type: "call_summary", ts: T0, op: "x", deployment: "secret-dep-123", startedAt: T0, endedAt: T0 + 1, calls: 1, ok: 1, byKind: {}, byStatus: { 200: 1 }, maxInflight: 1, suppressed: 0, lat: { min: 5, max: 5, sum: 5, buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, meta },
    { type: "call_failed", ts: T0, kind: "http", status: 500, pathTemplate: "p", deployment: "secret-dep-123", meta },
  ];
  const dir = tmp();
  const md = writeReport(buildReport(records), dir, {});
  for (const f of ["hourly.json", "hourly.csv", "summary.md"]) {
    expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain("secret-dep-123");
  }
  expect(md).not.toContain("secret-dep-123");
  expect(JSON.parse(fs.readFileSync(path.join(dir, "hourly.json"), "utf8")).rows[0].env).toBe("ci");
});

test("parse caps the decompressed bytes per file and skips oversize lines", async () => {
  const dir = tmp();
  const good = (id) => JSON.stringify(completion(id, T0 / 1000, 1));
  const huge = JSON.stringify({ kind: "Progress", pad: "x".repeat(5000) });
  fs.writeFileSync(path.join(dir, "a.jsonl"), [good("c1"), huge, good("c2")].join("\n") + "\n");
  const r = await parseLogs([dir], { caps: { maxLineBytes: 1000 } });
  expect(r.records.filter((x) => x.type === "completion")).toHaveLength(2);
  expect(r.stats.oversizeLines).toBe(1);
  expect(r.stats.badLines).toBe(0);

  // A gzip bomb: the stream ends at the file cap, only the lines before it are read.
  const lines = Array.from({ length: 200 }, (_, i) => good(`b${i}`)).join("\n") + "\n";
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, "bomb.jsonl.gz"), zlib.gzipSync(lines));
  const cap = Math.floor(lines.length / 2);
  const r2 = await parseLogs([dir2], { caps: { maxFileBytes: cap } });
  expect(r2.stats.truncatedFiles).toBe(1);
  const n = r2.records.filter((x) => x.type === "completion").length;
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(200);
});

// ── NEO-475: sheet reads per job ────────────────────────────────────────────

const sellerLine = (o) => JSON.stringify({ msg: "bsc_seller_call", platform: "bsc", operation: "sheetRead", ...o });
const retryLine = (o) => JSON.stringify({ msg: "bsc_sheet_retry", platform: "bsc", operation: "sheetRead", ...o });

test("a sheet read's condition and attempt, and a retry line, are read; a junk condition is dropped", () => {
  expect(recordsFromText(sellerLine({ condition: "excellent", attempt: 2, outcome: "ok", httpStatus: 200, durationMs: 4500 }), 7)).toEqual([
    { type: "seller_call", ts: 7, operation: "sheetRead", outcome: "ok", httpStatus: 200, durationMs: 4500, condition: "excellent", attempt: 2 },
  ]);
  expect(recordsFromText(sellerLine({ condition: "Jane Doe <x>", outcome: "ok" }), 7)[0].condition).toBeUndefined();
  expect(recordsFromText(retryLine({ pauseMs: 10000, attempt: 2, outcome: "http_503", durationMs: 30000 }), 9)).toEqual([
    { type: "sheet_retry", ts: 9, pauseMs: 10000, attempt: 2, outcome: "http_503", durationMs: 30000 },
  ]);
});

test("parsed line records carry their executionId; the report prints none", async () => {
  const dir = tmp();
  writeShard(dir, "convex-logs-a", [
    progress("exec-job-1", T0 + 30_000, sellerLine({ condition: "excellent", attempt: 1, outcome: "http_error", httpStatus: 503, durationMs: 30_000 })),
    progress("exec-job-1", T0 + 44_500, sellerLine({ condition: "excellent", attempt: 2, outcome: "ok", httpStatus: 200, durationMs: 4_500 })),
    progress("exec-job-1", T0 + 44_501, retryLine({ pauseMs: 10_000, attempt: 2, outcome: "ok", durationMs: 4_500 })),
  ]);
  const { records } = await parseLogs([dir], { meta: { env: "ci" } });
  expect(records.map((r) => [r.type, r.executionId])).toEqual([
    ["seller_call", "exec-job-1"],
    ["seller_call", "exec-job-1"],
    ["sheet_retry", "exec-job-1"],
  ]);
  const report = buildReport(records);
  expect(report.sheetJobs).toEqual([
    {
      env: "ci",
      jobs: 1,
      sheetsPerJob: { min: 1, p50: 1, max: 1 },
      reads: 2,
      firstRead503: 1,
      firstReadOtherFailure: 0,
      retries: 1,
      retriesOk: 1,
      recovered: 1,
      timeToSuccessMs: { p50: 44_500, max: 44_500 },
    },
  ]);
  const out = tmp();
  const md = writeReport(report, out, {});
  expect(md).toContain("### Seller sheet reads per job");
  expect(md).toContain("| ci | 1 | 1 | 1 | 1 | 2 | 1 | 0 | 1 | 1 | 1 | 44500 | 44500 |");
  for (const f of ["hourly.json", "hourly.csv", "summary.md"]) {
    expect(fs.readFileSync(path.join(out, f), "utf8")).not.toContain("exec-job-1");
  }
  expect(JSON.parse(fs.readFileSync(path.join(out, "hourly.json"), "utf8")).sheetJobs).toHaveLength(1);
});

test("sheetJobStats: sheets per job, first-read 503s, retries, recovery and time to success", () => {
  const meta = { env: "ci" };
  const read = (executionId, end, durationMs, outcome, httpStatus, attempt = 1) => ({
    type: "seller_call", ts: end, operation: "sheetRead", outcome, httpStatus, durationMs, attempt, executionId, meta,
  });
  const retry = (executionId, outcome) => ({ type: "sheet_retry", ts: 0, outcome, executionId, meta });
  const records = [
    // Job A: cold first read, warm on the retry, then two more sheets.
    read("A", 30_000, 30_000, "http_error", 503),
    read("A", 44_000, 4_000, "ok", 200, 2),
    retry("A", "ok"),
    read("A", 49_000, 5_000, "ok", 200),
    read("A", 54_000, 5_000, "ok", 200),
    // Job B: warm from the start, one sheet.
    read("B", 4_000, 4_000, "ok", 200),
    // Job C: cold on every try, never recovers.
    read("C", 30_000, 30_000, "http_error", 503),
    read("C", 70_000, 30_000, "http_error", 503, 2),
    retry("C", "http_503"),
    read("C", 130_000, 30_000, "http_error", 503, 3),
    retry("C", "http_503"),
    // Job D: a 500 first; logged out of order, sorted by start.
    read("D", 9_000, 1_000, "ok", 200),
    read("D", 2_000, 2_000, "http_error", 500),
    // Not a sheet read, and a record with no job: both ignored.
    { type: "seller_call", ts: 1, operation: "listingsPut", outcome: "ok", executionId: "A", meta },
    read(undefined, 1, 1, "ok", 200),
  ];
  expect(sheetJobStats(records)).toEqual([
    {
      env: "ci",
      jobs: 4,
      sheetsPerJob: { min: 1, p50: 1, max: 3 },
      reads: 10,
      firstRead503: 2,
      firstReadOtherFailure: 1,
      retries: 3,
      retriesOk: 1,
      recovered: 2,
      timeToSuccessMs: { p50: 9_000, max: 44_000 },
    },
  ]);
  expect(sheetJobStats([])).toEqual([]);
  expect(renderMarkdown(buildReport([]))).not.toContain("Seller sheet reads per job");
});

test("quantile is nearest-rank and null on nothing", () => {
  expect(quantile([], 0.5)).toBeNull();
  expect(quantile([5, 1, 3], 0)).toBe(1);
  expect(quantile([5, 1, 3], 0.5)).toBe(3);
  expect(quantile([5, 1, 3], 1)).toBe(5);
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
});
