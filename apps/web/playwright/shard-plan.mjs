#!/usr/bin/env node
// Longest-first (LPT) shard plan for the idiomatic Playwright suite.
//
//   node playwright/shard-plan.mjs <N> <i>     spec paths for shard i of N (1-based),
//                                                        one per line, relative to apps/web
//   node playwright/shard-plan.mjs <N>         the whole plan, per-shard totals (stderr)
//   node playwright/shard-plan.mjs --from-results <results.json>
//                                                        rewrite timings.json from a (merged)
//                                                        Playwright JSON report
//
// Playwright's own --shard splits by test COUNT in file order, so one shard
// can draw every multi-minute set-builder spec. This assigns each spec to the
// currently lightest shard, heaviest spec first, which is what the Maestro
// work queue achieves dynamically (NEO-61).
//
// Timings: timings.json (seconds per spec path under tests/), else
// .maestro/flow-timings.tsv. Only relative size matters. A spec with no
// timing gets the median. setup.spec.ts (the seed job) and
// profile/worker-bootstrap.spec.ts (every shard's `bootstrap` project
// dependency) are never planned.
//
// An empty shard prints nothing: the caller must then run nothing, because
// `playwright test` with no file arguments runs the whole suite.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const TESTS = path.join(HERE, "tests");
const TIMINGS_JSON = path.join(HERE, "timings.json");
const TIMINGS_TSV = path.join(WEB, ".maestro", "flow-timings.tsv");
const EXCLUDED = new Set(["setup.spec.ts", "profile/worker-bootstrap.spec.ts"]);

const toPosix = (p) => p.split(path.sep).join("/");

function listSpecs() {
  return fs
    .readdirSync(TESTS, { recursive: true })
    .map((p) => toPosix(String(p)))
    .filter((p) => p.endsWith(".spec.ts") && !EXCLUDED.has(p))
    .sort();
}

function loadTimings() {
  if (fs.existsSync(TIMINGS_JSON)) {
    return JSON.parse(fs.readFileSync(TIMINGS_JSON, "utf8")).seconds ?? {};
  }
  const out = {};
  if (fs.existsSync(TIMINGS_TSV)) {
    for (const line of fs.readFileSync(TIMINGS_TSV, "utf8").split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [secs, flow] = line.split("\t");
      const spec = flow.replace(/^\.maestro\/flows\//, "").replace(/\.yaml$/, ".spec.ts");
      out[spec] = Number(secs);
    }
  }
  return out;
}

function median(values) {
  if (values.length === 0) return 1;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function plan(n) {
  const timings = loadTimings();
  const specs = listSpecs();
  const fallback = median(specs.map((s) => timings[s]).filter((v) => Number.isFinite(v)));
  const weighted = specs
    .map((spec) => ({ spec, secs: Number.isFinite(timings[spec]) ? timings[spec] : fallback }))
    // Heaviest first; path breaks ties so every shard computes the same plan.
    .sort((a, b) => b.secs - a.secs || a.spec.localeCompare(b.spec));
  const shards = Array.from({ length: n }, () => ({ secs: 0, specs: [] }));
  for (const item of weighted) {
    let lightest = shards[0];
    for (const s of shards) if (s.secs < lightest.secs) lightest = s;
    lightest.secs += item.secs;
    lightest.specs.push(item.spec);
  }
  return shards;
}

function fromResults(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const secs = {};
  const walk = (suite, specFile) => {
    const f = suite.file ?? specFile;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName !== "e2e") continue;
        const d = (t.results ?? []).reduce((acc, r) => acc + (r.duration ?? 0), 0) / 1000;
        secs[toPosix(f)] = Math.round((secs[toPosix(f)] ?? 0) + d);
      }
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  const sorted = Object.fromEntries(Object.entries(secs).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(
    TIMINGS_JSON,
    `${JSON.stringify({ _source: `Playwright JSON report ${path.basename(file)}, e2e project, seconds per spec.`, seconds: sorted }, null, 2)}\n`,
  );
  console.error(`wrote ${Object.keys(sorted).length} timings to ${path.relative(WEB, TIMINGS_JSON)}`);
}

const args = process.argv.slice(2);
if (args[0] === "--from-results") {
  if (!args[1]) throw new Error("usage: shard-plan.mjs --from-results <results.json>");
  fromResults(args[1]);
} else {
  const n = Number(args[0]);
  const i = args[1] === undefined ? undefined : Number(args[1]);
  if (!Number.isInteger(n) || n < 1 || (i !== undefined && (!Number.isInteger(i) || i < 1 || i > n))) {
    throw new Error("usage: shard-plan.mjs <N> [<i> in 1..N] | --from-results <results.json>");
  }
  const shards = plan(n);
  if (i === undefined) {
    shards.forEach((s, k) =>
      console.error(`shard ${k + 1}/${n}: ${s.specs.length} specs, ~${Math.round(s.secs)}s`),
    );
  } else {
    const rel = toPosix(path.relative(WEB, TESTS));
    for (const spec of shards[i - 1].specs) console.log(`${rel}/${spec}`);
  }
}
