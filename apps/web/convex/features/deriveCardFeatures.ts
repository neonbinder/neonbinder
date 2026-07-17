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

export const SPORT_TO_LEAGUE: Record<string, string> = {
  Baseball: "MLB",
  Basketball: "NBA",
  Football: "NFL",
  Hockey: "NHL",
};

/** Selectable options for the League feature (NEO-72). */
export const LEAGUE_OPTIONS: ReadonlyArray<string> = Object.values(SPORT_TO_LEAGUE);

/**
 * eBay-standard "Era" item-specific buckets, named so the Era select
 * (NEO-73) and `eraForYear` can never drift apart.
 */
export const ERA_BUCKETS = {
  PRE_WWII: "Pre-WWII (Pre-1942)",
  POST_WWII: "Post-WWII (1942-69)",
  VINTAGE: "Vintage (1970-79)",
  MODERN: "Modern (1980-Now)",
} as const;

/** Selectable options for the Era feature (NEO-73). */
export const ERA_BUCKET_OPTIONS: ReadonlyArray<string> = Object.values(ERA_BUCKETS);

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
  if (year <= 1941) return ERA_BUCKETS.PRE_WWII;
  if (year <= 1969) return ERA_BUCKETS.POST_WWII;
  if (year <= 1979) return ERA_BUCKETS.VINTAGE;
  return ERA_BUCKETS.MODERN;
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
 * individual card): league, era, vintage, season, manufacturer, cardType,
 * isReprint, autographed, cardSize, cardMaterial, language.
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
    f.vintage = eraForYear(yearNum) !== ERA_BUCKETS.MODERN ? "true" : "false";
  }

  // Season — eBay's Season aspect is usually just the Year label verbatim;
  // an operator overrides it for split-year sports (e.g. year "2021" but
  // season "2020-21"). Mirrors whatever string the year node carries, valid
  // 4-digit year or not.
  if (inputs.year) f.season = inputs.year;

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
    // Parallel/Variety — a base card (no insert/parallel) has no special
    // variant, so default it to "Base" too. Inserts/Parallels intentionally
    // do NOT get a generic "Insert"/"Parallel" default here — their real
    // parallel name (e.g. "Gold Refractor") comes from the card's own
    // observed cardVariation (deriveCardObservedFeatures), which is
    // specific harvest data a generic string would only misrepresent.
    f.parallelName = "Base";
  }

  // Reprint — default false; our pipeline has no reprint signal yet, and an
  // operator can flip it per-set/per-card.
  f.isReprint = "false";

  // Autographed — default "None"; most cards are not autographed, and an
  // operator (or a future marketplace signal) can flip it per-set/per-card.
  f.autographed = "None";

  // Card Size / Material / Thickness / Language / Country of Origin —
  // default to the overwhelming majority case for the sports cards NB
  // catalogs today; an operator flips these per-set for the rare oddball
  // (minis, acetate/metal parallels, a foreign-language or foreign-printed
  // release), same "default the common case, override the exception"
  // pattern as isReprint/autographed above. Country of Origin has no other
  // signal to derive from yet (no manufacturer->country mapping is reliable
  // enough to encode) — "USA" is the fallback until a better source exists.
  f.cardSize = "Standard";
  f.cardMaterial = "Card Stock";
  f.cardThickness = "20pt";
  f.language = "English";
  f.countryOfOrigin = "USA";

  return f;
}

const LEVEL_HEURISTIC_KEYS: Partial<Record<string, string[]>> = {
  sport: ["league"],
  year: ["era", "vintage", "season"],
  manufacturer: ["manufacturer"],
  // variantType (Base) also gets a "Base" parallelName default — see
  // deriveSetLevelFeatures. insert/parallel intentionally do NOT list
  // parallelName: deriveSetLevelFeatures never sets it for those levels
  // (their real value is card-observed, not a node-level default).
  variantType: ["cardType", "parallelName"],
  insert: ["cardType"],
  parallel: ["cardType"],
  setName: [
    "isReprint",
    "autographed",
    "cardSize",
    "cardMaterial",
    "cardThickness",
    "language",
    "countryOfOrigin",
  ],
};

/**
 * Own-level heuristic contribution for a single selectorOptions node, keyed
 * by the node's OWN level/value — never an ancestor or descendant. Callers
 * merge this on top of the immediate parent's `features` (copy-down) to
 * produce the new row's complete resolved snapshot, once, at creation time
 * (NEO-71-74: write-once feature snapshots — see convex/selectorOptions.ts).
 *
 * `deriveSetLevelFeatures` unconditionally returns `isReprint: "false"`,
 * `autographed: "None"`, `cardSize: "Standard"`, `cardMaterial: "Card Stock"`,
 * `cardThickness: "20pt"`, `language: "English"`, and
 * `countryOfOrigin: "USA"` on every call regardless of input, so a naive
 * per-level reuse would leak them onto every level — `LEVEL_HEURISTIC_KEYS`
 * filters each level down to only the key(s) it actually owns.
 */
export function deriveOwnLevelFeatures(
  level: string,
  value: string,
  metadata?: { isInsert?: boolean; isParallel?: boolean },
): Record<string, string> {
  const keys = LEVEL_HEURISTIC_KEYS[level];
  if (!keys) return {};
  const full = deriveSetLevelFeatures({
    sport: level === "sport" ? value : undefined,
    year: level === "year" ? value : undefined,
    manufacturer: level === "manufacturer" ? value : undefined,
    leafLevel: level,
    leafIsInsert: metadata?.isInsert,
    leafIsParallel: metadata?.isParallel,
  });
  const picked: Record<string, string> = {};
  for (const key of keys) {
    if (full[key] !== undefined) picked[key] = full[key];
  }
  return picked;
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
  if (attrs.includes("SSP")) f.shortPrint = "SSP";
  else if (attrs.includes("SP")) f.shortPrint = "SP";
  if (card.autographType && card.autographType.trim()) {
    // Map the marketplace-observed autograph type to the `autographed`
    // select's closed vocabulary (None/On Card/Sticker/Label) — this used to
    // set `signedBy` directly to the raw autographType string ("On-Card"),
    // which is the auto FORMAT, not a signer's name. `signedBy` is now
    // populated separately from the card's actual playerIds, matching the
    // same "autographed just became non-None -> default signedBy from the
    // roster" rule the setCardFeature mutation applies for manual edits.
    const t = card.autographType.trim().toLowerCase();
    f.autographed = t.includes("sticker") ? "Sticker/Label" : "On Card";
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

/**
 * Server-side guard for the constrained select-type features (NEO-72/73):
 * rejects an era write that doesn't match the fixed bucket set, in case a
 * caller bypasses the `<select>` UI. No-op for every other feature key.
 *
 * NOT applied to "league": unlike era's closed 4-bucket taxonomy, league is
 * open-ended in the real world (NPB, KBO, CPBL, minor-league systems, etc.).
 * `LEAGUE_OPTIONS` covers only the 4 primary US leagues for the frontend
 * `<select>`'s common case; an operator overriding league via
 * `setSelectorOptionFeature` for an international/niche set (e.g. "NPB" for
 * a Japanese release — a pre-existing, tested capability predating this
 * guard) legitimately needs values outside that list. Hard-rejecting here
 * would silently break real product functionality, not just a bypassed UI.
 */
export function validateFeatureValue(key: string, value: string): void {
  if (key === "era" && !ERA_BUCKET_OPTIONS.includes(value)) {
    throw new Error(`Invalid era value: ${value}`);
  }
  if (key === "totalCardCount" && value !== "" && !/^\d+$/.test(value)) {
    throw new Error(`Invalid totalCardCount value: ${value}`);
  }
}
