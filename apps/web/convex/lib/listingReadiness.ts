/**
 * NEO-370 — whether a for-sale copy carries what a marketplace listing needs:
 * a price and a condition. Pure and env-free, so the listing drain, the copy
 * writers that refuse an unready add (`convex/listingGate.ts`) and the
 * screens that hold the add back (the inventory checklist, photo intake) all
 * read the same rule.
 *
 *   - **Price.** The copy's own floor (`minPriceCents`), else the owner's
 *     common price for the copy's variant (`variantCommonPrices`). Zero is a
 *     price (the drain raises it to the platform's minimum).
 *   - **Condition.** A raw copy needs one. A graded copy (a slab) lists
 *     another way (NEO-373) and needs neither here: the drain holds it back
 *     as `graded`, never as `noPrice` or `noCondition`.
 *
 * `intakeRunReadiness` adds what only photo intake asks for: a set.
 *
 * NB data only: nothing here reads a marketplace value.
 */

/** A copy's selling floor in cents: its own, else the common price; null when neither is set. */
export function listingFloorCents(
  ownPriceCents: number | null | undefined,
  commonPriceCents: number | null | undefined,
): number | null {
  return ownPriceCents ?? commonPriceCents ?? null;
}

/** A raw copy's condition is one the listing can use: any NB condition at all. */
export function hasListingCondition(condition: string | null | undefined): boolean {
  return typeof condition === "string" && condition.length > 0;
}

export interface ListingReadinessInput {
  /** The gate applies: the owner syncs AND the copy's home lists on marketplaces. */
  applies: boolean;
  /** A graded copy: never held to price or condition here. */
  graded?: boolean;
  /** The condition the copy will carry (its own, else the owner's default). */
  condition: string | null | undefined;
  /** The copy's own floor, cents. */
  ownPriceCents?: number | null;
  /** The owner's common price for the copy's variant, cents. */
  commonPriceCents: number | null | undefined;
}

export interface ListingReadiness {
  /** Nothing is missing (or the gate does not apply). */
  ready: boolean;
  needsPrice: boolean;
  needsCondition: boolean;
}

/** What a copy still needs before it may land in a listed home. */
export function listingReadiness(input: ListingReadinessInput): ListingReadiness {
  if (!input.applies || input.graded === true) {
    return { ready: true, needsPrice: false, needsCondition: false };
  }
  const needsPrice = listingFloorCents(input.ownPriceCents, input.commonPriceCents) === null;
  const needsCondition = !hasListingCondition(input.condition);
  return { ready: !needsPrice && !needsCondition, needsPrice, needsCondition };
}

export interface IntakeRunReadinessInput extends ListingReadinessInput {
  /** The run has a set to match its cards in: the collector's pick, or the open run's variant. */
  hasVariant: boolean;
}

export interface IntakeRunReadiness extends ListingReadiness {
  /** No set yet. Every new run needs one, listed or not (`intakeRuns.createIntakeRun`). */
  needsSet: boolean;
}

/**
 * NEO-452 — what an Add cards run still needs before its photos may go up. The
 * listing rule above plus a set, which every new run needs wherever it files.
 * With no set there is no common price to look up yet, so it never says a price
 * is missing: the set comes first, and the price question follows the pick.
 */
export function intakeRunReadiness(input: IntakeRunReadinessInput): IntakeRunReadiness {
  const { needsPrice, needsCondition } = listingReadiness(input);
  const needsSet = !input.hasVariant;
  const priceMissing = needsPrice && input.hasVariant;
  return {
    ready: !needsSet && !priceMissing && !needsCondition,
    needsSet,
    needsPrice: priceMissing,
    needsCondition,
  };
}
