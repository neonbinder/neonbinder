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
});
