#!/usr/bin/env node
// Longest-first (LPT) shard plan for the idiomatic Playwright suite.
//
//   node playwright/shard-plan.mjs <N> <i>     spec paths for shard i of N (1-based),
//                                                        one per line, relative to apps/web
//   node playwright/shard-plan.mjs <N>         the whole plan, per-shard totals (stderr)
//   node playwright/shard-plan.mjs --from-results <results.json>
//                                                        rewrite timings.json from a (merged)
//                                                        Playwright JSON report
//   node playwright/shard-plan.mjs --projects  the projects every planned spec runs
//                                                        on, one per line (e2e.yml reads it)
//
// Every planned spec runs on EVERY project in PROJECTS (desktop and mobile),
// both in the same shard: the shard passes all of them as --project, so one
// worker runs a spec's desktop and mobile tests back to back and a
// sole-writer spec never overlaps itself. A spec's weight is therefore its
// desktop + mobile time.
//
// Playwright's own --shard splits by test COUNT in file order, so one shard
// can draw every multi-minute set-builder spec. This assigns each spec to the
// currently lightest shard, heaviest spec first, which is what the retired
// Maestro work queue achieved dynamically (NEO-61).
//
// Timings: timings.json (seconds per spec path under tests/) is the only
// source. Only relative size matters. Its optional `projects` array names
// the projects each value sums; a file without one (the desktop-only format
// from before e2e-mobile) is read as `["e2e"]` and scaled up to all of
// PROJECTS, so old and new files plan alike. A spec with no timing (a new
// spec, or no timings.json at all) gets the median of the known timings, or
// 1s when there are none. setup.spec.ts (the seed job) and
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
const EXCLUDED = new Set(["setup.spec.ts", "profile/worker-bootstrap.spec.ts"]);
// Must match the spec projects in playwright.config.ts.
export const PROJECTS = ["e2e", "e2e-mobile"];

const toPosix = (p) => p.split(path.sep).join("/");

function listSpecs() {
  return fs
    .readdirSync(TESTS, { recursive: true })
    .map((p) => toPosix(String(p)))
    .filter((p) => p.endsWith(".spec.ts") && !EXCLUDED.has(p))
    .sort();
}

/** Seconds per spec for ALL of PROJECTS, whichever projects the file measured. */
function loadTimings() {
  if (!fs.existsSync(TIMINGS_JSON)) return {};
  const doc = JSON.parse(fs.readFileSync(TIMINGS_JSON, "utf8"));
  const measured = Array.isArray(doc.projects) && doc.projects.length > 0 ? doc.projects.length : 1;
  const scale = PROJECTS.length / measured;
  return Object.fromEntries(Object.entries(doc.seconds ?? {}).map(([spec, secs]) => [spec, secs * scale]));
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

// Sums every project in PROJECTS per spec. A spec that reported on only
// some of them (a project's run died) is scaled up from the ones it has, so
// one missing half never makes a spec look light. Projects outside PROJECTS
// (setup, bootstrap) are ignored.
function fromResults(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const perSpec = {}; // spec -> { project -> seconds }
  const walk = (suite, specFile) => {
    const f = toPosix(suite.file ?? specFile);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (!PROJECTS.includes(t.projectName)) continue;
        const d = (t.results ?? []).reduce((acc, r) => acc + (r.duration ?? 0), 0) / 1000;
        const byProject = (perSpec[f] ??= {});
        byProject[t.projectName] = (byProject[t.projectName] ?? 0) + d;
      }
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  const secs = {};
  for (const [spec, byProject] of Object.entries(perSpec)) {
    const values = Object.values(byProject);
    const total = values.reduce((a, b) => a + b, 0);
    secs[spec] = Math.round((total * PROJECTS.length) / values.length);
  }
  const sorted = Object.fromEntries(Object.entries(secs).sort(([a], [b]) => a.localeCompare(b)));
  const doc = {
    _source: `Playwright JSON report ${path.basename(file)}, seconds per spec summed over projects ${PROJECTS.join(" + ")}.`,
    projects: PROJECTS,
    seconds: sorted,
  };
  fs.writeFileSync(TIMINGS_JSON, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`wrote ${Object.keys(sorted).length} timings to ${path.relative(WEB, TIMINGS_JSON)}`);
}

const args = process.argv.slice(2);
if (args[0] === "--projects") {
  for (const p of PROJECTS) console.log(p);
} else if (args[0] === "--from-results") {
  if (!args[1]) throw new Error("usage: shard-plan.mjs --from-results <results.json>");
  fromResults(args[1]);
} else {
  const n = Number(args[0]);
  const i = args[1] === undefined ? undefined : Number(args[1]);
  if (!Number.isInteger(n) || n < 1 || (i !== undefined && (!Number.isInteger(i) || i < 1 || i > n))) {
    throw new Error("usage: shard-plan.mjs <N> [<i> in 1..N] | --from-results <results.json> | --projects");
  }
  const shards = plan(n);
  if (i === undefined) {
    shards.forEach((s, k) =>
      console.error(`shard ${k + 1}/${n}: ${s.specs.length} specs x ${PROJECTS.length} projects, ~${Math.round(s.secs)}s`),
    );
  } else {
    const rel = toPosix(path.relative(WEB, TESTS));
    for (const spec of shards[i - 1].specs) console.log(`${rel}/${spec}`);
  }
}
