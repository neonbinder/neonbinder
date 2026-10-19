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
  autographRows: 0,
  ...o,
});

describe("attentionSummaryLine", () => {
  const brand = "Topps 2024";
  test("the walker's own done line when nothing is left, lookups included", () => {
    expect(attentionSummaryLine(totals(), "Topps Chrome", brand)).toBe("All clear — nothing on this checklist needs attention.");
    expect(attentionSummaryLine(totals({ awaitingTeamLookup: 3 }), "Topps Chrome", brand)).toBe("All clear for now. Still looking up teams for 3 cards.");
  });

  test("names what is left, singular and plural, on the set", () => {
    expect(attentionSummaryLine(totals({ cards: 1 }), "Topps Chrome", brand)).toBe("1 card needs you on Topps Chrome.");
    expect(attentionSummaryLine(totals({ cards: 2, awaitingTeamLookup: 1, namesToCheck: 13, slSetsToSort: 1 }), "Topps Chrome", brand)).toBe(
      "2 cards need you on Topps Chrome, still looking up teams for 1 card; 13 names to check; 1 SportLots set to sort for Topps 2024.",
    );
    expect(attentionSummaryLine(totals({ namesToCheck: 1 }), "Topps Chrome", brand)).toBe("1 name to check on Topps Chrome.");
  });

  test("the SportLots count is the brand-year's, never the set's", () => {
    expect(attentionSummaryLine(totals({ slSetsToSort: 3 }), "Topps Chrome", brand)).toBe("3 SportLots sets to sort for Topps 2024.");
    expect(attentionSummaryLine(totals({ slSetsToSort: 1, awaitingTeamLookup: 2 }), "Topps Chrome", brand)).toBe(
      "Still looking up teams for 2 cards on Topps Chrome; 1 SportLots set to sort for Topps 2024.",
    );
  });

  test("NEO-345: rows asking on card or sticker are named, and keep the line from reading all clear", () => {
    expect(attentionSummaryLine(totals({ autographRows: 1 }), "Topps Chrome Black", brand)).toBe(
      "1 autograph row to mark on-card or sticker on Topps Chrome Black.",
    );
    expect(attentionSummaryLine(totals({ cards: 21, namesToCheck: 14, autographRows: 3, slSetsToSort: 2 }), "Topps Chrome Black", brand)).toBe(
      "21 cards need you on Topps Chrome Black; 14 names to check; 3 autograph rows to mark on-card or sticker; 2 SportLots sets to sort for Topps 2024.",
    );
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

  test("NEO-345: a set whose header still asks on card or sticker is never all clear", () => {
    const autographs = { ...totals({ autographRows: 2 }), summary: "2 autograph rows to mark on-card or sticker on A." };
    expect(applyEndLine([{ path: "A", attention: autographs }], 0)).toBe(
      "Built, but not done: 2 autograph rows to mark on-card or sticker on A. Run nb_attention to walk them.",
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
    expect(md).not.toContain("autograph row");
  });

  test("attentionMarkdown lists each autograph row with its line, its answers and its link, and the links note", () => {
    const r = {
      pathText: "Baseball/2024/Topps/Topps Chrome Black",
      link: "/admin/set-builder?set=s",
      summary: "1 autograph row to mark on-card or sticker on Topps Chrome Black.",
      totals: totals({ autographRows: 1 }),
      cards: [],
      autographs: [
        {
          row: { type: "Insert", name: "Ivory Autographs" },
          rowLabel: "Insert › Ivory Autographs",
          rowId: "r1",
          link: "/l3",
          cards: 17,
          prompt: "17 autographed cards — on card or sticker?",
          answers: [
            { format: "On Card", label: "On card" },
            { format: "Sticker/Label", label: "Sticker" },
          ],
        },
      ],
      names: [],
      slReview: null,
      review: null,
      notices: [],
      linksNote: "Links are paths only: set NB_SETBUILD_APP_URL to the app address for this deployment.",
    } as unknown as AttentionReport;
    const md = attentionMarkdown(r);
    expect(md).toContain("### 1 autograph row to mark on-card or sticker");
    expect(md).toContain('- Insert › Ivory Autographs: 17 autographed cards — on card or sticker? Answer "On Card" or "Sticker/Label" (/l3)');
    expect(md).toContain("Links are paths only: set NB_SETBUILD_APP_URL to the app address for this deployment.");
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
    expect(md).toContain("Applied 1 card answer and 0 name answers.");
    expect(md.trimEnd().split("\n").at(-1)).toBe("Still: All clear — nothing on this checklist needs attention.");
  });

  test("fixMarkdown counts autograph answers when there are any", () => {
    const md = fixMarkdown({
      path: "Baseball/2024/Topps/Topps Chrome Black",
      applied: { cards: 0, names: 1, autographs: 2 },
      results: [{ at: "autographs[0]", outcome: "applied", detail: "Autographs saved as on card.", warning: "still marking" }],
      nameCounts: { applied: 1, declined: 0, stale: 0, clashed: 0, skipped: 0 },
      remaining: totals(),
      summary: "All clear — nothing on this checklist needs attention.",
    } as unknown as FixReport);
    expect(md).toContain("Applied 0 card answers, 2 autograph answers and 1 name answer.");
    expect(md).toContain("- `autographs[0]` applied: Autographs saved as on card. (still marking)");
  });
});
