#!/usr/bin/env node
/**
 * NEO-475 — read `convex-logs-*` artifacts into BSC call records.
 *
 *   node parse.mjs <file-or-dir>... [--out records.jsonl]
 *
 * Inputs are CI artifacts (`*.jsonl` or `*.jsonl.gz`) and UNTRUSTED DATA: they
 * are only ever JSON-parsed and pattern-matched here, never evaluated.
 *
 * Every `convex-logs-<shard>` artifact is a full copy of the deployment-wide
 * log stream, so the same execution shows up in every shard. Records are
 * deduped: a Completion by `executionId`, a log line by `executionId` + the
 * line's own timestamp + its text. Counting without this multiplies by the
 * shard count.
 *
 * Emits records of these types (all carry `ts`, epoch ms, and `meta`):
 *   call_failed / call_summary        the NEO-475 structured lines
 *   adapter_sync_call                 platform "bsc" only
 *   seller_call                       `bsc_seller_call` (a sheet read's `condition` and `attempt` too)
 *   sheet_retry                       `bsc_sheet_retry`: a 503'd sheet read tried again
 *   limiter                           `marketplace_limiter` for BSC
 *   legacy_card_listing_failed        `card-listing fetch failed status=N`
 *   legacy_api_status / legacy_timeout  `BSC API 503 (attempt a/b)`, `... timed out`
 *   legacy_timeout_error              a bare `error=TimeoutError`
 *   completion                        a BSC action's Completion (executionMs)
 *
 * A log line's records also carry its `executionId` (one action run: a drain or
 * a seller cleanup), so report.mjs can group sheet reads per job. Ids stay in
 * the records; the report prints only counts.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const BSC_IDENTIFIER = /buysportscards|bscseller|bsc/i;

/** Every `*.jsonl` / `*.jsonl.gz` under the given files and directories, sorted. */
export function collectLogFiles(inputs) {
  const out = [];
  const visit = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    } else if (/\.jsonl(\.gz)?$/.test(p)) {
      out.push(p);
    }
  };
  for (const p of inputs) visit(p);
  return out.sort();
}

/** Decompressed bytes read per file; the rest is ignored (a gzip bomb cannot exhaust memory or time). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** A line longer than this is skipped, not parsed. */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Lines of a file as strings, with both caps applied. `stats.oversizeLines`
 * and `stats.truncatedFiles` count what was skipped.
 */
export async function* linesOf(file, caps = {}, stats = {}) {
  const maxFile = caps.maxFileBytes ?? MAX_FILE_BYTES;
  const maxLine = caps.maxLineBytes ?? MAX_LINE_BYTES;
  const raw = fs.createReadStream(file);
  const source = file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
  let total = 0;
  let pending = Buffer.alloc(0); // partial line carried between chunks
  let skipping = false; // inside an oversize line
  const flushLine = function* (buf) {
    if (buf.length > 0) yield buf.toString("utf8");
  };
  try {
    for await (const chunk of source) {
      let buf = chunk;
      if (total + buf.length > maxFile) {
        buf = buf.subarray(0, Math.max(0, maxFile - total));
        stats.truncatedFiles = (stats.truncatedFiles ?? 0) + 1;
        total = maxFile;
        // process what fits, then stop
        yield* splitChunk(buf);
        return;
      }
      total += buf.length;
      yield* splitChunk(buf);
    }
    if (!skipping) yield* flushLine(pending);
  } finally {
    source.destroy?.();
    raw.destroy();
  }

  function* splitChunk(buf) {
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      const end = nl === -1 ? buf.length : nl;
      const piece = buf.subarray(start, end);
      if (!skipping) {
        if (pending.length + piece.length > maxLine) {
          skipping = true;
          pending = Buffer.alloc(0);
          stats.oversizeLines = (stats.oversizeLines ?? 0) + 1;
        } else {
          pending = pending.length ? Buffer.concat([pending, piece]) : piece;
        }
      }
      if (nl === -1) return;
      if (!skipping) yield* flushLine(pending.at(-1) === 0x0d ? pending.subarray(0, -1) : pending);
      pending = Buffer.alloc(0);
      skipping = false;
      start = nl + 1;
    }
  }
}

/** Convex prints a string argument as `'text'`; undo that. */
export function unwrapMessage(s) {
  if (typeof s !== "string") return "";
  const first = s[0];
  if (s.length >= 2 && (first === "'" || first === '"' || first === "`") && s[s.length - 1] === first) {
    return s.slice(1, -1).replace(/\\'/g, "'");
  }
  return s;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A BSC condition key or an outcome word: short, lower case, nothing else kept. */
const word = (v) => (typeof v === "string" && /^[a-z0-9_-]{1,24}$/.test(v) ? v : undefined);

/** One log line's text to zero or more records. */
export function recordsFromText(text, ts) {
  const out = [];
  if (text.startsWith("{")) {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      o = null;
    }
    if (o && typeof o === "object" && typeof o.msg === "string") {
      switch (o.msg) {
        case "bsc_call_failed": {
          const { msg: _msg, ...rest } = o;
          out.push({ type: "call_failed", ts: num(o.at) ?? ts, ...rest });
          break;
        }
        case "bsc_call_summary": {
          const { msg: _msg, ...rest } = o;
          out.push({ type: "call_summary", ts: num(o.startedAt) ?? ts, ...rest });
          break;
        }
        case "adapter_sync_call":
          if (o.platform === "bsc") {
            out.push({
              type: "adapter_sync_call",
              ts,
              operation: o.operation,
              durationMs: num(o.duration_ms),
              success: o.success === true,
              statusCode: num(o.status_code),
              attempt: num(o.attempt),
              errorClass: typeof o.error_class === "string" ? o.error_class : undefined,
            });
          }
          break;
        case "bsc_seller_call":
          out.push({
            type: "seller_call",
            ts,
            operation: o.operation,
            outcome: o.outcome,
            httpStatus: num(o.httpStatus),
            durationMs: num(o.durationMs),
            condition: word(o.condition),
            attempt: num(o.attempt),
          });
          break;
        case "bsc_sheet_retry":
          out.push({
            type: "sheet_retry",
            ts,
            pauseMs: num(o.pauseMs),
            attempt: num(o.attempt),
            outcome: word(o.outcome),
            durationMs: num(o.durationMs),
          });
          break;
        case "marketplace_limiter":
          if (typeof o.platform === "string" && /bsc|buysportscards/i.test(o.platform)) {
            out.push({
              type: "limiter",
              ts,
              limiter: o.limiter,
              operation: o.operation,
              outcome: o.outcome,
              waitedMs: num(o.waitedMs),
              heldMs: num(o.heldMs),
            });
          }
          break;
        default:
      }
    }
    return out;
  }
  let m = /card-listing fetch failed status=(\d+)/.exec(text);
  if (m) out.push({ type: "legacy_card_listing_failed", ts, status: Number(m[1]) });
  m = /\[(\w+)\] BSC API request timed out after (\d+)s \(attempt (\d+)\/(\d+)\)/.exec(text);
  if (m) out.push({ type: "legacy_timeout", ts, fn: m[1], timeoutS: Number(m[2]), attempt: Number(m[3]) });
  m = /\[(\w+)\] BSC API (\d{3}) \(attempt (\d+)\/(\d+)\)/.exec(text);
  if (m) out.push({ type: "legacy_api_status", ts, fn: m[1], status: Number(m[2]), attempt: Number(m[3]) });
  if (/error=TimeoutError/.test(text)) out.push({ type: "legacy_timeout_error", ts });
  return out;
}

/**
 * Parse log files into deduped records.
 * @param {string[]} inputs files and directories
 * @param {{meta?: object, seen?: Set<string>, caps?: {maxFileBytes?: number, maxLineBytes?: number}}} [opts]
 *   `meta` is attached to every record; `caps` overrides the per-file (512 MB decompressed)
 *   and per-line (1 MB) limits, for tests.
 */
export async function parseLogs(inputs, opts = {}) {
  const meta = opts.meta ?? {};
  const seen = opts.seen ?? new Set();
  const records = [];
  const stats = { files: 0, lines: 0, badLines: 0, duplicates: 0, oversizeLines: 0, truncatedFiles: 0, byType: {} };
  const push = (rec) => {
    records.push({ ...rec, meta });
    stats.byType[rec.type] = (stats.byType[rec.type] ?? 0) + 1;
  };
  for (const file of collectLogFiles(inputs)) {
    stats.files += 1;
    for await (const line of linesOf(file, opts.caps, stats)) {
      stats.lines += 1;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        stats.badLines += 1;
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const executionId = typeof entry.executionId === "string" ? entry.executionId : "";
      if (entry.kind === "Completion") {
        if (typeof entry.identifier !== "string" || !BSC_IDENTIFIER.test(entry.identifier)) continue;
        const key = `c|${executionId}`;
        if (seen.has(key)) {
          stats.duplicates += 1;
          continue;
        }
        seen.add(key);
        push({
          type: "completion",
          ts: typeof entry.timestamp === "number" ? Math.round(entry.timestamp * 1000) : 0,
          identifier: entry.identifier,
          executionMs:
            typeof entry.executionTime === "number" ? Math.round(entry.executionTime * 1000) : undefined,
          failed: Boolean(entry.error),
        });
        continue;
      }
      if (!Array.isArray(entry.logLines)) continue;
      for (const ll of entry.logLines) {
        if (!ll || !Array.isArray(ll.messages)) continue;
        const text = ll.messages.map(unwrapMessage).join(" ");
        const ts = typeof ll.timestamp === "number" ? ll.timestamp : 0;
        const recs = recordsFromText(text, ts);
        if (recs.length === 0) continue;
        const key = `l|${executionId}|${ts}|${text}`;
        if (seen.has(key)) {
          stats.duplicates += 1;
          continue;
        }
        seen.add(key);
        for (const rec of recs) push(executionId ? { ...rec, executionId } : rec);
      }
    }
  }
  return { records, stats };
}

async function main(argv) {
  const inputs = [];
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else inputs.push(argv[i]);
  }
  if (inputs.length === 0) {
    console.error("usage: node parse.mjs <file-or-dir>... [--out records.jsonl]");
    process.exit(2);
  }
  const { records, stats } = await parseLogs(inputs);
  if (out) fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  console.log(JSON.stringify(stats));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
