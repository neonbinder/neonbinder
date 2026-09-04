/**
 * NEO-239 — is a marketplace REACHABLE from this ancestor chain?
 *
 * ## What this replaces
 *
 * `isCustomSubtree` (NEO-22/NEO-47) answered a different question: "did a human
 * type any row on this path?". One `isCustom` boolean gated BOTH marketplaces
 * for the whole subtree, forever — "once custom, always custom".
 *
 * That is the wrong question, and it made a row's behaviour depend on how it
 * came into being rather than on what it carries. NB owns the data; a
 * marketplace id is linkage, and a row either has one on a side or it does
 * not. There is no "custom" kind of row.
 *
 * So the gate becomes PER SIDE and PER PATH: a side is fetched only when every
 * ancestor that side needs an id from actually carries one. A hand-typed sport
 * with no ids skips both sides (exactly the old behaviour, reached by a
 * different route). A hand-typed MANUFACTURER under a BSC-linked year no longer
 * poisons its subtree: BSC has no manufacturer facet at all, so BSC still
 * resolves and the set/variant/card syncs below it run.
 *
 * ## What each side needs
 *
 * BSC filters on `sport`, `year`, `setName` and `variant`; there is NO
 * manufacturer facet (`LEVEL_TO_BSC_FACET` in `bscFacets.ts`). `insert` maps to
 * `variantName` and `parallel` to nothing, and neither is required — a query
 * scoped to the set is still a correct, narrower-is-better query.
 *
 * `variantType` is required but is NOT satisfied by "has a BSC id": it must
 * carry a slot TAGGED `variant` (NEO-189 facet tags). The id in an untagged
 * variantType slot is not self-describing, and one class of them is known to be
 * corrupt — a mis-saved Base mapping once wrote the parent's setName slug into
 * variantType rows. Before this ticket the fetch dodged that by re-deriving the
 * facet from the row's DISPLAY VALUE, which is the reverse dependency the
 * product invariant forbids: an NB name must never build a marketplace query.
 * So an untagged variantType makes BSC unresolvable and BSC is skipped — never
 * guessed. `backfillVariantFacetAndBaseRole` tags the rows that can be tagged
 * and reports the rest.
 *
 * SportLots has one unit of attachment reached through sport + year (its
 * `sprt`/`yr` form fields). `manufacturer` is additionally required on the
 * ATTACH pool, where the whole request is "every SL set under this brand" and
 * an unscoped answer is a different, useless pool rather than a wider one.
 *
 * ## Levels absent from the chain are not "missing"
 *
 * Syncing `year` under a `sport` parent has no `setName` ancestor to be missing
 * an id. Only levels PRESENT in the chain are checked, which is how the four
 * pre-existing preconditions already behaved.
 */

import type {
  PlatformDataShape,
  PlatformFacetShape,
  PlatformSide,
} from "./platformSlots";
import { slotEntries, slotFacet } from "./platformSlots";

/** The minimum a chain node must expose to be judged. */
export type ResolvableRow = {
  level: string;
  value?: string;
  platformData: PlatformDataShape;
  platformFacets?: PlatformFacetShape;
};

export type SideResolution = {
  /** True when every ancestor this side needs an id from carries one. */
  resolvable: boolean;
  /**
   * `${level}=${value}` per ancestor that owes this side an id. LOG ONLY —
   * it names NB rows and must never reach `selectorSyncStatus.message`
   * (NEO-47 security property; see the fixed constants below).
   */
  missing: string[];
};

export type ChainResolution = Record<PlatformSide, SideResolution>;

/** BSC facets that scope a query and have no NB display fallback. */
export const BSC_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
  "setName",
]);

/** SportLots' `sprt` + `yr` form fields. */
export const SL_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
]);

/**
 * The attach pool additionally needs `brd`. Browsing "every SL set under this
 * year" unscoped by brand is not a wider version of the pool the operator
 * asked for — it is a different one.
 */
export const SL_ATTACH_REQUIRED_LEVELS: ReadonlySet<string> = new Set([
  "sport",
  "year",
  "manufacturer",
]);

/**
 * What the admin sees when NEITHER side can be asked.
 *
 * FIXED TEXT. `selectorSyncStatus.message` is reactive state served to the
 * browser, so it carries no row values, no marketplace strings and no adapter
 * detail — same rule as `SYNC_ERROR_MESSAGE` and `partialSyncMessage`
 * (NEO-47 / NEO-211 B). The per-row detail goes to `console.log`.
 *
 * The ONE-side case is `skippedSyncMessage` in `selectorSyncStore.ts`, built
 * from the same platform-name mapping `partialSyncMessage` uses — a side that
 * was skipped and a side that failed are different events told in the same
 * vocabulary. It does not live here because this module is deliberately free
 * of Convex imports.
 */
export const NO_MARKETPLACE_IDS_MESSAGE =
  "No marketplace ids on this path — nothing to sync. Add entries by hand, or " +
  "attach a marketplace id to this set to link one.";

/** True when the row carries at least one marketplace id on `side`. */
export function rowHasSideId(
  row: Pick<ResolvableRow, "platformData">,
  side: PlatformSide,
): boolean {
  return slotEntries(row, side).length > 0;
}

/**
 * True when the row carries a BSC slot TAGGED with `facet`.
 *
 * An untagged slot is deliberately not counted. `slotFacet` returns `undefined`
 * for a slot written before NEO-189, and that means "inert", never
 * "unknown-so-guess" — see `bscFacets.ts`.
 */
export function rowHasBscFacet(
  row: Pick<ResolvableRow, "platformData" | "platformFacets">,
  facet: string,
): boolean {
  for (const { slot } of slotEntries(row, "bsc")) {
    if (slotFacet(row, "bsc", slot) === facet) return true;
  }
  return false;
}

function label(row: ResolvableRow): string {
  return row.value ? `${row.level}=${row.value}` : row.level;
}

/**
 * Which sides can be queried for this ancestor chain.
 *
 * `slRequired` lets the attach pool ask for its stricter rule without a second
 * near-identical helper — the two callers differ only in whether `manufacturer`
 * is load-bearing.
 */
export function resolvableSides(
  chain: readonly ResolvableRow[],
  opts?: { slRequired?: ReadonlySet<string> },
): ChainResolution {
  const slRequired = opts?.slRequired ?? SL_REQUIRED_LEVELS;

  const missingBsc: string[] = [];
  const missingSl: string[] = [];

  for (const row of chain) {
    if (BSC_REQUIRED_LEVELS.has(row.level) && !rowHasSideId(row, "bsc")) {
      missingBsc.push(label(row));
    }
    // A variantType contributes BSC's `variant` facet, and only a TAGGED slot
    // says which facet an id belongs to. No tag → nothing honest to filter on.
    if (row.level === "variantType" && !rowHasBscFacet(row, "variant")) {
      missingBsc.push(label(row));
    }
    if (slRequired.has(row.level) && !rowHasSideId(row, "sportlots")) {
      missingSl.push(label(row));
    }
  }

  return {
    bsc: { resolvable: missingBsc.length === 0, missing: missingBsc },
    sportlots: { resolvable: missingSl.length === 0, missing: missingSl },
  };
}

/** The sides worth calling, in a stable order. */
export function resolvedSideList(
  resolution: ChainResolution,
): PlatformSide[] {
  const out: PlatformSide[] = [];
  if (resolution.bsc.resolvable) out.push("bsc");
  if (resolution.sportlots.resolvable) out.push("sportlots");
  return out;
}

/**
 * The sides this run did NOT ask, in the stable order every caller reports and
 * subtracts from `coveredSides`.
 *
 * The inverse of `resolvedSideList`, and the value that rides back to the
 * client as `skippedSides`.
 */
export function skippedSideList(
  resolution: ChainResolution,
): PlatformSide[] {
  const out: PlatformSide[] = [];
  if (!resolution.bsc.resolvable) out.push("bsc");
  if (!resolution.sportlots.resolvable) out.push("sportlots");
  return out;
}
