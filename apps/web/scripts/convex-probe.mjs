#!/usr/bin/env node
// NEO-407 — Convex latency probe.
//
// Calls `latencyProbe:ping` (a one-document query) on a fixed clock, and
// `latencyProbe:pingMutation` every Nth tick, against one deployment, and
// appends one JSON line per answer:
//
//   {"t":"2026-10-31T15:13:09.500Z","kind":"query","ms":23,"ok":true}
//
// `t` is when the call was SENT, so a stall reads as a run of large `ms`
// values sent inside it. Calls go out on the clock whether or not the last one
// has answered (a stall must not stop the probe from measuring it), up to
// MAX_IN_FLIGHT. Nothing user-related is sent or recorded.
//
//   node scripts/convex-probe.mjs --url https://<name>.convex.cloud --out probe.jsonl
//        [--interval-ms 1000] [--mutation-every 4]
//   node scripts/convex-probe.mjs --summary probe.jsonl [--stall-ms 2000]
//
// The probe runs until SIGTERM/SIGINT; calls still in flight are then written
// as `"ok":false,"error":"stopped"` with the time waited so far, so a stall
// that outlives the run still shows. `--summary` prints counts, percentiles
// and every call slower than --stall-ms. Never exits non-zero on probe data:
// it is evidence, not a gate.
import { appendFileSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const MAX_IN_FLIGHT = 60;
const CALL_TIMEOUT_MS = 60_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

function summarize(file, stallMs) {
  let lines = [];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    console.log(`probe summary: no data (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  for (const kind of ["query", "mutation"]) {
    const rows = lines.filter((r) => r.kind === kind);
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const failed = rows.filter((r) => !r.ok).length;
    console.log(
      `probe ${kind}: n=${rows.length} failed=${failed} p50=${percentile(ms, 50)}ms ` +
        `p95=${percentile(ms, 95)}ms p99=${percentile(ms, 99)}ms max=${ms.at(-1) ?? null}ms`,
    );
  }
  const slow = lines.filter((r) => r.ms >= stallMs || !r.ok);
  console.log(`probe calls at or over ${stallMs}ms, or failed: ${slow.length}`);
  for (const r of slow.slice(0, 200)) {
    console.log(`  ${r.t} ${r.kind} ${r.ms}ms${r.ok ? "" : ` FAILED ${r.error}`}`);
  }
}

async function probe(url, out, intervalMs, mutationEvery) {
  const client = new ConvexHttpClient(url);
  const inFlight = new Map();
  let tick = 0;
  let seq = 0;

  const write = (row) => {
    try {
      appendFileSync(out, `${JSON.stringify(row)}\n`);
    } catch {
      // Best effort: a full disk must not crash the shard's background job.
    }
  };

  const call = (kind) => {
    if (inFlight.size >= MAX_IN_FLIGHT) {
      write({ t: new Date().toISOString(), kind, ms: 0, ok: false, error: "skipped_in_flight_cap" });
      return;
    }
    const id = ++seq;
    const sent = Date.now();
    inFlight.set(id, { kind, sent });
    const nonce = `${sent}-${id}`;
    const fn = kind === "query" ? anyApi.latencyProbe.ping : anyApi.latencyProbe.pingMutation;
    const p = kind === "query" ? client.query(fn, { nonce }) : client.mutation(fn, { nonce }, { skipQueue: true });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), CALL_TIMEOUT_MS);
    });
    Promise.race([p, timeout])
      .then(
        () => ({ ok: true }),
        (e) => ({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) }),
      )
      .then((res) => {
        clearTimeout(timer);
        if (!inFlight.delete(id)) return; // already written as stopped
        write({ t: new Date(sent).toISOString(), kind, ms: Date.now() - sent, ...res });
      });
  };

  const timer = setInterval(() => {
    tick += 1;
    call("query");
    if (mutationEvery > 0 && tick % mutationEvery === 0) call("mutation");
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    const now = Date.now();
    for (const [id, { kind, sent }] of inFlight) {
      inFlight.delete(id);
      write({ t: new Date(sent).toISOString(), kind, ms: now - sent, ok: false, error: "stopped" });
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const summaryFile = arg("summary");
if (summaryFile) {
  summarize(summaryFile, Number(arg("stall-ms", "2000")));
} else {
  const url = arg("url");
  const out = arg("out");
  if (!url || !out) {
    console.error("usage: convex-probe.mjs --url <deployment url> --out <file.jsonl>");
    process.exit(2);
  }
  await probe(url, out, Number(arg("interval-ms", "1000")), Number(arg("mutation-every", "4")));
}
