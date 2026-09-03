/**
 * Money formatting for money the seller is about to spend, or already has.
 *
 * Lifted out of app/print/shipping/page.tsx in NEO-213, when label history
 * became a second place that renders a cost in cents. Every amount that crosses
 * the postage boundary is an integer number of cents — EasyPost prices in
 * decimal strings and the Convex layer normalises them on the way in — so the
 * one thing this must never do is take a float dollar amount.
 */

/**
 * `1234` → `"$12.34"`. Always two decimal places, so a column of prices lines
 * up and 80 cents renders as `$0.80` rather than `$0.8`.
 *
 * Deliberately not `Intl.NumberFormat`: these are USPS postage amounts on a
 * US-only shipping flow, and a locale-aware formatter would render the same
 * purchase as `12,34 $` for a seller whose browser is set to de-DE — a number
 * they would then mis-read against their EasyPost statement.
 */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
