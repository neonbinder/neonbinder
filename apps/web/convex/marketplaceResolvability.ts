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
import { platformServesLevel } from "./platformLevels";

/** The minimum a chain node must expose to be judged. */
export type ResolvableRow = {
  level: string;
  value?: string;
  platformData: PlatformDataShape;
  platformFacets?: PlatformFacetShape;
};

export type SideResolution = {
  /**
   * Does this marketplace model the level being fetched at all
   * (`platformServesLevel`)? `false` is structural — no retry, no credential
   * and no attached id can change it.
   *
   * Kept separate from `resolvable` because the two failures read completely
   * differently to an operator. A side that does not serve the level was never
   * going to be asked and there is nothing to say about it; a side that COULD
   * have been asked and had no ids is worth a notice, because attaching an id
   * fixes it. Conflating them put "BuySportsCards skipped: no BuySportsCards
   * ids on this path" under every healthy Manufacturers sync — BSC has no
   * manufacturer axis — which is exactly the false-outage noise NEO-216
   * removed, reintroduced in different words.
   *
   * `true` when no level was supplied: with nothing to serve, nothing is
   * unserved.
   */
  served: boolean;
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

/**
 * SportLots, PER FETCH LEVEL — the ancestor ids the request body actually
 * consumes, and nothing more.
 *
 * A flat `{sport, year}` was too weak, and CI found it: ten flows drill a
 * MIXED chain — a real `Baseball / 2024 / Topps` plus a hand-made set with no
 * ids — where sport and year alone made SportLots look resolvable at the
 * variantType and Inserts columns. SL was then asked at levels it cannot serve
 * or cannot scope, and the refusal surfaced as a hard error with a Retry on a
 * column the operator only wanted to add rows to by hand. Under the retired
 * `isCustom` gate the hand-made set skipped both sides for the whole subtree,
 * which is why this never showed before.
 *
 * The rule is now: the requirement equals what the FORM BODY carries at that
 * level (see `resolveSlScope` and `fetchSetNames` in adapters/sportlots.ts).
 *
 *   sport        → nothing            newinven with no scope; lists sports
 *   year         → sport              `sprt`
 *   manufacturer → sport, year        `sprt`, `yr`
 *   insert       → sport, year, manufacturer   `sprt`, `yr`, `brd`
 *
 * Levels absent from this table are ones SportLots does not answer at all —
 * see `PLATFORM_LEVEL_SUPPORT` in convex/platformLevels.ts.
 */
export const SL_SCOPE_BY_LEVEL: Readonly<Record<string, readonly string[]>> = {
  sport: [],
  year: ["sport"],
  manufacturer: ["sport", "year"],
  insert: ["sport", "year", "manufacturer"],
};

/**
 * NEO-216 owns "does this marketplace have this level at all".
 *
 * That table lives in `convex/platformLevels.ts` — `PLATFORM_LEVEL_SUPPORT`,
 * read off `LEVEL_TO_BSC_FACET` and SportLots' `LEVEL_TO_TARGET_SELECT`,
 * enumerated exhaustively by its own test, and consulted by both adapters as a
 * backstop. NEO-239 arrived at the identical table independently and
 * duplicated it here for a week; the duplicate is gone, because two tables
 * that must agree are a table that will eventually disagree.
 *
 * The two questions remain distinct and BOTH gate a side:
 *
 *   platformServesLevel  — does this marketplace model this level? A property
 *                          of the marketplace's taxonomy; no retry or
 *                          credential can change it.
 *   the tables below     — does THIS CHAIN carry the ids that side's request
 *                          body consumes at this level? A property of the data.
 *
 * A side must pass both to be asked.
 */

/**
 * At `insert` and `parallel`, SportLots additionally requires the SET to be a
 * MARKETPLACE set at all — linked on at least one side.
 *
 * SL's answer at those levels is every set for the year and brand; it is not
 * "this set's variants" on its own. For a set NeonBinder invented, offering
 * the whole brand-year as its variants is the same fail-open shape the BSC
 * required-facet check exists to prevent — and it is what made ten flows call
 * a marketplace while drilling a hand-made set, then render the failure as a
 * Retry the operator could never satisfy.
 *
 * THE TEST IS "linked on EITHER side", and the first version of this rule got
 * that wrong in a way CI caught immediately. It asked for an SL id beneath the
 * manufacturer — which is circular, because `BaseMappingForm` fetches at
 * exactly this level to POPULATE the Base set picker, and the picker is how a
 * set gets its SL id in the first place. `syncSetsAcrossManufacturers` is
 * BSC-only, so a freshly synced real set has a BSC id and no SL one; requiring
 * SL first meant the picker never had candidates, silently took its
 * "no SL data" branch, and neither "Select Base Set" nor "Re-map Base" ever
 * rendered.
 *
 * A BSC id is sufficient evidence: the set exists on a marketplace, and the
 * operator is here to pick its SportLots counterpart.
 */
const SL_LINKED_SET_FETCH_LEVELS: ReadonlySet<string> = new Set([
  "insert",
  "parallel",
]);

/**
 * @deprecated NEO-239 — the flat set that CI proved too weak. Kept only as the
 * default when a caller does not say which level it is fetching; every real
 * caller passes `level` and gets `SL_SCOPE_BY_LEVEL` instead.
 */
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
  opts?: { level?: string; slRequired?: ReadonlySet<string> },
): ChainResolution {
  const level = opts?.level;
  const slRequired =
    opts?.slRequired ??
    (level !== undefined && level in SL_SCOPE_BY_LEVEL
      ? new Set(SL_SCOPE_BY_LEVEL[level])
      : SL_REQUIRED_LEVELS);

  const missingBsc: string[] = [];
  const missingSl: string[] = [];

  // A side that cannot answer at this level is unresolvable outright, whatever
  // ids the chain carries. `unsupported_level` is not an empty answer.
  if (level !== undefined && !platformServesLevel("bsc", level)) {
    missingBsc.push(`level=${level}`);
  }
  if (
    level !== undefined &&
    opts?.slRequired === undefined &&
    !platformServesLevel("sportlots", level)
  ) {
    missingSl.push(`level=${level}`);
  }

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

  // SL's flat list only means "this set's variants" once the set is linked to
  // some marketplace. EITHER side counts — see the note above for why
  // requiring the SportLots one specifically was circular.
  if (
    level !== undefined &&
    opts?.slRequired === undefined &&
    SL_LINKED_SET_FETCH_LEVELS.has(level)
  ) {
    const setRow = chain.find((row) => row.level === "setName");
    const setIsLinked =
      setRow !== undefined &&
      (rowHasSideId(setRow, "bsc") || rowHasSideId(setRow, "sportlots"));
    if (!setIsLinked) missingSl.push("unlinked set");
  }

  return {
    bsc: {
      served: level === undefined || platformServesLevel("bsc", level),
      resolvable: missingBsc.length === 0,
      missing: missingBsc,
    },
    sportlots: {
      served: level === undefined || platformServesLevel("sportlots", level),
      resolvable: missingSl.length === 0,
      missing: missingSl,
    },
  };
}

/**
 * The skipped sides an operator should be TOLD about: ones this marketplace
 * models at this level, that were skipped only because the chain carries none
 * of the ids they need.
 *
 * A strict subset of `skippedSideList`, which stays complete — the FE's
 * coverage logic must subtract every skipped side, whatever the reason, or a
 * side nobody asked authorises an unlink. Only the NOTICE narrows.
 */
export function notifiableSkippedSides(
  resolution: ChainResolution,
): PlatformSide[] {
  return skippedSideList(resolution).filter(
    (side) => resolution[side].served,
  );
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
