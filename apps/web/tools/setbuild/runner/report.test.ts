import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeJwt } from "../auth/test-helpers";
import type { ApplyReport } from "../service";
import { writeReportFiles } from "./report";

const SECRET = "tes_secret_value_0123456789";
const JWT = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });

function report(reason: string): ApplyReport {
  return {
    target: { convexUrl: "https://happy-otter-123.convex.cloud", host: "happy-otter-123.convex.cloud" },
    scope: "e2e-baseline",
    confirmPhrase: "BUILD happy-otter-123.convex.cloud e2e-baseline 0123abcd",
    steps: [{ index: 0, kind: "set", path: "Baseball/2024/Topps/Topps Chrome", action: `sync (${reason})`, status: "todo" }],
    openDecisions: { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [] },
    template: null,
    counts: { built: 0, committed: 0, skipped: 0 },
    durationMs: 1,
    stoppedAt: { step: -1, reason: `failed: ${reason}` },
  };
}

describe("writeReportFiles (security audit item 3)", () => {
  test("both files go through the shared scrub: secret values and anything JWT-shaped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setbuild-report-"));
    const path = join(dir, "seed-report.json");
    const md = await writeReportFiles(path, report(`upstream said ${SECRET} with Bearer ${JWT}`), [SECRET, undefined]);
    expect(md).toBe(join(dir, "seed-report.md"));
    const files = [await readFile(path, "utf8"), await readFile(md, "utf8")];
    for (const text of files) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(JWT);
      expect(text).toContain("[redacted]");
      expect(text).toContain("[redacted-token]");
    }
    // Still a valid report.
    expect(JSON.parse(files[0]).stoppedAt.reason).toBe("failed: upstream said [redacted] with Bearer [redacted-token]");
  });
});
