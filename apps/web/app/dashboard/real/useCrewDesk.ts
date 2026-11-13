/**
 * NEO-536 — the signed-in dashboard's crew (`../screen/crew`): the reads and
 * actions behind "Report to our crew" on Sync status and the crew section
 * under it. Kept apart from the screen so the demo never loads Convex.
 *
 * Both reads are subscribed and small: `crewDesk.mine` reads the caller's
 * newest requests (at most `MAX_REQUEST_LIST`) and open reports (at most
 * `MAX_OPEN_SYNC_REPORTS`; every one is in `reportedKeys`, which says
 * "Reported" on Sync status); `crewDesk.waiting`, asked only for an admin,
 * reads at most `CREW_DESK_WAITING` + 1 requests, and scans open reports
 * lazily to `CREW_DESK_WAITING` + 1 distinct sets (bounded by
 * `CREW_DESK_REPORT_SCAN`), counting for each the others who reported it, to
 * `SYNC_REPORT_GROUP_COUNT_CAP`. Neither re-runs on the
 * dashboard's own writes, only on a request or report changing, which is
 * exactly when the screen should move ("Reported" after a send, a row gone
 * after a withdraw).
 */

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { useMemo } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useIsAdmin } from "@/src/hooks/useIsAdmin";
import type { Marketplace } from "../dash-labels";
import type { Crew, CrewAsk, CrewDeskData } from "../screen/crew";

export type CrewMineRaw = FunctionReturnType<typeof api.crewDesk.mine>;
export type CrewWaitingRaw = FunctionReturnType<typeof api.crewDesk.waiting>;
type Platform = CrewMineRaw["reports"][number]["platform"];

function requestAsk(r: CrewMineRaw["requests"][number]): CrewAsk {
  return { id: r._id, kind: r.kind, label: r.label, at: r.requestedAt };
}

/** A report row; an admin's (`waiting`) also says how many other collectors have it open. */
function reportAsk(r: CrewMineRaw["reports"][number] | CrewWaitingRaw["reports"][number]): CrewAsk {
  return {
    id: r._id,
    kind: "report",
    label: r.label,
    platform: r.platform as Marketplace,
    at: r.reportedAt,
    ...("alsoReportedBy" in r ? { alsoReportedBy: r.alsoReportedBy } : {}),
  };
}

/**
 * The crew section's lists from the two reads: the collector's open asks
 * newest first, with how many more the totals count; an admin's waiting
 * asks oldest first (null when not asked). Undefined until `mine` answers.
 */
export function crewDeskOf(mine: CrewMineRaw | undefined, waiting: CrewWaitingRaw | undefined): CrewDeskData | undefined {
  if (!mine) return undefined;
  const asks = [...mine.requests.map(requestAsk), ...mine.reports.map(reportAsk)].sort((a, b) => b.at - a.at);
  const more = mine.requestsTotal - mine.requests.length + (mine.reportsTotal - mine.reports.length);
  return {
    mine: asks,
    mineMore: Math.max(0, more),
    waiting: waiting
      ? [...waiting.requests.map(requestAsk), ...waiting.reports.map(reportAsk)].sort((a, b) => a.at - b.at)
      : null,
    waitingMore: waiting ? waiting.requestsMore || waiting.reportsMore : false,
  };
}

/** One key per set and marketplace. */
export function reportKey(variantId: string, platform: string): string {
  return `${platform}|${variantId}`;
}

/**
 * The sets the collector has an open report on, by `reportKey`: every open
 * report (`reportedKeys`), not only the few the section names.
 */
export function reportedKeysOf(mine: CrewMineRaw | undefined): ReadonlySet<string> {
  return new Set((mine?.reportedKeys ?? []).map((r) => reportKey(r.variantId, r.platform)));
}

/** The sentence a failed call shows: the backend's own (a ConvexError's `message`), else the fallback. */
export function crewErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  }
  return fallback;
}

/** Only BuySportsCards and eBay are listing platforms a report can name. */
function listingPlatform(platform: Marketplace): Platform | null {
  return platform === "bsc" || platform === "ebay" ? platform : null;
}

export function useRealCrew(): Crew {
  const { isAdmin } = useIsAdmin();
  const mine = useQuery(api.crewDesk.mine, {});
  const waiting = useQuery(api.crewDesk.waiting, isAdmin ? {} : "skip");
  const sendReport = useMutation(api.syncReports.report);
  const sendWithdraw = useMutation(api.syncReports.withdraw);

  return useMemo<Crew>(() => {
    const reported = reportedKeysOf(mine);
    return {
      desk: crewDeskOf(mine, isAdmin ? waiting : undefined),
      isReported: (variantId, platform) => reported.has(reportKey(variantId, platform)),
      report: async ({ variantId, platform, note }) => {
        const to = listingPlatform(platform);
        if (!to) return "That marketplace can't take a report.";
        try {
          const trimmed = note.trim();
          await sendReport({
            variantId: variantId as Id<"selectorOptions">,
            platform: to,
            ...(trimmed ? { note: trimmed } : {}),
          });
          return null;
        } catch (error) {
          return crewErrorMessage(error, "That report didn't send. Give it another shot.");
        }
      },
      withdraw: async (reportId) => {
        try {
          await sendWithdraw({ id: reportId as Id<"syncReports"> });
          return null;
        } catch (error) {
          return crewErrorMessage(error, "That report didn't withdraw. Give it another shot.");
        }
      },
    };
  }, [mine, waiting, isAdmin, sendReport, sendWithdraw]);
}
