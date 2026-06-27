/**
 * NEO-25: auto-derive marketplace feature values from data we already know —
 * the card's ancestor chain (sport / year / manufacturer / variant level) and
 * the card's own attribute columns — so a freshly-synced card isn't blank in
 * the features panel.
 *
 * These are DEFAULTS. Precedence when merging at card-creation time is:
 *
 *   set-level defaults  <  operator-set ancestor features (inherited)  <  card-observed facts
 *
 * i.e. an operator's explicit set-level value (selectorOptions.features) wins
 * over our derived guess, and a fact observed on the card (it carries an RC
 * attribute → Rookie Card) wins over both. Per-card operator overrides
 * (setCardFeature) continue to win over everything, unchanged.
 *
 * Feature keys mirror `EXPECTED_FEATURES` in ./expectedFeatures.ts.
 */

const SPORT_TO_LEAGUE: Record<string, string> = {
  Baseball: "MLB",
  Basketball: "NBA",
  Football: "NFL",
  Hockey: "NHL",
};

export type SetLevelFeatureInputs = {
  /** Sport-level value, e.g. "Baseball". */
  sport?: string;
  /** Year-level value, e.g. "2024" or a season like "2023-24". */
  year?: string;
  /** Manufacturer-level value, e.g. "Topps". */
  manufacturer?: string;
  /** `level` of the leaf selectorOption the card lives under. */
  leafLevel?: string;
  /** leaf `metadata.isInsert` / `metadata.isParallel` (when set). */
  leafIsInsert?: boolean;
  leafIsParallel?: boolean;
};

export type CardObservedInputs = {
  isRookie?: boolean;
  isRelic?: boolean;
  autographType?: string;
  cardVariation?: string;
  /** Fallback when typed booleans are absent (e.g. legacy custom cards). */
  attributes?: ReadonlyArray<string>;
};

/**
 * Map a 4-digit year to eBay's standard "Era" item-specific bucket.
 * (NEO-25 product decision — eBay-standard buckets.)
 */
export function eraForYear(year: number): string {
  if (year <= 1941) return "Pre-WWII (Pre-1942)";
  if (year <= 1969) return "Post-WWII (1942-69)";
  if (year <= 1979) return "Vintage (1970-79)";
  return "Modern (1980-Now)";
}

/** Parse a leading 4-digit year out of a year/season string ("2023-24" → 2023). */
function parseYear(year: string | undefined): number | null {
  if (!year) return null;
  const m = year.match(/\d{4}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n > 1000 && n < 3000 ? n : null;
}

/**
 * Features derivable from the set hierarchy alone (independent of the
 * individual card): league, era, vintage, manufacturer, cardType, isReprint.
 */
export function deriveSetLevelFeatures(
  inputs: SetLevelFeatureInputs,
): Record<string, string> {
  const f: Record<string, string> = {};

  // League — only for the four stick-and-ball sports (matches
  // EXPECTED_FEATURES.applicableSports). Other sports get no league.
  if (inputs.sport && SPORT_TO_LEAGUE[inputs.sport]) {
    f.league = SPORT_TO_LEAGUE[inputs.sport];
  }

  // Era + Vintage — from the 4-digit year.
  const yearNum = parseYear(inputs.year);
  if (yearNum !== null) {
    f.era = eraForYear(yearNum);
    f.vintage = yearNum <= 1979 ? "true" : "false";
  }

  // Manufacturer — straight from the ancestor row.
  const mfr = inputs.manufacturer?.trim();
  if (mfr) f.manufacturer = mfr;

  // Card Type — from the leaf variant level.
  if (inputs.leafLevel === "parallel" || inputs.leafIsParallel) {
    f.cardType = "Parallel";
  } else if (inputs.leafLevel === "insert" || inputs.leafIsInsert) {
    f.cardType = "Insert";
  } else if (inputs.leafLevel === "variantType") {
    f.cardType = "Base";
  }

  // Reprint — default false; our pipeline has no reprint signal yet, and an
  // operator can flip it per-set/per-card.
  f.isReprint = "false";

  return f;
}

/**
 * Features observed on the specific card. These reflect what the BSC/SL
 * adapter actually saw (or the typed columns on a custom card) and win over
 * inherited set-level values.
 */
export function deriveCardObservedFeatures(
  card: CardObservedInputs,
): Record<string, string> {
  const f: Record<string, string> = {};
  const attrs = card.attributes ?? [];
  if (card.isRookie || attrs.includes("RC")) f.isRookie = "true";
  if (card.isRelic || attrs.includes("RELIC")) f.isRelic = "true";
  if (card.autographType && card.autographType.trim()) {
    // We don't know the signer name at this layer, so we record the autograph
    // *type* as the value; downstream treats any non-empty value as a positive
    // "signed" signal.
    f.signedBy = card.autographType.trim();
  }
  if (card.cardVariation && card.cardVariation.trim()) {
    f.parallelName = card.cardVariation.trim();
  }
  return f;
}

/**
 * Gap-fill helper for the one-time backfill of existing rows: compute every
 * auto-derivable feature, then let the card's EXISTING values win (so operator
 * overrides and already-derived keys are never clobbered).
 */
export function deriveBackfillFeatures(
  setInputs: SetLevelFeatureInputs,
  cardInputs: CardObservedInputs,
  existing: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...deriveSetLevelFeatures(setInputs),
    ...deriveCardObservedFeatures(cardInputs),
    ...(existing ?? {}),
  };
}
