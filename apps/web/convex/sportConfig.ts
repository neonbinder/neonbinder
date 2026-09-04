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
    /**
     * The sport's Hall of Fame, as a Wikidata entity.
     *
     * NEO-235: a match on this QID via ANY of `adapters/wikidata.ts`'s
     * `HALL_OF_FAME_STRATEGIES` — P166 "award received" or P463 "member of" —
     * flips `isHallOfFame` true. It used to be P166 only, which is why the
     * doc here used to name that property; the shape varies by sport and by
     * editor, so the property list lives with the strategies now rather than
     * being implied by this field's name.
     *
     * MUST be the INSTITUTION's QID (Q809892 "National Baseball Hall of Fame
     * and Museum"), because that is the entity both properties point at.
     */
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
 *
 * ## NEO-235: the four `hallOfFameQid` values were all wrong
 *
 * Every one of them resolved to an unrelated Wikidata entity, verified live on
 * 2026-09-04:
 *
 *   baseball    Q1194380 → "Grochów", a village in Poland
 *   football    Q1382553 → "Leistus spinibarbis", a species of beetle
 *   basketball  Q635155  → "creator deity"
 *   hockey      Q579974  → "Dušan Marković", a Serbian footballer (1906-1974)
 *
 * So `isHallOfFame` could never be true for anybody, in any sport, however the
 * induction was recorded — the P166-only detection this ticket widens was the
 * SECOND defect, not the first. The values below are the real institutions,
 * each confirmed against the statements of a known inductee (Gwynn/Ruth/
 * Griffey, Jerry Rice, Wayne Gretzky).
 *
 * These are DEFAULTS applied at sport-row creation, and the backfill in
 * `storeSelectorOptions` only fires when a row has NO `sportConfig` at all.
 * A deployment whose sport rows were created before this fix still carries the
 * wrong QIDs on the row, and correcting the constants here does not reach
 * them — see the NEO-235 notes on the branch.
 */
const SPORT_CONFIG_DEFAULTS: Record<string, SportConfig> = {
  baseball: {
    skuCode: "BB",
    league: "MLB",
    espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
    // Q809892 = National Baseball Hall of Fame and Museum, Cooperstown.
    wikidata: { sportQid: "Q5369", hallOfFameQid: "Q809892" },
  },
  football: {
    skuCode: "FB",
    league: "NFL",
    espn: { path: "football/nfl", leagueName: "National Football League" },
    // Q41323 = American football (our domain — no soccer cards).
    // Q778412 = Pro Football Hall of Fame, Canton.
    wikidata: { sportQid: "Q41323", hallOfFameQid: "Q778412" },
  },
  basketball: {
    skuCode: "BK",
    league: "NBA",
    espn: { path: "basketball/nba", leagueName: "National Basketball Association" },
    // Q290922 = Naismith Memorial Basketball Hall of Fame, Springfield.
    wikidata: { sportQid: "Q5372", hallOfFameQid: "Q290922" },
  },
  hockey: {
    skuCode: "HK",
    league: "NHL",
    espn: { path: "hockey/nhl", leagueName: "National Hockey League" },
    // Q41466 = ice hockey.
    // Q1136687 = Hockey Hall of Fame, Toronto.
    wikidata: { sportQid: "Q41466", hallOfFameQid: "Q1136687" },
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
