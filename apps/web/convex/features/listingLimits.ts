/**
 * NEO-101: the marketplace length limits a NeonBinder listing field has to
 * respect, in one place, with the evidence attached — same discipline as
 * `convex/sku.ts` (`SKU_MAX_LENGTH`), which this module is modelled on.
 *
 * Everything here is a plain exported number and this module imports nothing,
 * so it is safe for the Convex isolate, the pure `features/` derivations, and
 * the SPA bundle alike (`components/SetSelector/card-attention.ts` re-exports
 * the derivations that read these, and the card detail panel imports the cap
 * directly instead of keeping its own literal `80`).
 *
 * ## The limits, confirmed 2026-09-02
 *
 * | Field | Cap | Marketplace | On breach |
 * |---|---|---|---|
 * | listing title | **80** | eBay | **REJECTED** (error 70) — eBay does NOT truncate |
 * | item-specific (aspect) value | **65** | eBay | rejected |
 * | subtitle | 55 | eBay | not used by NB — no field maps to it |
 * | SKU | 50 | eBay | already handled: `sku.ts` caps at 41 |
 * | listing title | none | SportLots | lists by ref (`platformData.sportlots.ref`) |
 * | listing title | none | BuySportsCards | lists by ref (`platformData.bsc.ref`) |
 * | listing title | unknown | MyCardPost / MySlabs | no listing integration exists yet — revisit when one is built |
 *
 * The breach behaviour is the reason this is a hard cap at the write path and
 * not a display nicety: an over-length title is not a title that arrives
 * shortened, it is a listing that fails to publish — at the worst possible
 * moment, months after the card was built, across thousands of rows at once.
 *
 * ## The two CLIP values are NOT caps
 *
 * `LISTING_TITLE_MOBILE_CLIP` and `LISTING_TITLE_SEARCH_CLIP` are soft display
 * bands, not limits: eBay accepts titles well past both. They describe where a
 * title stops being FULLY VISIBLE — the mobile app's search tiles clip around
 * 55 characters and desktop search results around 70 — which is why the
 * generator front-loads year / set / player. Nothing rejects a title for
 * crossing them; the UI colours the character counter and moves on.
 *
 * Jason confirmed 2026-09-02 that there is **no separate 60-character rule**.
 * The "~60" in the NEO-101 ticket is this display truncation remembered as a
 * limit; there is exactly one hard title cap (80) and these two soft bands
 * beneath it.
 */

/**
 * eBay's hard listing-title cap. A title longer than this is REJECTED at
 * listing time, not truncated, so this is enforced server-side in
 * `selectorOptions.updateCard` and respected by construction in
 * `features/generateListing.ts`.
 */
export const LISTING_TITLE_MAX = 80;

/**
 * Soft band: roughly where eBay's mobile app clips a search-result tile.
 * A display hint for the character counter — never a cap.
 */
export const LISTING_TITLE_MOBILE_CLIP = 55;

/**
 * Soft band: roughly where eBay's desktop search results clip a title.
 * A display hint for the character counter — never a cap.
 */
export const LISTING_TITLE_SEARCH_CLIP = 70;

/**
 * eBay's cap on one item-specific (aspect) VALUE — the per-aspect strings a
 * listing sends, e.g. Parallel/Variety. Relevant to `cardChecklist.cardVariation`
 * and to parallel names once an eBay listing adapter exists; over-length values
 * are rejected the same way an over-length title is.
 *
 * Warn-only today (`features/cardAttention.ts` raises `aspectValueOverLimit`)
 * rather than enforced at the write path: no NB field is yet PROVEN to map
 * verbatim onto an eBay aspect, and hard-blocking an operator edit on a guess
 * is exactly the over-structuring NEO-189 rolled back.
 */
export const ASPECT_VALUE_MAX = 65;
