#!/usr/bin/env node
/**
 * NEO-164 — fail the run when a test file did not report a result.
 *
 * ## Why this exists
 *
 * `vitest run` can finish, print "passed", and exit 0 while whole test files
 * never ran. Two independent causes, both silent:
 *
 *   1. **A worker fork dies mid-run.** Observed repeatedly on this suite:
 *      `[vitest-pool]: Worker forks emitted error / Worker exited unexpectedly`.
 *      The dropped file varies run to run, and it is load-sensitive — it
 *      reproduces far more often when the machine is busy, which is exactly
 *      when CI runs. It also happens with `--no-file-parallelism`, so it is
 *      not contention between concurrent forks.
 *   2. **A test file sits in a directory no glob covers.** It is collected by
 *      nothing and never runs — forever, not just on one unlucky run. This has
 *      already happened twice: NEO-128 (src/layouts/) and NEO-141 (app/).
 *
 * In both cases the summary reports a smaller total and still says "passed".
 * The only tell is comparing COUNTS against what you expected, which requires
 * a human to remember to do it. This script does it mechanically.
 *
 * ## How it works
 *
 * Expected = every file matching the shared globs in ../vitest.include.mjs —
 * the same list vitest.config.ts collects from, deliberately not a second copy.
 * Actual = every file that reported a result in vitest's JSON output.
 * Any expected file with no result fails the run and is named.
 *
 * That covers cause (1) directly. It covers cause (2) as long as the new
 * directory is added to the shared globs — which is the one thing a human
 * still has to do, and the config comment says so.
 *
 * Usage: node scripts/verify-test-completeness.mjs [resultsFile]
 */

import { globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { EXCLUDED_DIRS, TEST_FILE_GLOB } from "../vitest.include.mjs";
import {
  extractRanFiles,
  findMissing,
  findRunLevelProblems,
  isExcluded,
} from "./test-completeness.mjs";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const resultsFile = path.resolve(
  WEB_ROOT,
  process.argv[2] ?? ".vitest-results.json",
);

function fail(message, detail = []) {
  console.error(`\n✖ test completeness check FAILED\n\n${message}`);
  for (const line of detail) console.error(`    ${line}`);
  console.error(
    "\nThis is NEO-164: the suite can drop files and still print “passed”.\n" +
      "\n" +
      "  • Listed once, varying between runs → a vitest worker fork died and\n" +
      "    took the file with it. Re-run. Do NOT write it off as flake without\n" +
      "    looking, and never merge on a run that printed this.\n" +
      "  • Listed EVERY run → the file is not collected at all. Its extension\n" +
      "    and directory are not paired by any glob in vitest.include.mjs\n" +
      "    (.test.ts under convex/ and lib/, .test.tsx under components/, src/\n" +
      "    and app/, .test.mjs under scripts/). Add the pairing there. This is\n" +
      "    the silent-forever case from NEO-128 and NEO-141.\n",
  );
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(resultsFile, "utf8");
} catch (err) {
  // A missing results file means vitest died before writing one. That is
  // itself a failed run, and silently passing here would defeat the point.
  fail(
    `Could not read vitest results at ${path.relative(WEB_ROOT, resultsFile)} — ` +
      `vitest likely crashed before writing them.`,
    [String(err.message ?? err)],
  );
}

let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  fail(`vitest results at ${resultsFile} are not valid JSON.`, [
    String(err.message ?? err),
  ]);
}

// Both sides are resolved against the same root so the comparison is
// apples-to-apples; see findMissing's note on why a mismatch here would be
// silent in the dangerous direction.
const ranFiles = new Set(
  extractRanFiles(report).map((f) => path.resolve(WEB_ROOT, f)),
);

/**
 * Every test-shaped file under apps/web, found INDEPENDENTLY of the globs
 * vitest collects from — see TEST_FILE_GLOB for why that independence is the
 * whole point.
 *
 * Top-level directories are enumerated and filtered before globbing rather
 * than globbing `**` from the root, so `node_modules` (~800 packages) is never
 * walked at all instead of being walked and then discarded.
 */
function discoverTestFiles(root) {
  const roots = readdirSync(root, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        !EXCLUDED_DIRS.includes(e.name),
    )
    .map((e) => e.name);

  const patterns = [
    TEST_FILE_GLOB, // a test file sitting at the apps/web root
    ...roots.map((dir) => `${dir}/**/${TEST_FILE_GLOB}`),
  ];

  return patterns
    .flatMap((pattern) => globSync(pattern, { cwd: root }))
    .filter((f) => !isExcluded(f, EXCLUDED_DIRS));
}

const expectedFiles = new Set(
  discoverTestFiles(WEB_ROOT).map((f) => path.resolve(WEB_ROOT, f)),
);

if (expectedFiles.size === 0) {
  // Discovery matching nothing means the pattern or the cwd is wrong. Passing
  // a vacuous check is precisely the silence this script exists to prevent.
  fail(
    "Discovery found ZERO test files. TEST_FILE_GLOB in vitest.include.mjs, " +
      "or this script's working directory, is wrong.",
    [TEST_FILE_GLOB, `cwd: ${WEB_ROOT}`],
  );
}

const runProblems = findRunLevelProblems(report);
if (runProblems.length > 0) {
  fail("The run itself reported a problem:", runProblems);
}

const missing = findMissing(expectedFiles, ranFiles)
  .map((f) => path.relative(WEB_ROOT, f))
  .sort();

if (missing.length > 0) {
  fail(
    `${missing.length} test file(s) exist but reported no result. ` +
      `${ranFiles.size} of ${expectedFiles.size} ran:`,
    missing,
  );
}

console.log(
  `✓ test completeness: ${ranFiles.size}/${expectedFiles.size} test files reported results`,
);
