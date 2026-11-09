import { describe, expect, it } from "vitest";
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
