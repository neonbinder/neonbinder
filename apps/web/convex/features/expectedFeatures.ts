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
  // ---- Marketplace facets (primary) ----
  {
    key: "league",
    label: "League",
    applicableSports: ["Baseball", "Basketball", "Football", "Hockey"],
    inputType: "select",
    options: LEAGUE_OPTIONS,
  },
  { key: "era", label: "Era", inputType: "select", options: ERA_BUCKET_OPTIONS },
  { key: "isReprint", label: "Reprint", inputType: "checkbox" },
  {
    key: "cardType",
    label: "Card Type",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },

  // ---- Card attributes (from BSC harvest) ----
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
  { key: "isRelic", label: "Memorabilia Relic", inputType: "checkbox" },
  {
    key: "parallelName",
    label: "Parallel/Variety",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },

  // ---- Set-level context ----
  { key: "vintage", label: "Vintage", inputType: "derived" },
  { key: "manufacturer", label: "Manufacturer" },

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
];
