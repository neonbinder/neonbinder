/**
 * NEO-370 — BuySportsCards seller orders, narrowed to what NB keeps, and the
 * choice of which copies a sale lowers. Pure and env-free.
 *
 * `parseBscOrder` reads a `GET seller/order/{orderId}` payload. It keeps the
 * order's ids, date, status, totals and, per item, the BSC card id, condition,
 * quantity, unit price and seller SKU, plus (NEO-509) the card's description
 * words and BSC's sport id (`BscListedCard`). Everything about the buyer and the
 * seller (names, emails, addresses, Stripe and payment ids, shipments,
 * tracking) is dropped here, at the boundary: none of it is ever stored.
 *
 * `parseBscOrderHistoryPage` reads `POST seller/order/history` (an empty
 * `status` array asks for every status; results come newest first).
 *
 * Status matters: a CANCELLED order lowers nothing. A cancel that arrives
 * after NB already lowered a copy is reported to the operator, never
 * restored automatically (`bscOrderDisposition`).
 */
import { bscDollarsToCents } from "./bscMoney";
import { compareCopiesOldestFirst, type AgedCopy } from "./listingCopyOrder";

// ── Status ───────────────────────────────────────────────────────────────────

/** The statuses seen on BSC's seller order screens (2026-11-01). */
export const BSC_ORDER_STATUSES = [
  "READY_TO_SHIP",
  "PARTIALLY_REFUNDED_READY_TO_SHIP",
  "SHIPPED",
  "PARTIALLY_REFUNDED_SHIPPED",
  "CANCELLED",
] as const;
export type KnownBscOrderStatus = (typeof BSC_ORDER_STATUSES)[number];

/**
 * What an order's status means for NB stock:
 *   "sale"      — the items sold; lower the copies (once per line).
 *   "cancelled" — nothing sold; lower nothing, and if a line was already
 *                 applied, tell the operator (never restore on our own).
 *   "unknown"   — a status NB has not seen; lower nothing and report it.
 */
export function bscOrderDisposition(status: string): "sale" | "cancelled" | "unknown" {
  switch (status) {
    case "READY_TO_SHIP":
    case "PARTIALLY_REFUNDED_READY_TO_SHIP":
    case "SHIPPED":
    case "PARTIALLY_REFUNDED_SHIPPED":
      return "sale";
    case "CANCELLED":
      return "cancelled";
    default:
      return "unknown";
  }
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * BSC order dates carry no zone ("2026-10-30T15:01:06.541323" on the detail,
 * "2026-10-30T15:01:06" on the history list) and up to six fraction digits.
 * Read as UTC; the fraction is cut to milliseconds. Null when unreadable.
 */
export function parseBscDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[2] ? `.${m[2].slice(0, 3).padEnd(3, "0")}` : "";
  const zone = m[3] ?? "Z";
  const ms = Date.parse(`${m[1]}${fraction}${zone}`);
  return Number.isFinite(ms) ? ms : null;
}

// ── Orders ─────────────────────────────────────────────────────────────────

/**
 * NEO-509 — the card a line describes, as BSC listed it: the words on
 * `orderItems[i].card` plus the item-level `sportId` (BSC's sport id, e.g.
 * "football", which is what a sport row's `platformData.bsc` slot holds).
 * Display text for the Pick List and one id to resolve at the sync boundary;
 * never NB data. Each field is present only when BSC sent a readable value
 * within `BSC_LISTED_BOUNDS`.
 */
export interface BscListedCard {
  sport?: string;
  platformSportId?: string;
  year?: string;
  setName?: string;
  players?: string;
  cardNo?: string;
  variant?: string;
  variantName?: string;
}

export interface BscOrderItem {
  bscCardId: string;
  condition: string;
  /** "raw" or "graded"; null when BSC sent none. Only raw is ever NB's. */
  productType: string | null;
  /** `orderQuantity`, an integer >= 1. */
  quantity: number;
  /** Unit price, integer cents. */
  priceCents: number | null;
  sellerSku: string | null;
  /** NEO-509 — the card's description; null when BSC sent nothing readable. */
  listed: BscListedCard | null;
}

export interface BscOrderTotals {
  subtotalCents: number | null;
  shippingCents: number | null;
  taxCents: number | null;
  discountCents: number | null;
  sellerFeeCents: number | null;
  totalCents: number | null;
  sellerNetCents: number | null;
  refundCents: number | null;
}

export interface BscOrder {
  orderId: string;
  orderNo: string | null;
  orderDateMs: number | null;
  status: string;
  currency: string | null;
  totals: BscOrderTotals;
  items: BscOrderItem[];
  /** Items present on the payload that could not be read (surface these). */
  unreadableItems: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The longest BSC strings NB keeps. A value over its bound is not a value NB
 * reads: the order (or the line) carrying it is treated as unreadable, never
 * stored truncated.
 */
export const BSC_ORDER_BOUNDS = {
  orderId: 64,
  orderNo: 64,
  status: 64,
  condition: 32,
  cardId: 64,
  sku: 100,
  productType: 32,
  currency: 8,
} as const;

/** A non-blank string within `max`; `undefined` when it is longer (unreadable). */
function bounded(value: unknown, max: number): string | null | undefined {
  const s = str(value);
  if (s === null) return null;
  return s.length > max ? undefined : s;
}

/**
 * NEO-509 — the longest description values NB keeps per line. Unlike
 * `BSC_ORDER_BOUNDS`, a value past its bound drops THAT field only: the line
 * stays readable (it still sold), it just names less. Never truncated.
 */
export const BSC_LISTED_BOUNDS = {
  sport: 32,
  platformSportId: 32,
  year: 16,
  setName: 120,
  players: 160,
  cardNo: 32,
  variant: 32,
  variantName: 120,
} as const;

/**
 * Characters that make a value not display text: C0 and C1 controls (tab and
 * newline included), and the Unicode format characters that change how text
 * around them reads without showing themselves. A U+202E inside a card number
 * or set name can visually reorder what a seller reads on the Pick List or the
 * print sheet, so they pull the wrong card. Matched:
 * - U+200B–U+200F zero-width space/joiners and the LRM/RLM marks,
 * - U+2028, U+2029 line and paragraph separators,
 * - U+202A–U+202E bidi embeddings and overrides,
 * - U+2060 word joiner,
 * - U+2066–U+2069 bidi isolates,
 * - U+FEFF zero-width no-break space (byte-order mark).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

/**
 * A trimmed display string within `max`; null when absent, blank, carrying a
 * control or format character (`CONTROL_CHARS`) or too long. Exported so the
 * store re-checks a projected description by the same rule
 * (`listingSales.storedListed`).
 */
export function bscListedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s.length > max || CONTROL_CHARS.test(s)) return null;
  return s;
}

/**
 * The card description on one order item. Reads ONLY the named keys of
 * `item.card` (`sport`, `year`, `setName`, `players`, `cardNo`, `variant`,
 * `variantName`) and the item's `sportId`; never image paths, prices or
 * seller fields. A year BSC sends as an integer is read as its digits.
 */
function narrowListed(item: Record<string, unknown>): BscListedCard | null {
  const card = isRecord(item.card) ? item.card : {};
  const rawYear = typeof card.year === "number" && Number.isInteger(card.year) ? String(card.year) : card.year;
  const out: BscListedCard = {};
  const put = (key: keyof BscListedCard, value: unknown) => {
    const s = bscListedText(value, BSC_LISTED_BOUNDS[key]);
    if (s !== null) out[key] = s;
  };
  put("sport", card.sport);
  put("platformSportId", item.sportId);
  put("year", rawYear);
  put("setName", card.setName);
  put("players", card.players);
  put("cardNo", card.cardNo);
  put("variant", card.variant);
  put("variantName", card.variantName);
  return Object.keys(out).length > 0 ? out : null;
}

function narrowOrderItem(value: unknown): BscOrderItem | null {
  if (!isRecord(value)) return null;
  const card = isRecord(value.card) ? value.card : null;
  const nestedId = card ? bounded(card.id, BSC_ORDER_BOUNDS.cardId) : null;
  const topId = bounded(value.cardId, BSC_ORDER_BOUNDS.cardId);
  if (nestedId === undefined || topId === undefined) return null;
  if (nestedId !== null && topId !== null && nestedId !== topId) return null;
  const bscCardId = nestedId ?? topId;
  if (bscCardId === null) return null;
  const condition = bounded(value.condition, BSC_ORDER_BOUNDS.condition);
  if (condition === null || condition === undefined) return null;
  const quantity = value.orderQuantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) return null;
  const productType = bounded(value.productType, BSC_ORDER_BOUNDS.productType);
  const sellerSku = bounded(value.sellerSku, BSC_ORDER_BOUNDS.sku);
  if (productType === undefined || sellerSku === undefined) return null;
  return {
    bscCardId,
    condition,
    productType,
    quantity,
    priceCents: bscDollarsToCents(value.price),
    sellerSku,
    listed: narrowListed(value),
  };
}

/**
 * A `GET seller/order/{orderId}` payload, narrowed. Null when it has no
 * `orderId` or no `orderStatus` (nothing can be decided without them), or
 * when its id, number or status is longer than NB takes (`BSC_ORDER_BOUNDS`).
 * Missing optional fields come back null; a missing `orderItems` is no items.
 */
export function parseBscOrder(value: unknown): BscOrder | null {
  if (!isRecord(value)) return null;
  const orderId = bounded(value.orderId, BSC_ORDER_BOUNDS.orderId);
  const status = bounded(value.orderStatus, BSC_ORDER_BOUNDS.status);
  const orderNo = bounded(value.orderNo, BSC_ORDER_BOUNDS.orderNo);
  if (orderId === null || orderId === undefined || status === null || status === undefined) return null;
  if (orderNo === undefined) return null;
  const rawItems = Array.isArray(value.orderItems) ? value.orderItems : [];
  const items: BscOrderItem[] = [];
  let unreadableItems = 0;
  for (const raw of rawItems) {
    const item = narrowOrderItem(raw);
    if (item) items.push(item);
    else unreadableItems += 1;
  }
  return {
    orderId,
    orderNo,
    orderDateMs: parseBscDate(value.orderDate),
    status,
    currency: bounded(value.orderCurrency, BSC_ORDER_BOUNDS.currency) ?? null,
    totals: {
      subtotalCents: bscDollarsToCents(value.subTotal),
      shippingCents: bscDollarsToCents(value.shippingCost),
      taxCents: bscDollarsToCents(value.salesTax),
      discountCents: bscDollarsToCents(value.buyerDiscountAmount),
      sellerFeeCents: bscDollarsToCents(value.sellerFee),
      totalCents: bscDollarsToCents(value.total),
      sellerNetCents: bscDollarsToCents(value.sellerNetTotal),
      refundCents: bscDollarsToCents(value.refundTotal),
    },
    items,
    unreadableItems,
  };
}

export interface BscOrderSummary {
  orderId: string;
  orderNo: string | null;
  orderDateMs: number | null;
  status: string | null;
}

/**
 * A `POST seller/order/history` page: `{totalElements, results}` with the
 * newest order first. `results` may be null on a seller with no orders. A
 * result with no `orderId`, or with an id, number or status longer than NB
 * takes, is counted in `unreadable` and skipped. Null when
 * the payload is not an object at all.
 */
export function parseBscOrderHistoryPage(
  value: unknown,
): { totalElements: number | null; orders: BscOrderSummary[]; unreadable: number } | null {
  if (!isRecord(value)) return null;
  const total = value.totalElements;
  const results = Array.isArray(value.results) ? value.results : [];
  const orders: BscOrderSummary[] = [];
  let unreadable = 0;
  for (const r of results) {
    const orderId = isRecord(r) ? bounded(r.orderId, BSC_ORDER_BOUNDS.orderId) : null;
    const orderNo = isRecord(r) ? bounded(r.orderNo, BSC_ORDER_BOUNDS.orderNo) : null;
    const status = isRecord(r) ? bounded(r.orderStatus, BSC_ORDER_BOUNDS.status) : null;
    if (!isRecord(r) || orderId === null || orderId === undefined || orderNo === undefined || status === undefined) {
      unreadable += 1;
      continue;
    }
    orders.push({
      orderId,
      orderNo,
      orderDateMs: parseBscDate(r.orderDate),
      status,
    });
  }
  return {
    totalElements: typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null,
    orders,
    unreadable,
  };
}

// ── Which copies a sale lowers ───────────────────────────────────────────────

export interface SaleCopy extends AgedCopy {
  quantity: number;
}

export interface SaleDecrement {
  copyId: string;
  /** How many to take off this copy line, 1..its quantity. */
  by: number;
}

/**
 * Lowers `sold` copies across the owner's box copies of one card in one
 * NB-condition group (the NB conditions that fold into the sold BSC
 * condition, `nbConditionsFor`). The caller has already filtered to raw box
 * copies of that card and group; binder and graded copies never reach here.
 *
 * Oldest first (`compareCopiesOldestFirst`), the SKU's box winning a tie on
 * the age day. `shortfall` is what NB could not lower because it held fewer
 * than sold (an oversell): the copies go to 0 and the caller reports it.
 */
export function chooseCopiesToLower(
  copies: readonly SaleCopy[],
  skuBoxId: string | null,
  sold: number,
): { decrements: SaleDecrement[]; shortfall: number } {
  if (!Number.isInteger(sold) || sold < 1) return { decrements: [], shortfall: 0 };
  const sorted = copies
    .filter((c) => Number.isInteger(c.quantity) && c.quantity > 0)
    .sort((a, b) => compareCopiesOldestFirst(a, b, skuBoxId));
  const decrements: SaleDecrement[] = [];
  let remaining = sold;
  for (const copy of sorted) {
    if (remaining === 0) break;
    const by = Math.min(copy.quantity, remaining);
    decrements.push({ copyId: copy.copyId, by });
    remaining -= by;
  }
  return { decrements, shortfall: remaining };
}
