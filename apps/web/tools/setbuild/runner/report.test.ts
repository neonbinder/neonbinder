import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeJwt } from "../auth/test-helpers";
import type { ApplyReport, AttentionReport, AttentionTotals, FixReport } from "../service";
import { applyEndLine, attentionSummaryLine } from "./attention";
import { attentionMarkdown, fixMarkdown, reportMarkdown, writeReportFiles } from "./report";

const SECRET = "tes_secret_value_0123456789";
const JWT = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });

function report(reason: string): ApplyReport {
  return {
    target: { convexUrl: "https://happy-otter-123.convex.cloud", host: "happy-otter-123.convex.cloud" },
    scope: "e2e-baseline",
    confirmPhrase: "BUILD happy-otter-123.convex.cloud e2e-baseline 0123abcd",
    steps: [{ index: 0, kind: "set", path: "Baseball/2024/Topps/Topps Chrome", action: `sync (${reason})`, status: "todo" }],
    openDecisions: { names: [], baseCandidates: [], reconcile: [], review: { players: [], teams: [], leagues: [] }, slReview: [], conflicts: [], grouping: [] },
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

describe("reportMarkdown", () => {
  test("opens with each set's Set Builder link, under the target line", () => {
    const md = reportMarkdown({
      ...report("x"),
      setLinks: [{ path: "Baseball/2014/Topps/Topps Chrome", link: "https://app.example.test/admin/set-builder?sport=a&year=b&brand=c&set=d" }],
    });
    const lines = md.split("\n");
    expect(lines.indexOf("Open Baseball/2014/Topps/Topps Chrome in the Set Builder: https://app.example.test/admin/set-builder?sport=a&year=b&brand=c&set=d")).toBe(4);
    expect(reportMarkdown(report("x"))).not.toContain("in the Set Builder");
  });
});

const totals = (o: Partial<AttentionTotals> = {}): AttentionTotals => ({
  cards: 0,
  byKind: {},
  awaitingTeamLookup: 0,
  namesToCheck: 0,
  slSetsToSort: 0,
  ...o,
});

describe("attentionSummaryLine", () => {
  test("the walker's own done line when nothing is left, lookups included", () => {
    expect(attentionSummaryLine(totals(), "Topps Chrome")).toBe("All clear — nothing on this checklist needs attention.");
    expect(attentionSummaryLine(totals({ awaitingTeamLookup: 3 }), "Topps Chrome")).toBe("All clear for now. Still looking up teams for 3 cards.");
  });

  test("names what is left, singular and plural, on the set", () => {
    expect(attentionSummaryLine(totals({ cards: 1 }), "Topps Chrome")).toBe("1 card needs you on Topps Chrome.");
    expect(attentionSummaryLine(totals({ cards: 2, awaitingTeamLookup: 1, namesToCheck: 13, slSetsToSort: 1 }), "Topps Chrome")).toBe(
      "2 cards need you on Topps Chrome, still looking up teams for 1 card; 13 names to check; 1 SportLots set to sort.",
    );
    expect(attentionSummaryLine(totals({ namesToCheck: 1 }), "Topps Chrome")).toBe("1 name to check on Topps Chrome.");
  });
});

describe("applyEndLine", () => {
  const clear = { ...totals(), summary: "x" };
  test("all clear only when every set is clear and no lookup is pending", () => {
    expect(applyEndLine([{ path: "A", attention: clear }], 0)).toBe("Built and all clear.");
    expect(applyEndLine([], 0)).toBeUndefined();
    expect(applyEndLine([{ path: "A", attention: { ...clear, awaitingTeamLookup: 2 } }], 0)).toBe(
      "Built, but not done: nothing needs you on A yet, but teams are still being looked up for 2 cards. Run nb_attention to walk them.",
    );
  });

  test("one line over every set that is not done; a stop says so first", () => {
    const one = { ...totals({ cards: 1 }), summary: "1 card needs you on A." };
    const names = { ...totals({ namesToCheck: 2 }), summary: "2 names to check on B." };
    expect(applyEndLine([{ path: "A", attention: one }, { path: "B", attention: names }, { path: "C", attention: clear }], 0)).toBe(
      "Built, but not done: 1 card needs you on A. 2 names to check on B. Run nb_attention to walk them.",
    );
    expect(applyEndLine([{ path: "A", attention: one }], 2)).toBe(
      "Stopped at 2 open decisions: answer them and apply again. Also: 1 card needs you on A. Run nb_attention to walk them.",
    );
    expect(applyEndLine([{ path: "A", attention: clear }], 1)).toBe("Stopped at 1 open decision: answer it and apply again.");
  });
});

describe("attention in the markdown", () => {
  test("an apply report ends on its attention line, and each set link carries its summary", () => {
    const md = reportMarkdown({
      ...report("x"),
      stoppedAt: undefined,
      setLinks: [{ path: "Baseball/2014/Topps/Topps Chrome", link: "/admin/set-builder", attention: { ...totals({ cards: 1 }), summary: "1 card needs you on Topps Chrome." } }],
      attentionLine: "Built, but not done: 1 card needs you on Topps Chrome. Run nb_attention to walk them.",
    });
    const lines = md.trimEnd().split("\n");
    expect(lines).toContain("- 1 card needs you on Topps Chrome.");
    expect(lines.at(-1)).toBe("**Built, but not done: 1 card needs you on Topps Chrome. Run nb_attention to walk them.**");
  });

  test("attentionMarkdown leads with the line, then every item with its link", () => {
    const r = {
      pathText: "Baseball/2014/Topps/Topps Chrome",
      link: "/admin/set-builder?set=s",
      summary: "1 card needs you on Topps Chrome; 1 name to check.",
      totals: totals({ cards: 1, namesToCheck: 1 }),
      cards: [{ rowLabel: "Base", cardNumber: "103b", cardName: "Jose Fernandez", reasons: ["variation text is over the 65-character limit"], link: "/l1" }],
      names: [{ where: "Baseball/2014/Topps/Topps Chrome › Inserts › Future Stars", currentValue: "Future Stars", sides: [{ side: "bsc", label: "Future Stars Inserts", foldEqual: false }], link: "/l2" }],
      slReview: null,
      review: null,
      notices: [],
    } as unknown as AttentionReport;
    const md = attentionMarkdown(r);
    expect(md.split("\n")[2]).toBe(r.summary);
    expect(md).toContain("- Base #103b Jose Fernandez — variation text is over the 65-character limit (/l1)");
    expect(md).toContain("NB says “Future Stars”; BSC calls it “Future Stars Inserts” (/l2)");
  });

  test("fixMarkdown lists every outcome with its warning", () => {
    const md = fixMarkdown({
      path: "Baseball/2014/Topps/Topps Chrome",
      applied: { cards: 1, names: 0 },
      results: [{ at: "cards[0]", outcome: "applied", detail: "Saved.", warning: "over 65" }],
      nameCounts: { applied: 0, declined: 0, stale: 0, clashed: 0, skipped: 0 },
      remaining: totals(),
      summary: "All clear — nothing on this checklist needs attention.",
    } as unknown as FixReport);
    expect(md).toContain("- `cards[0]` applied: Saved. (over 65)");
    expect(md.trimEnd().split("\n").at(-1)).toBe("Still: All clear — nothing on this checklist needs attention.");
  });
});
