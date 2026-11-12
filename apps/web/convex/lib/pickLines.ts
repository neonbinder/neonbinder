/**
 * NEO-500 — the Pick List's rules over a stored sale (`marketplaceSales`),
 * pure so the apply (`listingSales`), the Pick List queries (`pickList`) and
 * the test seed all read one definition.
 *
 * A LINE is one sale item. Its id is server-made and opaque to the client:
 * `${saleId}~${hash}`, the hash of `${itemKey}#n`, where `itemKey` is the
 * item's `platformCardId|condition|sku` (the key a re-poll matches lines on)
 * and `n` counts earlier items of the same sale with the same key. Never the
 * array index: a re-poll can reorder items, and the id must keep naming the
 * same line. Never the raw key either: it carries the marketplace's card id
 * and the seller SKU, which no client sees.
 *
 * An ORDER is on the Pick List while it is a sale (not cancelled, not a
 * status NB does not know) that has not shipped. A LINE is on it while its
 * order is, it was applied (oversold lines included: "Short N") or refused as
 * unmatched/linkMismatch ("Can't find it"), and nobody marked it pulled.
 * `pullOpen` on the sale row is the stored answer to "does this order have a
 * line on the Pick List", so the list reads one index.
 */
import type { Doc } from "../_generated/dataModel";
import { bscOrderDisposition } from "./bscOrders";
import { ebayStatusDisposition } from "./ebayListing";

type Sale = Doc<"marketplaceSales">;
type SaleItem = Sale["items"][number];

/** Box copies one item's `from` records (a sale doc stays well under the size cap). */
export const MAX_PICK_FROM = 10;
/**
 * `from` entries one sale holds across all its items. An item whose entries
 * would pass it records none (its line shows "Box not recorded"), so a sale
 * at `listingSales.MAX_SALE_ITEMS` lines stays under Convex's 1 MiB doc cap.
 */
export const MAX_FROM_PER_SALE = 1000;

/** The key a re-poll matches a stored item on (`listingSales.recordOrderCore`). */
export function saleItemKey(item: Pick<SaleItem, "platformCardId" | "condition" | "sellerSku">): string {
  return `${item.platformCardId}|${item.condition}|${item.sellerSku ?? ""}`;
}

type KeyedItem = Pick<SaleItem, "platformCardId" | "condition" | "sellerSku">;

/** cyrb53: a fast, well-mixed 53-bit string hash, base 36. Not cryptographic. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * One line's id: `${saleId}~${hash}`, the hash taken over the item's key and
 * `n`, its place among the sale's items with the same key. The key holds the
 * marketplace's card id and the seller SKU, which never reach a client, so
 * only the hash leaves the server.
 */
export function saleLineId(saleId: string, item: KeyedItem, n: number): string {
  return `${saleId}~${hash53(`${saleItemKey(item)}#${n}`)}`;
}

/** Every item's line id, in item order (parallel to `items`); stable when a re-poll reorders them. */
export function saleLineKeys(saleId: string, items: ReadonlyArray<KeyedItem>): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = saleItemKey(item);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return saleLineId(saleId, item, n);
  });
}

/**
 * The sale id a line id names, unchecked: the caller normalises it
 * (`ctx.db.normalizeId`) and checks the sale's owner. Null when it is not one.
 */
export function saleIdOfLine(lineId: string): string | null {
  const tilde = lineId.indexOf("~");
  return tilde > 0 && tilde < lineId.length - 1 ? lineId.slice(0, tilde) : null;
}

/** The index of the item a line id names in `items`, or -1. */
export function saleLineIndex(saleId: string, items: ReadonlyArray<KeyedItem>, lineId: string): number {
  return saleLineKeys(saleId, items).indexOf(lineId);
}

/** Whether the platform has marked the order shipped (BSC SHIPPED either way; eBay FULFILLED). */
export function orderShipped(platform: Sale["platform"], status: string): boolean {
  if (platform === "ebay") return status === "FULFILLED";
  return status === "SHIPPED" || status === "PARTIALLY_REFUNDED_SHIPPED";
}

/** An order with lines to pull: a sale (not cancelled, status known) that has not shipped. */
export function orderOnPickList(sale: Pick<Sale, "platform" | "status">): boolean {
  const disposition = sale.platform === "ebay" ? ebayStatusDisposition(sale.status) : bscOrderDisposition(sale.status);
  return disposition === "sale" && !orderShipped(sale.platform, sale.status);
}

/**
 * One item still to pull, its order aside: applied (oversold too), or refused
 * as unmatched/linkMismatch (the collector looks for it by hand), and not
 * marked pulled. An item not applied yet and not refused is not on the list.
 */
export function lineOnPickList(item: Pick<SaleItem, "applied" | "problem" | "pulledAt">): boolean {
  if (item.pulledAt !== undefined) return false;
  if (item.applied) return true;
  return item.problem === "unmatched" || item.problem === "linkMismatch";
}

/**
 * The stored `pullOpen` for a sale: `true` when the order is on the Pick List
 * with a line on it, otherwise `undefined`, which a patch must write
 * explicitly (a patch merges, so leaving the key out keeps an old `true`).
 */
export function pullOpenOf(sale: Pick<Sale, "platform" | "status" | "items">): true | undefined {
  return orderOnPickList(sale) && sale.items.some(lineOnPickList) ? true : undefined;
}
