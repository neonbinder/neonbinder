/**
 * NEO-96 — bootstrap defaults for a sport-level `selectorOptions` row's
 * `sportConfig`.
 *
 * WHAT CHANGED AND WHY
 * Five module-level maps used to be consulted AT RUNTIME, each keyed by the
 * sport's DISPLAY NAME, and each with its own casing convention:
 *
 *   SPORT_QIDS            (adapters/wikidata.ts)          keyed "baseball"
 *   HOF_QIDS              (adapters/wikidata.ts)          keyed "baseball"
 *   SPORT_TO_ESPN_LEAGUE  (adapters/espn.ts)              keyed "Baseball"
 *   SPORT_SKU_CODE        (sku.ts)                        keyed "Baseball"
 *   SPORT_TO_LEAGUE       (features/deriveCardFeatures.ts) keyed "Baseball"
 *
 * That coupled behaviour to a display string, with two consequences. First,
 * the casing split: `commitCardChecklist` was handed `fetchCardChecklist`'s
 * lowercased `"baseball"` (a BSC wire format that had leaked out of the adapter
 * layer) while `addCustomCard` used the raw `"Baseball"`, so the SAME set
 * produced two different SKU prefixes — `NB-BA-…` from the miss-and-slugify
 * path versus `NB-BB-…` from the hit. Second, renaming a sport would silently
 * break SKU generation and all enrichment, with no error — which is why
 * `selectorOptions.value` had no rename path at all.
 *
 * These are now DEFAULTS, applied once when a sport row is created
 * (`storeSelectorOptions`), and thereafter the row owns its config. Renaming a
 * sport can no longer affect SKUs or enrichment, because nothing looks anything
 * up by name any more.
 *
 * NOT marketplace wire formats. Those live in `platformData.bsc` /
 * `platformData.sportlots` ("baseball" / "BB") and are resolved at the adapter
 * boundary — see `resolveSportLotsPlatformValue` in adapters/sportlots.ts.
 * Nothing here should ever be sent to a marketplace, and nothing a marketplace
 * returns should ever be stored on a domain entity.
 *
 * A sport with no entry (any custom sport, or a real one we haven't mapped)
 * gets no config and degrades explicitly: `generateSku` falls back to its
 * slugify path, and Wikidata/ESPN enrichment is skipped rather than guessed.
 */

export interface SportConfig {
  /** 2-char NeonBinder SKU prefix, e.g. "BB". */
  skuCode?: string;
  /** e.g. "MLB". Feeds the `league` card feature. */
  league?: string;
  /** ESPN site-API URL segments + the league's full display name. */
  espn?: { path: string; leagueName: string };
  wikidata?: {
    /** Wikidata sport QID, used in the `wdt:P641` SPARQL filter. */
    sportQid: string;
    /** A P166 (award received) match on this QID flips isHallOfFame true. */
    hallOfFameQid?: string;
  };
}

/**
 * Keyed by the sport's display value as the marketplaces present it at sync
 * time. Matching is case-insensitive (see `sportConfigDefaultsFor`) so a
 * marketplace returning "BASEBALL" still resolves — the key casing here is
 * presentational only, and is NOT relied on for correctness the way the old
 * runtime maps were.
 *
 * Sports without a single canonical Hall of Fame (e.g. soccer) intentionally
 * omit `hallOfFameQid`: those players ship with `isHallOfFame` undefined rather
 * than misleadingly false.
 */
const SPORT_CONFIG_DEFAULTS: Record<string, SportConfig> = {
  baseball: {
    skuCode: "BB",
    league: "MLB",
    espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
    wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
  },
  football: {
    skuCode: "FB",
    league: "NFL",
    espn: { path: "football/nfl", leagueName: "National Football League" },
    // Q41323 = American football (our domain — no soccer cards).
    wikidata: { sportQid: "Q41323", hallOfFameQid: "Q1382553" },
  },
  basketball: {
    skuCode: "BK",
    league: "NBA",
    espn: { path: "basketball/nba", leagueName: "National Basketball Association" },
    wikidata: { sportQid: "Q5372", hallOfFameQid: "Q635155" },
  },
  hockey: {
    skuCode: "HK",
    league: "NHL",
    espn: { path: "hockey/nhl", leagueName: "National Hockey League" },
    // Q41466 = ice hockey.
    wikidata: { sportQid: "Q41466", hallOfFameQid: "Q579974" },
  },
};

/**
 * The bootstrap config for a sport display value, or undefined when we have no
 * mapping. Callers must treat undefined as "degrade gracefully", never as an
 * error — a custom sport is a legitimate, supported thing.
 */
export function sportConfigDefaultsFor(value: string): SportConfig | undefined {
  return SPORT_CONFIG_DEFAULTS[value.toLowerCase().trim()];
}

/** The display values we ship defaults for. Exposed for tests. */
export const CONFIGURED_SPORT_KEYS: ReadonlyArray<string> =
  Object.keys(SPORT_CONFIG_DEFAULTS);
