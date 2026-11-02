/**
 * NEO-370 — NB copy condition → BuySportsCards (BSC) raw condition.
 *
 * Pure and env-free: no Convex db, no fetch. The listing sync reads one BSC
 * seller sheet per BSC condition and sends one row per (BSC card id, BSC
 * condition), so every NB condition has to land on exactly one BSC key.
 *
 * The BSC vocabularies are the seller-side keys BSC serves from
 * `common/reference/product` (`condition` for modern, `conditionVintage` for
 * vintage), read 2026-10-28 and again 2026-11-01. They are NOT the buyer-side
 * search filter's spellings (`nm-mint`, `good-v`), and BSC does not validate
 * the condition on a sheet read: it stamps every row with whatever string it
 * is sent. So only these exact keys may ever reach BSC.
 *
 * Mapping decided with Jason, 2026-10-28 (NEO-370 "Condition mapping"):
 *   vintage is one to one; modern folds Mint into near_mint and Good into
 *   very_good. Two NB conditions landing on one BSC key add up into one row.
 */
import type { Infer } from "convex/values";
import type { collectionCopyConditionValidator } from "../schema";

/** An NB copy condition, exactly as stored on `collectionCopies.condition`. */
export type NbCondition = Infer<typeof collectionCopyConditionValidator>;

/** BSC's modern raw conditions (`common/reference/product` → `condition`). */
export const BSC_MODERN_RAW_CONDITIONS = [
  "near_mint",
  "excellent",
  "very_good",
  "poor",
] as const;

/** BSC's vintage raw conditions (`common/reference/product` → `conditionVintage`). */
export const BSC_VINTAGE_RAW_CONDITIONS = [
  "mint",
  "nm-mt",
  "nm",
  "ex-mt",
  "ex",
  "vg-ex",
  "vg",
  "good",
  "fair",
  "poor-v",
] as const;

export type BscModernCondition = (typeof BSC_MODERN_RAW_CONDITIONS)[number];
export type BscVintageCondition = (typeof BSC_VINTAGE_RAW_CONDITIONS)[number];
export type BscRawCondition = BscModernCondition | BscVintageCondition;

export type BscEra = "modern" | "vintage";

/**
 * The last card year BSC treats as vintage (inclusive). BSC's seller app
 * decides the era on the client as `Number(card.year) <= 1980`, in the listing
 * grid, the product view and the bulk-upload screen alike (its public web
 * bundle, read 2026-11-01). `common/reference/product` carries no year.
 */
export const BSC_VINTAGE_CUTOFF_YEAR = 1980;

const MODERN: Record<NbCondition, BscModernCondition> = {
  Mint: "near_mint",
  "Near Mint": "near_mint",
  Excellent: "excellent",
  "Very Good": "very_good",
  Good: "very_good",
  Poor: "poor",
};

const VINTAGE: Record<NbCondition, BscVintageCondition> = {
  Mint: "mint",
  "Near Mint": "nm",
  Excellent: "ex",
  "Very Good": "vg",
  Good: "good",
  Poor: "poor-v",
};

/**
 * The BSC era for an NB year row's value ("1988", "2020-21", "1980-81").
 * Reads the leading four-digit year, the same year BSC's bulk-upload screen
 * reads with `parseInt` from a year facet. Null when the value carries no
 * leading year: the caller reports it and lists nothing, never guesses.
 */
export function bscEraForYear(yearValue: string): BscEra | null {
  const match = /^\s*(\d{4})(?!\d)/.exec(yearValue);
  if (!match) return null;
  const year = Number(match[1]);
  return year <= BSC_VINTAGE_CUTOFF_YEAR ? "vintage" : "modern";
}

/** The BSC raw condition an NB condition lists under in that era. */
export function bscConditionFor(nb: NbCondition, era: BscEra): BscRawCondition {
  return era === "vintage" ? VINTAGE[nb] : MODERN[nb];
}

/** Every BSC raw condition of an era, in BSC's own order (best first). */
export function bscConditionsForEra(era: BscEra): readonly BscRawCondition[] {
  return era === "vintage" ? BSC_VINTAGE_RAW_CONDITIONS : BSC_MODERN_RAW_CONDITIONS;
}

/**
 * The NB conditions that fold into one BSC condition in that era: the copies
 * a sale of that BSC row may lower. Empty when the key is not of that era.
 */
export function nbConditionsFor(bsc: string, era: BscEra): NbCondition[] {
  const table = era === "vintage" ? VINTAGE : MODERN;
  return (Object.keys(table) as NbCondition[]).filter((nb) => table[nb] === bsc);
}

/** True when `value` is one of BSC's raw condition keys, either era. */
export function isBscRawCondition(value: string): value is BscRawCondition {
  return (
    (BSC_MODERN_RAW_CONDITIONS as readonly string[]).includes(value) ||
    (BSC_VINTAGE_RAW_CONDITIONS as readonly string[]).includes(value)
  );
}

/** True when `value` is a raw condition key of that era. */
export function isBscConditionOfEra(value: string, era: BscEra): value is BscRawCondition {
  return (bscConditionsForEra(era) as readonly string[]).includes(value);
}
