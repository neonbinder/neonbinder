/**
 * NEO-370 — the SKU NB writes on a BuySportsCards listing row, and its parse.
 *
 * BSC keeps ONE row per (card, condition) per seller; `sellerSku` is just a
 * field on that row. So the SKU is how a sale finds its way back to NB: it
 * carries the NB card id (`cardChecklist`), the row's BSC condition as a short
 * code, and the box (`collectionContainers`) holding the oldest copy folded
 * into the row. Nothing about the listing is stored in NB (NEO-370 revision
 * 2); a sale is matched by parsing this SKU and then checking the card's
 * `platformData.bsc.ref` against the order item's BSC card id.
 *
 * Format: `NB1-<cardId>-<COND>-<boxId>`. Convex ids are 31-37 characters of a
 * lowercase base32 alphabet with no `-`, and every condition code is upper
 * case letters, so `-` is an unambiguous separator. Longest possible:
 * 3 + 1 + 37 + 1 + 5 + 1 + 37 = 85 characters, under BSC's 100 (measured in
 * the NEO-370 spike: 100 is stored exactly, 255 is a 500).
 *
 * The parse is strict: anything that is not exactly this shape, with both ids
 * passing the Convex id checksum, is null. That is what keeps the old
 * platform's SKUs (`303|TB2`, matched by card number) and NB's catalog SKU
 * (`NB-BB-1988-…`, NEO-91) from ever matching a copy.
 */
import type { Id } from "../_generated/dataModel";
import type { BscRawCondition } from "./bscConditions";
import { tableNumberOf } from "./convexIdCodec";

export const LISTING_SKU_PREFIX = "NB1";
export const LISTING_SKU_MAX_LENGTH = 100;

/** Short, unique, upper-case code per BSC raw condition (both eras). */
export const BSC_CONDITION_SKU_CODE: Record<BscRawCondition, string> = {
  near_mint: "NM",
  excellent: "EX",
  very_good: "VG",
  poor: "PR",
  mint: "VMT",
  "nm-mt": "VNMMT",
  nm: "VNM",
  "ex-mt": "VEXMT",
  ex: "VEX",
  "vg-ex": "VVGEX",
  vg: "VVG",
  good: "VGD",
  fair: "VFR",
  "poor-v": "VPR",
};

const CONDITION_BY_CODE: ReadonlyMap<string, BscRawCondition> = new Map(
  (Object.entries(BSC_CONDITION_SKU_CODE) as [BscRawCondition, string][]).map(
    ([condition, code]) => [code, condition],
  ),
);

export interface ListingSkuParts {
  cardId: Id<"cardChecklist">;
  bscCondition: BscRawCondition;
  boxId: Id<"collectionContainers">;
}

/**
 * What a SKU names. The ids are shape-checked strings only: the caller must
 * still `ctx.db.normalizeId("cardChecklist" | "collectionContainers", …)`
 * them, and check the card's BSC ref, before acting on a sale.
 */
export interface ParsedListingSku {
  cardId: string;
  bscCondition: BscRawCondition;
  boxId: string;
}

/** Builds the SKU. Throws on an id that is not a Convex id (a caller bug). */
export function buildListingSku(parts: ListingSkuParts): string {
  if (tableNumberOf(parts.cardId) === null) throw new Error("buildListingSku: cardId is not a Convex id");
  if (tableNumberOf(parts.boxId) === null) throw new Error("buildListingSku: boxId is not a Convex id");
  const sku = [
    LISTING_SKU_PREFIX,
    parts.cardId,
    BSC_CONDITION_SKU_CODE[parts.bscCondition],
    parts.boxId,
  ].join("-");
  if (sku.length > LISTING_SKU_MAX_LENGTH) throw new Error("buildListingSku: SKU longer than 100 characters");
  return sku;
}

const SKU_SHAPE = /^NB1-([0-9a-z]{31,37})-([A-Z]{2,5})-([0-9a-z]{31,37})$/;

/**
 * The parts of an NB listing SKU, or null for anything else: the old
 * platform's `303|TB2`, NB's catalog SKU, a blank, a SKU the seller typed by
 * hand, or an NB SKU whose ids fail the checksum.
 */
export function parseListingSku(sku: string | null | undefined): ParsedListingSku | null {
  if (typeof sku !== "string") return null;
  const trimmed = sku.trim();
  if (trimmed.length === 0 || trimmed.length > LISTING_SKU_MAX_LENGTH) return null;
  const m = SKU_SHAPE.exec(trimmed);
  if (!m) return null;
  const [, cardId, code, boxId] = m;
  const bscCondition = CONDITION_BY_CODE.get(code);
  if (bscCondition === undefined) return null;
  if (tableNumberOf(cardId) === null || tableNumberOf(boxId) === null) return null;
  return { cardId, bscCondition, boxId };
}
