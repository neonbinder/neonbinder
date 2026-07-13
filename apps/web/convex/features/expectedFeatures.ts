/**
 * NEO-24: hardcoded list of marketplace-listing feature keys we expect to
 * populate at the set or card level. Drives:
 *
 *  - `SetFeaturesPanel` (Stage 4) — highlights missing keys per set
 *  - Stage 5 marketplace test flows that fail-loudly when a required
 *    facet is unset
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
   * "boolean" — checkbox bound to a typed schema column (`boundColumn`),
   *   NOT the `features` map.
   * "derived" — read-only computed value; not editable anywhere, sourced
   *   from whatever the derivation pipeline already wrote into `features`.
   */
  inputType?: "text" | "select" | "boolean" | "derived";
  /** Required when inputType === "select". */
  options?: ReadonlyArray<string>;
  /**
   * Required when inputType === "boolean". Names the typed schema column
   * this checkbox reads/writes directly, bypassing the `features` map.
   */
  boundColumn?: "isRookie";
  /** Levels at which this row shouldn't render at all (no typed target / not meaningful there). */
  hiddenAtLevels?: ReadonlyArray<"card" | "set">;
  /**
   * Restricts a "set"-side row to specific selectorOptions levels within
   * SetAttributesPanel, instead of every non-card level. Only needed for
   * features that are level-SPECIFIC within the set hierarchy (e.g.
   * `cardType`/`parallelName` only ever derive at variantType/insert/
   * parallel — showing them as "missing" at sport/year/manufacturer/setName
   * is misleading, since they simply don't apply there). Omit for features
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
  { key: "isReprint", label: "Reprint" },
  {
    key: "cardType",
    label: "Card Type",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },

  // ---- Card attributes (from BSC harvest) ----
  { key: "signedBy", label: "Signed By" },
  {
    key: "isRookie",
    label: "Rookie Card",
    inputType: "boolean",
    boundColumn: "isRookie",
    hiddenAtLevels: ["set"],
  },
  { key: "isRelic", label: "Memorabilia Relic" },
  {
    key: "parallelName",
    label: "Parallel/Variety",
    applicableAtLevels: ["variantType", "insert", "parallel"],
  },

  // ---- Set-level context ----
  { key: "vintage", label: "Vintage", inputType: "derived" },
  { key: "manufacturer", label: "Manufacturer" },
];
