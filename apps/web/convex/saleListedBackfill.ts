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
 *     and the per-sale byte budget (`listedBytes`, `MAX_LISTED_BYTES_PER_SALE`,
 *     the `capListed` rule: from the first line that would pass the budget, no
 *     new line gets one; a line already holding one keeps it).
 *
 * Two arms, the NEO-214 pair: `confirm: "BACKFILL"` per invocation and
 * `ALLOW_SALE_LISTED_BACKFILL=1` on the deployment. Without both it is a dry
 * run that makes NO BuySportsCards call (no token read either) and reports the
 * candidates; a `confirm` on an unarmed deployment is reported as refused,
 * never thrown. `fillListed` re-checks the flag itself, so it is not a write
 * primitive on an unarmed deployment.
 *
 * Armed: one BSC session per owner (`openBscSellerSession`, op
 * "saleListedBackfill", always closed), one `readBscOrder` at a time about a
 * second apart, at most `maxOrders` (default 5, cap 20) per call. An owner
 * BSC has signed out is skipped; a 429 (BSC limits by volume) stops the whole
 * call. Safe to re-run: a filled line is never a candidate again.
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
  listedBytes,
  MAX_LISTED_BYTES_PER_SALE,
  MAX_SALE_ITEMS,
  projectBscOrder,
  projectedListedValidator,
  sportResolver,
  storedListed,
} from "./listingSales";
import { closeBscSellerSession, openBscSellerSession, readBscOrder } from "./adapters/bscSeller";

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
/** Listing-state rows one call reads when it walks every owner. */
export const OWNERS_PER_PAGE = 25;
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
 */
export const ownerCandidates = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(candidateValidator),
  handler: async (ctx, args) => {
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
 * One page of the owners holding a BSC listing state, by owner id (an index
 * the poll does not rewrite while the walk is under way).
 */
export const ownersPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ ownerIds: v.array(v.string()), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform")
      .paginate({ numItems: OWNERS_PER_PAGE, cursor: args.cursor });
    const ownerIds = [...new Set(page.page.filter((row) => row.platform === "bsc").map((row) => row.ownerId))];
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

    // The budget already spent by lines that hold a description; those are
    // never changed, so new ones only spend what is left.
    let spent = 0;
    for (const item of sale.items) if (item.listed !== undefined) spent += listedBytes(item.listed);
    let over = false;

    const resolveSport = sportResolver(ctx, "bsc");
    const storedKeys = occurrenceKeys(sale.items);
    const items: SaleItem[] = [];
    let filled = 0;
    let stillMissing = 0;
    for (let i = 0; i < sale.items.length; i += 1) {
      const item = sale.items[i];
      if (item.listed !== undefined) {
        items.push(item);
        continue;
      }
      const projected = over ? undefined : fresh.get(storedKeys[i]);
      const listed = projected !== undefined ? await storedListed(projected, resolveSport) : undefined;
      if (listed !== undefined) {
        const cost = listedBytes(listed);
        if (spent + cost <= MAX_LISTED_BYTES_PER_SALE) {
          spent += cost;
          items.push({ ...item, listed });
          filled += 1;
          continue;
        }
        over = true;
      }
      items.push(item);
      stillMissing += 1;
    }
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
  /** Why this owner stopped early: a BSC failure kind ("signed_out", "no_token", "rate_limited", ...). */
  stopped: v.optional(v.string()),
});

const reportValidator = v.object({
  mode: v.union(v.literal("dry_run"), v.literal("refused"), v.literal("armed")),
  message: v.string(),
  /** Owners with at least one candidate order. */
  owners: v.number(),
  /** Candidate orders found (BSC, on the Pick List, a line without a description). */
  orders: v.number(),
  /** Lines without a description on those orders. */
  linesMissing: v.number(),
  /** Armed only: BSC order reads made, lines filled, lines BSC gave nothing for (or past the budget). */
  ordersRead: v.number(),
  linesFilled: v.number(),
  linesStillMissing: v.number(),
  /** Armed only: candidate orders this call did not reach (`maxOrders`, a stop). */
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

/** The backfill as a plain function, so a test drives it with a stub ctx and an instant pause. */
export async function fillMissingImpl(
  ctx: BackfillCtx,
  args: BackfillArgs,
  deps: { pause?: (ms: number) => Promise<void> } = {},
): Promise<BackfillReport> {
  const startedAt = Date.now();
  const pause = deps.pause ?? sleep;
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
    orders: 0,
    linesMissing: 0,
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

    if (halted || budget <= 0) {
      report.ordersLeft += candidates.length;
      cutShort = true;
      continue;
    }
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
    try {
      for (let i = 0; i < candidates.length; i += 1) {
        if (halted || budget <= 0 || row.stopped !== undefined) {
          report.ordersLeft += candidates.length - i;
          if (row.stopped === undefined) cutShort = true;
          break;
        }
        const candidate = candidates[i];
        if (reads > 0) await pause(ORDER_SPACING_MS);
        reads += 1;
        budget -= 1;
        const detail = await readBscOrder(ctx, session, candidate.orderId);
        report.ordersRead += 1;
        row.ordersRead += 1;
        if (!detail.ok) {
          const f = detail.failure;
          row.ordersFailed += 1;
          if (f.kind === "signed_out") {
            row.stopped = "signed_out";
          } else if (f.kind === "http" && f.httpStatus === 429) {
            row.stopped = "rate_limited";
            halted = true;
            cutShort = true;
          }
          continue;
        }
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
      orders: report.orders,
      ordersRead: report.ordersRead,
      linesFilled: report.linesFilled,
      ordersLeft: report.ordersLeft,
      halted,
      durationMs: Date.now() - startedAt,
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
