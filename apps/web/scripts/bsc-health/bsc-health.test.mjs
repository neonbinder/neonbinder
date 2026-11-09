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
import { assertOutsideRepo, parseRunLines } from "./backfill.mjs";
import { collectLogFiles, parseLogs, recordsFromText, unwrapMessage } from "./parse.mjs";
import { buildReport, hourOf, peakOverlap, renderCsv, renderMarkdown } from "./report.mjs";

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
