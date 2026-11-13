/**
 * NEO-536 — the dashboard's "with the crew" section: what is open between a
 * collector and the admin team, below Sync status.
 *
 * - `mine`: the caller's open asks: card and set requests still waiting
 *   (`cardRequests`, NEO-361) and sync reports still open (`syncReports`).
 * - `waiting`: for an admin, the open asks from every collector, oldest
 *   first, each with the id the admin screens open it by.
 *
 * Open items only (Jason, 2026-11-13: the dashboard holds stats and actions,
 * no history). A decided request or a closed report shows in the collector's
 * My requests list instead (`collectionRequests.mine`, `syncReports.mine`).
 * NB data only.
 */

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireAdmin, requireSignedIn } from "./auth";
import { MAX_REQUEST_LIST } from "./collectionRequests";
import { alsoReportedBy } from "./syncReports";
import { cardRequestKindValidator, listingPlatformValidator } from "./schema";
import { MAX_OPEN_SYNC_REPORTS } from "../lib/collection/sync-report";

/** Asks of each kind `mine` names (the rest are counted). */
export const CREW_DESK_SHOWN = 6;
/**
 * Asks of each kind `waiting` lists, oldest first: what the dashboard draws
 * (`app/dashboard/screen/crew.ts` `WAITING_SHOWN`, pinned equal by
 * `CrewDesk.test.tsx`). The dashboard merges the two kinds oldest first and
 * draws that many, so neither kind needs more; the rest live on Card Requests.
 */
export const CREW_DESK_WAITING = 8;
/**
 * Open reports `waiting` reads at most while finding `CREW_DESK_WAITING` + 1
 * sets (several collectors can report one set). Past it, "more".
 */
export const CREW_DESK_REPORT_SCAN = 100;

const requestItemValidator = v.object({
  _id: v.id("cardRequests"),
  kind: cardRequestKindValidator,
  label: v.string(),
  requestedAt: v.number(),
});

const reportItemValidator = v.object({
  _id: v.id("syncReports"),
  label: v.string(),
  platform: listingPlatformValidator,
  variantId: v.id("selectorOptions"),
  heldBack: v.number(),
  reportedAt: v.number(),
});

/** An admin's report row: with how many other collectors have that set open too (`syncReports.queue`'s count). */
const waitingReportItemValidator = v.object({
  _id: v.id("syncReports"),
  label: v.string(),
  platform: listingPlatformValidator,
  variantId: v.id("selectorOptions"),
  heldBack: v.number(),
  reportedAt: v.number(),
  /** Other collectors with this set open too, counted to `SYNC_REPORT_GROUP_COUNT_CAP` (equal reads "20+"). */
  alsoReportedBy: v.number(),
});

/** One set and platform the caller has an open report on. */
const reportedKeyValidator = v.object({
  variantId: v.id("selectorOptions"),
  platform: listingPlatformValidator,
});

/**
 * The caller's open asks, newest first, at most `CREW_DESK_SHOWN` of each,
 * with how many there are of each (`requestsTotal`, `reportsTotal`) for
 * "+N more". `reportedKeys` names the set and platform of EVERY open report
 * (not only the shown ones), so Sync status can say "Reported" on any set. Waiting requests are found among the caller's newest
 * `MAX_REQUEST_LIST` requests (the per-collector cap on open ones); open
 * reports are capped at `MAX_OPEN_SYNC_REPORTS` per collector, so both
 * counts are whole.
 */
export const mine = query({
  args: {},
  returns: v.object({
    requests: v.array(requestItemValidator),
    requestsTotal: v.number(),
    reports: v.array(reportItemValidator),
    reportsTotal: v.number(),
    reportedKeys: v.array(reportedKeyValidator),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const requestRows = await ctx.db
      .query("cardRequests")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(MAX_REQUEST_LIST);
    const waiting = requestRows.filter((r) => r.status === "waiting");
    const reportRows = await ctx.db
      .query("syncReports")
      .withIndex("by_owner_status_closed", (q) => q.eq("ownerId", ownerId).eq("status", "open"))
      .order("desc")
      .take(MAX_OPEN_SYNC_REPORTS);
    return {
      requests: waiting.slice(0, CREW_DESK_SHOWN).map((r) => ({
        _id: r._id,
        kind: r.kind,
        label: r.label,
        requestedAt: r._creationTime,
      })),
      requestsTotal: waiting.length,
      reports: reportRows.slice(0, CREW_DESK_SHOWN).map((r) => ({
        _id: r._id,
        label: r.label,
        platform: r.platform,
        variantId: r.variantId,
        heldBack: r.heldBack,
        reportedAt: r._creationTime,
      })),
      reportsTotal: reportRows.length,
      reportedKeys: reportRows.map((r) => ({ variantId: r.variantId, platform: r.platform })),
    };
  },
});

/**
 * Every collector's open asks, for an admin: waiting card and set requests
 * (opened on /admin/card-requests by `_id` and `kind`) and open sync reports
 * (by `_id`), oldest first, at most `CREW_DESK_WAITING` of each; `…More`:
 * another is past them. One report row per set and platform, the oldest
 * open one standing for the rest (an admin's close settles them together),
 * with how many other collectors have it open too (`alsoReportedBy`, counted
 * only for the rows returned). No collector ids.
 *
 * Bounded for a subscription: `CREW_DESK_WAITING` + 1 requests, at most
 * `CREW_DESK_REPORT_SCAN` reports, and `SYNC_REPORT_GROUP_COUNT_CAP` + 1 per
 * returned report row, a couple of hundred documents at worst.
 */
export const waiting = query({
  args: {},
  returns: v.object({
    requests: v.array(requestItemValidator),
    requestsMore: v.boolean(),
    reports: v.array(waitingReportItemValidator),
    reportsMore: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const requestRows = await ctx.db
      .query("cardRequests")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .take(CREW_DESK_WAITING + 1);
    // The oldest open report on each set, until one set past what is drawn.
    const firsts: Doc<"syncReports">[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    for await (const r of ctx.db.query("syncReports").withIndex("by_status_closed", (q) => q.eq("status", "open"))) {
      scanned += 1;
      const group = `${r.variantId}|${r.platform}`;
      if (!seen.has(group)) {
        seen.add(group);
        firsts.push(r);
        if (firsts.length > CREW_DESK_WAITING) break;
      }
      if (scanned >= CREW_DESK_REPORT_SCAN) break;
    }
    // Past the scan with nothing more found: there may be sets beyond it, so say "more" rather than guess.
    const reportsMore = firsts.length > CREW_DESK_WAITING || scanned >= CREW_DESK_REPORT_SCAN;
    const reports = [];
    for (const r of firsts.slice(0, CREW_DESK_WAITING)) {
      reports.push({
        _id: r._id,
        label: r.label,
        platform: r.platform,
        variantId: r.variantId,
        heldBack: r.heldBack,
        reportedAt: r._creationTime,
        alsoReportedBy: await alsoReportedBy(ctx, r),
      });
    }
    return {
      requests: requestRows.slice(0, CREW_DESK_WAITING).map((r) => ({
        _id: r._id,
        kind: r.kind,
        label: r.label,
        requestedAt: r._creationTime,
      })),
      requestsMore: requestRows.length > CREW_DESK_WAITING,
      reports,
      reportsMore,
    };
  },
});
