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
 *   seller_call                       `bsc_seller_call`
 *   limiter                           `marketplace_limiter` for BSC
 *   legacy_card_listing_failed        `card-listing fetch failed status=N`
 *   legacy_api_status / legacy_timeout  `BSC API 503 (attempt a/b)`, `... timed out`
 *   legacy_timeout_error              a bare `error=TimeoutError`
 *   completion                        a BSC action's Completion (executionMs)
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

async function* linesOf(file) {
  const raw = fs.createReadStream(file);
  const stream = file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line) yield line;
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
 * @param {{meta?: object, seen?: Set<string>}} [opts] `meta` is attached to every record
 */
export async function parseLogs(inputs, opts = {}) {
  const meta = opts.meta ?? {};
  const seen = opts.seen ?? new Set();
  const records = [];
  const stats = { files: 0, lines: 0, badLines: 0, duplicates: 0, byType: {} };
  const push = (rec) => {
    records.push({ ...rec, meta });
    stats.byType[rec.type] = (stats.byType[rec.type] ?? 0) + 1;
  };
  for (const file of collectLogFiles(inputs)) {
    stats.files += 1;
    for await (const line of linesOf(file)) {
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
        for (const rec of recs) push(rec);
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
