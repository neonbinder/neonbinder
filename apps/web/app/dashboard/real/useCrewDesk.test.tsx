/**
 * NEO-536 — the signed-in dashboard's crew from its reads: the collector's
 * open asks newest first, an admin's oldest first, which sets read
 * "Reported", the sentence a refused call shows, and which held-back sets
 * get a Report button (and what their lead says).
 */

import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { crewDeskOf, crewErrorMessage, reportedKeysOf, reportKey, type CrewMineRaw, type CrewWaitingRaw } from "./useCrewDesk";
import type { SyncAlertsRaw } from "./useDashboardServer";
import { crewFixOf, syncStatusOf } from "./useRealDashboard";

type Raw = Record<string, unknown>;
const mineOf = (raw: Raw): CrewMineRaw =>
  ({ requests: [], requestsTotal: 0, reports: [], reportsTotal: 0, reportedKeys: [], ...raw }) as CrewMineRaw;
const waitingOf = (raw: Raw): CrewWaitingRaw =>
  ({ requests: [], requestsMore: false, reports: [], reportsMore: false, ...raw }) as CrewWaitingRaw;

const request = (id: string, at: number, kind: "card" | "set" = "card") => ({ _id: id, kind, label: `Request ${id}`, requestedAt: at });
const report = (id: string, at: number, variantId = `v-${id}`, platform: "bsc" | "ebay" = "ebay") => ({
  _id: id,
  label: `Report ${id}`,
  platform,
  variantId,
  heldBack: 2,
  reportedAt: at,
});

describe("crewDeskOf", () => {
  it("waits for the collector's read", () => {
    expect(crewDeskOf(undefined, undefined)).toBeUndefined();
  });

  it("the collector's asks, requests and reports together, newest first, the rest counted from the totals", () => {
    const desk = crewDeskOf(
      mineOf({ requests: [request("a", 30), request("b", 10, "set")], requestsTotal: 5, reports: [report("r", 20)], reportsTotal: 2 }),
      undefined,
    )!;
    expect(desk.mine.map((a) => [a.id, a.kind])).toEqual([
      ["a", "card"],
      ["r", "report"],
      ["b", "set"],
    ]);
    expect(desk.mine[1].platform).toBe("ebay");
    expect(desk.mineMore).toBe(3 + 1);
    expect(desk.waiting).toBeNull();
    expect(desk.waitingMore).toBe(false);
  });

  it("an admin's waiting asks, oldest first, with whether more wait", () => {
    const desk = crewDeskOf(
      mineOf({}),
      waitingOf({ requests: [request("a", 30)], reports: [{ ...report("r", 10), alsoReportedBy: 4 }], reportsMore: true }),
    )!;
    expect(desk.waiting!.map((a) => a.id)).toEqual(["r", "a"]);
    expect(desk.waiting![0].alsoReportedBy).toBe(4);
    expect(desk.waiting![1].alsoReportedBy).toBeUndefined();
    // The collector's own report rows carry no count.
    expect(crewDeskOf(mineOf({ reports: [report("m", 1)] }), undefined)!.mine[0]).not.toHaveProperty("alsoReportedBy");
    expect(desk.waitingMore).toBe(true);
  });
});

describe("reportedKeysOf", () => {
  it("names each open report's set on its marketplace, from every open report, not only the rows shown", () => {
    const keys = reportedKeysOf(
      mineOf({
        reports: [report("r", 1, "v1", "ebay")],
        reportedKeys: [
          { variantId: "v1", platform: "ebay" },
          { variantId: "v-old", platform: "bsc" },
        ],
      }),
    );
    expect(keys.has(reportKey("v1", "ebay"))).toBe(true);
    // An older report past the shown rows still reads Reported.
    expect(keys.has(reportKey("v-old", "bsc"))).toBe(true);
    expect(keys.has(reportKey("v1", "bsc"))).toBe(false);
    expect(reportedKeysOf(undefined).size).toBe(0);
  });
});

describe("crewErrorMessage", () => {
  it("shows the backend's own sentence, from a code-and-message error or a plain string", () => {
    expect(crewErrorMessage(new ConvexError({ code: "SYNC_REPORT_LIMIT", message: "Withdraw one." }), "fallback")).toBe("Withdraw one.");
    expect(crewErrorMessage(new ConvexError("Plain words."), "fallback")).toBe("Plain words.");
  });

  it("never a plain Error's text", () => {
    expect(crewErrorMessage(new Error("[CONVEX M(syncReports:report)] Server Error"), "fallback")).toBe("fallback");
  });
});

describe("which held-back sets the crew fixes", () => {
  const card = (reason: string) => ({ cardId: `c-${reason}`, reason }) as SyncAlertsRaw["sets"][number]["cards"][number];

  it("all, some or none of the named cards", () => {
    expect(crewFixOf({ failed: false, cards: [card("noLink"), card("rejected")] })).toEqual({ crewFix: "all" });
    expect(crewFixOf({ failed: false, cards: [card("noLink"), card("noPrice")] })).toEqual({ crewFix: "some" });
    expect(crewFixOf({ failed: false, cards: [card("noPrice")] })).toEqual({});
  });

  it("never a set whose last sync failed", () => {
    expect(crewFixOf({ failed: true, cards: [card("noLink")] })).toEqual({});
  });

  it("the sync status carries the set's id and who fixes it", () => {
    const raw = {
      pending: [],
      sets: [{ platform: "ebay", variantId: "variant-9", setLabel: "2024 Topps Base", failed: false, heldBack: 1, cards: [card("noLink")] }],
      more: false,
    } as unknown as SyncAlertsRaw;
    const status = syncStatusOf(raw, undefined)!;
    expect(status.problems[0].variantId).toBe("variant-9");
    expect(status.problems[0].crewFix).toBe("all");
  });
});
