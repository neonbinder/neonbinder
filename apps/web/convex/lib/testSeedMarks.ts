/**
 * NEO-464 — the marks the dashboard's test seeds (`testing.seedMyTestSale`,
 * `testing.seedMyTestSync`) put on what they write, so the clear removes
 * exactly those rows and production code can tell a seeded row from a real
 * one without importing `testing.ts`.
 *
 * NEO-500: `testing.seedMyTestPickOrder` writes a BuySportsCards order for the
 * Pick List spec whose `orderId` also carries `TEST_SALE_ORDER_PREFIX`.
 *
 * The order poll (`listingSales.pollInput`) drops orders carrying
 * `TEST_SALE_ORDER_PREFIX`: a seeded order is not final, and the poll would
 * otherwise re-read it from the marketplace by id on every run once the
 * account starts polling that platform.
 */

/** Every order the sale seed writes carries this `orderId` prefix. */
export const TEST_SALE_ORDER_PREFIX = "nb-test-sale-";

/** Every sync record the sync seed writes leads its NB sentences with this. */
export const TEST_SYNC_MARK = "(Test) ";

/** Queued cards the sync seed writes carry this `seq` (real rows count up from 0). */
export const TEST_OUTBOX_SEQ = -1;

/** True for an order the sale seed wrote (never a marketplace's own id). */
export function isTestSaleOrderId(orderId: string): boolean {
  return orderId.startsWith(TEST_SALE_ORDER_PREFIX);
}
