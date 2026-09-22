/**
 * NEO-237 — SportLots' ALL-BRANDS option on its brand axis, recognised by
 * its marketplace id.
 *
 * ## What it is
 *
 * SportLots' brand list for a year carries one entry that is not a brand:
 * its no-filter option, "show every set from every brand". Its `brd` value
 * is the literal `"All Brands"` (measured on dev and on the hockey E2E
 * fixture, 2026-09-21; see the plan's risk 1 for the per-sport residual).
 * Two kinds of NB manufacturer row hold that id in their SportLots slot:
 *
 *   • the year's Unknown row (`metadata.isBrandUnknown`), because the
 *     brand-unknown sets are the ones SportLots files nowhere narrower; and
 *   • a brand SportLots has no entry for (Bandai, Choice), linked THROUGH the
 *     all-brands option and narrowed to its sets by the row's own
 *     `metadata.setNamePrefix` (the "via All Brands" control on the New
 *     Manufacturer step).
 *
 * "Linked via All Brands" is therefore NOT a schema flag. It is "the row's
 * SportLots primary id is SportLots' all-brands option", answered here.
 *
 * ## Why a predicate on the id, and not on the row's name
 *
 * The `bscFacets.ts` `isBscBaseVariantId` precedent: a marketplace id
 * compared to that marketplace's own vocabulary, inside the adapter/sync
 * boundary, on a value that came FROM the marketplace. It never reads the NB
 * display value — a row called "All Brands" is just a row called that, and
 * `checkCustomSelectorValue` refuses the name at manufacturer level anyway
 * because it is the name of the view pinned at the top of that column.
 *
 * Nothing user-facing branches on this predicate. Its callers are the
 * SportLots adapter (`fetchSetNames` narrows only when the request's `brd`
 * satisfies it), the manufacturer sync (`fetchAggregatedOptions` routes the
 * option to `ensureBrandUnknownRow` instead of storing it as a row), the Sync
 * Sets SportLots phase (one fetch of the all-brands list, narrowed per brand)
 * and the NEO-211 suggestion doors (no rename is ever suggested from this
 * label — it is not the row's name on any side).
 *
 * ENV-FREE and FE-importable on purpose, like `bscFacets.ts`: the confirm
 * step that offers the via-All-Brands control reads nothing from here today,
 * but the module must stay safe to import from a component if it ever does.
 */

/** SportLots' `brd` value for its all-brands option. Marketplace vocabulary. */
export const SL_ALL_BRANDS_BRAND_ID = "All Brands";

/**
 * Is `id` SportLots' all-brands option?
 *
 * Folded (case, surrounding whitespace) the way SportLots' own select values
 * are compared elsewhere in the adapter, so a re-cased upstream literal does
 * not silently turn every via-All-Brands brand into a real one. Non-ASCII is
 * left alone: the literal is ASCII and a marketplace select value is not
 * operator text.
 */
export function isSlAllBrandsBrandId(id: string | undefined): boolean {
  if (id === undefined) return false;
  return id.trim().toLowerCase() === SL_ALL_BRANDS_BRAND_ID.toLowerCase();
}
