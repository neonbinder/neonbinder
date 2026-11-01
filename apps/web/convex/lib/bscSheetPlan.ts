/**
 * NEO-370 — what one BuySportsCards push for one variant should send.
 *
 * Pure and env-free. BSC is a BY-SET platform (NEO-370 revision 2): a push
 * reads the variant's seller sheet once per BSC condition
 * (`POST seller/bulk-upload/results`), sets EVERY row to NB's count, and PUTs
 * only the rows that differ (`PUT seller/bulk-upload` with `{sellerId,
 * listings}`). A PUT row is the sheet row spread back with our fields changed,
 * the old platform's approach (`{...listing, availableQuantity, price,
 * sellerSku}`). Only quantity, price, SKU and seller photos are NB's to set.
 *
 * Two steps, both here:
 *   1. `foldBscTargets` folds a variant's for-sale copies into one target per
 *      (NB card, BSC condition): quantities add, the price is the highest
 *      floor, the SKU names the oldest copy's box.
 *   2. `planBscSheet` diffs those targets against the sheet rows.
 *
 * Rows are keyed on BSC `card.id` + condition, never `productId` (a row that
 * drops to 0 comes back as a blank template with a NEW productId). A row is
 * matched to an NB card ONLY through the card's own `platformData.bsc.ref`
 * (product invariant: never by name or number). The card number is a check,
 * not a key: a ref whose sheet `cardNo` disagrees with NB's number is a
 * conflict for the operator. Every guard is a problem and leaves that BSC row
 * untouched; the worst outcome is a card that does not list, never the wrong
 * card listed.
 *
 * Never two rows with the same (card.id, condition) in one push: BSC answered
 * that with a 500 that was half applied (NEO-370 spike).
 */
import type { Id } from "../_generated/dataModel";
import {
  bscConditionFor,
  type BscEra,
  type BscRawCondition,
  type NbCondition,
} from "./bscConditions";
import { bscDollarsToCents, centsToBscDollars, checkBscPrice } from "./bscMoney";
import { compareCopiesOldestFirst, type AgedCopy } from "./listingCopyOrder";
import { hasListingCondition, listingFloorCents } from "./listingReadiness";
import { buildListingSku } from "./listingSku";

/** BSC takes at most this many rows per PUT (the old platform's batch). */
export const BSC_PUT_CHUNK_SIZE = 100;

// ── Problems ────────────────────────────────────────────────────────────────

export type ListingProblemReason =
  /** The NB card carries no BSC id, so it has no BSC row to list on. */
  | "no_bsc_id"
  /** Two NB cards in the variant carry the same BSC id. */
  | "shared_bsc_id"
  /** The BSC row for this card's id shows a different card number. */
  | "card_number_conflict"
  /** The card's BSC id is not on this variant's BSC sheet. */
  | "not_on_bsc_sheet"
  /** BSC's sheet held two rows for one (card, condition). */
  | "duplicate_sheet_row"
  /** A sheet row that could not be read (missing card id, quantity, …). */
  | "unreadable_sheet_row"
  /** A target's condition sheet was not read (a caller bug). */
  | "condition_not_read"
  /** A target for a card that is not in the variant's card list. */
  | "card_not_in_variant"
  | "no_price"
  | "price_too_high"
  /** A for-sale copy with no condition. */
  | "no_condition"
  /** A graded copy (slabs list another way, NEO-373). */
  | "graded"
  /** A copy of the collector's own private card (never catalog data). */
  | "private_card"
  /** The variant's year carries no year BSC can read. */
  | "no_era";

export interface ListingProblem {
  reason: ListingProblemReason;
  /** An NB card id (a private card id for "private_card"). */
  cardId?: string;
  bscCardId?: string;
  bscCondition?: string;
  /** Short operator-facing detail, never a marketplace value used as data. */
  detail?: string;
}

// ── Step 1: fold copies into targets ───────────────────────────────────────

/** A copy as the fold reads it. `homeIsBox` false = a binder copy, never for sale. */
export interface ListingCopy extends AgedCopy {
  copyId: Id<"collectionCopies">;
  homeId: Id<"collectionContainers">;
  card:
    | { kind: "catalog"; id: Id<"cardChecklist"> }
    | { kind: "private"; id: Id<"privateCards"> };
  homeIsBox: boolean;
  graded: boolean;
  quantity: number;
  condition?: NbCondition;
  /** The copy's own floor, integer cents. */
  minPriceCents?: number;
}

/** One BSC row's worth of NB stock: (NB card, BSC condition). */
export interface BscTarget {
  cardId: Id<"cardChecklist">;
  bscCondition: BscRawCondition;
  /** Sum of every copy folded in, an integer >= 1. */
  quantity: number;
  /** Highest floor among the folded copies; null when none has a floor. */
  priceCents: number | null;
  sku: string;
  /** The oldest copy folded in: its box is the SKU's, its photos list. */
  oldestCopyId: Id<"collectionCopies">;
}

export interface FoldBscTargetsInput {
  copies: readonly ListingCopy[];
  /** Null when the variant's year gave no era (`bscEraForYear`). */
  era: BscEra | null;
  /** The owner's `variantCommonPrices` row for this variant, cents. */
  commonPriceCents: number | null | undefined;
}

export function foldBscTargets(input: FoldBscTargetsInput): {
  targets: BscTarget[];
  problems: ListingProblem[];
} {
  const problems = new ProblemList();
  const groups = new Map<string, { cardId: Id<"cardChecklist">; bscCondition: BscRawCondition; copies: ListingCopy[] }>();

  for (const copy of input.copies) {
    if (!copy.homeIsBox) continue; // a binder copy is never for sale
    if (!Number.isInteger(copy.quantity) || copy.quantity < 1) continue;
    if (copy.card.kind === "private") {
      problems.add({ reason: "private_card", cardId: copy.card.id });
      continue;
    }
    const cardId = copy.card.id;
    if (copy.graded) {
      problems.add({ reason: "graded", cardId });
      continue;
    }
    if (copy.condition === undefined || !hasListingCondition(copy.condition)) {
      problems.add({ reason: "no_condition", cardId });
      continue;
    }
    if (input.era === null) {
      problems.add({ reason: "no_era", cardId });
      continue;
    }
    const bscCondition = bscConditionFor(copy.condition, input.era);
    const key = `${cardId}|${bscCondition}`;
    const group = groups.get(key);
    if (group) group.copies.push(copy);
    else groups.set(key, { cardId, bscCondition, copies: [copy] });
  }

  const targets: BscTarget[] = [];
  for (const { cardId, bscCondition, copies } of groups.values()) {
    const sorted = [...copies].sort((a, b) => compareCopiesOldestFirst(a, b));
    const oldest = sorted[0];
    let quantity = 0;
    let priceCents: number | null = null;
    for (const c of sorted) {
      quantity += c.quantity;
      // The one price rule the add gate shares (`listingReadiness`).
      const floor = listingFloorCents(c.minPriceCents, input.commonPriceCents);
      if (floor !== null && (priceCents === null || floor > priceCents)) priceCents = floor;
    }
    targets.push({
      cardId,
      bscCondition,
      quantity,
      priceCents,
      sku: buildListingSku({ cardId, bscCondition, boxId: oldest.homeId }),
      oldestCopyId: oldest.copyId,
    });
  }
  return { targets, problems: problems.list() };
}

// ── Sheet rows ───────────────────────────────────────────────────────────────

/** A seller-sheet row, narrowed. `raw` is the row exactly as BSC sent it. */
export interface BscSheetRow {
  raw: Readonly<Record<string, unknown>>;
  bscCardId: string;
  cardNo: string;
  condition: string;
  /** "raw" on a raw sheet; null when BSC sent none. */
  productType: string | null;
  quantity: number;
  priceCents: number;
  sellerSku: string | null;
  sellerImgFront: string | null;
  sellerImgBack: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Longest BSC card id, condition and SKU NB takes from a sheet row. */
export const MAX_SHEET_CARD_ID = 64;
export const MAX_SHEET_CONDITION = 32;
export const MAX_SHEET_SKU = 100;
/** A sheet row whose JSON is longer than this is unreadable (a measured row is about 1 KB). */
export const MAX_SHEET_ROW_BYTES = 16 * 1024;

/**
 * A row of `seller/bulk-upload/results`, or null when it lacks what a push
 * needs: `card.id` (agreeing with a top-level `cardId` when both are sent),
 * `card.cardNo`, `condition`, a whole `availableQuantity` >= 0 and a readable
 * `price` ("0" when unlisted). A card id, condition or SKU longer than NB
 * takes is unreadable too.
 */
export function narrowBscSheetRow(value: unknown): BscSheetRow | null {
  if (!isRecord(value)) return null;
  const card = value.card;
  if (!isRecord(card)) return null;
  const bscCardId = optionalString(card.id);
  if (bscCardId === null || bscCardId.length > MAX_SHEET_CARD_ID) return null;
  const topCardId = value.cardId;
  if (topCardId !== undefined && topCardId !== null && topCardId !== bscCardId) return null;
  const cardNo =
    typeof card.cardNo === "string" ? card.cardNo : typeof card.cardNo === "number" ? String(card.cardNo) : null;
  if (cardNo === null || cardNo.length > MAX_SHEET_CARD_ID) return null;
  const condition = optionalString(value.condition);
  if (condition === null || condition.length > MAX_SHEET_CONDITION) return null;
  const quantity = value.availableQuantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) return null;
  const priceCents = bscDollarsToCents(value.price);
  if (priceCents === null || priceCents < 0) return null;
  const sellerSku = optionalString(value.sellerSku);
  if (sellerSku !== null && sellerSku.length > MAX_SHEET_SKU) return null;
  return {
    raw: value,
    bscCardId,
    cardNo,
    condition,
    productType: optionalString(value.productType),
    quantity,
    priceCents,
    sellerSku,
    sellerImgFront: optionalString(value.sellerImgFront),
    sellerImgBack: optionalString(value.sellerImgBack),
  };
}

/**
 * Sheet rows narrowed as they are read (`narrowBscSheet`), so a caller never
 * holds BSC's raw answer: `rows` are the readable ones, `total` how many BSC
 * sent and `unreadable` how many were dropped.
 */
export interface NarrowedBscSheet {
  kind: "narrowed";
  rows: BscSheetRow[];
  total: number;
  unreadable: number;
}

/** Narrows each row (`narrowBscSheetRow`), dropping unreadable and oversized ones. */
export function narrowBscSheet(values: readonly unknown[]): NarrowedBscSheet {
  const rows: BscSheetRow[] = [];
  let unreadable = 0;
  for (const value of values) {
    let size = 0;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      size = Infinity;
    }
    const row = size > MAX_SHEET_ROW_BYTES ? null : narrowBscSheetRow(value);
    if (row) rows.push(row);
    else unreadable += 1;
  }
  return { kind: "narrowed", rows, total: values.length, unreadable };
}

/** Joins narrowed sheets (several conditions or facet requests) into one. */
export function joinNarrowedSheets(sheets: readonly NarrowedBscSheet[]): NarrowedBscSheet {
  return {
    kind: "narrowed",
    rows: sheets.flatMap((s) => s.rows),
    total: sheets.reduce((n, s) => n + s.total, 0),
    unreadable: sheets.reduce((n, s) => n + s.unreadable, 0),
  };
}

function isNarrowedSheet(value: readonly unknown[] | NarrowedBscSheet): value is NarrowedBscSheet {
  return !Array.isArray(value) && (value as NarrowedBscSheet).kind === "narrowed";
}

/**
 * True when the row still shows BSC's stock or default image on that side
 * (missing, or a `Default…` placeholder): the old platform's rule for when to
 * upload the seller's own photo.
 */
export function rowNeedsSellerPhoto(row: BscSheetRow, side: "front" | "back"): boolean {
  const img = side === "front" ? row.sellerImgFront : row.sellerImgBack;
  return img === null || img.includes("Default");
}

// ── Step 2: diff targets against the sheet ─────────────────────────────────

/** A PUT row: the sheet row spread back with NB's fields set. */
export type BscPutRow = Record<string, unknown> & {
  availableQuantity: number;
  condition: string;
};

/** Seller photo object keys (from BSC's attachment upload) for one target. */
export interface BscPhotoKeys {
  front?: string;
  back?: string;
}

export interface PlannedBscPut {
  kind: "set" | "zero";
  bscCardId: string;
  condition: string;
  /** The NB card, for "set" rows. */
  cardId?: Id<"cardChecklist">;
  oldestCopyId?: Id<"collectionCopies">;
  /** For "set" rows: the row still shows BSC's image on that side. */
  needsPhotoFront: boolean;
  needsPhotoBack: boolean;
  row: BscPutRow;
}

export interface NbVariantCard {
  cardId: Id<"cardChecklist">;
  cardNumber: string;
  /** `platformData.bsc.ref`, or null when the card has none. */
  bscRef: string | null;
}

export interface PlanBscSheetInput {
  /**
   * Every row of every condition sheet read for the variant: as BSC sent
   * them, or already narrowed as they were read (`narrowBscSheet`).
   */
  sheetRows: readonly unknown[] | NarrowedBscSheet;
  /** The conditions those sheets were read for. */
  conditionsRead: readonly string[];
  targets: readonly BscTarget[];
  /** Every NB card of the variant (not only the ones with targets). */
  cards: readonly NbVariantCard[];
  /**
   * Seller photo keys already uploaded, by `photoKeyFor(bscCardId, condition)`.
   * Applied only to a "set" row that still shows BSC's image on that side.
   */
  photoKeys?: ReadonlyMap<string, BscPhotoKeys>;
}

export interface BscSheetPlanCounts {
  sheetRows: number;
  unreadableRows: number;
  targets: number;
  /** Targets whose BSC row will show NB's stock after the push. */
  listed: number;
  quantityListed: number;
  toSet: number;
  toZero: number;
  /** Targets whose row already matches (quantity, price and SKU). */
  unchanged: number;
  problems: number;
}

export interface BscSheetPlan {
  puts: PlannedBscPut[];
  /** `puts` rows in PUT-sized chunks (<= BSC_PUT_CHUNK_SIZE), same objects. */
  chunks: BscPutRow[][];
  counts: BscSheetPlanCounts;
  problems: ListingProblem[];
}

export function photoKeyFor(bscCardId: string, condition: string): string {
  return `${bscCardId}|${condition}`;
}

function sameCardNumber(sheetCardNo: string, nbCardNumber: string): boolean {
  return sheetCardNo.trim().toUpperCase() === nbCardNumber.trim().toUpperCase();
}

export function planBscSheet(input: PlanBscSheetInput): BscSheetPlan {
  const problems = new ProblemList();
  const conditionsRead = new Set(input.conditionsRead);

  // Sheet rows by (card.id, condition); a key seen twice is blocked whole.
  const narrowed = isNarrowedSheet(input.sheetRows) ? input.sheetRows : narrowBscSheet(input.sheetRows);
  const sheetRows = narrowed.total;
  const unreadableRows = narrowed.unreadable;
  const rowsByKey = new Map<string, BscSheetRow>();
  const duplicateKeys = new Set<string>();
  const firstRowByRef = new Map<string, BscSheetRow>();
  const sheetOrder: string[] = [];
  for (const row of narrowed.rows) {
    if (row.productType !== null && row.productType !== "raw") continue; // never ours
    const key = photoKeyFor(row.bscCardId, row.condition);
    if (rowsByKey.has(key)) {
      if (!duplicateKeys.has(key)) {
        duplicateKeys.add(key);
        problems.add({ reason: "duplicate_sheet_row", bscCardId: row.bscCardId, bscCondition: row.condition });
      }
      continue;
    }
    rowsByKey.set(key, row);
    sheetOrder.push(key);
    if (!firstRowByRef.has(row.bscCardId)) firstRowByRef.set(row.bscCardId, row);
  }
  if (unreadableRows > 0) {
    problems.add({ reason: "unreadable_sheet_row", detail: `${unreadableRows} of ${sheetRows} rows` });
  }

  // NB cards by id, and which NB cards hold each BSC ref.
  const cardsById = new Map<string, NbVariantCard>();
  const cardsByRef = new Map<string, NbVariantCard[]>();
  for (const card of input.cards) {
    cardsById.set(card.cardId, card);
    if (card.bscRef === null || card.bscRef === "") continue;
    const list = cardsByRef.get(card.bscRef);
    if (list) list.push(card);
    else cardsByRef.set(card.bscRef, [card]);
  }

  // Refs and keys NB holds stock for but cannot push: never touched at all.
  const blockedRefs = new Set<string>();
  const blockedKeys = new Set<string>(duplicateKeys);
  const handledKeys = new Set<string>();

  const puts: PlannedBscPut[] = [];
  let listed = 0;
  let quantityListed = 0;
  let unchanged = 0;

  // Pass 1: the guards that block a whole ref.
  const targetRef = new Map<BscTarget, string>();
  for (const target of input.targets) {
    const card = cardsById.get(target.cardId);
    if (!card) {
      problems.add({ reason: "card_not_in_variant", cardId: target.cardId });
      continue;
    }
    if (card.bscRef === null || card.bscRef === "") {
      problems.add({ reason: "no_bsc_id", cardId: target.cardId });
      continue;
    }
    const ref = card.bscRef;
    const holders = cardsByRef.get(ref) ?? [];
    if (holders.length > 1) {
      blockedRefs.add(ref);
      problems.add({ reason: "shared_bsc_id", cardId: target.cardId, bscCardId: ref });
      continue;
    }
    const anyRow = firstRowByRef.get(ref);
    if (anyRow && !sameCardNumber(anyRow.cardNo, card.cardNumber)) {
      blockedRefs.add(ref);
      problems.add({
        reason: "card_number_conflict",
        cardId: target.cardId,
        bscCardId: ref,
        // NB's own number only: a marketplace value never reaches the operator.
        detail: `NB #${card.cardNumber}`,
      });
      continue;
    }
    targetRef.set(target, ref);
  }

  // Pass 2: per target, the row guards, then the diff.
  for (const target of input.targets) {
    const ref = targetRef.get(target);
    if (ref === undefined || blockedRefs.has(ref)) continue;
    const key = photoKeyFor(ref, target.bscCondition);
    if (handledKeys.has(key) || blockedKeys.has(key)) continue;
    handledKeys.add(key);
    if (!conditionsRead.has(target.bscCondition)) {
      blockedKeys.add(key);
      problems.add({ reason: "condition_not_read", cardId: target.cardId, bscCardId: ref, bscCondition: target.bscCondition });
      continue;
    }
    const row = rowsByKey.get(key);
    if (!row) {
      blockedKeys.add(key);
      problems.add({ reason: "not_on_bsc_sheet", cardId: target.cardId, bscCardId: ref, bscCondition: target.bscCondition });
      continue;
    }
    const price = checkBscPrice(target.priceCents);
    if (!price.ok) {
      blockedKeys.add(key);
      problems.add({ reason: price.reason, cardId: target.cardId, bscCardId: ref, bscCondition: target.bscCondition });
      continue;
    }

    const photos = input.photoKeys?.get(key);
    const needsPhotoFront = rowNeedsSellerPhoto(row, "front");
    const needsPhotoBack = rowNeedsSellerPhoto(row, "back");
    const photoFront = needsPhotoFront ? photos?.front : undefined;
    const photoBack = needsPhotoBack ? photos?.back : undefined;

    listed += 1;
    quantityListed += target.quantity;
    const same =
      row.quantity === target.quantity &&
      row.priceCents === price.priceCents &&
      row.sellerSku === target.sku &&
      photoFront === undefined &&
      photoBack === undefined;
    if (same) {
      unchanged += 1;
      continue;
    }
    const putRow: BscPutRow = {
      ...row.raw,
      condition: row.condition,
      availableQuantity: target.quantity,
      price: centsToBscDollars(price.priceCents),
      sellerSku: target.sku,
    };
    if (photoFront !== undefined) putRow.sellerImgFront = photoFront;
    if (photoBack !== undefined) putRow.sellerImgBack = photoBack;
    puts.push({
      kind: "set",
      bscCardId: ref,
      condition: row.condition,
      cardId: target.cardId,
      oldestCopyId: target.oldestCopyId,
      needsPhotoFront,
      needsPhotoBack,
      row: putRow,
    });
  }

  // Pass 3: every other row NB does not hold goes to 0 (NB is the truth).
  let toZero = 0;
  for (const key of sheetOrder) {
    if (handledKeys.has(key) || blockedKeys.has(key)) continue;
    const row = rowsByKey.get(key);
    if (!row || row.quantity === 0 || blockedRefs.has(row.bscCardId)) continue;
    toZero += 1;
    puts.push({
      kind: "zero",
      bscCardId: row.bscCardId,
      condition: row.condition,
      needsPhotoFront: false,
      needsPhotoBack: false,
      row: { ...row.raw, condition: row.condition, availableQuantity: 0 },
    });
  }

  const chunks = chunkRows(puts.map((p) => p.row), BSC_PUT_CHUNK_SIZE);
  const problemList = problems.list();
  return {
    puts,
    chunks,
    counts: {
      sheetRows,
      unreadableRows,
      targets: input.targets.length,
      listed,
      quantityListed,
      toSet: puts.length - toZero,
      toZero,
      unchanged,
      problems: problemList.length,
    },
    problems: problemList,
  };
}

/** Splits rows into chunks of at most `size` (>= 1), in order. */
export function chunkRows<T>(rows: readonly T[], size: number = BSC_PUT_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunkRows: size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Problems, one per (reason, card, BSC card, condition). */
class ProblemList {
  private readonly seen = new Set<string>();
  private readonly items: ListingProblem[] = [];
  add(problem: ListingProblem): void {
    const key = [problem.reason, problem.cardId ?? "", problem.bscCardId ?? "", problem.bscCondition ?? ""].join("|");
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(problem);
  }
  list(): ListingProblem[] {
    return [...this.items];
  }
}
