/**
 * NEO-339 — the Base mapping decisions, as plain functions.
 *
 * Moved out of `BaseSetPicker` (the scoring and pre-select rules) and
 * `BaseMappingForm` (the set-listing candidate and the write) with no change in
 * behaviour, so the dialog and the set-building tool (`tools/setbuild/`) rank
 * the same candidates, pre-select the same one, and send the same
 * `setVariantTypePlatformData` arguments. The dialog keeps the rendering and
 * the keyboard model, and re-exports the scoring so existing imports work.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";
import { slotIds, type SlotBearingRow } from "../../convex/platformSlots";
import {
  duplicateNames,
  itemLabel,
} from "../../components/SetSelector/marketplace-item-label";
import type { PlatformItem } from "./reconcile";

/**
 * An EXACT match on the set's own name, or on the set name with the
 * manufacturer prefix stripped. These two are the only scores this dialog
 * pre-selects from — see `preselectScore`.
 */
export const EXACT_SET_NAME_SCORE = 1000;
export const PREFIX_STRIPPED_SCORE = 950;

/**
 * A bare manufacturer row ("Topps" under set "Topps Chrome").
 *
 * NEO-219 decision 7: this used to score 1000 — the SAME tier as an exact set
 * name — which made "Topps" outrank "Topps Chrome" whenever the sort was
 * stable-by-input-order, and auto-selected the brand's catch-all row as a set's
 * base. A brand name is the weakest real signal here, not the strongest: it is
 * demoted BELOW the generic "Base"/"Base Set" rows, which at least claim to be
 * a base set.
 */
export const EXACT_MANUFACTURER_SCORE = 600;

/**
 * At or above this score a row shows the "likely match" pill.
 *
 * Deliberately LOWER than the pre-select threshold, and unchanged from before
 * NEO-219: the generic "Base" / "Base Set" rows still say "likely match"
 * (`.maestro/flows/set-selector/sets-base.yaml` asserts the pill), they are
 * just no longer pre-selected on the operator's behalf.
 */
export const LIKELY_MATCH_SCORE = 795;

/**
 * The one rule for "safe to pre-select".
 *
 * Pre-selection is a claim that a human need not look. Only an exact name match
 * earns that: everything below 950 is a guess, and a guess that is pre-selected
 * gets confirmed by reflex. Exported (with `scoreBaseSetMatch`) so the scoring
 * table can be tested without rendering the dialog.
 */
export function preselectScore(score: number): boolean {
  return score >= PREFIX_STRIPPED_SCORE;
}

/**
 * NEO-325 — the candidate to pre-select, or `null`: the ONE candidate whose
 * score clears `preselectScore`, and only when it is the only one.
 *
 * SportLots lists distinct sets under one name, so two rows can both be an
 * exact match for the set. Picking the first of them would be a guess wearing
 * a pre-selection, and Enter would link it. Two or more exact matches select
 * nothing; the operator chooses (CLAUDE.md invariant 7, exactly-one-match).
 * The same holds for one exact and one prefix-stripped exact match: both
 * clear the bar, so neither is "the" match. Exported so the rule can be
 * tested without rendering the dialog.
 */
export function soleExactMatch<T>(
  candidates: readonly T[],
  scoreOf: (candidate: T) => number | null,
): T | null {
  let found: T | null = null;
  for (const candidate of candidates) {
    const score = scoreOf(candidate);
    if (score === null || !preselectScore(score)) continue;
    if (found !== null) return null;
    found = candidate;
  }
  return found;
}

// Returns a score indicating how likely `slValue` is the base set.
// Tiers (higher = more likely):
//   1000 — exact match on the set name
//    950 — exact match on the set name with the manufacturer prefix stripped
//    900-885 — "<setName> Base Set" / "<setName> Base"
//    800/795 — trailing "Base Set" / "Base" (generic base row)
//    600 — exact match on the MANUFACTURER (NEO-219: below generic)
//    <600 — weaker fuzzy signals
export function scoreBaseSetMatch(
  slValue: string,
  setName: string,
  manufacturer: string,
): number {
  const norm = slValue.toLowerCase().trim();
  const setNorm = setName.toLowerCase().trim();
  const mfgNorm = manufacturer.toLowerCase().trim();

  // Tier 1: exact match on set name
  if (setNorm && norm === setNorm) return EXACT_SET_NAME_SCORE;

  // Tier 2: exact match on set name with manufacturer prefix stripped
  // (e.g., setName "Topps Opening Day", mfg "Topps" → match "Opening Day")
  const stripped =
    mfgNorm && setNorm.startsWith(`${mfgNorm} `)
      ? setNorm.slice(mfgNorm.length + 1).trim()
      : "";
  if (stripped && norm === stripped) return PREFIX_STRIPPED_SCORE;

  // Tier 3: set name + "Base Set"/"Base" appended
  if (setNorm) {
    if (norm === `${setNorm} base set`) return 900;
    if (norm === `${setNorm} base`) return 895;
  }
  if (stripped) {
    if (norm === `${stripped} base set`) return 890;
    if (norm === `${stripped} base`) return 885;
  }

  // Tier 4: generic "Base Set" / "Base" row
  if (norm === "base set") return 800;
  if (norm === "base") return LIKELY_MATCH_SCORE;

  // Tier 5 (NEO-219): a bare manufacturer row. Below every tier above.
  if (mfgNorm && norm === mfgNorm) return EXACT_MANUFACTURER_SCORE;

  // Weaker fuzzy signals below
  if (setNorm && norm.startsWith(setNorm)) {
    const suffix = norm.slice(setNorm.length).trim();
    return 500 - suffix.length;
  }
  if (setNorm && norm.includes(setNorm)) return 300;

  return 0;
}

/** One row in either list, already scored and labelled. */
export type Candidate = {
  /** Stable identity for selection state — the set listing needs its own. */
  key: string;
  item: PlatformItem;
  /** Visible row text. */
  label: string;
  /** `null` for the set-listing row, which is never scored (see below). */
  score: number | null;
  isSetListing: boolean;
};

/** A SportLots option with its score, as the dialog sorts them. */
export type ScoredSlOption = PlatformItem & { score: number };

/**
 * The SportLots options, scored and sorted best first. Moved from the dialog's
 * `sortedSlOptions` (which still returns nothing for a paused side itself).
 */
export function rankSlBaseOptions(
  slOptions: readonly PlatformItem[],
  setName: string,
  manufacturer: string,
): ScoredSlOption[] {
  const scored = slOptions.map((opt) => ({
    ...opt,
    score: scoreBaseSetMatch(opt.value, setName, manufacturer),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * BSC candidates = the marketplace's own rows, plus the set-listing row.
 *
 * The set listing is deliberately UNSCORED (`score: null`). Scoring it would
 * hand it `EXACT_SET_NAME_SCORE` (its label IS the set name) and it would
 * pre-select itself over every real BSC row — which is precisely the silent
 * substitution NEO-219 removed. Its one pre-selection rule lives in
 * `preselectedBscKey`.
 *
 * `dups` is `duplicateNames(bscOptions)`, over the whole option list.
 * Moved from the dialog's `bscCandidates` (which still returns nothing for a
 * paused side itself).
 */
export function buildBscBaseCandidates(input: {
  bscOptions: readonly PlatformItem[];
  setListing?: PlatformItem;
  setName: string;
  manufacturer: string;
  dups: ReadonlySet<string>;
}): Candidate[] {
  const { bscOptions, setListing, setName, manufacturer, dups } = input;
  const scored: Candidate[] = bscOptions
    .map((opt) => ({
      key: `bsc:${opt.platformValue}:${opt.value}`,
      item: opt,
      // NEO-325: a BSC name two candidates share carries its slug, the same
      // rule the SportLots list follows. A unique name is unchanged.
      label: itemLabel(opt, "bsc", dups),
      score: scoreBaseSetMatch(opt.value, setName, manufacturer),
      isSetListing: false,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (setListing) {
    scored.push({
      key: "bsc:set-listing",
      item: setListing,
      label: `${setName} — set listing (BSC)`,
      score: null,
      isSetListing: true,
    });
  }
  return scored;
}

/**
 * The BSC candidate the dialog pre-selects, by `key`, or `null`.
 *
 * Decision 4: the set listing is pre-selected only when it is the SOLE BSC
 * candidate — there is nothing else it could be, and making the operator pick
 * the only row on offer is ceremony, not safety. Otherwise only a SOLE exact
 * match; the set listing is unscored (`score: null`), so it never counts here.
 */
export function preselectedBscKey(candidates: readonly Candidate[]): string | null {
  if (candidates.length === 1 && candidates[0].isSetListing) {
    return candidates[0].key;
  }
  const sole = soleExactMatch(candidates, (c) => c.score);
  return sole ? sole.key : null;
}

/**
 * The SET row's own BSC slug, offered as an explicit, selectable candidate.
 * Moved from `BaseMappingForm`. NEO-137: read through `slotIds` —
 * `platformData.bsc` is a slot MAP, so the old typeof-string / Array.isArray
 * narrowing was type-legal against a Record and silently always undefined.
 */
export function baseSetListing(
  setNameAncestor:
    | (Pick<SlotBearingRow, "platformData"> & { value: string })
    | undefined,
): PlatformItem | undefined {
  const setListingSlug = setNameAncestor
    ? slotIds(setNameAncestor, "bsc")[0]
    : undefined;
  const setNameValue = setNameAncestor?.value;
  return setListingSlug && setNameValue
    ? { value: setNameValue, platformValue: setListingSlug }
    : undefined;
}

/** `setReconciliation.fetchRawOptions`' result, the part the picker reads. */
export type BaseOptionsFetch = {
  bscOptions: PlatformItem[];
  slOptions: PlatformItem[];
  /** NEO-287 — slot sides the operator has paused. */
  pausedSides?: readonly string[];
};

export type BaseCandidates = {
  /** SportLots options, best first; empty for a paused side. */
  sl: ScoredSlOption[];
  /** BSC candidates, best first, then the set listing; empty for a paused side. */
  bsc: Candidate[];
  /** The set's own BSC listing, when it has one. */
  setListing?: PlatformItem;
  /** What the dialog pre-selects: a SportLots id and a BSC candidate key. */
  preselected: { sl: string | null; bsc: string | null };
};

/**
 * NEO-339 — every Base candidate the dialog would show for one fetch, with
 * what it would pre-select. The set-building tool's view of the picker:
 * nothing is chosen here, and a spec names its pick by marketplace id.
 */
export function listBaseCandidates(
  fetch: BaseOptionsFetch,
  setNameAncestor:
    | (Pick<SlotBearingRow, "platformData"> & { value: string })
    | undefined,
  manufacturer = "",
): BaseCandidates {
  const paused = fetch.pausedSides ?? [];
  const setName = setNameAncestor?.value ?? "";
  const setListing = baseSetListing(setNameAncestor);
  const sl = paused.includes("sportlots")
    ? []
    : rankSlBaseOptions(fetch.slOptions, setName, manufacturer);
  const bsc = paused.includes("bsc")
    ? []
    : buildBscBaseCandidates({
        bscOptions: fetch.bscOptions,
        setListing,
        setName,
        manufacturer,
        dups: duplicateNames(fetch.bscOptions),
      });
  const soleSl = soleExactMatch(sl, (opt) => opt.score);
  return {
    sl,
    bsc,
    ...(setListing ? { setListing } : {}),
    preselected: {
      sl: soleSl ? soleSl.platformValue : null,
      bsc: preselectedBscKey(bsc),
    },
  };
}

/** `selectorOptions.setVariantTypePlatformData`'s arguments, as the form sends them. */
export type BaseMappingPayload = {
  variantTypeId: Id<"selectorOptions">;
  platformData: {
    bsc?: string;
    sportlots?: string;
    sportlotsDisplay?: string;
  };
  bscLabel?: string;
  baseVersion?: number;
};

/**
 * The Base mapping write for exactly what was picked, or `null` when nothing
 * was. Moved from `BaseMappingForm` (`handlePickerConfirm` + its
 * `writePlatformData`), which now sends this.
 *
 * No implicit set-slug substitution: the set listing is a candidate row in the
 * dialog, so if it is what should be linked, it was chosen.
 *
 * `bscLabel` is BSC's own display name for the set that was picked — the BSC
 * twin of `sportlotsDisplay`, stored as the setName slot's LABEL. Without it
 * `slotLabel` fell back to the slug and the Multi-source panel read "topps
 * topps". Absent when nothing was picked on BSC, which CLEARS a stale label
 * rather than leaving the previous set's name over a new slug (NEO-239).
 *
 * `baseVersion` is the row's `lastUpdated` as the picker read it, sent whenever
 * the row has loaded, in both modes. A version token can only ever REFUSE a
 * write, so carrying one on a mapping that turns out to have had nothing at
 * stake costs nothing — while omitting one on a row that quietly did (a
 * BSC-only mapping reads as unmapped) is a silent re-point of every card in
 * that slot.
 */
export function buildBaseMappingPayload(
  sel: { sl?: PlatformItem; bsc?: PlatformItem },
  row: { variantTypeId: Id<"selectorOptions">; lastUpdated?: unknown },
): BaseMappingPayload | null {
  const platformData: {
    bsc?: string;
    sportlots?: string;
    sportlotsDisplay?: string;
  } = {};
  if (sel.sl) {
    platformData.sportlots = sel.sl.platformValue;
    platformData.sportlotsDisplay = sel.sl.value;
  }
  if (sel.bsc) {
    platformData.bsc = sel.bsc.platformValue;
  }
  if (!platformData.sportlots && !platformData.bsc) return null;
  const bscLabel = sel.bsc?.value;
  return {
    variantTypeId: row.variantTypeId,
    platformData,
    ...(bscLabel ? { bscLabel } : {}),
    ...(typeof row.lastUpdated === "number"
      ? { baseVersion: row.lastUpdated }
      : {}),
  };
}
