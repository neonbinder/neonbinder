import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pickReportAttempts } from "./pick-report-attempts.mjs";

describe("pickReportAttempts", () => {
  it("keeps the newest attempt <= current per base and mixes reruns", () => {
    const r = pickReportAttempts(
      ["pw-report-desktop-1-a1", "pw-report-desktop-1-a2", "pw-report-desktop-2-a1", "pw-report-seed-a1"],
      2,
    );
    expect(r.keep).toEqual(["pw-report-desktop-1-a2", "pw-report-desktop-2-a1", "pw-report-seed-a1"]);
    expect(r.drop).toEqual(["pw-report-desktop-1-a1"]);
  });
  it("ignores attempts newer than current", () => {
    const r = pickReportAttempts(["pw-report-seed-a1", "pw-report-seed-a3"], 2);
    expect(r.keep).toEqual(["pw-report-seed-a1"]);
    expect(r.drop).toEqual(["pw-report-seed-a3"]);
  });
  it("keeps the only attempt of a shard that passed in attempt 1 and was not rerun", () => {
    const r = pickReportAttempts(["pw-report-desktop-1-a1", "pw-report-desktop-2-a1", "pw-report-desktop-2-a2"], 2);
    expect(r.keep).toEqual(["pw-report-desktop-1-a1", "pw-report-desktop-2-a2"]);
    expect(r.drop).toEqual(["pw-report-desktop-2-a1"]);
  });
  it("keeps an unsuffixed name from before the suffix existed, as attempt 0 of its own base", () => {
    const r = pickReportAttempts(["pw-report-seed", "pw-report-desktop-1"], 3);
    expect(r.keep).toEqual(["pw-report-desktop-1", "pw-report-seed"]);
    expect(r.drop).toEqual([]);
  });
  it("lets a suffixed attempt of the same base replace an unsuffixed one, in either order", () => {
    for (const names of [["pw-report-seed", "pw-report-seed-a1"], ["pw-report-seed-a1", "pw-report-seed"]]) {
      const r = pickReportAttempts(names, 1);
      expect(r.keep).toEqual(["pw-report-seed-a1"]);
      expect(r.drop).toEqual(["pw-report-seed"]);
    }
  });
  it("picks the newest <= current whatever order the names arrive in", () => {
    const names = ["pw-report-x-a3", "pw-report-x-a1", "pw-report-x-a2"];
    for (const order of [names, [...names].reverse(), [names[1], names[2], names[0]]]) {
      const r = pickReportAttempts(order, 2);
      expect(r.keep).toEqual(["pw-report-x-a2"]);
      expect(r.drop).toEqual(["pw-report-x-a1", "pw-report-x-a3"]);
    }
  });
  it("keeps nothing when every attempt is newer than the current one", () => {
    const r = pickReportAttempts(["pw-report-x-a2", "pw-report-x-a3"], 1);
    expect(r.keep).toEqual([]);
    expect(r.drop).toEqual(["pw-report-x-a2", "pw-report-x-a3"]);
  });
  it("treats a multi-digit attempt as a number, not text (a10 beats a9)", () => {
    const r = pickReportAttempts(["pw-report-x-a9", "pw-report-x-a10"], 10);
    expect(r.keep).toEqual(["pw-report-x-a10"]);
  });
  it("treats a name that merely contains -a<digits> mid-name as part of the base", () => {
    const r = pickReportAttempts(["pw-report-a1-desktop-a2"], 2);
    expect(r.keep).toEqual(["pw-report-a1-desktop-a2"]);
  });
});

describe("pick-report-attempts CLI", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "pick-report-attempts.mjs");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("deletes the stale attempt directories and keeps the right ones, ignoring plain files", () => {
    dir = mkdtempSync(join(tmpdir(), "pick-report-"));
    for (const name of ["pw-report-a-a1", "pw-report-a-a2", "pw-report-b-a1", "pw-report-b-a3"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "report.zip"), "x");
    }
    writeFileSync(join(dir, "pw-report-note-a9"), "a file, not a directory");
    const res = run(dir, "2");
    expect(res.status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["pw-report-a-a2", "pw-report-b-a1", "pw-report-note-a9"]);
    expect(existsSync(join(dir, "pw-report-a-a2", "report.zip"))).toBe(true);
    expect(res.stdout).toContain("kept: pw-report-a-a2, pw-report-b-a1");
    expect(res.stdout).toContain("dropped: pw-report-a-a1, pw-report-b-a3");
  });

  it("says (none) and drops nothing for an empty directory", () => {
    dir = mkdtempSync(join(tmpdir(), "pick-report-"));
    const res = run(dir, "1");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("kept: (none)");
    expect(res.stdout).not.toContain("dropped");
  });

  it.each([
    ["a current attempt below 1", (d) => [d, "0"]],
    ["a non-numeric attempt", (d) => [d, "abc"]],
    ["a fractional attempt", (d) => [d, "1.5"]],
    ["a missing attempt", (d) => [d]],
    ["no arguments at all", () => []],
  ])("exits 2 with a usage line for %s, deleting nothing", (_name, args) => {
    dir = mkdtempSync(join(tmpdir(), "pick-report-"));
    mkdirSync(join(dir, "pw-report-a-a1"));
    const res = run(...args(dir));
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage:");
    expect(readdirSync(dir)).toEqual(["pw-report-a-a1"]);
  });

  it("fails when the directory does not exist", () => {
    dir = join(tmpdir(), "pick-report-does-not-exist");
    const res = run(dir, "1");
    expect(res.status).not.toBe(0);
  });
});
