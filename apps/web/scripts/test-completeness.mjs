/**
 * NEO-164 — pure comparison logic for the test-completeness gate.
 *
 * Split from the CLI (`verify-test-completeness.mjs`) purely so it can be
 * unit-tested. That matters more than usual here: this code is the thing that
 * decides whether a suite which printed "passed" is actually trustworthy. If
 * it silently no-ops — an empty expected set, a path-shape mismatch that makes
 * every file look present — it does not merely fail to help, it manufactures
 * confidence. So the failure modes are asserted rather than assumed.
 *
 * No I/O here. The CLI does the globbing and file reading and hands results in.
 */

/**
 * True when a repo-relative path sits inside a directory that must never
 * contribute test files (vendored deps, build output).
 *
 * Matches on whole path SEGMENTS, not substrings: a legitimate directory named
 * `dist-tools` or a file called `build.test.ts` must not be swallowed.
 */
export function isExcluded(relPath, excludedDirs) {
  return relPath
    .split("/")
    .some((segment) => excludedDirs.includes(segment));
}

/**
 * Files that were expected to run but reported no result, sorted.
 *
 * Both inputs must already be normalised to the same absolute form — comparing
 * a relative path against an absolute one would report everything as missing,
 * which is loud and therefore safe, whereas the reverse mistake would report
 * nothing as missing and be silent. The CLI resolves both through
 * `path.resolve` against the same root for that reason.
 */
export function findMissing(expectedFiles, ranFiles) {
  const ran = ranFiles instanceof Set ? ranFiles : new Set(ranFiles);
  return [...expectedFiles].filter((f) => !ran.has(f)).sort();
}

/**
 * Did this file's entry in the report actually execute its tests?
 *
 * Presence of the entry is NOT enough. Vitest's JSON reporter emits one entry
 * per file task registered in run state, and marks it `passed` unless a test
 * explicitly failed — so a module that was collected but whose worker died
 * before running it still appears, with an empty `assertionResults` or with
 * assertions left `pending`. Counting that as "ran" reinstates exactly the
 * silent-skip bug this gate exists to catch.
 *
 * `skipped` is fine: that is a deliberate `.skip`, which is a coverage
 * decision someone made on purpose. `pending` is not: that is a test that
 * never reached a verdict.
 */
export function fileDidRun(result) {
  const assertions = result?.assertionResults;
  if (!Array.isArray(assertions) || assertions.length === 0) return false;
  return !assertions.some((a) => a?.status === "pending");
}

/**
 * Extract the paths of test files that genuinely executed.
 *
 * Tolerates a missing/!Array `testResults` by returning an empty list, which
 * the caller turns into "everything is missing" — the safe direction. Entries
 * without a usable name, or that did not really run, are dropped for the same
 * reason: every ambiguous case must push toward failing loudly.
 */
export function extractRanFiles(report) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  return results
    .filter((r) => fileDidRun(r))
    .map((r) => r?.name)
    .filter((n) => typeof n === "string" && n);
}

/**
 * Whole-run red flags that are independent of any single file.
 *
 * Returns a list of human-readable problems, empty when the run looks sound.
 * These are cheap belt-and-braces: the `&&` in `test:unit` already means a
 * non-zero vitest exit skips this script entirely, so reaching here with
 * `success: false` or pending tests would itself be surprising — which is
 * precisely why it is worth saying out loud rather than assuming.
 */
export function findRunLevelProblems(report) {
  const problems = [];
  if (report?.success !== true) {
    problems.push(`vitest reported success=${JSON.stringify(report?.success)}`);
  }
  if (typeof report?.numPendingTests === "number" && report.numPendingTests > 0) {
    problems.push(
      `${report.numPendingTests} test(s) never reached a verdict (pending)`,
    );
  }
  return problems;
}
