/**
 * The mark a testing seed puts on the marketplace orders it writes, so
 * production code can tell a seeded order from a real one without importing
 * `testing.ts`.
 *
 * NEO-500: `testing.seedMyTestPickOrder` writes a BuySportsCards order for the
 * Pick List spec whose `orderId` is `TEST_SALE_ORDER_PREFIX` + the spec's
 * order token. The order poll (`listingSales.pollInput`) drops such orders: a
 * seeded order is not final, and the poll would otherwise try to re-read it
 * from the marketplace by id on every run once the account polls that
 * platform. (NEO-464's dashboard seeds use the same prefix for their sales.)
 */

/** Every order a sale seed writes carries this `orderId` prefix. */
export const TEST_SALE_ORDER_PREFIX = "nb-test-sale-";

/** True for an order a sale seed wrote (never a marketplace's own id). */
export function isTestSaleOrderId(orderId: string): boolean {
  return orderId.startsWith(TEST_SALE_ORDER_PREFIX);
}
