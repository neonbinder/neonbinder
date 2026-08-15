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

import { globSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { ALL_TEST_INCLUDE, EXCLUDED_DIRS } from "../vitest.include.mjs";
import {
  extractRanFiles,
  findMissing,
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
      "If these files were dropped by a crashed worker, re-run — but do not\n" +
      "dismiss it as flake without checking, and never merge on a run that\n" +
      "printed this. If a file is listed every time, its directory is probably\n" +
      "not covered by the globs in vitest.include.mjs.\n",
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

const expectedFiles = new Set(
  ALL_TEST_INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: WEB_ROOT }))
    .filter((f) => !isExcluded(f, EXCLUDED_DIRS))
    .map((f) => path.resolve(WEB_ROOT, f)),
);

if (expectedFiles.size === 0) {
  // Globs matching nothing means the patterns or the cwd are wrong. Passing a
  // vacuous check is precisely the silence this script exists to prevent.
  fail(
    "The include globs matched ZERO test files. The patterns in " +
      "vitest.include.mjs, or this script's working directory, are wrong.",
    ALL_TEST_INCLUDE,
  );
}

const missing = findMissing(expectedFiles, ranFiles)
  .map((f) => path.relative(WEB_ROOT, f))
  .sort();

if (missing.length > 0) {
  fail(
    `${missing.length} test file(s) matched the include globs but reported no ` +
      `result. ${ranFiles.size} of ${expectedFiles.size} ran:`,
    missing,
  );
}

console.log(
  `✓ test completeness: ${ranFiles.size}/${expectedFiles.size} test files reported results`,
);
