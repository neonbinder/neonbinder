/**
 * NEO-500 — the Pick List: the signed-in seller's sold copies still to pull
 * from their boxes, one line per order item, and the "I pulled it" mark.
 *
 * What is on the list is decided in one place, `lib/pickLines.ts`: an order
 * that is a sale and has not shipped; a line on it that was applied (an
 * oversold line too: "Short N") or refused as unmatched/linkMismatch ("Can't
 * find it"), and is not marked pulled. Where a line's copies came from is the
 * apply's snapshot (`items[].from`); NB data only, so a line never names a
 * marketplace card id or SKU.
 *
 * Four functions, split so a pull re-runs as little as possible:
 *   - `open` (subscribed): the lines and the boxes they name. Bounded: at
 *     most `OPEN_SALES_READ + RECENT_SALES_READ` sale docs plus one read per
 *     distinct box. Every poll and every `setPulled` re-runs it, so it reads
 *     no catalog rows and no photos.
 *   - `cards`: the catalog cards the lines name, hydrated once by the client
 *     (they do not change when a line is pulled).
 *   - `soldPhotos`: the photos of the copies the lines came from.
 *   - `setPulled`: marks lines pulled or not, and recomputes the order's
 *     stored `pullOpen`.
 *
 * Every function is the caller's own: the owner is never an argument, and a
 * line id or copy id that is not the caller's shows or changes nothing.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { COLLECTION_ERRORS, refuse } from "./collection";
import { copyPhotosValidator, ownerPhotoUrlsByCopyId } from "./copyPhotos";
import { MAX_CARDS_BY_ID } from "./collectionCatalog";
import { CatalogReader, catalogCardWithPathValidator } from "./lib/catalogView";
import { parseListingSku } from "./lib/listingSku";
import { lineOnPickList, orderOnPickList, pullOpenOf, saleIdOfLine, saleLineKeys } from "./lib/pickLines";
import { collectionCopyConditionValidator, listingPlatformValidator } from "./schema";

type Sale = Doc<"marketplaceSales">;
type SaleItem = Sale["items"][number];

/**
 * Orders `open` reads off the `pullOpen` index, OLDEST first: past this the
 * list is cut short and keeps the oldest orders, which ship first.
 */
export const OPEN_SALES_READ = 200;
/**
 * The owner's most recent orders `open` also reads, whatever their `pullOpen`.
 * TEMPORARY (NEO-500 decision 7): a sale applied before NEO-500 carries no
 * `pullOpen`, so the index alone would hide it. Drop this read once every
 * such order has shipped.
 */
export const RECENT_SALES_READ = 100;
/** Lines one `open` answer carries; past this it says `truncated`. */
export const MAX_PICK_LINES = 1000;
/** Copies one `soldPhotos` call may ask about. */
export const MAX_SOLD_PHOTOS = 100;
/** Line ids one `setPulled` call may carry. */
export const MAX_SET_PULLED = 200;

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

/** One box copy a line was taken from, as the apply recorded it. */
const pickFromValidator = v.object({
  /** The copy row (it may be gone now: a sale that took the last copy deletes it). For `soldPhotos`. */
  copyId: v.id("collectionCopies"),
  /** Absent when the box is gone or is not the caller's any more. */
  boxId: v.optional(v.id("collectionContainers")),
  slot: v.optional(v.number()),
  quantity: v.number(),
  condition: collectionCopyConditionValidator,
  serialNumber: v.optional(v.string()),
});

const cantFindValidator = v.union(v.literal("unmatched"), v.literal("linkMismatch"));

export const pickLineValidator = v.object({
  /**
   * Opaque (`lib/pickLines.saleLineId`: the sale id and a hash, never the
   * marketplace's card id or SKU); pass it back to `setPulled`. One per order
   * item, whatever its `from` holds.
   */
  id: v.string(),
  saleId: v.id("marketplaceSales"),
  platform: listingPlatformValidator,
  /** The order number the marketplace shows the seller. */
  orderNo: v.string(),
  orderDate: v.number(),
  /** When NB first saw the order (a line that arrives mid-pull is "New"). */
  firstSeenAt: v.number(),
  /** NB's card, on a line the apply matched. Absent on a "Can't find it" line. */
  cardId: v.optional(v.id("cardChecklist")),
  /** Why NB could not match the line; it goes in "Can't find it". */
  cantFind: v.optional(cantFindValidator),
  quantity: v.number(),
  /** The marketplace's condition string for the line, verbatim. */
  condition: v.string(),
  /** Where the copies came from, in the order taken. Empty when none was recorded. */
  from: v.array(pickFromValidator),
  /**
   * The apply recorded no box for a matched line that took copies (applied
   * before NEO-500, or past the sale's `from` cap): the UI says "Box not
   * recorded".
   */
  boxUnrecorded: v.optional(v.literal(true)),
  /**
   * On a `boxUnrecorded` BuySportsCards line: the box its listing's SKU
   * names, when that is still one of the caller's boxes. A hint, not a record.
   */
  skuBoxId: v.optional(v.id("collectionContainers")),
  lastOnes: v.optional(v.literal(true)),
  /** Sold more than NB held: this many short. */
  shortBy: v.optional(v.number()),
});

const pickBoxValidator = v.object({
  id: v.id("collectionContainers"),
  name: v.string(),
  /** The catch-all box for copies not filed anywhere yet. */
  unsorted: v.optional(v.literal(true)),
});

const openValidator = v.object({
  /** Oldest order first; inside an order, in the order's own item order. */
  lines: v.array(pickLineValidator),
  /** Every box a line names (`from[].boxId`, `skuBoxId`). */
  boxes: v.array(pickBoxValidator),
  /** More orders or lines were open than one answer carries. */
  truncated: v.boolean(),
});

type PickLine = typeof pickLineValidator.type;
type PickBox = typeof pickBoxValidator.type;

// ───────────────────────────────────────────────────────────────────────────
// open
// ───────────────────────────────────────────────────────────────────────────

/** The caller's lines to pull and the boxes they name. */
export const open = query({
  args: {},
  returns: openValidator,
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);

    const openSales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_pull_open", (q) => q.eq("ownerId", ownerId).eq("pullOpen", true))
      .order("asc")
      .take(OPEN_SALES_READ + 1);
    let truncated = openSales.length > OPEN_SALES_READ;

    // TEMPORARY (decision 7): orders applied before NEO-500 have no
    // `pullOpen`; the newest few are read by date so they still show.
    const recentSales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(RECENT_SALES_READ);

    const byId = new Map<string, Sale>();
    for (const sale of [...openSales.slice(0, OPEN_SALES_READ), ...recentSales]) {
      if (sale.ownerId === ownerId && orderOnPickList(sale)) byId.set(sale._id, sale);
    }
    const sales = [...byId.values()].sort(
      (a, b) => a.orderDate - b.orderDate || a._creationTime - b._creationTime,
    );

    // One read per distinct box, the caller's only.
    const homes = new Map<string, Doc<"collectionContainers"> | null>();
    const ownHome = async (id: Id<"collectionContainers">): Promise<Doc<"collectionContainers"> | null> => {
      if (!homes.has(id)) {
        const row = await ctx.db.get(id);
        homes.set(id, row && row.ownerId === ownerId ? row : null);
      }
      return homes.get(id) ?? null;
    };

    const lines: PickLine[] = [];
    for (const sale of sales) {
      const ids = saleLineKeys(sale._id, sale.items);
      for (let i = 0; i < sale.items.length; i += 1) {
        const item = sale.items[i];
        if (!lineOnPickList(item)) continue;
        if (lines.length >= MAX_PICK_LINES) {
          truncated = true;
          break;
        }
        lines.push(await lineOf(sale, item, ids[i], ownHome, (raw) => ctx.db.normalizeId("collectionContainers", raw)));
      }
    }

    const boxes: PickBox[] = [];
    for (const home of homes.values()) {
      if (!home) continue;
      boxes.push({ id: home._id, name: home.name, ...(home.system === "unsorted" ? { unsorted: true as const } : {}) });
    }
    return { lines, boxes, truncated };
  },
});

async function lineOf(
  sale: Sale,
  item: SaleItem,
  id: string,
  ownHome: (id: Id<"collectionContainers">) => Promise<Doc<"collectionContainers"> | null>,
  boxIdOf: (raw: string) => Id<"collectionContainers"> | null,
): Promise<PickLine> {
  const base = {
    id,
    saleId: sale._id,
    platform: sale.platform,
    orderNo: sale.orderNo,
    orderDate: sale.orderDate,
    firstSeenAt: sale.firstSeenAt,
    quantity: item.quantity,
    condition: item.condition,
  };
  if (!item.applied) {
    // `lineOnPickList` lets an unapplied line through only when refused.
    const cantFind = item.problem === "linkMismatch" ? ("linkMismatch" as const) : ("unmatched" as const);
    return { ...base, cantFind, from: [] };
  }

  const from: PickLine["from"] = [];
  for (const entry of item.from ?? []) {
    const home = await ownHome(entry.homeId);
    from.push({
      copyId: entry.copyId,
      ...(home ? { boxId: home._id } : {}),
      ...(entry.slot !== undefined ? { slot: entry.slot } : {}),
      quantity: entry.quantity,
      condition: entry.condition,
      ...(entry.serialNumber !== undefined ? { serialNumber: entry.serialNumber } : {}),
    });
  }

  // No record of where a line that did take copies came from.
  const tookCopies = (item.shortBy ?? 0) < item.quantity;
  const boxUnrecorded = item.from === undefined && tookCopies;
  let skuBoxId: Id<"collectionContainers"> | undefined;
  if (boxUnrecorded && sale.platform === "bsc") {
    const sku = parseListingSku(item.sellerSku);
    const boxId = sku ? boxIdOf(sku.boxId) : null;
    const home = boxId ? await ownHome(boxId) : null;
    if (home && home.kind === "box") skuBoxId = home._id;
  }

  return {
    ...base,
    ...(item.cardId !== undefined ? { cardId: item.cardId } : {}),
    from,
    ...(boxUnrecorded ? { boxUnrecorded: true as const } : {}),
    ...(skuBoxId ? { skuBoxId } : {}),
    ...(item.lastOnes ? { lastOnes: true as const } : {}),
    ...(item.shortBy !== undefined && item.shortBy > 0 ? { shortBy: item.shortBy } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// cards
// ───────────────────────────────────────────────────────────────────────────

const pickCardValidator = v.object({
  card: catalogCardWithPathValidator,
  /** NB's own code for the card's sport (the sport row's SKU code: "BB"); null when it has none. */
  sportCode: v.union(v.string(), v.null()),
});

/**
 * The cards some lines name, aligned with `cardIds`: a gone card (or a bad
 * id) is null in its place. Catalog data only, so any signed-in caller may
 * read it. At most `MAX_CARDS_BY_ID` ids.
 */
export const cards = query({
  args: { cardIds: v.array(v.string()) },
  returns: v.array(v.union(pickCardValidator, v.null())),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_CARDS_BY_ID) {
      refuse(COLLECTION_ERRORS.limit, `Ask for at most ${MAX_CARDS_BY_ID} cards at once.`);
    }
    const reader = new CatalogReader(ctx);
    const out: Array<typeof pickCardValidator.type | null> = [];
    for (const raw of args.cardIds) {
      const id = ctx.db.normalizeId("cardChecklist", raw);
      const row = id ? await ctx.db.get(id) : null;
      if (!row) {
        out.push(null);
        continue;
      }
      const card = await reader.cardWithPath(row);
      const sport = card.set?.sport ? await reader.row(card.set.sport._id) : null;
      out.push({ card, sportCode: sport?.sportConfig?.skuCode ?? null });
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// soldPhotos
// ───────────────────────────────────────────────────────────────────────────

/**
 * The photos of some copies the caller's lines came from (`from[].copyId`).
 * Read off the photo rows, since a sold copy's row may be gone; a photo that
 * is not the caller's is left out, and so is a copy with none.
 */
export const soldPhotos = query({
  args: { copyIds: v.array(v.id("collectionCopies")) },
  returns: v.array(copyPhotosValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.copyIds.length > MAX_SOLD_PHOTOS) {
      refuse(COLLECTION_ERRORS.limit, `Ask for at most ${MAX_SOLD_PHOTOS} copies at once.`);
    }
    const out: Array<typeof copyPhotosValidator.type> = [];
    for (const copyId of new Set(args.copyIds)) {
      const urls = await ownerPhotoUrlsByCopyId(ctx, ownerId, copyId);
      if (urls.front || urls.back) out.push({ copyId, ...urls });
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// setPulled
// ───────────────────────────────────────────────────────────────────────────

/**
 * Marks some of the caller's lines pulled (`pulled: true`) or back to pull.
 * The whole call is refused when any id is not a line id of one of the
 * caller's orders, so nothing is half done. A line the order no longer has
 * (a re-poll dropped it) is skipped. Marking a line pulled again keeps its
 * first `pulledAt`. Each order's `pullOpen` is recomputed in the same write.
 */
export const setPulled = mutation({
  args: { ids: v.array(v.string()), pulled: v.boolean() },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.ids.length > MAX_SET_PULLED) {
      refuse(COLLECTION_ERRORS.limit, `Mark at most ${MAX_SET_PULLED} cards at once.`);
    }
    const bySale = new Map<string, Set<string>>();
    for (const lineId of new Set(args.ids)) {
      const raw = saleIdOfLine(lineId);
      const saleId = raw ? ctx.db.normalizeId("marketplaceSales", raw) : null;
      if (!saleId) refuse(COLLECTION_ERRORS.notFound, "That sale isn't on your Pick List.");
      const set = bySale.get(saleId) ?? new Set<string>();
      set.add(lineId);
      bySale.set(saleId, set);
    }

    const sales: Sale[] = [];
    for (const saleId of bySale.keys()) {
      const sale = await ctx.db.get(saleId as Id<"marketplaceSales">);
      if (!sale || sale.ownerId !== ownerId) refuse(COLLECTION_ERRORS.notFound, "That sale isn't on your Pick List.");
      sales.push(sale);
    }

    const now = Date.now();
    let updated = 0;
    for (const sale of sales) {
      const wanted = bySale.get(sale._id) ?? new Set<string>();
      const ids = saleLineKeys(sale._id, sale.items);
      let changed = false;
      const items = sale.items.map((item, i) => {
        if (!wanted.has(ids[i])) return item;
        if (args.pulled) {
          if (item.pulledAt !== undefined) return item;
          changed = true;
          updated += 1;
          return { ...item, pulledAt: now };
        }
        if (item.pulledAt === undefined) return item;
        changed = true;
        updated += 1;
        const { pulledAt: _cleared, ...rest } = item;
        return rest;
      });
      if (!changed) continue;
      await ctx.db.patch(sale._id, { items, pullOpen: pullOpenOf({ ...sale, items }) });
    }
    return { updated };
  },
});
