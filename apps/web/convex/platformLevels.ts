/**
 * NEO-216 — which marketplace SERVES which selector level.
 *
 * ## The bug this exists to end
 *
 * The Manufacturers column showed "BuySportsCards could not be reached, so
 * nothing from BuySportsCards was changed…" after every healthy Sync
 * Manufacturers, in prod and on every PR preview. Nothing was wrong with BSC.
 *
 * BuySportsCards has **no manufacturer level at all** — its taxonomy goes
 * sport → year → setName, and NeonBinder's Manufacturer rows are populated
 * from SportLots' brand list, with BSC's sets bucketed under them afterwards by
 * name prefix (`syncSetsAcrossManufacturers`). So the BSC adapter answered the
 * only way it could: "BSC has no aggregation for level: manufacturer". The
 * aggregator read that as an adapter FAILURE, put `bsc` in `failedPlatforms`,
 * and NEO-211's partial-failure notice faithfully reported an outage that had
 * not happened.
 *
 * Three things were wrong with that, and they compound:
 *
 *   1. It is false, and a monitoring surface that cries wolf on every run
 *      trains an operator to ignore it — including on the run where BSC really
 *      is down.
 *   2. It cost a real credential round-trip per sync. Both adapters resolved a
 *      marketplace session token BEFORE discovering they had nothing to do at
 *      that level.
 *   3. `coveredSides` — the positive evidence that licenses the NEO-211 unlink
 *      pass — was being computed from "did this adapter error", which conflates
 *      "asked and got nothing" with "never asked". Only the first may ever
 *      detach a marketplace link.
 *
 * ## The rule
 *
 * A platform either serves a level or it does not, and that is a property of
 * the MARKETPLACE'S TAXONOMY, not of any one call's outcome. At a level a
 * platform does not serve, it is not fetched, it is not in `coveredSides`, it
 * contributes no `returnedIds`, it never appears in `failedPlatforms` or a
 * fetch's `errors`, and it produces no notice. Only a platform that serves the
 * level AND errored is a partial failure.
 *
 * This table is the single source of that truth. Every caller reads it —
 * `fetchAggregatedOptions` (columns 1-5), `setReconciliation.fetchRawOptions`
 * (inserts / sub-variants / Base mapping), and both adapters themselves as a
 * backstop — so a new call site cannot re-derive it and get it wrong.
 *
 * ## Where each entry comes from
 *
 * Read off the adapters, not assumed:
 *
 *   BSC  — `LEVEL_TO_BSC_FACET` in convex/bscFacets.ts is the whole of it. A
 *          level with no facet has no BSC query to make: `manufacturer` (BSC
 *          has no such axis) and `parallel` (see the bscFacets header — it
 *          never had a facet).
 *   SL   — `LEVEL_TO_TARGET_SELECT` in convex/adapters/sportlots.ts covers
 *          sport / year / manufacturer (the three `newinven.tpl` selects), plus
 *          `insert`, which is SL's flat `dealsets.tpl` set list. `setName` and
 *          `variantType` are NB-only splits SportLots does not model, and
 *          `parallel` has no SL concept either.
 *
 * **If you add a level or teach an adapter a new one, change it HERE.** The
 * table is enumerated exhaustively by `platformLevels.test.ts`, and its level
 * keys are pinned against `selectorOptionLevelValidator`, so a new level fails
 * that test until it is given an answer for both platforms.
 */

import type { PlatformSide } from "./platformSlots";

/**
 * The seven selector levels, in hierarchy order.
 *
 * Kept in step with `selectorOptionLevelValidator` (convex/schema.ts) by a test
 * rather than by an import: that validator is a `v.union` of literals, and
 * reaching into its internals at runtime to enumerate them would couple this
 * module to a convex-values implementation detail.
 */
export const SELECTOR_LEVELS = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
] as const;

export type SelectorLevel = (typeof SELECTOR_LEVELS)[number];

/**
 * Platform → level → does this marketplace have anything to say at this level.
 *
 * `false` is not "it might fail" and not "we have no credentials" — it is
 * "there is no such axis on that marketplace", which no retry, no re-auth and
 * no outage can change.
 */
export const PLATFORM_LEVEL_SUPPORT: Record<
  PlatformSide,
  Record<SelectorLevel, boolean>
> = {
  bsc: {
    sport: true,
    year: true,
    // BSC has no manufacturer axis. NB's Manufacturer rows come from
    // SportLots' brand list; BSC sets are filed under them afterwards by
    // name prefix in `syncSetsAcrossManufacturers`.
    manufacturer: false,
    setName: true,
    variantType: true,
    insert: true,
    // Never had a BSC facet — see the convex/bscFacets.ts header.
    parallel: false,
  },
  sportlots: {
    sport: true,
    year: true,
    manufacturer: true,
    // SportLots does not split a year's brands into sets and variant types;
    // those two levels are NB's own structure, filled from BSC.
    setName: false,
    variantType: false,
    // SL's flat dealsets.tpl set list lands at NB's `insert` level.
    insert: true,
    parallel: false,
  },
};

/** The sides, in the order every user-facing list already uses. */
export const PLATFORM_SIDES_ORDERED: readonly PlatformSide[] = [
  "bsc",
  "sportlots",
];

/**
 * Does `side` have anything to fetch at `level`?
 *
 * Takes a plain `string` because the adapters' own `level` arg is a `v.string()`
 * — an unrecognised level is not served by anyone, which is the correct answer
 * for a caller that made one up.
 */
export function platformServesLevel(side: PlatformSide, level: string): boolean {
  return PLATFORM_LEVEL_SUPPORT[side][level as SelectorLevel] === true;
}

/**
 * The sides worth calling at `level`, BSC first.
 *
 * An empty result means no marketplace models this level at all (`parallel`
 * today). That is a legitimate, successful outcome with nothing to fetch — NOT
 * a failure, and never a notice.
 */
export function platformsServingLevel(level: string): PlatformSide[] {
  return PLATFORM_SIDES_ORDERED.filter((side) =>
    platformServesLevel(side, level),
  );
}

/**
 * The fixed message an adapter returns when it is asked for a level it does not
 * serve.
 *
 * A caller that consults the table never sees this; it is the backstop for one
 * that does not. Composed entirely from our own strings and the caller's own
 * level name — no marketplace response text.
 */
export function unsupportedLevelMessage(
  side: PlatformSide,
  level: string,
): string {
  const name = side === "bsc" ? "BuySportsCards" : "SportLots";
  return `${name} has no ${level} level — nothing to fetch.`;
}
