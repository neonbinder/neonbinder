/**
 * NEO-370 — the order poll: what sold on a listing platform comes back to NB.
 * BuySportsCards only today.
 *
 * Every 15 minutes (`crons.ts`) `pollAll` lists the owners with a BSC
 * listing state that is not dormant (`marketplaceListingStates` on
 * `by_platform_dormant_polled`, never-polled first) and schedules
 * `pollOwner` for each LISTING owner (`listingOutbox.pollsSales`, the same
 * rule as pushing: Revision 5, a saved sign-in is listing and selling). A row
 * held off by the E2E test marker is skipped (the tick stamps it
 * `lastPolledAt` so it moves to the back of the read, never holding a slot).
 * Nothing is read or written while NB has paused the platform. Until it
 * records itself done, each tick also starts the one-time pass that sets up
 * sign-ins saved before Revision 5 (`listingSync.setUpSavedSignInsPage`). The credential
 * gate: an owner with no saved BSC credentials is not polled (their state
 * goes dormant), and one whose session needs a fresh sign-in is polled at
 * most hourly (`reauthPollAt`), so a dead session is not logged into every
 * tick. One owner's poll:
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
 *      exactly-one guard); the owner's raw copies of that card in a LISTED
 *      box (or in the box the SKU names: a listing pushed before that box
 *      was set to in-person) in the NB conditions that fold into the sold
 *      BSC condition are lowered oldest first (the SKU's box wins a tie)
 *      through the app's own write path
 *      (`applyCopyChanges`), so counts, smart-binder fits and the listing
 *      outbox all follow. Lowering and flipping `applied` share a mutation.
 *      A sold copy's photos are KEPT (Jason, 2026-11-01), unlike a manual
 *      delete: a sale that removes a line leaves its `collectionCopyPhotos`
 *      rows (and R2 objects) behind, pointing at a copy that is gone. Every
 *      reader goes through a live copy, so none shows them; the per-user test
 *      reset and the global drain clear them by owner / by table. A cleanup
 *      (or a use for them on the sold record, NEO-371) is expected later.
 *
 * After each owner's poll `finishPoll` kicks the owner's listing drain when
 * changes are queued: that is the cron's half of the drain triggers.
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
  MAX_LINES_PER_CARD,
  pocketEmptied,
  type CountChange,
} from "./collection";
import {
  kickListingDrain,
  LISTING_CREDENTIAL_SITE,
  listingCredentialOf,
  listsOnMarketplaces,
  pollsSales,
} from "./listingOutbox";
import { isPlatformPaused } from "./marketplacePause";
import { savedSignInsPassDone } from "./listingSync";
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
/**
 * The window a tick's polls are spread over: under the 15-minute interval,
 * so one tick's last poll starts before the next tick's first. The stagger
 * shrinks to fit it (`pollStaggerMs`).
 */
export const POLL_SPREAD_MS = 14 * 60 * 1000;
/** While an owner's credentials need a fresh sign-in, their poll runs at most this often. */
export const REAUTH_POLL_INTERVAL_MS = 60 * 60 * 1000;
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

type Platform = Doc<"marketplaceSales">["platform"];
type SaleItem = Doc<"marketplaceSales">["items"][number];

/** Statuses after which BSC will not change the order again. */
const FINAL_STATUSES = new Set(["SHIPPED", "PARTIALLY_REFUNDED_SHIPPED", "CANCELLED"]);

export function isFinalOrderStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

// ── The cron fan-out ───────────────────────────────────────────────────────

/** The spacing between one tick's `count` polls: 2s, less when they would not fit the window. */
export function pollStaggerMs(count: number): number {
  if (count <= 1) return POLL_STAGGER_MS;
  return Math.min(POLL_STAGGER_MS, Math.floor(POLL_SPREAD_MS / count));
}

type PollGate = "poll" | "noCredentials" | "reauthWait";

/** Whether an owner's poll may run now (see the module comment). */
function pollGate(
  credential: { hasCredentials: boolean; needsReauth: boolean },
  state: Pick<Doc<"marketplaceListingStates">, "reauthPollAt">,
  now: number,
): PollGate {
  if (!credential.hasCredentials) return "noCredentials";
  if (credential.needsReauth && state.reauthPollAt !== undefined && now - state.reauthPollAt < REAUTH_POLL_INTERVAL_MS) {
    return "reauthWait";
  }
  return "poll";
}

/**
 * The 15-minute tick: one scheduled `pollOwner` per listing, non-dormant
 * owner with a BSC listing state, through the credential gate, and (until
 * it is done, never on a testing deployment) one pass over saved sign-ins
 * not yet set up (`listingSync.setUpSavedSignInsPage`).
 * While NB has paused BSC it does nothing at all. A row not listing (the E2E
 * test marker) is skipped and stamped `lastPolledAt`, so it moves to the
 * back of the read. An owner with no saved credentials goes dormant (and
 * leaves the index the tick reads); one waiting out the hourly re-sign-in
 * limit is skipped but still stamped `lastPolledAt`, so they move to the back
 * of the queue rather than hold a slot every tick.
 */
export const pollAll = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number(), skipped: v.number() }),
  handler: async (ctx) => {
    if (isPlatformPaused(LISTING_CREDENTIAL_SITE.bsc)) return { scheduled: 0, skipped: 0 };
    // The one-time pass over sign-ins saved before Revision 5: only while it
    // has not recorded itself done, and never on a testing deployment.
    if (!process.env.TESTING_RESET_SECRET && !(await savedSignInsPassDone(ctx))) {
      await ctx.scheduler.runAfter(0, internal.listingSync.setUpSavedSignInsPage, { cursor: null });
    }
    const now = Date.now();
    const states = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_platform_dormant_polled", (q) => q.eq("platform", "bsc").eq("dormant", undefined))
      .take(MAX_OWNERS_PER_TICK);
    const due: Array<Doc<"marketplaceListingStates">> = [];
    let skipped = 0;
    for (const state of states) {
      if (!pollsSales(state)) {
        await ctx.db.patch(state._id, { lastPolledAt: now, lastUpdated: now });
        skipped += 1;
        continue;
      }
      const credential = await listingCredentialOf(ctx, state.ownerId, state.platform);
      const gate = pollGate(credential, state, now);
      if (gate === "noCredentials") {
        await ctx.db.patch(state._id, { dormant: "noCredentials", lastUpdated: now });
        skipped += 1;
      } else if (gate === "reauthWait") {
        await ctx.db.patch(state._id, { lastPolledAt: now, lastUpdated: now });
        skipped += 1;
      } else {
        if (credential.needsReauth) await ctx.db.patch(state._id, { reauthPollAt: now, lastUpdated: now });
        due.push(state);
      }
    }
    const stagger = pollStaggerMs(due.length);
    for (let i = 0; i < due.length; i += 1) {
      await ctx.scheduler.runAfter(i * stagger, internal.listingSales.pollOwner, {
        ownerId: due[i].ownerId,
        platform: due[i].platform,
      });
    }
    return { scheduled: due.length, skipped };
  },
});

// ── What the poll reads of NB ──────────────────────────────────────────────

const pollInputValidator = v.union(
  v.null(),
  v.object({
    cursorAt: v.number(),
    stored: v.array(v.object({ orderId: v.string(), status: v.string(), orderDate: v.number() })),
  }),
);

export const pollInput = internalQuery({
  args: { ownerId: v.string(), platform: listingPlatformValidator },
  returns: pollInputValidator,
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", args.platform))
      .unique();
    // The gate again, at the moment the poll starts (credentials may have
    // been cleared, or the row put to sleep, since the tick).
    if (!state || !pollsSales(state)) return null;
    const credential = await listingCredentialOf(ctx, args.ownerId, args.platform);
    if (!credential.hasCredentials) return null;
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
 * Sales on `platform` are polled for the owner while their state row lists
 * (`pollsSales`: a saved sign-in, not dormant, no test marker). A row that stops (the
 * sign-in cleared, a seller conflict) makes a poll already under way stand
 * down at its next write: no sale stored, no copy lowered.
 */
async function pollingOn(ctx: QueryCtx, ownerId: string, platform: Doc<"marketplaceSales">["platform"]): Promise<boolean> {
  const state = await ctx.db
    .query("marketplaceListingStates")
    .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId).eq("platform", platform))
    .unique();
  return state !== null && pollsSales(state);
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
    if (!(await pollingOn(ctx, args.ownerId, args.platform))) return { saleId: null, toApply: [] };
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
    if (!(await pollingOn(ctx, args.ownerId, sale.platform))) return { applied: 0, lowered: 0 };
    const now = Date.now();
    const items = [...sale.items];
    // Which homes a sold copy may come from: a LISTED box (or the SKU's own
    // box, checked per line below). One read per home.
    const homes = new Map<string, boolean>();
    const listedHome = async (homeId: Id<"collectionContainers">): Promise<boolean> => {
      const known = homes.get(homeId);
      if (known !== undefined) return known;
      const home = await ctx.db.get(homeId);
      const lists = home !== null && home.ownerId === args.ownerId && listsOnMarketplaces(home);
      homes.set(homeId, lists);
      return lists;
    };
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
      const skuBoxId = ctx.db.normalizeId("collectionContainers", sku.boxId);
      const candidates: Doc<"collectionCopies">[] = [];
      for (const row of lines) {
        if (row.grading !== undefined || row.condition === undefined) continue;
        if (!nbConditions.includes(row.condition)) continue;
        if (!(await listedHome(row.homeId))) {
          // The SKU's own box still counts while it is a box of the owner's:
          // it was listed when this listing was pushed.
          if (row.homeId !== skuBoxId) continue;
          const home = await ctx.db.get(row.homeId);
          if (!home || home.ownerId !== args.ownerId || home.kind !== "box") continue;
        }
        candidates.push(row);
      }
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
          // The sold copy's photos are kept on purpose (no `dropPhotos`, unlike
          // a manual delete): see the module comment. A cleanup comes later.
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
 * only when `cursorAt` is given). Then the cron's half of the drain
 * triggers: when the owner pushes counts and has changes queued, the drain
 * runs now (`kickListingDrain`: a drain already scheduled or running is not
 * doubled, and one that died holding a lease is replaced once it runs out).
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
    await ctx.db.patch(state._id, patch);
    const kick = await kickListingDrain(ctx, args.ownerId, args.platform);
    return { drainKicked: kick === "scheduled" };
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

  // `finishPoll` runs exactly once, whatever happens below: `finish` on a
  // normal end, the `finally` when a step threw, so a throw never leaves the
  // owner unstamped (first in line every tick) or their drain unkicked.
  let finished = false;
  let standDown = false;
  const finish = async (cursorAt: number | undefined, failure: BscSellerFailure | string | null) => {
    const error = failure === null ? undefined : typeof failure === "string" ? failure : failure.message;
    report.error = error ?? null;
    report.cursorAt = cursorAt ?? null;
    finished = true;
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

  try {
    return await pollOwnerSteps(ctx, args, input, report, finish, () => {
      standDown = true;
    });
  } finally {
    if (!finished && !standDown) {
      finished = true;
      report.error = "The sales check stopped part-way through; it runs again next time.";
      await ctx.runMutation(internal.listingSales.finishPoll, { ...args, error: report.error });
    }
  }
}

type PollInput = NonNullable<typeof pollInputValidator.type>;

/** The body of one owner's poll (`pollOwnerImpl` wraps it so it always finishes). */
async function pollOwnerSteps(
  ctx: PollCtx,
  args: { ownerId: string; platform: Platform },
  input: PollInput,
  report: PollReport,
  finish: (cursorAt: number | undefined, failure: BscSellerFailure | string | null) => Promise<PollReport>,
  standDown: () => void,
): Promise<PollReport> {
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
    // The row was put to sleep under the poll: stand down, write nothing more.
    if (recorded.saleId === null) {
      standDown();
      return report;
    }
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
