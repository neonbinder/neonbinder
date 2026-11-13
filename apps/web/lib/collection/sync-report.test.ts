import { describe, expect, test } from "vitest";
import { listingProblemReasonValidator } from "../../convex/schema";
import {
  MAX_SYNC_REPORT_CARDS,
  MAX_SYNC_REPORT_DETAIL,
  REPORTABLE_SYNC_REASONS,
  hasReportableCard,
  isReportableSyncReason,
  reportableProblems,
  syncReportDetail,
} from "./sync-report";

const ALL_REASONS = listingProblemReasonValidator.members.map((m) => m.value);

describe("isReportableSyncReason", () => {
  test("exactly the reasons only the admin team can fix", () => {
    expect(ALL_REASONS.filter(isReportableSyncReason).sort()).toEqual(
      ["missingAspect", "noLink", "notOnSheet", "numberMismatch", "rejected", "sharedLink"].sort(),
    );
  });

  test("every reportable reason is one the schema knows", () => {
    for (const r of REPORTABLE_SYNC_REASONS) expect(ALL_REASONS).toContain(r);
  });

  test("hasReportableCard: any one card is enough", () => {
    expect(hasReportableCard([{ reason: "noPrice" }, { reason: "noPhoto" }])).toBe(false);
    expect(hasReportableCard([{ reason: "noPrice" }, { reason: "notOnSheet" }])).toBe(true);
    expect(hasReportableCard([])).toBe(false);
  });
});

describe("syncReportDetail", () => {
  test("kept only for rejected and missingAspect, trimmed and cut", () => {
    expect(syncReportDetail("rejected", "  said no  ")).toBe("said no");
    expect(syncReportDetail("missingAspect", "Year Manufactured")).toBe("Year Manufactured");
    expect(syncReportDetail("noLink", "anything")).toBeUndefined();
    expect(syncReportDetail("rejected", "   ")).toBeUndefined();
    expect(syncReportDetail("rejected", undefined)).toBeUndefined();
    expect(syncReportDetail("rejected", "a".repeat(MAX_SYNC_REPORT_DETAIL + 1))).toHaveLength(MAX_SYNC_REPORT_DETAIL);
  });
});

describe("reportableProblems", () => {
  test("keeps reportable problems naming a card, capped, counting them all", () => {
    const problems = [
      { cardId: "a", reason: "noPrice" },
      { reason: "noLink" },
      { cardId: "b", reason: "sharedLink", detail: "dropped" },
      ...Array.from({ length: MAX_SYNC_REPORT_CARDS + 1 }, () => ({ cardId: "c", reason: "notOnSheet" })),
    ];
    const out = reportableProblems(problems);
    expect(out.heldBack).toBe(MAX_SYNC_REPORT_CARDS + 2);
    expect(out.cards).toHaveLength(MAX_SYNC_REPORT_CARDS);
    expect(out.cards[0]).toEqual({ cardId: "b", reason: "sharedLink" });
  });
});
