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
  findMissing,
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

describe("extractRanFiles", () => {
  it("pulls file names out of vitest's JSON report", () => {
    expect(
      extractRanFiles({
        testResults: [{ name: "/w/a.test.ts" }, { name: "/w/b.test.ts" }],
      }),
    ).toEqual(["/w/a.test.ts", "/w/b.test.ts"]);
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
