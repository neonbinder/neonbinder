#!/usr/bin/env node
// Longest-first (LPT) shard plan for the idiomatic Playwright suite.
//
//   node playwright/shard-plan.mjs <N> <i> [--project <p>]
//                                                        spec paths for shard i of N (1-based),
//                                                        one per line, relative to apps/web
//   node playwright/shard-plan.mjs <N> [--project <p>]   the whole plan, per-shard totals (stderr)
//   node playwright/shard-plan.mjs --from-results <results.json>...
//                                                        rewrite timings.json from one or more
//                                                        (merged) Playwright JSON reports, each
//                                                        spec's median over the reports
//   node playwright/shard-plan.mjs --projects  the spec projects, one per line
//                                                        (e2e.yml's gate reads it)
//
// <p> is one of PROJECTS (default `e2e`, desktop). CI runs the suite in TWO
// passes, one per project, each on a freshly seeded preview (e2e.yml: seed ->
// shard-desktop x N -> seed-mobile -> shard-mobile x N): a spec that is
// fresh-only or the sole writer of a real marketplace set passes once per
// seed, so desktop and mobile never share one. Each pass plans on its own
// project's timings, one project's weight per spec, and every pass uses the
// same file set, less the specs playwright/project-scope.mjs leaves out of
// that project (NEO-389). Playwright's own --shard splits by test COUNT in file order,
// so one shard can draw every multi-minute set-builder spec. This assigns each
// spec to the currently lightest shard, heaviest spec first, which is what the
// retired Maestro work queue achieved dynamically (NEO-61).
//
// Timings: timings.json (seconds per spec path under tests/) is the only
// source. Only relative size matters. In CI, e2e.yml's `timings` job rewrites
// it before every run from the last few green runs' reports (NEO-389), so the
// committed file is the fallback when those cannot be fetched. Schema:
//   seconds    - per-spec seconds on `e2e` (desktop)
//   byProject  - optional { "<project>": { "<spec>": seconds } } for the
//                other projects (today `e2e-mobile`)
// A project with no value for a spec falls back to the desktop value, so a
// desktop-only file (the original format) plans both passes alike. A file
// with a legacy `projects` array (seconds summed over several projects) is
// divided back to a per-project figure. A spec with no timing at all (a new
// spec, or no timings.json) gets the median of the known timings, or 1s when
// there are none. setup.spec.ts (the seed jobs) and
// profile/worker-bootstrap.spec.ts (every shard's `bootstrap` project
// dependency) are never planned.
//
// An empty shard prints nothing: the caller must then run nothing, because
// `playwright test` with no file arguments runs the whole suite.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ignoredSpecs } from "./project-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const TESTS = path.join(HERE, "tests");
const TIMINGS_JSON = path.join(HERE, "timings.json");
const EXCLUDED = new Set(["setup.spec.ts", "profile/worker-bootstrap.spec.ts"]);
// Must match the spec projects in playwright.config.ts.
export const PROJECTS = ["e2e", "e2e-mobile"];
// A test runs for at most the config's 20 min timeout; anything above an hour
// in a report is not a real duration.
const MAX_SPEC_SECONDS = 3600;

const toPosix = (p) => p.split(path.sep).join("/");

function listSpecs(project) {
  const ignored = new Set(ignoredSpecs(project));
  return fs
    .readdirSync(TESTS, { recursive: true })
    .map((p) => toPosix(String(p)))
    .filter((p) => p.endsWith(".spec.ts") && !EXCLUDED.has(p) && !ignored.has(p))
    .sort();
}

/** Seconds per spec on `project`, falling back to the desktop value. */
function loadTimings(project) {
  if (!fs.existsSync(TIMINGS_JSON)) return {};
  const doc = JSON.parse(fs.readFileSync(TIMINGS_JSON, "utf8"));
  const legacy = Array.isArray(doc.projects) && doc.projects.length > 1 ? doc.projects.length : 1;
  const desktop = Object.fromEntries(Object.entries(doc.seconds ?? {}).map(([spec, secs]) => [spec, secs / legacy]));
  const own = doc.byProject?.[project] ?? {};
  return project === PROJECTS[0] ? desktop : { ...desktop, ...own };
}

function median(values) {
  if (values.length === 0) return 1;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function plan(n, project) {
  const timings = loadTimings(project);
  const specs = listSpecs(project);
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

// One figure per spec per project in PROJECTS: `seconds` is the desktop
// (PROJECTS[0]) run, `byProject` carries the others. With several reports
// each spec gets its median over the reports it appears in, so one slow run
// (a stalled marketplace fetch) cannot skew the plan (NEO-389). A spec that
// reported on only some projects (a pass died) falls back to its desktop
// value in the planner. Projects outside PROJECTS (setup, bootstrap) are
// ignored.
function fromResults(files) {
  const samples = Object.fromEntries(PROJECTS.map((p) => [p, {}])); // project -> spec -> [seconds per report]
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const perProject = Object.fromEntries(PROJECTS.map((p) => [p, {}])); // project -> spec -> seconds
    const walk = (suite, specFile) => {
      const f = toPosix(suite.file ?? specFile);
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          if (!PROJECTS.includes(t.projectName)) continue;
          const ms = (t.results ?? []).reduce((acc, r) => acc + (Number(r.duration) || 0), 0);
          // Reports come from other runs: clamp, so a bad figure can only
          // weigh a spec, never break the plan.
          const d = Math.min(Math.max(ms / 1000, 0), MAX_SPEC_SECONDS);
          perProject[t.projectName][f] = (perProject[t.projectName][f] ?? 0) + d;
        }
      }
      for (const child of suite.suites ?? []) walk(child, f);
    };
    for (const s of report.suites ?? []) walk(s, s.file);
    for (const p of PROJECTS) {
      for (const [f, d] of Object.entries(perProject[p])) (samples[p][f] ??= []).push(d);
    }
  }
  const perProject = Object.fromEntries(
    PROJECTS.map((p) => [p, Object.fromEntries(Object.entries(samples[p]).map(([f, ds]) => [f, median(ds)]))]),
  );
  const round = (m) =>
    Object.fromEntries(
      Object.entries(m)
        .map(([k, v]) => [k, Math.round(v)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const [desktop, ...others] = PROJECTS;
  const doc = {
    _source: `Median over ${files.length} Playwright JSON report(s), seconds per spec per project (${PROJECTS.join(", ")}).`,
    seconds: round(perProject[desktop]),
  };
  const byProject = Object.fromEntries(others.map((p) => [p, round(perProject[p])]).filter(([, m]) => Object.keys(m).length));
  if (Object.keys(byProject).length) doc.byProject = byProject;
  fs.writeFileSync(TIMINGS_JSON, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(
    `wrote timings for ${PROJECTS.map((p) => `${p}=${Object.keys(p === desktop ? doc.seconds : (byProject[p] ?? {})).length}`).join(", ")} to ${path.relative(WEB, TIMINGS_JSON)}`,
  );
}

const args = process.argv.slice(2);
const pIdx = args.indexOf("--project");
let project = PROJECTS[0];
if (pIdx !== -1) {
  project = args[pIdx + 1];
  if (!PROJECTS.includes(project)) throw new Error(`--project must be one of ${PROJECTS.join(", ")}, got '${project}'`);
  args.splice(pIdx, 2);
}
if (args[0] === "--projects") {
  for (const p of PROJECTS) console.log(p);
} else if (args[0] === "--from-results") {
  if (!args[1]) throw new Error("usage: shard-plan.mjs --from-results <results.json>...");
  fromResults(args.slice(1));
} else {
  const n = Number(args[0]);
  const i = args[1] === undefined ? undefined : Number(args[1]);
  if (!Number.isInteger(n) || n < 1 || (i !== undefined && (!Number.isInteger(i) || i < 1 || i > n))) {
    throw new Error(
      "usage: shard-plan.mjs <N> [<i> in 1..N] [--project <p>] | --from-results <results.json>... | --projects",
    );
  }
  const shards = plan(n, project);
  if (i === undefined) {
    shards.forEach((s, k) =>
      console.error(`shard ${k + 1}/${n} [${project}]: ${s.specs.length} specs, ~${Math.round(s.secs)}s`),
    );
  } else {
    const rel = toPosix(path.relative(WEB, TESTS));
    for (const spec of shards[i - 1].specs) console.log(`${rel}/${spec}`);
  }
}
