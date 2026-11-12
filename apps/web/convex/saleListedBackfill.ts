/**
 * NEO-509 — one-time backfill: give BSC sale lines stored before NEO-509 the
 * card description BSC sends (`marketplaceSales.items[].listed`), so the Pick
 * List can name an unmatched line ("2021 Score · Justin Fields · #TB2")
 * instead of "Unmatched sale (n of 80)".
 *
 * The poll already re-reads up to `MAX_OPEN_ORDER_REFRESH` open orders each
 * round and fills `listed` as it goes (`recordOrderCore`); this reaches the
 * orders that window misses. Runbook:
 * `docs/operations/neo509-backfill-sale-descriptions.md`. Delete this file and
 * its flag once a dry run on prod reports `"orders": 0`.
 *
 * What it touches:
 *   - Candidates: BSC sales still on the Pick List (`orderOnPickList`: a sale
 *     status, not shipped), never a test seed's order (`isTestSaleOrderId`),
 *     with at least one line lacking `listed`. Read the way `pickList.open`
 *     reads them: `by_owner_pull_open` plus the newest by `by_owner_date`.
 *   - Writes: `items[].listed` ONLY, and only where a line has none
 *     (`fillListed`). Lines are matched by `saleItemKey` + occurrence, the
 *     same key as the poll's merge and the Pick List's line ids, so ids do not
 *     move. Never `applied`, `appliedAt`, `from`, `pulledAt`, `problem`,
 *     `pullOpen`, status or totals; nothing is applied or re-applied.
 *   - Each description goes through the poll's own store rules: the bounds
 *     re-check and NB's sport resolved by id (`storedListed`, `sportResolver`),
 *     and the per-sale byte budget (`capListed`, the poll's own helper: a
 *     line already holding one keeps it and is budgeted first; from the first
 *     new line that would pass `MAX_LISTED_BYTES_PER_SALE`, no new line gets
 *     one).
 *
 * Two arms, the NEO-214 pair: `confirm: "BACKFILL"` per invocation and
 * `ALLOW_SALE_LISTED_BACKFILL=1` on the deployment. Without both it is a dry
 * run that makes NO BuySportsCards call (no token read either) and reports the
 * candidates; a `confirm` on an unarmed deployment is reported as refused,
 * never thrown. `fillListed` re-checks the flag itself, so it is not a write
 * primitive on an unarmed deployment.
 *
 * Owners: only those the sales poll itself polls (`listingOutbox.pollsSales`
 * on the owner's BSC listing state: a saved sign-in, not dormant, not held
 * off by the E2E marker), on the walk and for an `ownerId` alike. Any other
 * owner is counted in `ownersNotPolled` and never read, dry run included.
 *
 * Armed, a call's BSC contact is bounded three ways:
 *   - Session opens: every open attempt (`openBscSellerSession`, op
 *     "saleListedBackfill", always closed), success or failure, is charged to
 *     `MAX_OPENS_PER_CALL` (5). A walk page holds at most that many listing
 *     states, so the walk never stalls on it.
 *   - Order reads: one `readBscOrder` at a time about a second apart, at most
 *     `maxOrders` (default 5, cap 20) per call.
 *   - Time: no session is opened and no read started once `READ_DEADLINE_MS`
 *     (8 minutes) has passed since the call began, so Convex's 10-minute
 *     action limit never cuts the `finally` that closes a session.
 * An owner BSC has signed out is skipped, and so is one whose reads fail
 * `MAX_CONSECUTIVE_UNAVAILABLE` (2) times running on a timeout, a network
 * error or a 5xx (`stopped: "unavailable"`); a 429 (BSC limits by volume)
 * stops the whole call. Safe to re-run: a filled line is never a candidate
 * again.
 */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { OPEN_SALES_READ, RECENT_SALES_READ } from "./pickList";
import { orderOnPickList, saleItemKey } from "./lib/pickLines";
import { isTestSaleOrderId } from "./lib/testSeedMarks";
import {
  capListed,
  MAX_SALE_ITEMS,
  projectBscOrder,
  projectedListedValidator,
  sportResolver,
  storedListed,
} from "./listingSales";
import { pollsSales } from "./listingOutbox";
import {
  closeBscSellerSession,
  openBscSellerSession,
  readBscOrder,
  type BscSellerFailure,
} from "./adapters/bscSeller";

type Sale = Doc<"marketplaceSales">;
type SaleItem = Sale["items"][number];
type ProjectedListed = typeof projectedListedValidator.type;

export const CONFIRM_TOKEN = "BACKFILL";
export const ENV_FLAG = "ALLOW_SALE_LISTED_BACKFILL";
/** Orders one armed call reads from BSC when `maxOrders` is not given. */
export const DEFAULT_MAX_ORDERS = 5;
/** The most orders one armed call reads, whatever `maxOrders` says. */
export const MAX_ORDERS_CAP = 20;
/** Spacing between two BSC order reads in one call. */
export const ORDER_SPACING_MS = 1000;
/** BSC session open attempts (success or failure) one armed call may make. */
export const MAX_OPENS_PER_CALL = 5;
/**
 * Listing-state rows one call reads when it walks every owner. No more than
 * the open budget, so a page never needs more opens than a call has and the
 * walk always moves on to the next page.
 */
export const OWNERS_PER_PAGE = MAX_OPENS_PER_CALL;
/** Timeout, network or 5xx read failures in a row that stop an owner. */
export const MAX_CONSECUTIVE_UNAVAILABLE = 2;
/**
 * No session is opened and no order read started after this long from the
 * call's start. One read in flight then takes at most its 30 s timeout (or,
 * once per session, a re-auth and a retry), well inside Convex's 10-minute
 * action limit, so the `finally` that closes the session always runs.
 */
export const READ_DEADLINE_MS = 8 * 60_000;
/** The session name on the BSC call summary (NEO-475). */
export const SESSION_OP = "saleListedBackfill";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

const DRY_RUN_MESSAGE =
  `Dry run: nothing written and no BuySportsCards call made. Arm with ${ENV_FLAG}=1 on the ` +
  `deployment and re-run with {"confirm":"${CONFIRM_TOKEN}","ownerId":"<owner>"} to fill.`;
const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed. Set ${ENV_FLAG}=1 on it, check it with env get, ` +
  `re-run, and remove the flag afterwards. Nothing was written and no BuySportsCards call was ` +
  `made; the counts below are the dry run's.`;
const ARMED_MESSAGE = "Filled. Re-run the dry run to confirm what is left.";

// ── Reads ──────────────────────────────────────────────────────────────────

const candidateValidator = v.object({
  saleId: v.id("marketplaceSales"),
  orderId: v.string(),
  linesMissing: v.number(),
});

/** A sale this backfill would read: BSC, on the Pick List, not a test seed, a line lacking `listed`. */
function isCandidate(sale: Sale, ownerId: string): boolean {
  return (
    sale.ownerId === ownerId &&
    sale.platform === "bsc" &&
    orderOnPickList(sale) &&
    !isTestSaleOrderId(sale.orderId) &&
    sale.items.some((item) => item.listed === undefined)
  );
}

/**
 * One owner's candidate sales, oldest first (the Pick List's order). Reads
 * what `pickList.open` reads: the `pullOpen` index, plus the newest by date
 * for orders stored before `pullOpen` existed.
 *
 * `null` when the sales poll does not poll this owner on BSC (no BSC listing
 * state, or one failing `pollsSales`: dormant, never started, or held off by
 * the E2E marker). Such an owner's orders are neither counted nor read.
 */
export const ownerCandidates = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.null(), v.array(candidateValidator)),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", "bsc"))
      .unique();
    if (!state || !pollsSales(state)) return null;
    const openSales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_pull_open", (q) => q.eq("ownerId", args.ownerId).eq("pullOpen", true))
      .order("asc")
      .take(OPEN_SALES_READ);
    const recentSales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(RECENT_SALES_READ);
    const byId = new Map<string, Sale>();
    for (const sale of [...openSales, ...recentSales]) {
      if (isCandidate(sale, args.ownerId)) byId.set(sale._id, sale);
    }
    return [...byId.values()]
      .sort((a, b) => a.orderDate - b.orderDate || a._creationTime - b._creationTime)
      .map((sale) => ({
        saleId: sale._id,
        orderId: sale.orderId,
        linesMissing: sale.items.filter((item) => item.listed === undefined).length,
      }));
  },
});

/**
 * One page of the owners the sales poll polls on BSC (a BSC listing state
 * passing `pollsSales`), by owner id (an index the poll does not rewrite
 * while the walk is under way).
 */
export const ownersPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ ownerIds: v.array(v.string()), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform")
      .paginate({ numItems: OWNERS_PER_PAGE, cursor: args.cursor });
    const ownerIds = [
      ...new Set(page.page.filter((row) => row.platform === "bsc" && pollsSales(row)).map((row) => row.ownerId)),
    ];
    return { ownerIds, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

// ── The write ──────────────────────────────────────────────────────────────

const fillLineValidator = v.object({
  platformCardId: v.string(),
  condition: v.string(),
  sellerSku: v.optional(v.string()),
  listed: v.optional(projectedListedValidator),
});

const fillOutcomeValidator = v.union(
  v.literal("filled"),
  v.literal("notArmed"),
  v.literal("gone"),
  v.literal("offList"),
);

/** `key#n`: the n-th line (from 0) with that `saleItemKey`, as the poll's merge pairs lines. */
function occurrenceKeys(items: ReadonlyArray<Pick<SaleItem, "platformCardId" | "condition" | "sellerSku">>): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = saleItemKey(item);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key}#${n}`;
  });
}

/**
 * Sets `listed` on the sale's lines that lack one, from a fresh BSC read of
 * the same order. Re-reads the sale, so a line the poll filled in between is
 * left as it is. Patches `items` only, and only when a line was filled.
 */
export const fillListed = internalMutation({
  args: { ownerId: v.string(), saleId: v.id("marketplaceSales"), lines: v.array(fillLineValidator) },
  returns: v.object({ outcome: fillOutcomeValidator, filled: v.number(), stillMissing: v.number() }),
  handler: async (ctx, args) => {
    if (!deploymentIsArmed()) return { outcome: "notArmed" as const, filled: 0, stillMissing: 0 };
    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.ownerId !== args.ownerId || sale.platform !== "bsc") {
      return { outcome: "gone" as const, filled: 0, stillMissing: 0 };
    }
    if (!orderOnPickList(sale) || isTestSaleOrderId(sale.orderId)) {
      return { outcome: "offList" as const, filled: 0, stillMissing: 0 };
    }

    const freshKeys = occurrenceKeys(args.lines);
    const fresh = new Map<string, ProjectedListed>();
    args.lines.forEach((line, i) => {
      if (line.listed !== undefined) fresh.set(freshKeys[i], line.listed);
    });

    // Only lines without a description get a candidate; a line that holds one
    // keeps it as it is. The poll's own budget rule (`capListed`) then spends
    // the stored ones first and the new ones on what is left, in item order.
    const resolveSport = sportResolver(ctx, "bsc");
    const storedKeys = occurrenceKeys(sale.items);
    const candidates: SaleItem[] = [];
    for (let i = 0; i < sale.items.length; i += 1) {
      const item = sale.items[i];
      const projected = item.listed === undefined ? fresh.get(storedKeys[i]) : undefined;
      const listed = projected !== undefined ? await storedListed(projected, resolveSport) : undefined;
      candidates.push(listed !== undefined ? { ...item, listed } : item);
    }
    const items = capListed(candidates, (_item, i) => sale.items[i].listed);
    let filled = 0;
    let stillMissing = 0;
    items.forEach((item, i) => {
      if (sale.items[i].listed !== undefined) return;
      if (item.listed !== undefined) filled += 1;
      else stillMissing += 1;
    });
    if (filled > 0) await ctx.db.patch(sale._id, { items });
    return { outcome: "filled" as const, filled, stillMissing };
  },
});

// ── The run ────────────────────────────────────────────────────────────────

const ownerReportValidator = v.object({
  ownerId: v.string(),
  orders: v.number(),
  linesMissing: v.number(),
  ordersRead: v.number(),
  linesFilled: v.number(),
  linesStillMissing: v.number(),
  ordersFailed: v.number(),
  /**
   * Why this owner stopped early: a BSC failure kind ("signed_out",
   * "no_token", "paused"), "rate_limited" (a 429), "unavailable"
   * (`MAX_CONSECUTIVE_UNAVAILABLE` timeout/network/5xx reads in a row) or
   * "not_armed".
   */
  stopped: v.optional(v.string()),
});

const reportValidator = v.object({
  mode: v.union(v.literal("dry_run"), v.literal("refused"), v.literal("armed")),
  message: v.string(),
  /** Owners with at least one candidate order. */
  owners: v.number(),
  /** Owners the sales poll does not poll on BSC (`pollsSales`): never counted or read. */
  ownersNotPolled: v.number(),
  /** Candidate orders found (BSC, on the Pick List, a line without a description). */
  orders: v.number(),
  /** Lines without a description on those orders. */
  linesMissing: v.number(),
  /** Armed only: BSC session open attempts, success or failure (at most `MAX_OPENS_PER_CALL`). */
  sessionOpens: v.number(),
  /** Armed only: BSC order reads made, lines filled, lines BSC gave nothing for (or past the budget). */
  ordersRead: v.number(),
  linesFilled: v.number(),
  linesStillMissing: v.number(),
  /** Armed only: candidate orders this call did not reach (`maxOrders`, the open budget, the deadline, a stop). */
  ordersLeft: v.number(),
  byOwner: v.array(ownerReportValidator),
  /** True when the walk is finished; otherwise re-run with `nextCursor` (omitted when null). */
  complete: v.boolean(),
  nextCursor: v.union(v.string(), v.null()),
});
export type BackfillReport = typeof reportValidator.type;
type OwnerReport = typeof ownerReportValidator.type;

export type BackfillCtx = Pick<ActionCtx, "runQuery" | "runMutation" | "runAction"> &
  Partial<Pick<ActionCtx, "scheduler">>;

export interface BackfillArgs {
  ownerId?: string;
  confirm?: typeof CONFIRM_TOKEN;
  cursor?: string;
  maxOrders?: number;
}

/** `maxOrders` as a whole number in [1, `MAX_ORDERS_CAP`]. */
export function clampMaxOrders(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ORDERS;
  return Math.min(MAX_ORDERS_CAP, Math.max(1, Math.floor(value)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A read failure that says BSC is not answering: a timeout, a network error or a 5xx. */
function unavailable(f: BscSellerFailure): boolean {
  return f.kind === "timeout" || f.kind === "network" || (f.kind === "http" && (f.httpStatus ?? 0) >= 500);
}

export interface BackfillDeps {
  /** The spacing pause (tests pass an instant one). */
  pause?: (ms: number) => Promise<void>;
  /** The clock the deadline reads (tests advance a fake one). */
  now?: () => number;
  /** Test seam only: a smaller open budget than `MAX_OPENS_PER_CALL`. */
  maxOpens?: number;
}

/** The backfill as a plain function, so a test drives it with a stub ctx and an instant pause. */
export async function fillMissingImpl(
  ctx: BackfillCtx,
  args: BackfillArgs,
  deps: BackfillDeps = {},
): Promise<BackfillReport> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const pause = deps.pause ?? sleep;
  const maxOpens = Math.min(MAX_OPENS_PER_CALL, deps.maxOpens ?? MAX_OPENS_PER_CALL);
  const pastDeadline = () => now() - startedAt >= READ_DEADLINE_MS;
  const confirmed = args.confirm === CONFIRM_TOKEN;
  const armed = confirmed && deploymentIsArmed();
  const mode: BackfillReport["mode"] = armed ? "armed" : confirmed ? "refused" : "dry_run";
  let budget = clampMaxOrders(args.maxOrders);

  let ownerIds: string[];
  let pageDone = true;
  let continueCursor: string | null = null;
  if (args.ownerId !== undefined) {
    ownerIds = [args.ownerId];
  } else {
    const page = await ctx.runQuery(internal.saleListedBackfill.ownersPage, { cursor: args.cursor ?? null });
    ownerIds = page.ownerIds;
    pageDone = page.isDone;
    continueCursor = page.continueCursor;
  }

  const report: BackfillReport = {
    mode,
    message: armed ? ARMED_MESSAGE : confirmed ? NOT_ARMED_MESSAGE : DRY_RUN_MESSAGE,
    owners: 0,
    ownersNotPolled: 0,
    orders: 0,
    linesMissing: 0,
    sessionOpens: 0,
    ordersRead: 0,
    linesFilled: 0,
    linesStillMissing: 0,
    ordersLeft: 0,
    byOwner: [],
    complete: true,
    nextCursor: null,
  };
  // Set when this call stopped before reaching every candidate on its page.
  let cutShort = false;
  // Set on a stop that ends the whole call (a 429, BSC paused).
  let halted = false;
  let reads = 0;

  for (const ownerId of ownerIds) {
    const candidates = await ctx.runQuery(internal.saleListedBackfill.ownerCandidates, { ownerId });
    if (candidates === null) {
      report.ownersNotPolled += 1;
      continue;
    }
    if (candidates.length === 0) continue;
    const row: OwnerReport = {
      ownerId,
      orders: candidates.length,
      linesMissing: candidates.reduce((n, c) => n + c.linesMissing, 0),
      ordersRead: 0,
      linesFilled: 0,
      linesStillMissing: 0,
      ordersFailed: 0,
    };
    report.byOwner.push(row);
    report.owners += 1;
    report.orders += row.orders;
    report.linesMissing += row.linesMissing;
    if (!armed) continue;

    if (halted || budget <= 0 || report.sessionOpens >= maxOpens || pastDeadline()) {
      report.ordersLeft += candidates.length;
      cutShort = true;
      continue;
    }
    // Charged before the attempt: a failed open (a token read, perhaps a BSC
    // sign-in) spends the budget as much as a good one.
    report.sessionOpens += 1;
    const opened = await openBscSellerSession(ctx, ownerId, { op: SESSION_OP });
    if (!opened.ok) {
      row.stopped = opened.failure.kind;
      report.ordersLeft += candidates.length;
      if (opened.failure.kind === "paused") {
        halted = true;
        cutShort = true;
      }
      continue;
    }
    const session = opened.value;
    // Timeout/network/5xx reads in a row for this owner.
    let unavailableRun = 0;
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        const leaveRest = () => {
          report.ordersLeft += candidates.length - i;
          if (row.stopped === undefined) cutShort = true;
        };
        if (halted || budget <= 0 || row.stopped !== undefined) {
          leaveRest();
          break;
        }
        const candidate = candidates[i];
        if (reads > 0) await pause(ORDER_SPACING_MS);
        // The deadline is checked here, after the pause (which can carry the
        // call past it) and before a session's first read (after an open
        // that may have).
        if (pastDeadline()) {
          leaveRest();
          break;
        }
        reads += 1;
        budget -= 1;
        const detail = await readBscOrder(ctx, session, candidate.orderId);
        report.ordersRead += 1;
        row.ordersRead += 1;
        if (!detail.ok) {
          const f = detail.failure;
          row.ordersFailed += 1;
          unavailableRun = unavailable(f) ? unavailableRun + 1 : 0;
          if (f.kind === "signed_out") {
            row.stopped = "signed_out";
          } else if (f.kind === "http" && f.httpStatus === 429) {
            row.stopped = "rate_limited";
            halted = true;
            cutShort = true;
          } else if (unavailableRun >= MAX_CONSECUTIVE_UNAVAILABLE) {
            row.stopped = "unavailable";
          }
          continue;
        }
        unavailableRun = 0;
        if (detail.value.items.length > MAX_SALE_ITEMS) {
          row.ordersFailed += 1;
          continue;
        }
        const order = projectBscOrder(detail.value, null);
        const result = await ctx.runMutation(internal.saleListedBackfill.fillListed, {
          ownerId,
          saleId: candidate.saleId,
          lines: order.items.map((item) => ({
            platformCardId: item.platformCardId,
            condition: item.condition,
            ...(item.sellerSku !== undefined ? { sellerSku: item.sellerSku } : {}),
            ...(item.listed !== undefined ? { listed: item.listed } : {}),
          })),
        });
        if (result.outcome === "notArmed") {
          // Disarmed under the run: stop writing at once.
          row.stopped = "not_armed";
          halted = true;
          cutShort = true;
          continue;
        }
        row.linesFilled += result.filled;
        row.linesStillMissing += result.stillMissing;
        report.linesFilled += result.filled;
        report.linesStillMissing += result.stillMissing;
      }
    } finally {
      await closeBscSellerSession(ctx, session);
    }
  }

  const anyStopped = report.byOwner.some((row) => row.stopped !== undefined);
  if (args.ownerId !== undefined) {
    report.complete = !cutShort && !anyStopped;
    report.nextCursor = null;
  } else if (cutShort) {
    // Redo this page: the owners filled so far have no candidates left.
    report.complete = false;
    report.nextCursor = args.cursor ?? null;
  } else {
    report.complete = pageDone;
    report.nextCursor = pageDone ? null : continueCursor;
  }

  console.log(
    JSON.stringify({
      msg: "sale_listed_backfill",
      platform: "bsc",
      operation: SESSION_OP,
      mode,
      owners: report.owners,
      ownersNotPolled: report.ownersNotPolled,
      orders: report.orders,
      sessionOpens: report.sessionOpens,
      ordersRead: report.ordersRead,
      linesFilled: report.linesFilled,
      ordersLeft: report.ordersLeft,
      halted,
      pastDeadline: pastDeadline(),
      durationMs: now() - startedAt,
    }),
  );
  return report;
}

/**
 * The backfill. A dry run unless `confirm: "BACKFILL"` AND the deployment is
 * armed (`ALLOW_SALE_LISTED_BACKFILL=1`). With `ownerId`, that owner only;
 * without it, one page of owners from `cursor`.
 */
export const fillMissing = internalAction({
  args: {
    ownerId: v.optional(v.string()),
    confirm: v.optional(v.literal(CONFIRM_TOKEN)),
    cursor: v.optional(v.string()),
    maxOrders: v.optional(v.number()),
  },
  returns: reportValidator,
  handler: async (ctx, args) => await fillMissingImpl(ctx, args),
});
