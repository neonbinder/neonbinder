/**
 * NEO-189 — which BSC FACET a marketplace id belongs to, and how a chain of
 * `selectorOptions` rows turns into a BSC filter set.
 *
 * ## The problem this exists to solve
 *
 * A NeonBinder row must be able to draw its cards from N marketplace sets, and
 * the two marketplaces split differently. Topps ships Series 1 and Series 2;
 * SportLots may file those as two set ids while BSC files them as one
 * `setName`, or the reverse — BSC as `2024 → Topps → Topps Series 1 → Base`
 * and `… Series 2 → Base` while SportLots has a single set. Parallels and
 * inserts split the same way.
 *
 * SportLots needs nothing new: one attached id is one set, and
 * `fetchCardChecklist` already fans out one call per id.
 *
 * BSC does, because a BSC id is not self-describing. `topps-series-1` is a
 * value of the `setName` facet; `dugout-collection-artists-proofs` is a value
 * of the `variantName` facet. Before this ticket the fetch guessed the facet
 * from the NB LEVEL of the row holding the id (`LEVEL_TO_BSC_FACET`) — which
 * is wrong for exactly the case above, where a **setName** id has to hang off
 * a Base (`variantType`) row. Those ids were silently discarded: `variantType`
 * was skipped deliberately and `parallel` was never in the map at all.
 *
 * So a slot now records its facet, and the bucketing follows what the id IS
 * rather than where the row sits.
 *
 * ## Backward compatibility
 *
 * An UNTAGGED slot — every slot written before this ticket — keeps the old
 * level-derived behaviour exactly, including the two drops. Nothing here
 * infers a facet for it. A wrong guess would change which marketplace sets an
 * existing production checklist sources, which is precisely the mis-sourcing
 * this surface exists to prevent; an id that is inert today stays inert.
 */

import { v } from "convex/values";
import {
  slotEntries,
  slotFacet,
  type PlatformDataShape,
} from "./platformSlots";

/**
 * The BSC facets a slot's id can belong to.
 *
 * `sport` and `year` are scope resolved from the ancestor chain and are never
 * tagged; every other facet a slot can hold is here.
 *
 * NEO-239 added `variant` (base/insert/parallel/promo/…). It used to be
 * derived from the NB variantType row's DISPLAY VALUE, which is the reverse
 * dependency the product invariant forbids — an NB name must never build a
 * marketplace query, and BSC's variant set is not a closed enum ("Promo",
 * "Mail In" occur), so the name was never a safe stand-in for the id either.
 * It is now a tagged slot like any other.
 */
export type BscFacet = "setName" | "variantName" | "variant";

/**
 * The facets that name a SOURCE OF CARDS, and so the only ones an operator can
 * attach as an extra source set.
 *
 * `variant` is deliberately NOT here (NEO-239 / audit F6): it SCOPES a query
 * — "the base cards of this set" — it does not name a second set to draw cards
 * from. Attaching it as a source would make `sourceFacet` attribute cards to a
 * value that is not a set, and `resolveCardSlots` would bind them to nothing.
 */
export type BscSourceFacet = "setName" | "variantName";

export const BSC_SOURCE_FACETS: ReadonlySet<string> = new Set([
  "setName",
  "variantName",
]);

export const bscFacetValidator = v.union(
  v.literal("setName"),
  v.literal("variantName"),
  v.literal("variant"),
);

/**
 * The facet a SYNC at `level` knows the ids it just fetched belong to.
 *
 * Only `variantType` is answered, and only since NEO-239. The level sync at
 * variantType asks BSC for its `variant` facet values and stores exactly what
 * came back, so the tag is a fact the writer holds, not an inference about an
 * id someone else wrote.
 *
 * Every other level deliberately returns `undefined`: NEO-189's rule is that a
 * slot is tagged deliberately or not at all, and retro-tagging a setName row's
 * primary would change nothing (the level rule already answers `setName` for
 * it) while adding a way for the two sources of truth to disagree.
 */
export function syncWrittenBscFacet(level: string): BscFacet | undefined {
  return level === "variantType" ? "variant" : undefined;
}

/** NB level → BSC facet key. Levels absent here have no BSC facet at all. */
export const LEVEL_TO_BSC_FACET: Record<string, string> = {
  sport: "sport",
  year: "year",
  setName: "setName",
  variantType: "variant",
  insert: "variantName",
};

/**
 * The facet an UNTAGGED slot on a row at `level` filters on, in the checklist
 * fetch.
 *
 * Two levels resolve to `undefined` and that is load-bearing:
 *
 *   variantType — `LEVEL_TO_BSC_FACET` maps it to `variant`, but an UNTAGGED
 *                 variantType slug is not trustworthy: a mis-saved
 *                 BaseSetPicker mapping corrupted those slugs in dev (they
 *                 ended up pointing at the parent setName), so an untagged id
 *                 here could be a setName value wearing a variant's clothes.
 *                 It contributes nothing.
 *
 *                 NEO-239 changed what happens NEXT, not this: the checklist
 *                 fetch used to paper over the gap by deriving `variant` from
 *                 the row's DISPLAY value. It no longer does. A variantType row
 *                 with no `variant`-tagged slot makes the whole BSC side
 *                 unresolvable and BSC is SKIPPED — see
 *                 `marketplaceResolvability.ts`. Failing open would query
 *                 sport+year+setName with no variant axis, which returns base
 *                 plus every insert and parallel in the set.
 *   parallel    — never had a BSC facet.
 */
export function legacyBscFacetForLevel(level: string): string | undefined {
  if (level === "variantType") return undefined;
  return LEVEL_TO_BSC_FACET[level];
}

/** The minimum a chain node must expose to be bucketed. */
export type FacetBearingRow = {
  level: string;
  platformData: PlatformDataShape;
  platformFacets?: { bsc?: Record<string, BscFacet> };
};

export type BscFacetPlan = {
  /** BSC facet key → the ids to filter on. Ready for the request body. */
  filters: Record<string, string[]>;
  /**
   * The facet that identifies a SOURCE SET for the leaf row — i.e. the facet
   * the deepest contributing row supplied. Cards are attributed to the value
   * of this facet so `resolveCardSlots` can bind each card to the slot it came
   * from. `undefined` when the leaf contributed nothing, which is the legacy
   * Base/Parallel case and keeps the old attribution fallback.
   *
   * NEVER `variant` (NEO-239 / audit F6) — that facet scopes a query, it does
   * not name a set cards can be attributed to.
   */
  sourceFacet?: BscSourceFacet;
};

/**
 * Bucket a root→leaf ancestor chain into BSC facet filters.
 *
 * Two rules, and both matter:
 *
 * 1. **Within one row**, ids sharing a facet UNION. A row holding a legacy
 *    untagged variantName plus a newly-tagged `variantName` must query both,
 *    not one.
 *
 * 2. **Across rows**, the deepest contributor of a facet WINS — it does not
 *    union with its ancestors'. When a Base row is tagged with
 *    `setName: [series-1, series-2]`, the setName ancestor's own `topps` slug
 *    must not survive: unioned, BSC would receive a three-value `setName`
 *    facet, and BSC answers a multi-value facet with 200 OK and an empty body.
 *    Overriding is also the semantically right reading — the operator said
 *    "this row's cards come from these two sets", which is more specific than
 *    "…somewhere under Topps".
 */
export function resolveBscFacetFilters(
  chain: readonly FacetBearingRow[],
): BscFacetPlan {
  const filters: Record<string, string[]> = {};
  let sourceFacet: BscSourceFacet | undefined;

  for (const node of chain) {
    const perFacet = new Map<string, string[]>();
    for (const { slot, id } of slotEntries(node, "bsc")) {
      const tagged = slotFacet(node, "bsc", slot);
      const facet = tagged ?? legacyBscFacetForLevel(node.level);
      if (!facet) continue; // untagged variantType / parallel — inert, as before
      const bucket = perFacet.get(facet);
      if (bucket) bucket.push(id);
      else perFacet.set(facet, [id]);
    }
    for (const [facet, ids] of perFacet) {
      filters[facet] = ids;
      // Deepest contributor of a SOURCE facet names the source. `sport`,
      // `year` and `variant` are scope, never a source.
      if (BSC_SOURCE_FACETS.has(facet)) sourceFacet = facet as BscSourceFacet;
    }
  }

  return { filters, ...(sourceFacet ? { sourceFacet } : {}) };
}

/**
 * Cap on BSC requests per checklist fetch. Mirrors `MAX_SL_FAN_OUT` in
 * `fetchCardChecklist` and, like it, is defence in depth: `MAX_ATTACHED_PER_SIDE`
 * already bounds what an operator can attach, but a row could carry extras
 * from before that cap existed, and the cross product below multiplies.
 */
export const MAX_BSC_FAN_OUT = 10;

export type BscFanOutPlan = {
  /**
   * One entry per outgoing request: the facet values that request pins.
   * `[{}]` — a single empty combination — means "send `filters` as-is".
   */
  combos: Array<Record<string, string>>;
  /** Facets carrying more than one value. */
  multiFacets: string[];
  /** Number of combinations before the cap was applied. */
  totalBeforeCap: number;
  capped: boolean;
};

/**
 * Plan the fan-out: one request per combination of the multi-valued facets.
 *
 * BSC does **not** OR a multi-value facet. Measured live on dev 2026-08-12,
 * 1996 Score inserts:
 *
 *   filters.variantName = ["…series-2"]               -> 110 rows
 *   filters.variantName = ["…series-2", "…series-1"]  -> 200 OK, ZERO rows
 *
 * So no outgoing request may ever carry two values for one facet. When exactly
 * one facet is multi-valued this is the same one-call-per-source fan-out the
 * SportLots path does. When two are — an insert that lives under two different
 * BSC setName sets, where both the setName and the variantName differ per
 * source — the CROSS PRODUCT is the only shape that stays single-valued
 * everywhere. Combinations that do not exist on BSC simply return no rows and
 * cost one request; they cannot mis-source, because every row that comes back
 * matched a combination the operator selected.
 *
 * Order is preserved from `filters`, so a caller's id order is the request
 * order.
 */
export function planBscFanOut(
  filters: Record<string, string[]>,
  max: number = MAX_BSC_FAN_OUT,
): BscFanOutPlan {
  const multi = Object.entries(filters).filter(([, ids]) => ids.length > 1);
  if (multi.length === 0) {
    return { combos: [{}], multiFacets: [], totalBeforeCap: 1, capped: false };
  }

  let combos: Array<Record<string, string>> = [{}];
  for (const [facet, ids] of multi) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) {
      for (const id of ids) next.push({ ...combo, [facet]: id });
    }
    combos = next;
  }

  const totalBeforeCap = combos.length;
  const capped = totalBeforeCap > max;
  return {
    combos: capped ? combos.slice(0, max) : combos,
    multiFacets: multi.map(([facet]) => facet),
    totalBeforeCap,
    capped,
  };
}
