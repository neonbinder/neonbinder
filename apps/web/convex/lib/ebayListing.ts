/**
 * NEO-415 — eBay listing rules, pure and env-free (no db, no fetch), so the
 * drain, the settings actions and the order poll all read the same rules and
 * a unit test can pin them without Convex.
 *
 * eBay is a CARD-level platform: NB makes one listing per (owner, card,
 * condition bucket) on the collector's own account, keyed by a SKU NB owns
 * (`NB2-<cardId>-<bucket>`). Nothing here reads a marketplace value to decide
 * NB behaviour; eBay answers are narrowed to the few fields NB needs and
 * otherwise ignored (product invariant 4).
 *
 * Shapes verified against eBay's published OpenAPI documents (Sell Inventory
 * v1, Sell Account v1, Sell Fulfillment v1, Commerce Taxonomy v1, Sell
 * Metadata v1), https://developer.ebay.com/api-docs/ ; where a value is NOT in
 * those documents it says so beside it.
 */
import type { Id } from "../_generated/dataModel";
import type { NbCondition } from "./bscConditions";
import { tableNumberOf } from "./convexIdCodec";
import { compareCopiesOldestFirst, type AgedCopy } from "./listingCopyOrder";
import { hasListingCondition, listingFloorCents } from "./listingReadiness";

// ── Constants ───────────────────────────────────────────────────────────────

/** eBay US marketplace (the only one NB lists on). */
export const EBAY_MARKETPLACE_ID = "EBAY_US";
/** Every listing's language (the `Content-Language` header too). */
export const EBAY_LOCALE = "en_US";
export const EBAY_CONTENT_LANGUAGE = "en-US";
/** Default category tree for EBAY_US. */
export const EBAY_CATEGORY_TREE_ID = "0";
/**
 * "Sports Trading Card Singles". Verified as the leaf for single sports cards
 * on EBAY_US (eBay's condition-descriptor guide uses it as the example
 * category); its aspects are re-read at runtime (`requiredAspectNames`).
 */
export const EBAY_CARD_CATEGORY_ID = "261328";
/** eBay caps a bulk request at 25 entries (bulk* methods, Sell Inventory v1). */
export const EBAY_BULK_LIMIT = 25;
/** eBay SKU cap (InventoryItem.sku maxLength). */
export const EBAY_SKU_MAX = 50;
/** eBay title cap (Product.title maxLength). */
export const EBAY_TITLE_MAX = 80;
/** eBay description cap, characters (Product.description maxLength 4000 for an item). */
export const EBAY_DESCRIPTION_MAX = 4000;
/** NB's floor for a listing price: eBay will not take less in this category. */
export const EBAY_MIN_PRICE_CENTS = 99;
/** At or above this a card uses the "$20 and up" shipping slot (ESE covers items under $20). */
export const EBAY_ESE_PRICE_CAP_CENTS = 2000;
/** eBay Standard Envelope's shipping service code. */
export const EBAY_ESE_SERVICE_CODE = "US_eBayStandardEnvelope";
/** Aspect values NB never sends longer than this (`features/listingLimits.ASPECT_VALUE_MAX`). */
export const EBAY_ASPECT_VALUE_MAX = 65;

/**
 * Ungraded trading cards list as condition id 4000, whose Inventory API enum
 * is `USED_VERY_GOOD` (eBay "Item condition ID and name values": 4000 is
 * "Ungraded" in the trading-card categories). The card's real state rides in
 * the Card Condition descriptor below.
 */
export const EBAY_UNGRADED_CONDITION = "USED_VERY_GOOD";
/** Condition descriptor "Card Condition" (id 40001, eBay's descriptor guide). */
export const EBAY_CARD_CONDITION_DESCRIPTOR = "40001";

// ── Condition buckets ───────────────────────────────────────────────────────

/** NB's eBay condition buckets, one listing each. */
export type EbayConditionCode = "NM" | "EX" | "VG" | "PR";
export const EBAY_CONDITION_CODES: readonly EbayConditionCode[] = ["NM", "EX", "VG", "PR"];

/** NB condition → bucket. Mint and Near Mint share one; Very Good and Good share one. */
const BUCKET_OF: Record<NbCondition, EbayConditionCode> = {
  Mint: "NM",
  "Near Mint": "NM",
  Excellent: "EX",
  "Very Good": "VG",
  Good: "VG",
  Poor: "PR",
};

/**
 * Bucket → Card Condition descriptor value id. From eBay's condition
 * descriptor values for 40001: 400010 "Near mint or better", 400011
 * "Excellent", 400012 "Very good", 400013 "Poor". UNVERIFIED against a live
 * `getItemConditionPolicies` answer (the published spec documents the shape,
 * not the ids); a wrong id is refused per item and reported as `rejected`.
 */
export const EBAY_DESCRIPTOR_VALUE: Record<EbayConditionCode, string> = {
  NM: "400010",
  EX: "400011",
  VG: "400012",
  PR: "400013",
};

export function ebayBucketOf(condition: NbCondition): EbayConditionCode {
  return BUCKET_OF[condition];
}

/** Every NB condition that folds into `code` (what a sale may lower). */
export function nbConditionsOfBucket(code: string): NbCondition[] {
  return (Object.entries(BUCKET_OF) as Array<[NbCondition, EbayConditionCode]>)
    .filter(([, bucket]) => bucket === code)
    .map(([condition]) => condition);
}

export function isEbayConditionCode(value: string): value is EbayConditionCode {
  return (EBAY_CONDITION_CODES as readonly string[]).includes(value);
}

// ── SKU ─────────────────────────────────────────────────────────────────────

export const EBAY_SKU_PREFIX = "NB2";
const EBAY_SKU_SHAPE = /^NB2-([0-9a-z]{31,37})-(NM|EX|VG|PR)$/;

/** `NB2-<cardId>-<bucket>`. Throws on a card id that is not a Convex id (a caller bug). */
export function buildEbaySku(cardId: Id<"cardChecklist"> | string, code: EbayConditionCode): string {
  if (tableNumberOf(cardId) === null) throw new Error("buildEbaySku: cardId is not a Convex id");
  const sku = `${EBAY_SKU_PREFIX}-${cardId}-${code}`;
  if (sku.length > EBAY_SKU_MAX) throw new Error("buildEbaySku: SKU longer than 50 characters");
  return sku;
}

/**
 * The parts of an NB eBay SKU, or null for anything else (a SKU the seller
 * typed, another tool's, a BSC `NB1-` SKU). The card id is shape-checked only:
 * the caller must still `normalizeId` it and check the link row.
 */
export function parseEbaySku(sku: string | null | undefined): { cardId: string; conditionCode: EbayConditionCode } | null {
  if (typeof sku !== "string") return null;
  const trimmed = sku.trim();
  if (trimmed.length === 0 || trimmed.length > EBAY_SKU_MAX) return null;
  const m = EBAY_SKU_SHAPE.exec(trimmed);
  if (!m) return null;
  const [, cardId, code] = m;
  if (tableNumberOf(cardId) === null) return null;
  return { cardId, conditionCode: code as EbayConditionCode };
}

// ── Fold copies into listings ───────────────────────────────────────────────

/** A copy as the eBay fold reads it (the drain's `variantCopiesPage` row). */
export interface EbayListingCopy extends AgedCopy {
  copyId: Id<"collectionCopies">;
  homeId: Id<"collectionContainers">;
  cardId: Id<"cardChecklist">;
  /** Its home is a LISTED box (`listingOutbox.listsOnMarketplaces`). */
  homeIsBox: boolean;
  graded: boolean;
  quantity: number;
  condition?: NbCondition;
  minPriceCents?: number;
  hasPhotos: boolean;
}

/** One eBay listing's worth of NB stock. */
export interface EbayTarget {
  cardId: Id<"cardChecklist">;
  conditionCode: EbayConditionCode;
  sku: string;
  quantity: number;
  /** Highest floor among the folded copies, raised to eBay's minimum; null = no floor at all. */
  priceCents: number | null;
  /** The oldest copy folded in: the one a sale lowers first, so its photo is the listing's. */
  oldestCopyId: Id<"collectionCopies">;
  oldestHasPhotos: boolean;
}

export type EbayHoldReason = "graded" | "noCondition" | "noPrice" | "noPhoto" | "missingAspect" | "rejected";

export interface EbayHold {
  cardId: Id<"cardChecklist">;
  reason: EbayHoldReason;
  /** NB-written; for `missingAspect` it names the field. */
  detail?: string;
  /** The bucket held back, when one is known (a held listing keeps its live state). */
  conditionCode?: EbayConditionCode;
}

/**
 * Folds the owner's copies of one variant into eBay targets: copies in LISTED
 * boxes only, raw only (graded is held back, NEO-373), grouped by (card,
 * bucket). Quantity is the sum; price is the highest floor
 * (`listingFloorCents`, the add gate's rule) raised to `EBAY_MIN_PRICE_CENTS`.
 * A group with no floor is held back `noPrice`, a copy with no condition
 * `noCondition`, a group whose oldest copy has no photo `noPhoto` (eBay
 * needs a picture). Targets come back for held groups too (`held`), so the
 * drain can leave a live listing alone rather than read the hold as zero.
 */
export function foldEbayTargets(input: {
  copies: readonly EbayListingCopy[];
  commonPriceCents: number | null | undefined;
}): { targets: EbayTarget[]; holds: EbayHold[] } {
  const holds: EbayHold[] = [];
  const holdKeys = new Set<string>();
  const hold = (h: EbayHold) => {
    const key = `${h.cardId}|${h.reason}|${h.conditionCode ?? ""}`;
    if (holdKeys.has(key)) return;
    holdKeys.add(key);
    holds.push(h);
  };
  const groups = new Map<string, { cardId: Id<"cardChecklist">; code: EbayConditionCode; copies: EbayListingCopy[] }>();
  for (const copy of input.copies) {
    if (!copy.homeIsBox) continue;
    if (!Number.isInteger(copy.quantity) || copy.quantity < 1) continue;
    if (copy.graded) {
      hold({ cardId: copy.cardId, reason: "graded" });
      continue;
    }
    if (copy.condition === undefined || !hasListingCondition(copy.condition)) {
      hold({ cardId: copy.cardId, reason: "noCondition" });
      continue;
    }
    const code = ebayBucketOf(copy.condition);
    const key = `${copy.cardId}|${code}`;
    const group = groups.get(key);
    if (group) group.copies.push(copy);
    else groups.set(key, { cardId: copy.cardId, code, copies: [copy] });
  }
  const targets: EbayTarget[] = [];
  for (const { cardId, code, copies } of groups.values()) {
    const sorted = [...copies].sort((a, b) => compareCopiesOldestFirst(a, b));
    const oldest = sorted[0];
    let quantity = 0;
    let floor: number | null = null;
    for (const c of sorted) {
      quantity += c.quantity;
      const f = listingFloorCents(c.minPriceCents, input.commonPriceCents);
      if (f !== null && (floor === null || f > floor)) floor = f;
    }
    targets.push({
      cardId,
      conditionCode: code,
      sku: buildEbaySku(cardId, code),
      quantity,
      priceCents: floor === null ? null : Math.max(floor, EBAY_MIN_PRICE_CENTS),
      oldestCopyId: oldest.copyId,
      oldestHasPhotos: oldest.hasPhotos,
    });
  }
  return { targets, holds };
}

// ── Money ───────────────────────────────────────────────────────────────────

/** Cents → eBay's decimal string ("12.50"). */
export function centsToEbayValue(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${rest.toString().padStart(2, "0")}`;
}

/** eBay Amount.value ("12.5", "0.99") → integer cents, or null for anything else. */
export function ebayValueToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

// ── Aspects ─────────────────────────────────────────────────────────────────

/** The NB facts a listing's aspects are built from (all NB data). */
export interface EbayAspectFacts {
  sport?: string;
  playerNames?: readonly string[];
  teamNames?: readonly string[];
  /** `features.season`, e.g. "1988" or "2021-22". */
  season?: string;
  manufacturer?: string;
  /** NEO-272: the manufacturer row is the all-brands filter, not a brand. */
  manufacturerBrandUnknown?: boolean;
  setName?: string;
  insertName?: string;
  cardNumber: string;
  parallelName?: string;
  isRookie?: boolean;
  /** `features.autographed`: "None" / "On Card" / "Sticker/Label". */
  autographed?: string;
  /** `features.shortPrint`: "None" / "SP" / "SSP". */
  shortPrint?: string;
  printRun?: number;
}

function clean(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/**
 * NB facts → eBay item aspects (name → values). The aspect NAMES are eBay's
 * (the category's aspect list); every VALUE is NB's own data, verbatim. A
 * value longer than `EBAY_ASPECT_VALUE_MAX` (or the aspect's own
 * `maxLength`) is DROPPED, never cut: a cut value would be NB inventing data.
 * If that leaves a required aspect empty, `missingRequiredAspects` names it.
 */
export function buildEbayAspects(
  facts: EbayAspectFacts,
  maxLengths: ReadonlyMap<string, number> = new Map(),
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const put = (name: string, values: ReadonlyArray<string | null | undefined>) => {
    const cap = Math.min(EBAY_ASPECT_VALUE_MAX, maxLengths.get(name) ?? EBAY_ASPECT_VALUE_MAX);
    const kept = [...new Set(values.map(clean).filter((v): v is string => v !== null && v.length <= cap))];
    if (kept.length > 0) out[name] = kept.slice(0, 30);
  };
  const season = clean(facts.season);
  const setName = clean(facts.setName);
  const manufacturer = facts.manufacturerBrandUnknown ? null : clean(facts.manufacturer);
  put("Sport", [facts.sport]);
  put("Player/Athlete", facts.playerNames ?? []);
  put("Team", facts.teamNames ?? []);
  put("Manufacturer", [manufacturer]);
  put("Set", [setName ? [season, setName].filter(Boolean).join(" ") : null]);
  put("Season", [season]);
  // Only a plain four-digit year: "2021-22" is a season, not a year.
  put("Year Manufactured", [season && /^\d{4}$/.test(season) ? season : null]);
  put("Card Number", [facts.cardNumber]);
  const parallel = clean(facts.parallelName);
  if (parallel && parallel.toLowerCase() !== "base") put("Parallel/Variety", [parallel]);
  put("Insert Set", [facts.insertName]);
  const features: string[] = [];
  if (facts.isRookie) features.push("Rookie");
  if (facts.shortPrint === "SP" || facts.shortPrint === "SSP") features.push("Short Print");
  if (features.length > 0) put("Features", features);
  const autographed = clean(facts.autographed);
  const signed = autographed !== null && autographed !== "None";
  put("Autographed", [signed ? "Yes" : "No"]);
  if (signed) put("Autograph Format", [autographed === "On Card" ? "On Card" : "Sticker"]);
  if (typeof facts.printRun === "number" && Number.isInteger(facts.printRun) && facts.printRun > 0) {
    put("Print Run", [String(facts.printRun)]);
  }
  put("Type", ["Sports Trading Card"]);
  put("Graded", ["No"]);
  return out;
}

/** Names of required aspects (`requiredAspectNames`) the built aspects leave empty. */
export function missingRequiredAspects(
  aspects: Readonly<Record<string, readonly string[]>>,
  required: readonly string[],
): string[] {
  return required.filter((name) => !(aspects[name]?.length));
}

/**
 * Narrows a Taxonomy `getItemAspectsForCategory` answer (AspectMetadata) to
 * the required aspect names and every aspect's max length. Anything
 * unreadable is skipped.
 */
export function readCategoryAspects(body: unknown): { required: string[]; maxLengths: Map<string, number> } {
  const required: string[] = [];
  const maxLengths = new Map<string, number>();
  const aspects = isRecord(body) && Array.isArray(body.aspects) ? body.aspects : [];
  for (const aspect of aspects.slice(0, 500)) {
    if (!isRecord(aspect)) continue;
    const name = typeof aspect.localizedAspectName === "string" ? aspect.localizedAspectName : null;
    if (!name || name.length > 100) continue;
    const constraint = isRecord(aspect.aspectConstraint) ? aspect.aspectConstraint : {};
    if (typeof constraint.aspectMaxLength === "number" && constraint.aspectMaxLength > 0) {
      maxLengths.set(name, constraint.aspectMaxLength);
    }
    if (constraint.aspectRequired === true) required.push(name);
  }
  return { required, maxLengths };
}

// ── Item content and its fingerprint ────────────────────────────────────────

/** The listing's text: NB's stored title and description, capped to eBay's limits. */
export function ebayListingText(card: { listingTitle: string; listingDescription?: string }): {
  title: string;
  description: string;
} {
  const title = card.listingTitle.trim().slice(0, EBAY_TITLE_MAX);
  const described = card.listingDescription?.trim();
  const description = (described && described.length > 0 ? described : title).slice(0, EBAY_DESCRIPTION_MAX);
  return { title, description };
}

/** A short stable fingerprint of what NB sent as item content (FNV-1a, hex). */
export function contentFingerprint(value: unknown): string {
  const text = stableJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + text.length.toString(16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ── Policies ────────────────────────────────────────────────────────────────

export interface NarrowFulfillmentPolicy {
  id: string;
  name: string;
  domestic: Array<{ code: string; costCents: number | null; free: boolean }>;
}

/**
 * Narrows `getFulfillmentPolicies` (FulfillmentPolicyResponse) to id, name
 * and the DOMESTIC shipping services. Capped; unreadable entries skipped.
 */
export function readFulfillmentPolicies(body: unknown): NarrowFulfillmentPolicy[] {
  const list = isRecord(body) && Array.isArray(body.fulfillmentPolicies) ? body.fulfillmentPolicies : [];
  const out: NarrowFulfillmentPolicy[] = [];
  for (const p of list.slice(0, 200)) {
    if (!isRecord(p) || typeof p.fulfillmentPolicyId !== "string" || typeof p.name !== "string") continue;
    const domestic: NarrowFulfillmentPolicy["domestic"] = [];
    const options = Array.isArray(p.shippingOptions) ? p.shippingOptions : [];
    for (const o of options) {
      if (!isRecord(o) || o.optionType !== "DOMESTIC" || !Array.isArray(o.shippingServices)) continue;
      for (const s of o.shippingServices) {
        if (!isRecord(s) || typeof s.shippingServiceCode !== "string") continue;
        const cost = isRecord(s.shippingCost) ? ebayValueToCents(s.shippingCost.value) : null;
        domestic.push({ code: s.shippingServiceCode, costCents: cost, free: s.freeShipping === true });
      }
    }
    out.push({ id: p.fulfillmentPolicyId.slice(0, 64), name: p.name.slice(0, 64), domestic });
  }
  return out;
}

/**
 * What NB reads off a fulfillment policy for the two shipping slots.
 *   eseFit    it offers eBay Standard Envelope (a fit for cards under $20)
 *   eseOnly   ESE is its ONLY domestic service, so it cannot ship a card of
 *             $20 or more (ESE covers items under $20): refused for $20+
 *   freeShipping any domestic service is free
 */
export function policyFitness(
  policy: NarrowFulfillmentPolicy,
  /** eBay's own name for each service code, from its shipping metadata (`description`); may be empty. */
  serviceNames: ReadonlyMap<string, string> = new Map(),
): {
  eseFit: boolean;
  eseOnly: boolean;
  freeShipping: boolean;
  summary: string;
} {
  const eseFit = policy.domestic.some((s) => s.code === EBAY_ESE_SERVICE_CODE);
  const eseOnly = policy.domestic.length > 0 && policy.domestic.every((s) => s.code === EBAY_ESE_SERVICE_CODE);
  const freeShipping = policy.domestic.some((s) => s.free || s.costCents === 0);
  const parts = policy.domestic.slice(0, 4).map((s) => {
    const name = ebayServiceLabel(s.code, serviceNames);
    const price =
      s.free || s.costCents === 0 ? "free" : s.costCents !== null ? `$${centsToEbayValue(s.costCents)}` : EBAY_CALCULATED_LABEL;
    return `${name}, ${price}`;
  });
  const summary = parts.length > 0 ? parts.join("; ") : "No domestic shipping";
  return { eseFit, eseOnly, freeShipping, summary: summary.slice(0, 160) };
}

/** How a calculated service's price reads on the picker: eBay prices it from the card's package weight. */
export const EBAY_CALCULATED_LABEL = "eBay's rate by weight";
/** A service eBay's metadata gave no name for. Never the raw code. */
export const EBAY_UNNAMED_SERVICE_LABEL = "eBay shipping";

/**
 * A shipping service as the collector reads it, never eBay's raw code:
 * Standard Envelope by NB's name for it; anything else by eBay's own name
 * from its shipping metadata; a code eBay gave no name for is "eBay shipping".
 */
export function ebayServiceLabel(code: string, serviceNames: ReadonlyMap<string, string>): string {
  if (code === EBAY_ESE_SERVICE_CODE) return "Standard Envelope";
  const name = serviceNames.get(code)?.replace(/\s+/g, " ").trim();
  return name ? name.slice(0, 60) : EBAY_UNNAMED_SERVICE_LABEL;
}

/** Code → eBay's own name, for the services its metadata named. */
export function ebayServiceNames(services: ReadonlyArray<{ code: string; description: string | null }>): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of services) if (s.description && s.description.trim()) names.set(s.code, s.description);
  return names;
}

/** The shipping slot a price uses: $20.00 and up → the 20+ policy. */
export function fulfillmentSlotFor(priceCents: number): "under20" | "twentyPlus" {
  return priceCents >= EBAY_ESE_PRICE_CAP_CENTS ? "twentyPlus" : "under20";
}

// ── Shipping: cost type and package ─────────────────────────────────────────

/**
 * eBay's calculated-shipping cost type (Sell Account ShippingOption.costType:
 * "the shipping rate varies by the ship-to location and size and weight of
 * the package"). With it the policy carries no shipping cost; eBay prices
 * each order from the item's package and the seller's ship-from postal code.
 */
export const EBAY_COST_TYPE_CALCULATED = "CALCULATED";
export const EBAY_COST_TYPE_FLAT_RATE = "FLAT_RATE";

/**
 * False only when eBay's own shipping metadata lists `code` with its cost
 * types and CALCULATED is not among them (Sell Metadata
 * `getShippingServices` → `shippingCostTypes`). A service the metadata does
 * not mention, or lists without cost types, is left to eBay to accept or
 * refuse when the policy is made.
 */
export function ebayServiceTakesCalculated(
  services: ReadonlyArray<{ code: string; costTypes: readonly string[] }>,
  code: string,
): boolean {
  const service = services.find((s) => s.code === code);
  if (!service || service.costTypes.length === 0) return true;
  return service.costTypes.some((t) => t.toUpperCase() === EBAY_COST_TYPE_CALCULATED);
}

/** A shipping service as eBay's metadata lists it (`adapters/ebaySeller.getShippingServices`). */
export interface EbayMetadataService {
  code: string;
  description: string | null;
  carrier: string | null;
  international: boolean;
  validForSelling: boolean;
}

/** Lower case, trademark marks dropped, every run of other characters one space. */
function serviceWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The phrase that names the service, as words. */
const GROUND_ADVANTAGE_WORDS = "ground advantage";
/** USPS's own name for it (the carrier's name, not an eBay code). */
const GROUND_ADVANTAGE_NAME = "usps ground advantage";

/**
 * eBay's USPS Ground Advantage service, read from eBay's own shipping
 * metadata, never a hard-coded code: eBay kept older codes when USPS renamed
 * its ground services in 2023 (sellers report Ground Advantage behind
 * `USPSParcel`), so the code alone may not say "Ground Advantage" at all.
 * Only domestic services valid for selling count. In order, each step taking
 * exactly one service or passing its candidates on:
 *   1. code   the code names it ("groundadvantage", separators ignored);
 *             several → the ones whose code starts with "USPS"
 *   2. name   eBay's localized name is exactly "USPS Ground Advantage"
 *             (case, ™/® and a trailing "(…)" note ignored)
 *   3. words  the name says "ground advantage" and the carrier or the name
 *             says USPS
 * Still several at a step (or none anywhere) → null: NB never gives a tie to
 * the first candidate, and makes no tracked policy on a guess.
 */
export function ebayGroundAdvantageService(services: ReadonlyArray<EbayMetadataService>): EbayMetadataService | null {
  const pool = services.filter((s) => !s.international && s.validForSelling);
  const one = <T>(list: T[]): T | null => (list.length === 1 ? list[0] : null);

  const byCode = pool.filter((s) => serviceWords(s.code).replace(/ /g, "").includes("groundadvantage"));
  if (byCode.length === 1) return byCode[0];
  const uspsCodes = byCode.filter((s) => /^usps/i.test(s.code));
  if (uspsCodes.length === 1) return uspsCodes[0];
  // Several codes name it: the name decides among them; no code names it: among all.
  const named = byCode.length > 0 ? (uspsCodes.length > 0 ? uspsCodes : byCode) : pool;

  const nameOf = (s: EbayMetadataService) => serviceWords((s.description ?? "").replace(/\s*\([^)]*\)\s*$/, ""));
  const exact = named.filter((s) => nameOf(s) === GROUND_ADVANTAGE_NAME);
  if (exact.length > 0) return one(exact);

  const words = named.filter((s) => {
    const name = nameOf(s);
    if (!` ${name} `.includes(` ${GROUND_ADVANTAGE_WORDS} `)) return false;
    return /\busps\b/.test(serviceWords(s.description ?? "")) || serviceWords(s.carrier ?? "") === "usps";
  });
  return one(words);
}

/**
 * Package weights NB declares for a RAW card, in ounces (Jason, NEO-415):
 * a single card in a Standard Envelope letter is 1 oz; a card packaged in a
 * bubble mailer (tracked, $20 and up) is 6 oz. Calculated shipping prices
 * from these. Graded cards are held from eBay today; when they list they
 * need their own weight (a slab ships heavier), so add a third package then
 * rather than reusing either of these.
 */
export const EBAY_ENVELOPE_WEIGHT_OZ = 1;
export const EBAY_MAILER_WEIGHT_OZ = 6;

/**
 * Sell Inventory `packageWeightAndSize` for a raw card under $20: a letter
 * (eBay Standard Envelope takes letters up to 6.125" × 11.5" × 0.25").
 * `packageType` values are PackageTypeEnum's; the enum's values are not in
 * the published OpenAPI document (it links out), so LETTER and PADDED_BAGS
 * are UNVERIFIED against the contract (they match eBay's Trading
 * ShippingPackageCodeType Letter / PaddedBags). Dimensions are NB product
 * defaults: eBay says calculated shipping needs them.
 */
export const EBAY_ENVELOPE_PACKAGE = {
  packageType: "LETTER",
  weight: { value: EBAY_ENVELOPE_WEIGHT_OZ, unit: "OUNCE" },
  dimensions: { length: 6, width: 4, height: 0.25, unit: "INCH" },
} as const;

/** `packageWeightAndSize` for a raw card at $20 and up: a padded (bubble) mailer, tracked. */
export const EBAY_MAILER_PACKAGE = {
  packageType: "PADDED_BAGS",
  weight: { value: EBAY_MAILER_WEIGHT_OZ, unit: "OUNCE" },
  dimensions: { length: 10, width: 6, height: 1, unit: "INCH" },
} as const;

export type EbayPackage = typeof EBAY_ENVELOPE_PACKAGE | typeof EBAY_MAILER_PACKAGE;

/** The package a raw card ships in at this price: it follows the shipping slot. */
export function ebayPackageFor(priceCents: number): EbayPackage {
  return fulfillmentSlotFor(priceCents) === "twentyPlus" ? EBAY_MAILER_PACKAGE : EBAY_ENVELOPE_PACKAGE;
}

export interface NarrowReturnPolicy {
  id: string;
  name: string;
  summary: string;
}

export function readReturnPolicies(body: unknown): NarrowReturnPolicy[] {
  const list = isRecord(body) && Array.isArray(body.returnPolicies) ? body.returnPolicies : [];
  const out: NarrowReturnPolicy[] = [];
  for (const p of list.slice(0, 200)) {
    if (!isRecord(p) || typeof p.returnPolicyId !== "string" || typeof p.name !== "string") continue;
    let summary = "No returns";
    if (p.returnsAccepted === true) {
      const period = isRecord(p.returnPeriod) ? p.returnPeriod : {};
      const days = typeof period.value === "number" && period.unit === "DAY" ? `${period.value} days` : "Returns accepted";
      const payer = p.returnShippingCostPayer === "SELLER" ? "you pay return shipping" : "buyer pays return shipping";
      summary = `${days}, ${payer}`;
    }
    out.push({ id: p.returnPolicyId.slice(0, 64), name: p.name.slice(0, 64), summary });
  }
  return out;
}

export function readPaymentPolicies(body: unknown): Array<{ id: string; name: string }> {
  const list = isRecord(body) && Array.isArray(body.paymentPolicies) ? body.paymentPolicies : [];
  const out: Array<{ id: string; name: string }> = [];
  for (const p of list.slice(0, 200)) {
    if (!isRecord(p) || typeof p.paymentPolicyId !== "string" || typeof p.name !== "string") continue;
    out.push({ id: p.paymentPolicyId.slice(0, 64), name: p.name.slice(0, 64) });
  }
  return out;
}

// ── Orders ──────────────────────────────────────────────────────────────────

export interface EbayOrderLine {
  /** eBay legacy item id: the listing id NB's link row holds. */
  legacyItemId: string;
  sku: string | null;
  quantity: number;
  /** Per unit, cents: lineItemCost / quantity, rounded. */
  unitPriceCents: number;
}

export interface EbayProjectedOrder {
  orderId: string;
  /** What the seller sees (eBay shows the order id). */
  orderNo: string;
  orderDate: number;
  lastModified: number;
  /** NB's status word for the Sales screen (see `ebayOrderStatus`). */
  status: string;
  disposition: "sale" | "cancelled" | "unknown";
  totals: { subtotalCents?: number; shippingCents?: number; feesCents?: number; totalCents?: number };
  lines: EbayOrderLine[];
}

/** An order holds at most this many lines NB will read. */
export const EBAY_ORDER_MAX_LINES = 200;

/**
 * Whether an order lowers NB's copies. `cancelState` CANCELED or a full
 * refund → cancelled (lowers nothing); `orderPaymentStatus` PAID (or a
 * partial refund: the sale stands) → sale; anything else (PENDING, FAILED)
 * → unknown, so a later poll decides.
 */
export function ebayOrderDisposition(order: {
  cancelState?: string;
  paymentStatus?: string;
}): "sale" | "cancelled" | "unknown" {
  if (order.cancelState === "CANCELED") return "cancelled";
  if (order.paymentStatus === "FULLY_REFUNDED") return "cancelled";
  if (order.paymentStatus === "PAID" || order.paymentStatus === "PARTIALLY_REFUNDED") return "sale";
  return "unknown";
}

/** The order statuses NB stores for eBay (the web maps each to its own words). */
export const EBAY_ORDER_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "FULFILLED",
  "PAID",
  "PENDING",
  "FAILED",
  "FULLY_REFUNDED",
  "PARTIALLY_REFUNDED",
  "CANCELED",
] as const;
export type EbayOrderStatus = (typeof EBAY_ORDER_STATUSES)[number];

const FULFILLMENT_STATUSES: ReadonlySet<string> = new Set(["NOT_STARTED", "IN_PROGRESS", "FULFILLED"]);

/**
 * The status stored on the sale row: always one of `EBAY_ORDER_STATUSES`,
 * chosen so the Sales screen says what matters most. A cancelled order says
 * CANCELED (a cancellation still being decided is not one yet); then a full
 * or partial refund, or a payment not through (PENDING, FAILED); then the
 * fulfillment status (NOT_STARTED, IN_PROGRESS, FULFILLED); then PAID. An
 * order NB cannot read the state of says PENDING.
 */
export function ebayOrderStatus(order: {
  cancelState?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
}): EbayOrderStatus {
  if (order.cancelState === "CANCELED") return "CANCELED";
  switch (order.paymentStatus) {
    case "FULLY_REFUNDED":
    case "PARTIALLY_REFUNDED":
    case "PENDING":
    case "FAILED":
      return order.paymentStatus;
    default:
      break;
  }
  if (order.fulfillmentStatus && FULFILLMENT_STATUSES.has(order.fulfillmentStatus)) {
    return order.fulfillmentStatus as EbayOrderStatus;
  }
  return order.paymentStatus === "PAID" ? "PAID" : "PENDING";
}

/**
 * The disposition of a STORED eBay status (`ebayOrderStatus`'s word): what
 * the sale-apply step reads back off the row. CANCELED and FULLY_REFUNDED
 * lower nothing; PENDING and FAILED wait for a later poll; every other word
 * is a paid order (fulfillment states are only reported once payment is
 * through, and a partial refund leaves the sale standing).
 */
export function ebayStatusDisposition(status: string): "sale" | "cancelled" | "unknown" {
  switch (status) {
    case "CANCELED":
    case "FULLY_REFUNDED":
      return "cancelled";
    case "NOT_STARTED":
    case "IN_PROGRESS":
    case "FULFILLED":
    case "PAID":
    case "PARTIALLY_REFUNDED":
      return "sale";
    default:
      return "unknown";
  }
}

/** eBay statuses after which NB stops re-reading the order on its own. */
export function isFinalEbayStatus(status: string): boolean {
  return status === "FULFILLED" || status === "CANCELED" || status === "FULLY_REFUNDED";
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Projects one Fulfillment `Order` to what NB stores. NO buyer data: the
 * buyer, the ship-to (`fulfillmentStartInstructions`) and checkout notes are
 * never read. Null for an order NB cannot read (no id or date).
 */
export function projectEbayOrder(raw: unknown): EbayProjectedOrder | null {
  if (!isRecord(raw)) return null;
  const orderId = typeof raw.orderId === "string" && raw.orderId.length > 0 && raw.orderId.length <= 64 ? raw.orderId : null;
  const orderDate = parseIsoMs(raw.creationDate);
  if (!orderId || orderDate === null) return null;
  const lastModified = parseIsoMs(raw.lastModifiedDate) ?? orderDate;
  const cancel = isRecord(raw.cancelStatus) ? raw.cancelStatus : {};
  const statusFacts = {
    cancelState: typeof cancel.cancelState === "string" ? cancel.cancelState.slice(0, 40) : undefined,
    paymentStatus: typeof raw.orderPaymentStatus === "string" ? raw.orderPaymentStatus.slice(0, 40) : undefined,
    fulfillmentStatus: typeof raw.orderFulfillmentStatus === "string" ? raw.orderFulfillmentStatus.slice(0, 40) : undefined,
  };
  const pricing = isRecord(raw.pricingSummary) ? raw.pricingSummary : {};
  const amount = (a: unknown): number | undefined => {
    if (!isRecord(a)) return undefined;
    const cents = ebayValueToCents(a.value);
    return cents === null ? undefined : cents;
  };
  const totals: EbayProjectedOrder["totals"] = {};
  const subtotal = amount(pricing.priceSubtotal);
  const shipping = amount(pricing.deliveryCost);
  const total = amount(pricing.total);
  const fees = amount(raw.totalMarketplaceFee);
  if (subtotal !== undefined) totals.subtotalCents = subtotal;
  if (shipping !== undefined) totals.shippingCents = shipping;
  if (fees !== undefined) totals.feesCents = fees;
  if (total !== undefined) totals.totalCents = total;
  const lines: EbayOrderLine[] = [];
  const rawLines = Array.isArray(raw.lineItems) ? raw.lineItems : [];
  for (const line of rawLines.slice(0, EBAY_ORDER_MAX_LINES)) {
    if (!isRecord(line)) continue;
    const legacyItemId = typeof line.legacyItemId === "string" && line.legacyItemId.length <= 40 ? line.legacyItemId : null;
    const quantity = typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : null;
    const cost = isRecord(line.lineItemCost) ? ebayValueToCents(line.lineItemCost.value) : null;
    if (!legacyItemId || quantity === null || quantity < 1 || cost === null) continue;
    const sku = typeof line.sku === "string" && line.sku.length <= EBAY_SKU_MAX ? line.sku : null;
    lines.push({ legacyItemId, sku, quantity, unitPriceCents: Math.round(cost / quantity) });
  }
  return {
    orderId,
    orderNo: orderId,
    orderDate,
    lastModified,
    status: ebayOrderStatus(statusFacts),
    disposition: ebayOrderDisposition(statusFacts),
    totals,
    lines,
  };
}

/** `getOrders` filter for orders modified at or after `sinceMs` (ISO 8601, UTC). */
export function ordersModifiedSinceFilter(sinceMs: number): string {
  return `lastmodifieddate:[${new Date(sinceMs).toISOString()}..]`;
}

// ── Misc ────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A US ZIP (5 or ZIP+4). */
export function isUsPostalCode(value: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(value.trim());
}

/** A two-letter US state or territory code. */
export function isUsStateCode(value: string): boolean {
  return /^[A-Za-z]{2}$/.test(value.trim());
}

// ── Settings completeness ───────────────────────────────────────────────────

export type EbaySetupItem = "location" | "shippingUnder20" | "shipping20Plus" | "payment" | "returns";

/** What the collector's eBay settings still lack before anything may list (in page order). */
export function ebaySetupMissing(
  settings: {
    fulfillmentPolicyUnder20Id?: string;
    fulfillmentPolicy20PlusId?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
    merchantLocationKey?: string;
    location?: unknown;
  } | null,
): EbaySetupItem[] {
  const missing: EbaySetupItem[] = [];
  // Ships from comes first: Set me up's calculated policies need the ZIP.
  if (!settings?.location || !settings.merchantLocationKey) missing.push("location");
  if (!settings?.fulfillmentPolicyUnder20Id) missing.push("shippingUnder20");
  if (!settings?.fulfillmentPolicy20PlusId) missing.push("shipping20Plus");
  if (!settings?.paymentPolicyId) missing.push("payment");
  if (!settings?.returnPolicyId) missing.push("returns");
  return missing;
}

/** The inventory location key NB creates on a collector's eBay account (≤36 chars, eBay's cap). */
export const EBAY_MERCHANT_LOCATION_KEY = "neonbinder-main";
