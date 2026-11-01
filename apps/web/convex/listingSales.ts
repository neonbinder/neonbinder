/**
 * NEO-370 — the order poll: what sold on a listing platform comes back to NB.
 * BuySportsCards only today.
 *
 * Every 15 minutes (`crons.ts`) `pollAll` lists the owners who list on BSC
 * (`marketplaceListingStates` on `by_platform_polled`, never-polled first)
 * and schedules `pollOwner` for each. One owner's poll:
 *
 *   1. reads order history newest first, every status, until it reaches the
 *      stored cursor (`orderCursorAt`, the newest order date seen; a new
 *      state row's cursor starts at its creation, less a grace for BSC's
 *      zone-less dates, so the seller's history from before NB is not
 *      imported);
 *   2. fetches the detail of each new order, of each stored order whose
 *      status moved, and of stored orders not yet final that the history
 *      pages did not reach;
 *   3. projects each to `marketplaceSales` (no buyer data, ever) and applies
 *      each sold line EXACTLY ONCE: the SKU names the NB card and box; the
 *      card's own `platformData.bsc.ref` must be the line's BSC card id (the
 *      exactly-one guard); the owner's raw box copies of that card in the NB
 *      conditions that fold into the sold BSC condition are lowered oldest
 *      first (the SKU's box wins a tie) through the app's own write path
 *      (`applyCopyChanges`), so counts, smart-binder fits and the listing
 *      outbox all follow. Lowering and flipping `applied` share a mutation.
 *
 * A cancelled order lowers nothing; a cancel that lands after a line was
 * applied is left for the operator (the line stays `applied` on a CANCELLED
 * order; NB never restores on its own). A status NB does not know is stored
 * and not applied.
 *
 * The cursor moves only when a poll read everything back to it and every
 * order it fetched was stored, so a failed poll is simply redone.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { listingPlatformValidator } from "./schema";
import {
  applyCopyChanges,
  changeOf,
  counted,
  HomeSides,
  MAX_LINES_PER_CARD,
  pocketEmptied,
  type CountChange,
} from "./collection";
import { dropPhotos } from "./copyPhotos";
import { bscEraForYear, isBscRawCondition, nbConditionsFor, type BscEra } from "./lib/bscConditions";
import { bscOrderDisposition, chooseCopiesToLower, type BscOrder } from "./lib/bscOrders";
import { parseListingSku } from "./lib/listingSku";
import {
  BSC_ORDER_PAGE_SIZE,
  openBscSellerSession,
  readBscOrder,
  readBscOrderHistory,
  type BscSellerFailure,
} from "./adapters/bscSeller";

/** Owners one cron tick schedules (never-polled and oldest-polled first). */
export const MAX_OWNERS_PER_TICK = 500;
/** Spacing between the scheduled per-owner polls, so a tick is not one burst. */
export const POLL_STAGGER_MS = 2000;
/** History pages one poll reads before giving up on reaching the cursor. */
export const MAX_HISTORY_PAGES = 10;
/** Stored, not-final orders one poll re-reads when the history did not reach them. */
export const MAX_OPEN_ORDER_REFRESH = 20;
/** Stored orders the "which are still open" read looks at. */
const OPEN_ORDER_SCAN = 200;
/** Order lines one apply mutation handles. */
export const SALE_ITEMS_PER_APPLY = 25;
/** An order with more lines than this is refused and reported (array cap headroom). */
export const MAX_SALE_ITEMS = 2000;
/**
 * BSC order dates carry no zone and are read as UTC (`parseBscDate`). If BSC
 * writes them in US local time, a date reads up to 8 hours early, so a new
 * state row's first cursor starts this much before its creation: an order
 * placed just after NB started listing is never skipped. Anything older that
 * this lets in has no NB SKU and is stored as unmatched, never applied.
 */
export const INITIAL_CURSOR_GRACE_MS = 12 * 60 * 60 * 1000;
/** A stored drain latch older than this is treated as lost. */
const STALE_DRAIN_LATCH_MS = 10 * 60 * 1000;

type Platform = Doc<"marketplaceSales">["platform"];
type SaleItem = Doc<"marketplaceSales">["items"][number];

/** Statuses after which BSC will not change the order again. */
const FINAL_STATUSES = new Set(["SHIPPED", "PARTIALLY_REFUNDED_SHIPPED", "CANCELLED"]);

export function isFinalOrderStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

// ── The cron fan-out ───────────────────────────────────────────────────────

/** The 15-minute tick: one scheduled `pollOwner` per owner listing on BSC. */
export const pollAll = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const states = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_platform_polled", (q) => q.eq("platform", "bsc"))
      .take(MAX_OWNERS_PER_TICK);
    let i = 0;
    for (const state of states) {
      await ctx.scheduler.runAfter(i * POLL_STAGGER_MS, internal.listingSales.pollOwner, {
        ownerId: state.ownerId,
        platform: state.platform,
      });
      i += 1;
    }
    return { scheduled: i };
  },
});

// ── What the poll reads of NB ──────────────────────────────────────────────

export const pollInput = internalQuery({
  args: { ownerId: v.string(), platform: listingPlatformValidator },
  returns: v.union(
    v.null(),
    v.object({
      cursorAt: v.number(),
      stored: v.array(v.object({ orderId: v.string(), status: v.string(), orderDate: v.number() })),
    }),
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state) return null;
    const recent = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(OPEN_ORDER_SCAN);
    return {
      cursorAt: state.orderCursorAt ?? state._creationTime - INITIAL_CURSOR_GRACE_MS,
      stored: recent
        .filter((s) => s.platform === args.platform)
        .map((s) => ({ orderId: s.orderId, status: s.status, orderDate: s.orderDate })),
    };
  },
});

// ── Storing an order ───────────────────────────────────────────────────────

const orderValidator = v.object({
  orderId: v.string(),
  orderNo: v.string(),
  orderDate: v.number(),
  status: v.string(),
  totals: v.object({
    subtotalCents: v.optional(v.number()),
    shippingCents: v.optional(v.number()),
    feesCents: v.optional(v.number()),
    netCents: v.optional(v.number()),
    totalCents: v.optional(v.number()),
  }),
  items: v.array(
    v.object({
      platformCardId: v.string(),
      condition: v.string(),
      quantity: v.number(),
      priceCents: v.number(),
      sellerSku: v.optional(v.string()),
      /** A graded line is never NB's (NB lists raw only). */
      graded: v.boolean(),
    }),
  ),
});
export type ProjectedOrder = typeof orderValidator.type;

/**
 * BSC's order → what NB keeps. Drops every buyer and seller field (only ids,
 * date, status, money and per-line card id / condition / quantity / price /
 * SKU survive), turning dollars into cents. `fallbackDate` is the history
 * page's date for an order whose detail carries none.
 */
export function projectBscOrder(order: BscOrder, fallbackDate: number | null): ProjectedOrder {
  const t = order.totals;
  const totals: ProjectedOrder["totals"] = {};
  if (t.subtotalCents !== null) totals.subtotalCents = t.subtotalCents;
  if (t.shippingCents !== null) totals.shippingCents = t.shippingCents;
  if (t.sellerFeeCents !== null) totals.feesCents = t.sellerFeeCents;
  if (t.sellerNetCents !== null) totals.netCents = t.sellerNetCents;
  if (t.totalCents !== null) totals.totalCents = t.totalCents;
  return {
    orderId: order.orderId,
    orderNo: order.orderNo ?? order.orderId,
    orderDate: order.orderDateMs ?? fallbackDate ?? Date.now(),
    status: order.status,
    totals,
    items: order.items.map((item) => ({
      platformCardId: item.bscCardId,
      condition: item.condition,
      quantity: item.quantity,
      priceCents: item.priceCents ?? 0,
      ...(item.sellerSku !== null ? { sellerSku: item.sellerSku } : {}),
      graded: item.productType !== null && item.productType !== "raw",
    })),
  };
}

/**
 * Listing on `platform` is on for the owner exactly while their state row
 * exists. Turning it off deletes the row, so a poll already under way stands
 * down at its next write: no sale stored, no copy lowered.
 */
async function listingOn(ctx: QueryCtx, ownerId: string, platform: Doc<"marketplaceSales">["platform"]): Promise<boolean> {
  const state = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .unique();
  return state !== null;
}

function itemKey(item: { platformCardId: string; condition: string; sellerSku?: string }): string {
  return `${item.platformCardId}|${item.condition}|${item.sellerSku ?? ""}`;
}

/**
 * Upserts one order. A re-read updates status, totals and lines and NEVER
 * resets a line's `applied` (lines are matched on card id, condition and SKU;
 * a stored line the new read lacks is kept). Returns the lines still to apply:
 * only on a "sale" status, only lines not applied and not already refused.
 */
export const recordOrder = internalMutation({
  args: { ownerId: v.string(), platform: listingPlatformValidator, order: orderValidator },
  returns: v.object({ saleId: v.union(v.id("marketplaceSales"), v.null()), toApply: v.array(v.number()) }),
  handler: async (ctx, args) => {
    if (!(await listingOn(ctx, args.ownerId, args.platform))) return { saleId: null, toApply: [] };
    const now = Date.now();
    const { order } = args;
    const existing = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) =>
        q.eq("ownerId", args.ownerId).eq("platform", args.platform).eq("orderId", order.orderId),
      )
      .unique();

    const fresh: SaleItem[] = order.items.map((item) => ({
      platformCardId: item.platformCardId,
      condition: item.condition,
      quantity: item.quantity,
      priceCents: item.priceCents,
      ...(item.sellerSku !== undefined ? { sellerSku: item.sellerSku } : {}),
      applied: false,
      // A graded line was never NB's listing: refused at once, never applied.
      ...(item.graded ? { problem: "unmatched" as const } : {}),
    }));

    let items: SaleItem[];
    if (!existing) {
      items = fresh;
    } else {
      // Match each fresh line to a stored one by key (in order, for repeats).
      const pool = new Map<string, SaleItem[]>();
      for (const old of existing.items) {
        const list = pool.get(itemKey(old));
        if (list) list.push(old);
        else pool.set(itemKey(old), [old]);
      }
      items = fresh.map((line) => {
        const old = pool.get(itemKey(line))?.shift();
        if (!old) return line;
        return {
          ...old,
          quantity: old.applied ? old.quantity : line.quantity,
          priceCents: line.priceCents,
        };
      });
      for (const leftover of pool.values()) items.push(...leftover);
    }

    const doc = {
      ownerId: args.ownerId,
      platform: args.platform,
      orderId: order.orderId,
      orderNo: order.orderNo,
      orderDate: order.orderDate,
      status: order.status,
      totals: order.totals,
      items,
      lastUpdated: now,
    };
    let saleId: Id<"marketplaceSales">;
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      saleId = existing._id;
    } else {
      saleId = await ctx.db.insert("marketplaceSales", { ...doc, firstSeenAt: now });
    }
    const toApply =
      bscOrderDisposition(order.status) === "sale"
        ? items.flatMap((item, i) => (!item.applied && item.problem === undefined ? [i] : []))
        : [];
    return { saleId, toApply };
  },
});

/** The BSC era of a card, from NB's own year row above its variant. */
async function eraOfVariant(
  ctx: Pick<MutationCtx, "db">,
  variantId: Id<"selectorOptions">,
  cache: Map<string, BscEra | null>,
): Promise<BscEra | null> {
  const hit = cache.get(variantId);
  if (hit !== undefined) return hit;
  let cursor = await ctx.db.get(variantId);
  let era: BscEra | null = null;
  for (let depth = 0; cursor && depth < 16; depth += 1) {
    if (cursor.level === "year") {
      era = bscEraForYear(cursor.value);
      break;
    }
    cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
  }
  cache.set(variantId, era);
  return era;
}

/**
 * Applies some of an order's lines (at most `SALE_ITEMS_PER_APPLY`), each
 * exactly once: the copies are lowered and the line flips `applied` in this
 * one transaction. Re-checks the stored status and each line's `applied`, so
 * a racing poll or a re-run is a no-op.
 */
export const applySaleItems = internalMutation({
  args: { ownerId: v.string(), saleId: v.id("marketplaceSales"), indexes: v.array(v.number()) },
  returns: v.object({ applied: v.number(), lowered: v.number() }),
  handler: async (ctx, args) => {
    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.ownerId !== args.ownerId) return { applied: 0, lowered: 0 };
    if (bscOrderDisposition(sale.status) !== "sale") return { applied: 0, lowered: 0 };
    if (!(await listingOn(ctx, args.ownerId, sale.platform))) return { applied: 0, lowered: 0 };
    const now = Date.now();
    const items = [...sale.items];
    const sides = new HomeSides(ctx, args.ownerId);
    const eras = new Map<string, BscEra | null>();
    const changes: CountChange[] = [];
    let applied = 0;
    let lowered = 0;

    for (const index of args.indexes.slice(0, SALE_ITEMS_PER_APPLY)) {
      const item = items[index];
      if (!item || item.applied || item.problem !== undefined) continue;
      const refuse = (problem: "unmatched" | "linkMismatch", cardId?: Id<"cardChecklist">) => {
        items[index] = { ...item, ...(cardId ? { cardId } : {}), problem };
      };

      // The SKU names the NB card and box; anything else is not NB's line.
      const sku = parseListingSku(item.sellerSku);
      const cardId = sku ? ctx.db.normalizeId("cardChecklist", sku.cardId) : null;
      const card = cardId ? await ctx.db.get(cardId) : null;
      if (!sku || !cardId || !card) {
        refuse("unmatched");
        continue;
      }
      // The exactly-one guard: the card must carry this very BSC card id.
      if ((card.platformData?.bsc?.ref ?? null) !== item.platformCardId) {
        refuse("linkMismatch", cardId);
        continue;
      }
      const era = await eraOfVariant(ctx, card.selectorOptionId, eras);
      const nbConditions =
        era !== null && isBscRawCondition(item.condition) ? nbConditionsFor(item.condition, era) : [];
      if (nbConditions.length === 0) {
        refuse("unmatched", cardId);
        continue;
      }

      const lines = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", args.ownerId).eq("cardId", cardId))
        .take(MAX_LINES_PER_CARD + 1);
      const candidates: Doc<"collectionCopies">[] = [];
      for (const row of lines) {
        if (row.grading !== undefined || row.condition === undefined) continue;
        if (!nbConditions.includes(row.condition)) continue;
        if ((await sides.of(row.homeId)) !== "inventory") continue;
        candidates.push(row);
      }
      const skuBoxId = ctx.db.normalizeId("collectionContainers", sku.boxId);
      const { decrements, shortfall } = chooseCopiesToLower(
        candidates.map((row) => ({
          copyId: row._id,
          homeId: row.homeId,
          ...(row.acquiredOn !== undefined ? { acquiredOn: row.acquiredOn } : {}),
          creationTime: row._creationTime,
          quantity: row.quantity,
        })),
        skuBoxId,
        item.quantity,
      );
      for (const d of decrements) {
        const row = candidates.find((c) => c._id === d.copyId);
        if (!row) continue;
        if (d.by >= row.quantity) {
          await dropPhotos(ctx, row);
          await ctx.db.delete(row._id);
          await pocketEmptied(ctx, row.homeId, row.slot);
          changes.push(changeOf(row, counted(row), null));
        } else {
          const quantity = row.quantity - d.by;
          await ctx.db.patch(row._id, { quantity, lastUpdated: now });
          changes.push(changeOf(row, counted(row), counted({ ...row, quantity })));
        }
        lowered += d.by;
      }
      items[index] = {
        ...item,
        cardId,
        applied: true,
        appliedAt: now,
        ...(shortfall > 0 ? { problem: "oversold" as const, shortBy: shortfall } : {}),
      };
      applied += 1;
    }

    await ctx.db.patch(sale._id, { items, lastUpdated: now });
    if (changes.length > 0) await applyCopyChanges(ctx, args.ownerId, changes);
    return { applied, lowered };
  },
});

/**
 * Ends one owner's poll: stamps `lastPolledAt` (always, so the cron's order
 * moves on), the error or its absence, and the cursor (only forward, and
 * only when `cursorAt` is given). Also the drain safety net: pending outbox
 * rows with no live drain scheduled or running get one now.
 */
export const finishPoll = internalMutation({
  args: {
    ownerId: v.string(),
    platform: listingPlatformValidator,
    cursorAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  returns: v.object({ drainKicked: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    if (!state) return { drainKicked: false };
    const patch: Partial<Doc<"marketplaceListingStates">> = {
      lastPolledAt: now,
      lastPollError: args.error?.slice(0, 300),
      lastUpdated: now,
    };
    if (args.cursorAt !== undefined && args.cursorAt > (state.orderCursorAt ?? -Infinity)) {
      patch.orderCursorAt = args.cursorAt;
    }
    let drainKicked = false;
    const leaseLive = state.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > now;
    const latchLive = state.drainScheduledAt !== undefined && state.drainScheduledAt > now - STALE_DRAIN_LATCH_MS;
    if (!leaseLive && !latchLive) {
      const pending = await ctx.db
        .query("listingOutbox")
        .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
        .first();
      if (pending) {
        await ctx.scheduler.runAfter(0, internal.listingDrain.drainOwner, {
          ownerId: args.ownerId,
          platform: args.platform,
        });
        patch.drainScheduledAt = now;
        drainKicked = true;
      }
    }
    await ctx.db.patch(state._id, patch);
    return { drainKicked };
  },
});

// ── One owner's poll ───────────────────────────────────────────────────────

export type PollCtx = Pick<ActionCtx, "runQuery" | "runMutation" | "runAction">;

export interface PollReport {
  ordersRead: number;
  ordersStored: number;
  linesApplied: number;
  cursorAt: number | null;
  error: string | null;
}

/** The poll itself, as a plain function so a test can drive it with a stub ctx. */
export async function pollOwnerImpl(
  ctx: PollCtx,
  args: { ownerId: string; platform: Platform },
): Promise<PollReport> {
  const startedAt = Date.now();
  const report: PollReport = { ordersRead: 0, ordersStored: 0, linesApplied: 0, cursorAt: null, error: null };
  const input = await ctx.runQuery(internal.listingSales.pollInput, args);
  if (!input) return report;

  const finish = async (cursorAt: number | undefined, failure: BscSellerFailure | string | null) => {
    const error = failure === null ? undefined : typeof failure === "string" ? failure : failure.message;
    report.error = error ?? null;
    report.cursorAt = cursorAt ?? null;
    await ctx.runMutation(internal.listingSales.finishPoll, {
      ...args,
      ...(cursorAt !== undefined ? { cursorAt } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    console.log(
      JSON.stringify({
        msg: "listing_sales_poll",
        platform: args.platform,
        operation: "pollOwner",
        ordersRead: report.ordersRead,
        ordersStored: report.ordersStored,
        linesApplied: report.linesApplied,
        ok: error === undefined,
        durationMs: Date.now() - startedAt,
      }),
    );
    return report;
  };

  const opened = await openBscSellerSession(ctx, args.ownerId);
  if (!opened.ok) return await finish(undefined, opened.failure);
  const session = opened.value;

  const storedStatus = new Map(input.stored.map((s) => [s.orderId, s.status]));
  const toFetch = new Map<string, number | null>(); // orderId → history date
  let newest = input.cursorAt;
  let reachedCursor = false;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const history = await readBscOrderHistory(ctx, session, page);
    if (!history.ok) return await finish(undefined, history.failure);
    for (const summary of history.value.orders) {
      if (summary.orderDateMs === null) continue;
      if (summary.orderDateMs < input.cursorAt) {
        reachedCursor = true;
        // An older stored order whose status moved still gets re-read.
        const was = storedStatus.get(summary.orderId);
        if (was !== undefined && summary.status !== null && summary.status !== was) {
          toFetch.set(summary.orderId, summary.orderDateMs);
        }
        continue;
      }
      newest = Math.max(newest, summary.orderDateMs);
      const was = storedStatus.get(summary.orderId);
      if (was === undefined || summary.status === null || summary.status !== was) {
        toFetch.set(summary.orderId, summary.orderDateMs);
      }
    }
    if (reachedCursor || history.value.orders.length + history.value.unreadable < BSC_ORDER_PAGE_SIZE) {
      reachedCursor = true;
      break;
    }
  }

  // Stored orders not final yet that the pages did not show: re-read a few.
  let refreshed = 0;
  for (const s of input.stored) {
    if (refreshed >= MAX_OPEN_ORDER_REFRESH) break;
    if (isFinalOrderStatus(s.status) || toFetch.has(s.orderId)) continue;
    toFetch.set(s.orderId, s.orderDate);
    refreshed += 1;
  }

  // `failed` holds the cursor back (the poll is redone); `note` is reported
  // and does not (a retry would see the same thing).
  let failed: BscSellerFailure | null = null;
  let note: string | null = null;
  for (const [orderId, historyDate] of toFetch) {
    const detail = await readBscOrder(ctx, session, orderId);
    report.ordersRead += 1;
    if (!detail.ok) {
      const f = detail.failure;
      const permanent =
        (f.kind === "http" && f.httpStatus !== undefined && f.httpStatus >= 400 && f.httpStatus < 500 && f.httpStatus !== 429) ||
        f.kind === "bad_response";
      if (permanent) note = `One BuySportsCards order couldn't be read (${f.message})`;
      else failed = f;
      if (f.kind === "signed_out") break;
      continue;
    }
    const order = projectBscOrder(detail.value, historyDate);
    if (order.items.length > MAX_SALE_ITEMS) {
      note = `Order ${order.orderNo} has more lines than NeonBinder takes in one order, so none of it was applied.`;
      continue;
    }
    if (detail.value.unreadableItems > 0) {
      note = `Order ${order.orderNo} has ${detail.value.unreadableItems} line(s) NeonBinder can't read; the rest were applied.`;
    }
    const recorded = await ctx.runMutation(internal.listingSales.recordOrder, { ...args, order });
    // Listing switched off under the poll: stand down (finishPoll would find
    // no row to write either).
    if (recorded.saleId === null) return report;
    report.ordersStored += 1;
    for (let i = 0; i < recorded.toApply.length; i += SALE_ITEMS_PER_APPLY) {
      const r = await ctx.runMutation(internal.listingSales.applySaleItems, {
        ownerId: args.ownerId,
        saleId: recorded.saleId,
        indexes: recorded.toApply.slice(i, i + SALE_ITEMS_PER_APPLY),
      });
      report.linesApplied += r.applied;
    }
  }

  // The cursor moves only past a complete read: history back to the cursor,
  // every order stored.
  const complete = reachedCursor && failed === null;
  return await finish(complete ? newest : undefined, failed ?? note);
}

/** One owner's poll (scheduled by `pollAll`). */
export const pollOwner = internalAction({
  args: { ownerId: v.string(), platform: listingPlatformValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await pollOwnerImpl(ctx, args);
    return null;
  },
});
