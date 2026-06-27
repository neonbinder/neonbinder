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

export type ExpectedFeature = {
  key: string;
  label: string;
  /**
   * When present, restricts applicability to the named sports. The UI uses
   * this to hide irrelevant rows (e.g. "League" doesn't apply to Pokemon).
   * Sport values match `selectorOptions.level="sport"` row `value`s.
   */
  applicableSports?: ReadonlyArray<string>;
};

export const EXPECTED_FEATURES: ReadonlyArray<ExpectedFeature> = [
  // ---- Marketplace facets (primary) ----
  {
    key: "league",
    label: "League",
    applicableSports: ["Baseball", "Basketball", "Football", "Hockey"],
  },
  { key: "era", label: "Era" },
  { key: "isReprint", label: "Reprint" },
  { key: "cardType", label: "Card Type" },

  // ---- Card attributes (from BSC harvest) ----
  { key: "signedBy", label: "Signed By" },
  { key: "isRookie", label: "Rookie Card" },
  { key: "isRelic", label: "Memorabilia Relic" },
  { key: "parallelName", label: "Parallel/Variety" },

  // ---- Set-level context ----
  { key: "vintage", label: "Vintage" },
  { key: "manufacturer", label: "Manufacturer" },
];
