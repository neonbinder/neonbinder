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
   * "toggleOptions" — mutually-exclusive toggle-pill group over `options`,
   *   stored as a single string in the `features` map (like "select"). By
   *   convention `options[0]` is the implicit "off" value (e.g. "None") and
   *   is never rendered as its own pill — only `options.slice(1)` render,
   *   and clicking the currently-active one again reverts to `options[0]`.
   *   Use for closed-vocabulary facets where the options are naturally
   *   exclusive toggles rather than a dropdown (e.g. Autographed's
   *   On Card/Sticker, Short Print's SP/SSP).
   */
  inputType?: "text" | "select" | "checkbox" | "boolean" | "toggleOptions";
  /** Required when inputType === "select" or "toggleOptions". */
  options?: ReadonlyArray<string>;
  /**
   * "toggleOptions" only — overrides the pill button text, index-aligned
   * with `options` (index 0 is unused since that entry never renders a
   * pill). Omit to use `options` values verbatim as button labels.
   */
  toggleLabels?: ReadonlyArray<string>;
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
  // Auto-derived from the year's era bucket at creation time (see
  // deriveSetLevelFeatures), but a plain toggle here so an operator can
  // correct the odd edge case (e.g. a reprint/throwback set) per-node.
  { key: "vintage", label: "Vintage", inputType: "checkbox" },
  // eBay "Season" — distinct from Year (matters for split-year sports like
  // Basketball/Hockey, e.g. a card documenting a 2020-21 season released in
  // a 2021 product).
  { key: "season", label: "Season" },
  // NOTE: no "manufacturer"/"cardType"/set-level "Variation" (parallelName)
  // rows — all three only ever restated information already visible in the
  // panel's own breadcrumb (manufacturer, and the leaf level itself for
  // cardType), or were a set-level default that deriveSetLevelFeatures
  // deliberately never populates for inserts/parallels (parallelName — the
  // real per-card variation name always comes from that card's own
  // `cardVariation`, edited on the card itself, not here). Removed rather
  // than hidden: nothing else reads these three as UI-editable.
  // MyCardPost + MySlabs both track short-print status as a discrete facet
  // (eBay folds it into its generic multi-select Features tag instead).
  // Auto-derived from the existing `attributes[]` harvest in
  // `deriveCardObservedFeatures` (attrs.includes("SP")/"SSP"), the same way
  // `isRookie`/`isRelic` already are — no new harvest work needed.
  {
    key: "shortPrint",
    label: "Short Print",
    inputType: "toggleOptions",
    options: ["None", "SP", "SSP"],
  },
  { key: "isReprint", label: "Reprint", inputType: "checkbox" },
  { key: "isCaseHit", label: "Case Hit", inputType: "checkbox" },

  // ---- Release metadata (formerly the separate `setMetadata` object,
  // editable ONLY at the setName level). Folded into the same feature
  // copy-down/override model as everything above so a node created later
  // (e.g. a "Panini Rewards" parallel released after the base set) can carry
  // its own value independent of its parent — a plain set-level-only field
  // can't represent that. Hidden at "card": a single card doesn't have its
  // own release date/card-count distinct from its set/parallel. ----
  { key: "releaseDate", label: "Release Date", hiddenAtLevels: ["card"] },
  {
    key: "totalCardCount",
    label: "Total Cards",
    numeric: true,
    hiddenAtLevels: ["card"],
  },
  // NOTE: no "Block" row — a manufacturer sub-release like "Series 1"/
  // "Series 2" isn't its own set (e.g. Topps Series 1 and Series 2 are both
  // just "Topps", not two separate sets), so it doesn't belong as a facet
  // here. Revisit once set data models multi-part releases properly.

  // ---- Card notable traits (from BSC harvest) ----
  {
    key: "autographed",
    label: "Autographed",
    inputType: "toggleOptions",
    options: ["None", "On Card", "Sticker/Label"],
    toggleLabels: ["None", "Auto (On Card)", "Auto (Sticker)"],
  },
  // Card-level only — a whole set/insert/parallel being signed by the same
  // single person is vanishingly rare (this describes an individual card's
  // autograph, not a set-wide fact).
  { key: "signedBy", label: "Signed By", hiddenAtLevels: ["set"] },
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

  // NOTE: no "UPC" row — a UPC is a case/box-level barcode, not a fact
  // about the set or any individual card, so it doesn't belong here.
];
