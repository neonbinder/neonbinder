/**
 * NEO-164 — tests for the test-completeness gate itself.
 *
 * This gate exists because the suite can print "passed" while whole files
 * never ran. If the gate no-ops, we are worse off than before: the run still
 * says passed AND now carries a green completeness tick. So the cases below
 * are mostly about proving it FAILS when it should, not that it passes.
 *
 * Note this file lives under scripts/ and is `.mjs`, so it only runs because
 * `scripts/**\/*.test.mjs` was added to the shared globs in vitest.include.mjs
 * — the same "a new test location needs a glob" step this gate enforces.
 */

import { describe, expect, it } from "vitest";

import {
  extractRanFiles,
  fileDidRun,
  findMissing,
  findRunLevelProblems,
  isExcluded,
} from "./test-completeness.mjs";

const EXCLUDED = ["node_modules", "dist", "build"];

describe("isExcluded", () => {
  it("excludes vendored and build directories at any depth", () => {
    expect(isExcluded("node_modules/foo/a.test.tsx", EXCLUDED)).toBe(true);
    expect(isExcluded("components/x/dist/a.test.tsx", EXCLUDED)).toBe(true);
    expect(isExcluded("build/a.test.tsx", EXCLUDED)).toBe(true);
  });

  it("matches whole segments, not substrings", () => {
    // A real directory that merely starts with an excluded name, and a file
    // whose basename contains one. Substring matching would eat both.
    expect(isExcluded("components/dist-tools/a.test.tsx", EXCLUDED)).toBe(false);
    expect(isExcluded("lib/build.test.ts", EXCLUDED)).toBe(false);
    expect(isExcluded("components/Card.test.tsx", EXCLUDED)).toBe(false);
  });
});

describe("findMissing", () => {
  it("returns nothing when every expected file ran", () => {
    const files = ["/w/a.test.ts", "/w/b.test.ts"];
    expect(findMissing(files, files)).toEqual([]);
  });

  it("names the files that did not report, sorted", () => {
    const missing = findMissing(
      ["/w/c.test.ts", "/w/a.test.ts", "/w/b.test.ts"],
      ["/w/b.test.ts"],
    );
    expect(missing).toEqual(["/w/a.test.ts", "/w/c.test.ts"]);
  });

  it("reports everything missing when the run produced no results", () => {
    // A worker that died before reporting, or a crashed run. This must be the
    // loudest case, not the quietest.
    expect(findMissing(["/w/a.test.ts", "/w/b.test.ts"], [])).toEqual([
      "/w/a.test.ts",
      "/w/b.test.ts",
    ]);
  });

  it("ignores extra reported files it did not expect", () => {
    // Not our concern: a file that ran but is not in the globs is a config
    // question, not a dropped-coverage question, and failing on it would make
    // the gate noisy enough to get disabled.
    expect(findMissing(["/w/a.test.ts"], ["/w/a.test.ts", "/w/z.test.ts"])).toEqual(
      [],
    );
  });

  it("accepts a Set or an array for what ran", () => {
    expect(findMissing(["/w/a.test.ts"], new Set(["/w/a.test.ts"]))).toEqual([]);
  });
});

describe("fileDidRun", () => {
  const passed = { status: "passed" };

  it("accepts a file whose assertions reached a verdict", () => {
    expect(fileDidRun({ assertionResults: [passed] })).toBe(true);
    expect(
      fileDidRun({ assertionResults: [passed, { status: "failed" }] }),
    ).toBe(true);
  });

  it("accepts deliberately skipped tests", () => {
    // `.skip` is a coverage decision someone made on purpose — not the silent
    // drop this gate is hunting. Failing on it would make the gate noisy
    // enough to get switched off.
    expect(fileDidRun({ assertionResults: [{ status: "skipped" }] })).toBe(true);
  });

  it("rejects an entry that reported no assertions at all", () => {
    // The dangerous shape: vitest emits one entry per file task it registered,
    // marked `passed` unless something explicitly failed. A module collected
    // but never executed — its worker died first — looks exactly like this.
    expect(fileDidRun({ assertionResults: [] })).toBe(false);
    expect(fileDidRun({})).toBe(false);
    expect(fileDidRun(null)).toBe(false);
    expect(fileDidRun({ assertionResults: "nope" })).toBe(false);
  });

  it("rejects a file with any test left pending", () => {
    expect(
      fileDidRun({ assertionResults: [passed, { status: "pending" }] }),
    ).toBe(false);
  });
});

describe("findRunLevelProblems", () => {
  const clean = { success: true, numPendingTests: 0 };

  it("passes a sound run", () => {
    expect(findRunLevelProblems(clean)).toEqual([]);
  });

  it("flags success:false and pending tests", () => {
    expect(findRunLevelProblems({ ...clean, success: false })).toHaveLength(1);
    expect(findRunLevelProblems({ ...clean, numPendingTests: 3 })).toHaveLength(
      1,
    );
  });

  it("flags a report missing success entirely", () => {
    // Absent is not the same as true. A truncated or foreign report must not
    // coast through on a missing field.
    expect(findRunLevelProblems({})).not.toEqual([]);
    expect(findRunLevelProblems(null)).not.toEqual([]);
  });
});

describe("extractRanFiles", () => {
  const ran = { assertionResults: [{ status: "passed" }] };

  it("pulls file names out of vitest's JSON report", () => {
    expect(
      extractRanFiles({
        testResults: [
          { name: "/w/a.test.ts", ...ran },
          { name: "/w/b.test.ts", ...ran },
        ],
      }),
    ).toEqual(["/w/a.test.ts", "/w/b.test.ts"]);
  });

  it("omits a file that appears in the report but never executed", () => {
    // Regression guard for the exact hole a review found: keying on the
    // filename alone let an entry with empty assertionResults count as "ran",
    // so a worker that died after collection produced a green tick.
    expect(
      extractRanFiles({
        testResults: [
          { name: "/w/a.test.ts", ...ran },
          { name: "/w/dropped.test.ts", assertionResults: [] },
        ],
      }),
    ).toEqual(["/w/a.test.ts"]);
  });

  it("treats a malformed or empty report as nothing having run", () => {
    // Degrading toward "everything missing" keeps a corrupt report loud. The
    // opposite default would let a truncated JSON file pass the gate.
    expect(extractRanFiles({})).toEqual([]);
    expect(extractRanFiles(null)).toEqual([]);
    expect(extractRanFiles({ testResults: "not-an-array" })).toEqual([]);
    expect(extractRanFiles({ testResults: [{}, { name: "" }] })).toEqual([]);
  });
});
