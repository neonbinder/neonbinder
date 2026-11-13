/**
 * NEO-536 — "Tell the crew": a collector reports one held-back set (one
 * variant on one listing platform) to the admin team.
 *
 * The dashboard's Sync status panel (`dashboard.syncAlerts`) lists the sets
 * whose last sync held cards back. Some reasons the collector fixes
 * themselves; the rest only the admin team can fix
 * (`lib/collection/sync-report.REPORTABLE_SYNC_REASONS`). For a set holding
 * any of those, the collector can send a report:
 *   - `report` copies the reportable cards from the caller's OWN sync record
 *     (`marketplaceListingSyncs`); the client sends no card ids. A second
 *     report of the same set while one is open refreshes it.
 *   - `withdraw` deletes one of the caller's open reports.
 *   - `mine` is the caller's reports of every status, for My requests: a
 *     closed one carries the admin's note.
 *
 * An admin (`requireAdmin`) reads the open ones (`queue`, oldest first, one
 * row per set and platform), one in full (`review`), and closes them
 * (`close`): as Fixed, or as Not a bug with a note the collector reads. A
 * close settles every open report on that set and platform, whoever sent it,
 * because the fix is to NB's shared catalog. Nothing closes a report on its
 * own; `review` only says when the reporter's set last listed cleanly.
 *
 * Every collector read and write is owner-scoped: another collector's report
 * reads exactly like one that does not exist. NB data only: a report keeps
 * NB's own reasons and, for `rejected`/`missingAspect`, a short snapshot of
 * the detail NB's sync recorded, display-only for the admin, never NB data.
 */

import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireAdmin, requireSignedIn } from "./auth";
import { syncOutcome } from "./dashboard";
import { ListingLabels } from "./lib/listingLabels";
import { listingPlatformValidator, listingProblemReasonValidator, syncReportStatusValidator } from "./schema";
import {
  MAX_OPEN_SYNC_REPORTS,
  MAX_SYNC_REPORT_GROUP,
  MAX_SYNC_REPORT_NOTE,
  SYNC_REPORT_GROUP_COUNT_CAP,
  reportableProblems,
} from "../lib/collection/sync-report";

type Ctx = Pick<QueryCtx, "db">;
type ReportRow = Doc<"syncReports">;
type Platform = Doc<"syncReports">["platform"];

/** Sets the admin queue lists, oldest first. */
export const SYNC_REPORT_QUEUE = 50;
/**
 * Open reports the admin queue reads, oldest first (one more says "more"):
 * its rows and their counts both come from these, with no read per set.
 */
export const SYNC_REPORT_QUEUE_SCAN = 200;
/** The caller's reports `mine` returns, newest first. */
export const MY_SYNC_REPORTS = 50;

export const SYNC_REPORT_ERRORS = {
  notFound: "SYNC_REPORT_NOT_FOUND",
  invalid: "SYNC_REPORT_INVALID",
  limit: "SYNC_REPORT_LIMIT",
} as const;

function refuse(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/** Trimmed text, or undefined for blank. Refuses text over `MAX_SYNC_REPORT_NOTE`. */
function cleanNote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SYNC_REPORT_NOTE) {
    refuse(SYNC_REPORT_ERRORS.invalid, `That note is too long. Keep it under ${MAX_SYNC_REPORT_NOTE} characters.`);
  }
  return trimmed;
}

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

const reportCardValidator = v.object({
  cardId: v.id("cardChecklist"),
  reason: listingProblemReasonValidator,
  detail: v.optional(v.string()),
});

/** One of the caller's reports, as My requests lists it. Never `closedBy`. */
export const mySyncReportValidator = v.object({
  _id: v.id("syncReports"),
  status: syncReportStatusValidator,
  label: v.string(),
  platform: listingPlatformValidator,
  variantId: v.id("selectorOptions"),
  heldBack: v.number(),
  note: v.optional(v.string()),
  reportedAt: v.number(),
  closedAt: v.optional(v.number()),
  /** The admin's note to the collector on a close (always there for `notABug`). */
  closeNote: v.optional(v.string()),
});

/** One set in the admin queue: the oldest open report on it stands for the rest. */
export const syncReportQueueItemValidator = v.object({
  _id: v.id("syncReports"),
  label: v.string(),
  platform: listingPlatformValidator,
  variantId: v.id("selectorOptions"),
  heldBack: v.number(),
  note: v.optional(v.string()),
  reportedAt: v.number(),
  /** Other collectors with this set open too, counted to `SYNC_REPORT_GROUP_COUNT_CAP` (equal reads "20+"). */
  alsoReportedBy: v.number(),
});

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

/** The open reports on one set and platform, at most `cap`. */
async function openInGroup(ctx: Ctx, variantId: Id<"selectorOptions">, platform: Platform, cap: number): Promise<ReportRow[]> {
  return await ctx.db
    .query("syncReports")
    .withIndex("by_variant_platform_status_owner", (q) =>
      q.eq("variantId", variantId).eq("platform", platform).eq("status", "open"),
    )
    .take(cap);
}

/**
 * Other open reports on the report's set and platform, counted to
 * `SYNC_REPORT_GROUP_COUNT_CAP`: one capped read of the set's open reports.
 * The review and the dashboard's admin list (`crewDesk.waiting`, a few rows)
 * count this way; the queue counts the reports it has already read.
 */
export async function alsoReportedBy(ctx: Ctx, row: ReportRow): Promise<number> {
  const group = await openInGroup(ctx, row.variantId, row.platform, SYNC_REPORT_GROUP_COUNT_CAP + 1);
  return Math.min(group.filter((r) => r._id !== row._id).length, SYNC_REPORT_GROUP_COUNT_CAP);
}

/** The same held-back cards, in the same order, with the same reasons and details (key order aside). */
function sameCards(a: ReportRow["cards"], b: ReportRow["cards"]): boolean {
  return a.length === b.length && a.every((c, i) => c.cardId === b[i].cardId && c.reason === b[i].reason && c.detail === b[i].detail);
}

/** The owner's sync record of one set on one platform (one at most). */
async function syncRecordOf(
  ctx: Ctx,
  ownerId: string,
  variantId: Id<"selectorOptions">,
  platform: Platform,
): Promise<Doc<"marketplaceListingSyncs"> | null> {
  return await ctx.db
    .query("marketplaceListingSyncs")
    .withIndex("by_owner_variant_platform", (q) =>
      q.eq("ownerId", ownerId).eq("variantId", variantId).eq("platform", platform),
    )
    .unique();
}

/**
 * When the reporter's set last listed without holding back any reported
 * card: the record's last run time, when its last run finished (`idle`), its
 * held-back list is whole (not cut at the writer's cap, which could hide a
 * card) and names none of them. Undefined otherwise, or with no record.
 * Computed on read; nothing is stored.
 */
export function listedCleanlySince(
  record: Pick<Doc<"marketplaceListingSyncs">, "status" | "lastRunAt" | "problems" | "problemsTotal"> | null,
  reported: ReadonlyArray<{ cardId: string }>,
): number | undefined {
  if (!record || record.status !== "idle" || record.lastRunAt === undefined) return undefined;
  if ((record.problemsTotal ?? record.problems.length) > record.problems.length) return undefined;
  const held = new Set(record.problems.flatMap((p) => (p.cardId === undefined ? [] : [p.cardId as string])));
  return reported.some((c) => held.has(c.cardId)) ? undefined : record.lastRunAt;
}

// ───────────────────────────────────────────────────────────────────────────
// Collector
// ───────────────────────────────────────────────────────────────────────────

/**
 * Report one held-back set to the admin team. Copies the reportable cards
 * from the caller's own sync record of that set and platform (at most
 * `MAX_SYNC_REPORT_CARDS`; `heldBack` counts them all). Refuses with no
 * record, a failed last sync (NB tries again on its own), or nothing
 * reportable. An open report of the caller's on the same set and platform
 * is refreshed instead (`already: true`); a `note` left out keeps its note,
 * a blank one clears it. A refresh that changes nothing (same cards, count
 * and note) writes nothing, so its "refreshed" time stays put. At most
 * `MAX_OPEN_SYNC_REPORTS` open per collector.
 */
export const report = mutation({
  args: {
    variantId: v.id("selectorOptions"),
    platform: listingPlatformValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({ id: v.id("syncReports"), already: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const note = cleanNote(args.note);
    const record = await syncRecordOf(ctx, ownerId, args.variantId, args.platform);
    if (!record) {
      refuse(SYNC_REPORT_ERRORS.notFound, "That set hasn't synced there yet, so there's nothing to report.");
    }
    if (syncOutcome(record, Date.now()).failed) {
      refuse(
        SYNC_REPORT_ERRORS.invalid,
        "That set's last sync didn't finish, and NB tries it again on its own. If cards are still held back after that, report it then.",
      );
    }
    const { cards, heldBack } = reportableProblems(record.problems);
    if (heldBack === 0) {
      refuse(
        SYNC_REPORT_ERRORS.invalid,
        "Nothing held back in that set needs the crew. Each card's reason says what to change.",
      );
    }
    const now = Date.now();
    const open = await ctx.db
      .query("syncReports")
      .withIndex("by_variant_platform_status_owner", (q) =>
        q.eq("variantId", args.variantId).eq("platform", args.platform).eq("status", "open").eq("ownerId", ownerId),
      )
      .first();
    if (open) {
      // Sent again with nothing new: leave the row (and its "refreshed" time) alone.
      const nextNote = args.note !== undefined ? note : open.note;
      const same =
        heldBack === open.heldBack && nextNote === open.note && sameCards(cards, open.cards);
      if (!same) {
        await ctx.db.patch(open._id, {
          cards,
          heldBack,
          ...(args.note !== undefined ? { note } : {}),
          lastUpdated: now,
        });
      }
      return { id: open._id, already: true };
    }
    const mineOpen = await ctx.db
      .query("syncReports")
      .withIndex("by_owner_status_closed", (q) => q.eq("ownerId", ownerId).eq("status", "open"))
      .take(MAX_OPEN_SYNC_REPORTS);
    if (mineOpen.length >= MAX_OPEN_SYNC_REPORTS) {
      refuse(
        SYNC_REPORT_ERRORS.limit,
        `You have ${MAX_OPEN_SYNC_REPORTS} reports open. Withdraw one, or wait for the crew to close some.`,
      );
    }
    const label = await new ListingLabels(ctx, { brand: true }).setLabel(args.variantId);
    const id = await ctx.db.insert("syncReports", {
      ownerId,
      platform: args.platform,
      variantId: args.variantId,
      label,
      cards,
      heldBack,
      ...(note !== undefined ? { note } : {}),
      status: "open",
      lastUpdated: now,
    });
    return { id, already: false };
  },
});

/** Withdraw one of the caller's open reports (deletes it). Anyone else's reads as not found. */
export const withdraw = mutation({
  args: { id: v.id("syncReports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.ownerId !== ownerId) refuse(SYNC_REPORT_ERRORS.notFound, "That report isn't one of yours.");
    if (row.status !== "open") refuse(SYNC_REPORT_ERRORS.invalid, "The crew closed that report already.");
    await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * The caller's reports of every status, newest first (an open one by when it
 * was sent, a closed one by when it was closed), at most `MY_SYNC_REPORTS`.
 * A closed one carries the admin's note. Never who closed it.
 */
export const mine = query({
  args: {},
  returns: v.array(mySyncReportValidator),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows: ReportRow[] = [];
    for (const status of ["open", "fixed", "notABug"] as const) {
      rows.push(
        ...(await ctx.db
          .query("syncReports")
          .withIndex("by_owner_status_closed", (q) => q.eq("ownerId", ownerId).eq("status", status))
          .order("desc")
          .take(MY_SYNC_REPORTS)),
      );
    }
    const at = (r: ReportRow) => r.closedAt ?? r._creationTime;
    rows.sort((a, b) => at(b) - at(a));
    return rows.slice(0, MY_SYNC_REPORTS).map((r) => ({
      _id: r._id,
      status: r.status,
      label: r.label,
      platform: r.platform,
      variantId: r.variantId,
      heldBack: r.heldBack,
      ...(r.note !== undefined ? { note: r.note } : {}),
      reportedAt: r._creationTime,
      ...(r.closedAt !== undefined ? { closedAt: r.closedAt } : {}),
      ...(r.closeNote !== undefined ? { closeNote: r.closeNote } : {}),
    }));
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Admin
// ───────────────────────────────────────────────────────────────────────────

/**
 * Open reports, oldest first: one row per set and platform (the oldest open
 * report on it stands for the others), at most `SYNC_REPORT_QUEUE` sets, all
 * from the oldest `SYNC_REPORT_QUEUE_SCAN` open reports. `alsoReportedBy`
 * counts the set's other reports among those same rows, to
 * `SYNC_REPORT_GROUP_COUNT_CAP`: exact while that many or fewer are open,
 * and with more, a floor (newer reports past the scan are not counted; the
 * review counts them all). One bounded read, no read per set, because the
 * list is a subscription. `more`: another open report or set is past the
 * list. No collector ids.
 */
export const queue = query({
  args: {},
  returns: v.object({ reports: v.array(syncReportQueueItemValidator), more: v.boolean() }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("syncReports")
      .withIndex("by_status_closed", (q) => q.eq("status", "open"))
      .take(SYNC_REPORT_QUEUE_SCAN + 1);
    const read = rows.slice(0, SYNC_REPORT_QUEUE_SCAN);
    const groupOf = (row: ReportRow) => `${row.variantId}|${row.platform}`;
    const inGroup = new Map<string, number>();
    for (const row of read) inGroup.set(groupOf(row), (inGroup.get(groupOf(row)) ?? 0) + 1);
    const seen = new Set<string>();
    const firsts: ReportRow[] = [];
    for (const row of read) {
      if (seen.has(groupOf(row))) continue;
      seen.add(groupOf(row));
      firsts.push(row);
    }
    const reports = firsts.slice(0, SYNC_REPORT_QUEUE).map((row) => ({
      _id: row._id,
      label: row.label,
      platform: row.platform,
      variantId: row.variantId,
      heldBack: row.heldBack,
      ...(row.note !== undefined ? { note: row.note } : {}),
      reportedAt: row._creationTime,
      alsoReportedBy: Math.min((inGroup.get(groupOf(row)) ?? 1) - 1, SYNC_REPORT_GROUP_COUNT_CAP),
    }));
    return { reports, more: rows.length > SYNC_REPORT_QUEUE_SCAN || firsts.length > SYNC_REPORT_QUEUE };
  },
});

/**
 * One report in full, for the admin's review: the held cards by NB number
 * and name (a card gone from NB is left out, `cardsGone` counts it), how many
 * other collectors have the set open too, the reporter's id (only to open
 * their sync status, `/admin/sync-status?owner=`), and when the reporter's
 * set last listed without holding a reported card back
 * (`listedCleanlySince`, computed now; nothing closes on it). Null for a bad
 * id or a gone report.
 */
export const review = query({
  args: { id: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("syncReports"),
      status: syncReportStatusValidator,
      label: v.string(),
      platform: listingPlatformValidator,
      variantId: v.id("selectorOptions"),
      heldBack: v.number(),
      note: v.optional(v.string()),
      reportedAt: v.number(),
      lastUpdated: v.number(),
      closedAt: v.optional(v.number()),
      closeNote: v.optional(v.string()),
      ownerId: v.string(),
      cards: v.array(
        v.object({
          cardId: v.id("cardChecklist"),
          reason: listingProblemReasonValidator,
          detail: v.optional(v.string()),
          cardNumber: v.string(),
          /** Player names joined " / ", else the card's NB name; absent when both are blank. */
          cardLabel: v.optional(v.string()),
        }),
      ),
      cardsGone: v.number(),
      alsoReportedBy: v.number(),
      listedCleanlySince: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = ctx.db.normalizeId("syncReports", args.id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) return null;
    const labels = new ListingLabels(ctx, { brand: true });
    const cards = [];
    let cardsGone = 0;
    for (const c of row.cards) {
      const card = await labels.card(c.cardId);
      if (!card) {
        cardsGone += 1;
        continue;
      }
      cards.push({
        cardId: c.cardId,
        reason: c.reason,
        ...(c.detail !== undefined ? { detail: c.detail } : {}),
        cardNumber: card.cardNo,
        ...(card.cardLabel !== undefined ? { cardLabel: card.cardLabel } : {}),
      });
    }
    const record = await syncRecordOf(ctx, row.ownerId, row.variantId, row.platform);
    const since = listedCleanlySince(record, row.cards);
    return {
      _id: row._id,
      status: row.status,
      label: row.label,
      platform: row.platform,
      variantId: row.variantId,
      heldBack: row.heldBack,
      ...(row.note !== undefined ? { note: row.note } : {}),
      reportedAt: row._creationTime,
      lastUpdated: row.lastUpdated,
      ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}),
      ...(row.closeNote !== undefined ? { closeNote: row.closeNote } : {}),
      ownerId: row.ownerId,
      cards,
      cardsGone,
      alsoReportedBy: row.status === "open" ? await alsoReportedBy(ctx, row) : 0,
      ...(since !== undefined ? { listedCleanlySince: since } : {}),
    };
  },
});

/**
 * Close a report as `fixed` or `notABug`, and with it every open report on
 * the same set and platform, whoever sent it (the fix is to NB's shared
 * catalog). Not a bug needs a note: the collector reads it. Refuses past
 * `MAX_SYNC_REPORT_GROUP` open reports in the group rather than half-do it.
 */
export const close = mutation({
  args: {
    id: v.id("syncReports"),
    outcome: v.union(v.literal("fixed"), v.literal("notABug")),
    note: v.optional(v.string()),
  },
  returns: v.object({ closed: v.number() }),
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) refuse(SYNC_REPORT_ERRORS.notFound, "That report is gone. The collector may have withdrawn it.");
    if (row.status !== "open") refuse(SYNC_REPORT_ERRORS.invalid, "That report is closed already.");
    const note = cleanNote(args.note);
    if (args.outcome === "notABug" && note === undefined) {
      refuse(SYNC_REPORT_ERRORS.invalid, "Add a note saying why it isn't a bug. The collector reads it.");
    }
    const group = await openInGroup(ctx, row.variantId, row.platform, MAX_SYNC_REPORT_GROUP + 1);
    if (group.length > MAX_SYNC_REPORT_GROUP) {
      refuse(
        SYNC_REPORT_ERRORS.limit,
        `More than ${MAX_SYNC_REPORT_GROUP} collectors reported this set, which is more than one close can settle.`,
      );
    }
    const now = Date.now();
    for (const r of group) {
      await ctx.db.patch(r._id, {
        status: args.outcome,
        closedBy: adminId,
        closedAt: now,
        ...(note !== undefined ? { closeNote: note } : {}),
        lastUpdated: now,
      });
    }
    return { closed: group.length };
  },
});
