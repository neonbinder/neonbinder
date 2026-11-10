/**
 * NEO-479 — the highest price a copy can carry, in cents ($100,000,000.00):
 * far above any card, below float trouble. The client's copy of the server's
 * `MAX_COST_CENTS` (`convex/collection.ts`, read by `isPriceCents`), which a
 * client module cannot import (it would pull the server graph into the
 * bundle). Keep the two in step.
 */
export const MAX_PRICE_CENTS = 10_000_000_000;
