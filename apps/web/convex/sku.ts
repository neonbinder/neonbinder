/**
 * NEO-91: NeonBinder-generated SKU — the canonical cross-marketplace
 * identifier for a card (eBay, MySlabs, MyCardPost all key listings off a
 * seller-defined SKU; BSC's `platformData.bsc` is an opaque catalog hash,
 * not a real SKU, and SportLots has no field large enough to carry one at
 * all — confirmed its "Bin" field maxes out at 5 characters).
 *
 * Format: NB-{sportCode:2}-{year:4}-{setSlug:<=12}-{cardNumber:<=10}-{suffix:6}
 * Worst case: 3 + 2+1 + 4+1 + 12+1 + 10+1 + 6 = 41 characters — always
 * comfortably under eBay's confirmed 50-char `sku` field limit, with
 * headroom for whatever MySlabs/MyCardPost/BSC turn out to need once those
 * listing integrations exist.
 *
 * The human-readable prefix (sport/year/set/card number) is for legibility
 * only — it is NOT relied on for uniqueness (two parallels sharing a visible
 * card number, or two custom cards, could otherwise collide on it). The
 * caller-supplied `uniqueSuffix` is the sole uniqueness guarantee.
 */

export const SKU_MAX_LENGTH = 41;

/**
 * NEO-96: `SPORT_SKU_CODE`, a display-name-keyed map consulted here at runtime,
 * is gone. It was keyed `"Baseball"`, but `commitCardChecklist` passed the
 * lowercased `"baseball"` that had leaked out of the BSC adapter, so it MISSED
 * and fell through to `slugify("baseball", 2)` → `"BA"`, while `addCustomCard`
 * passed the raw `"Baseball"` and hit → `"BB"`. The same set therefore produced
 * two different marketplace-facing SKU prefixes depending on which path created
 * the card.
 *
 * The code now comes from the sport row's own `sportConfig.skuCode` (seeded by
 * convex/sportConfig.ts), so both paths read one value and a sport rename can't
 * change it. `skuCode` is optional: a custom sport has none, and falls back to
 * the slugify path below — which is a legitimate degrade, not a bug.
 */
function slugify(raw: string, maxLength: number): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, maxLength);
  return cleaned || "X";
}

export interface GenerateSkuParams {
  /** The sport row's `sportConfig.skuCode` (e.g. "BB"). Undefined for a custom
   *  or unmapped sport — `sportFallbackLabel` is slugified instead. */
  skuCode?: string;
  /** The sport's display value, used ONLY to derive a prefix when `skuCode` is
   *  absent. Never used when `skuCode` is present, so casing cannot affect the
   *  result for a configured sport. */
  sportFallbackLabel: string;
  year: string;
  setName: string;
  cardNumber: string;
  /** Caller-supplied randomness (e.g. from crypto.randomUUID()) — the only
   *  component responsible for guaranteeing uniqueness across cards. */
  uniqueSuffix: string;
}

export function generateSku(params: GenerateSkuParams): string {
  const sportCode =
    params.skuCode ?? slugify(params.sportFallbackLabel, 2).padEnd(2, "X");
  const year = slugify(params.year, 4);
  const setSlug = slugify(params.setName, 12);
  const cardNumberSlug = slugify(params.cardNumber, 10);
  const suffix = slugify(params.uniqueSuffix, 6).padEnd(6, "0");

  return `NB-${sportCode}-${year}-${setSlug}-${cardNumberSlug}-${suffix}`;
}
