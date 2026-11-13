/**
 * NEO-464 — the dashboard's shared words: how a marketplace badge reads, and
 * how an order's age reads. Both screens use them, the signed-in `/dashboard`
 * and the logged-out demo, so they live here and not in `./fake-data`: the
 * fake data pulls in the demo's store and catalog, which the signed-in page
 * must never load.
 */

export type Marketplace = "bsc" | "sportlots" | "ebay";

/** How a marketplace badge reads. `short` fits a small pill; `name` is for an accessible name. */
export const MARKETPLACES: Record<Marketplace, { name: string; short: string }> = {
  bsc: { name: "BuySportsCards", short: "BSC" },
  sportlots: { name: "SportLots", short: "SportLots" },
  ebay: { name: "eBay", short: "eBay" },
};

/** A row turns the warning colour from day 2. */
export function isLate(sale: { daysSinceSold: number }): boolean {
  return sale.daysSinceSold >= 2;
}

/** "Today", "Yesterday", "3 days ago". */
export function daysAgoLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
