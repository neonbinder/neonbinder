/**
 * NEO-24: hardcoded list of marketplace-listing feature keys we surface at
 * the set or card level. None of these are actually required — blank is a
 * perfectly acceptable, complete answer for most of them, so there is no
 * "missing"/required warning treatment anywhere this list is rendered.
 *
 * Each entry is purely metadata; the actual storage is the free-form
 * `Record<string, string>` on `selectorOptions.features` and
 * `cardChecklist.features` in `schema.ts`. New keys land as PRs to this
 * file — no schema migration required.
 *
 * Initial list seeded from `docs/marketplace-listings.md` section 8.
 */

import { LEAGUE_OPTIONS, ERA_BUCKET_OPTIONS } from "./deriveCardFeatures";

export type ExpectedFeature = {
  key: string;
  label: string;
  /**
   * When present, restricts applicability to the named sports. The UI uses
   * this to hide irrelevant rows (e.g. "League" doesn't apply to Pokemon).
   * Sport values match `selectorOptions.level="sport"` row `value`s.
   */
  applicableSports?: ReadonlyArray<string>;
  /**
   * "text" (default when omitted) — free-form string, stored in the
   *   `features` map, same as today.
   * "select" — dropdown constrained to `options`; still stored in the
   *   `features` map, same shape as text.
   * "checkbox" — true/false checkbox stored as the strings "true"/"false" in
   *   the `features` map (like text/select — NOT a typed schema column).
   *   Unchecked/missing is a complete, valid answer, not a "missing" state.
   * "boolean" — checkbox bound to a typed schema column (`boundColumn`),
   *   NOT the `features` map. Reserved for card-level facets that need a
   *   real queryable column (e.g. `isRookie`); use "checkbox" instead for
   *   any new true/false facet that doesn't need one.
   * "derived" — read-only computed value; not editable anywhere, sourced
   *   from whatever the derivation pipeline already wrote into `features`.
   */
  inputType?: "text" | "select" | "checkbox" | "boolean" | "derived";
  /** Required when inputType === "select". */
  options?: ReadonlyArray<string>;
  /**
   * Required when inputType === "boolean". Names the typed schema column
   * this checkbox reads/writes directly, bypassing the `features` map.
   */
  boundColumn?: "isRookie";
  /** Hints the UI to use a numeric input mode. Value is still stored/edited as a string. */
  numeric?: boolean;
  /** Optional tooltip explaining what belongs in this field (shown on hover over the label). */
  hint?: string;
  /** Levels at which this row shouldn't render at all (no typed target / not meaningful there). */
  hiddenAtLevels?: ReadonlyArray<"card" | "set">;
  /**
   * Restricts a "set"-side row to specific selectorOptions levels within
   * SetAttributesPanel, instead of every non-card level. Only needed for
   * features that are level-SPECIFIC within the set hierarchy (e.g.
   * `cardType`/`parallelName` only ever derive at variantType/insert/
   * parallel — rendering them at sport/year/manufacturer/setName would be
   * misleading, since they simply don't apply there). Omit for features
   * that apply at every set-side level (e.g. `league`, `era`).
   */
  applicableAtLevels?: ReadonlyArray<
    | "sport"
    | "year"
    | "manufacturer"
    | "setName"
    | "variantType"
    | "insert"
    | "parallel"
  >;
};

export const EXPECTED_FEATURES: ReadonlyArray<ExpectedFeature> = [
  // ---- Classification (what is this card) ----
  {
    key: "league",
    label: "League",
    applicableSports: ["Baseball", "Basketball", "Football", "Hockey"],
    inputType: "select",
    options: LEAGUE_OPTIONS,
  },
  { key: "era", label: "Era", inputType: "select", options: ERA_BUCKET_OPTIONS },
  { key: "vintage", label: "Vintage", inputType: "derived" },
  // eBay "Season" — distinct from Year (matters for split-year sports like
  // Basketball/Hockey, e.g. a card documenting a 2020-21 season released in
  // a 2021 product).
  { key: "season", label: "Season" },
  { key: "manufacturer", label: "Manufacturer" },
  {
    key: "cardType",
    label: "Card Type",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },
  {
    key: "parallelName",
    label: "Parallel/Variety",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },
  // MyCardPost + MySlabs both track short-print status as a discrete facet
  // (eBay folds it into its generic multi-select Features tag instead).
  // Auto-derived from the existing `attributes[]` harvest in
  // `deriveCardObservedFeatures` (attrs.includes("SP")/"SSP"), the same way
  // `isRookie`/`isRelic` already are — no new harvest work needed.
  {
    key: "shortPrint",
    label: "Short Print",
    inputType: "select",
    options: ["None", "SP", "SSP"],
  },
  { key: "isReprint", label: "Reprint", inputType: "checkbox" },

  // ---- Release metadata (formerly the separate `setMetadata` object,
  // editable ONLY at the setName level). Folded into the same feature
  // copy-down/override model as everything above so a node created later
  // (e.g. a "Panini Rewards" parallel released after the base set) can carry
  // its own value independent of its parent — a plain set-level-only field
  // can't represent that. Hidden at "card": a single card doesn't have its
  // own release date/block/card-count distinct from its set/parallel. ----
  { key: "releaseDate", label: "Release Date", hiddenAtLevels: ["card"] },
  {
    key: "totalCardCount",
    label: "Total Cards",
    numeric: true,
    hiddenAtLevels: ["card"],
  },
  {
    key: "block",
    label: "Block",
    hint: "Manufacturer sub-release within the set, e.g. Series 1, Series 2, Update",
    hiddenAtLevels: ["card"],
  },

  // ---- Card notable traits (from BSC harvest) ----
  {
    key: "autographed",
    label: "Autographed",
    inputType: "select",
    options: ["None", "On Card", "Sticker/Label"],
  },
  { key: "signedBy", label: "Signed By" },
  {
    key: "isRookie",
    label: "Rookie Card",
    inputType: "boolean",
    boundColumn: "isRookie",
    hiddenAtLevels: ["set"],
  },
  // MySlabs distinguishes Prospect explicitly from Rookie; no existing BSC
  // signal reliably means "prospect", so this is a genuine manual-entry gap.
  { key: "isProspect", label: "Prospect Card", inputType: "checkbox" },
  { key: "isRelic", label: "Memorabilia Relic", inputType: "checkbox" },

  // ---- Physical/production details (eBay item specifics; typically
  // constant per manufacturer/set, so usually entered once and copied down
  // rather than needing per-card entry). ----
  { key: "countryOfOrigin", label: "Country of Origin" },
  { key: "cardSize", label: "Card Size" },
  { key: "cardMaterial", label: "Material" },
  { key: "cardThickness", label: "Card Thickness" },
  { key: "language", label: "Language" },

  // ---- Special distribution context — eBay's two distinct aspects, kept
  // separate to match eBay's own schema (both can appear on the same
  // listing, e.g. a convention-exclusive card commemorating an event). ----
  { key: "eventTournament", label: "Event/Tournament" },
  { key: "conventionEvent", label: "Convention/Event" },

  // ---- Rare / edge case — no sports card in NB's catalog has ever carried
  // a UPC (it's a case/box-level barcode, not a per-card fact), but kept as
  // a just-in-case field. Bottom of the form since it's virtually always
  // blank. (Originally slated to come from `setMetadata.tcdbSetId` per
  // docs/marketplace-listings.md — that never shipped since TCDB is
  // Cloudflare-blocked — this gives it a direct home independent of that.) ----
  { key: "upc", label: "UPC" },
];
