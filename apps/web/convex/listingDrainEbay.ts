/**
 * NEO-415 — the eBay half of the per-owner listing drainer.
 *
 * eBay is a CARD-level platform: NB makes one listing per (owner, card,
 * condition bucket) on the collector's own eBay account, keyed by NB's SKU
 * (`NB2-<cardId>-<bucket>`, `lib/ebayListing`). NB is the only truth: the
 * quantity is NB's count of the card in LISTED boxes, the price NB's floor,
 * the text NB's stored title and description, the aspects NB's own facts.
 * Nothing eBay says decides NB behaviour; what NB keeps of eBay is linkage
 * (`marketplaceListingLinks`: offer and listing ids, and what NB last sent).
 *
 * The drain shares NEO-370's machinery (`listingDrain`): the owner lease
 * (`claimDrain`, which for eBay also refuses until the collector's eBay
 * settings are complete, `setupIncomplete`), the per-variant walk of the
 * outbox (`nextOutboxVariant`, `outboxSnapshot`, `claimVariant`,
 * `finishVariant`, seq-guarded clears), the variant's copies
 * (`variantCopiesPage`) and the sync record's counts and problems. Per
 * variant it:
 *
 *   1. folds the owner's copies into targets (`foldEbayTargets`: listed
 *      boxes only, raw only, grouped by card and bucket) and holds back
 *      graded, no-condition, no-price, no-photo and missing-aspect cards;
 *   2. reads NB's link rows for the cards in play (every card of the variant
 *      on a full read: first run or a Sync press; else the queued cards and
 *      the targets), and decides per listing what changed;
 *   3. uploads photos (Media API) for listings whose picture changed,
 *      replaces inventory items whose content changed, creates offers for new
 *      listings (adopting an offer eBay already holds for the SKU), replaces
 *      offers whose policies changed, updates price and quantity on live
 *      ones, publishes new and returning listings, and withdraws a live
 *      listing whose count went to 0 (its link goes `ended`; the offer is
 *      kept so the listing is published again when stock returns);
 *   4. writes the link rows as each step lands and the variant's summary.
 *
 * NEO-415: the steps it takes (photos, items, offers, publish, withdraw;
 * only those this run needs) are ticked off on the sync record one write
 * each (`listingDrain.ProgressLedger`), and a step eBay stops is said in NB
 * words for that step (`EBAY_STEP_SAYS`); eBay's status and error ids stay
 * in the structured log lines.
 *
 * Only what changed is sent (eBay limits revisions per listing per day). A
 * held-back card with a live listing is left as it is (the BSC rule): a hold
 * is "NB can't say", never "zero". Errors are per variant, a dead session or
 * a pause stops the whole drain.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { ebayConditionCodeValidator } from "./schema";
import { copyPhotoObjectKey, MAX_COPY_PHOTO_BYTES } from "./copyPhotos";
import { commonPriceCentsOf } from "./listingGate";
import { titleChainFacts } from "./listingShortName";
import { teamFullName } from "../lib/teams/team-name";
import {
  DRAIN_BUDGET_MS,
  EBAY_SETUP_INCOMPLETE_ERROR,
  MAX_STORED_PROBLEMS,
  ProgressLedger,
  defaultFetchPhoto,
  distinctCards,
  newToken,
  settleRows,
  type CopyOut,
  type DrainCtx,
  type DrainOptions,
  type DrainReport,
  type FinishOutcome,
  type StoredProblem,
} from "./listingDrain";
import {
  EBAY_BULK_LIMIT,
  EBAY_CARD_CATEGORY_ID,
  EBAY_CARD_CONDITION_DESCRIPTOR,
  EBAY_DESCRIPTOR_VALUE,
  EBAY_LOCALE,
  EBAY_MARKETPLACE_ID,
  EBAY_UNGRADED_CONDITION,
  buildEbayAspects,
  centsToEbayValue,
  contentFingerprint,
  ebayListingText,
  ebayPackageFor,
  foldEbayTargets,
  fulfillmentSlotFor,
  missingRequiredAspects,
  readCategoryAspects,
  type EbayAspectFacts,
  type EbayConditionCode,
  type EbayHold,
  type EbayTarget,
} from "./lib/ebayListing";
import {
  bulkCreateOffers,
  bulkCreateOrReplaceInventoryItems,
  bulkPublishOffers,
  bulkUpdatePriceQuantity,
  getCardCategoryAspects,
  getOfferBySku,
  openEbaySellerSession,
  sayEbayFailure,
  updateOffer,
  uploadImage,
  withdrawOffer,
  type EbayFailure,
  type EbayResult,
  type EbaySellerSession,
} from "./adapters/ebaySeller";

// ── Limits ─────────────────────────────────────────────────────────────────

/** Photo uploads one variant makes per run; the rest wait for the next run. */
export const MAX_EBAY_UPLOADS_PER_VARIANT = 40;
/** Cards one facts / links / photos read covers. */
const READ_CHUNK = 100;
const MAX_DETAIL = 160;
/** eBay's "an offer already exists for this SKU" (Sell Inventory error 25002). */
const OFFER_EXISTS_ERROR_IDS = new Set([25002]);
/** A picture is re-uploaded when an unused one expires within this long. */
const IMAGE_FRESH_MS = 24 * 60 * 60 * 1000;

type Platform = "ebay";

// ── Reads ──────────────────────────────────────────────────────────────────

const settingsOutValidator = v.object({
  fulfillmentPolicyUnder20Id: v.string(),
  fulfillmentPolicy20PlusId: v.string(),
  paymentPolicyId: v.string(),
  returnPolicyId: v.string(),
  merchantLocationKey: v.string(),
  bestOffer: v.boolean(),
});
type EbaySettingsOut = typeof settingsOutValidator.type;

/**
 * What one variant's eBay push reads from NB besides copies: its set (the
 * copy index's key), the owner's common price, the owner's eBay settings
 * (complete, or null) and the eBay user id NB binds the seller account by.
 */
export const ebayVariantInput = internalQuery({
  args: { ownerId: v.string(), variantId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ kind: v.literal("gone") }),
    v.object({
      kind: v.literal("ok"),
      setId: v.union(v.id("selectorOptions"), v.null()),
      commonPriceCents: v.union(v.number(), v.null()),
      settings: v.union(settingsOutValidator, v.null()),
      ebayUserId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const leaf = await ctx.db.get(args.variantId);
    if (!leaf) return { kind: "gone" as const };
    let setId: Id<"selectorOptions"> | null = null;
    let cursor: Doc<"selectorOptions"> | null = leaf;
    for (let depth = 0; cursor && depth < 16; depth += 1) {
      if (cursor.level === "setName") {
        setId = cursor._id;
        break;
      }
      cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
    }
    const commonPriceCents = await commonPriceCentsOf(ctx, args.ownerId, args.variantId);
    const row = await ctx.db
      .query("ebaySellerSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    const settings: EbaySettingsOut | null =
      row &&
      row.fulfillmentPolicyUnder20Id &&
      row.fulfillmentPolicy20PlusId &&
      row.paymentPolicyId &&
      row.returnPolicyId &&
      row.merchantLocationKey &&
      row.location
        ? {
            fulfillmentPolicyUnder20Id: row.fulfillmentPolicyUnder20Id,
            fulfillmentPolicy20PlusId: row.fulfillmentPolicy20PlusId,
            paymentPolicyId: row.paymentPolicyId,
            returnPolicyId: row.returnPolicyId,
            merchantLocationKey: row.merchantLocationKey,
            bestOffer: row.bestOffer !== false,
          }
        : null;
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.ownerId))
      .unique();
    return {
      kind: "ok" as const,
      setId,
      commonPriceCents,
      settings,
      ebayUserId: profile?.marketplaceAccountIds?.ebayUserId ?? null,
    };
  },
});

/** Every card id of a variant (ids only), paged. */
export const ebayVariantCardIdsPage = internalQuery({
  args: { variantId: v.id("selectorOptions"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ cardIds: v.array(v.id("cardChecklist")), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", args.variantId))
      .paginate({ numItems: 500, cursor: args.cursor });
    return { cardIds: page.page.map((c) => c._id), cursor: page.continueCursor, isDone: page.isDone };
  },
});

const linkOutValidator = v.object({
  linkId: v.id("marketplaceListingLinks"),
  cardId: v.id("cardChecklist"),
  conditionCode: ebayConditionCodeValidator,
  sku: v.string(),
  offerId: v.union(v.string(), v.null()),
  listingId: v.union(v.string(), v.null()),
  status: v.union(v.literal("draft"), v.literal("live"), v.literal("ended")),
  pushed: v.union(
    v.object({
      quantity: v.number(),
      priceCents: v.number(),
      fulfillmentPolicyId: v.string(),
      paymentPolicyId: v.string(),
      returnPolicyId: v.string(),
      bestOffer: v.boolean(),
      contentHash: v.string(),
    }),
    v.null(),
  ),
  images: v.array(v.object({ url: v.string(), photoToken: v.string(), expiresAt: v.optional(v.number()) })),
});
type LinkOut = typeof linkOutValidator.type;

/** The owner's eBay link rows for some cards (every bucket). */
export const ebayLinksForCards = internalQuery({
  args: { ownerId: v.string(), cardIds: v.array(v.id("cardChecklist")) },
  returns: v.array(linkOutValidator),
  handler: async (ctx, args) => {
    const out: LinkOut[] = [];
    for (const cardId of args.cardIds.slice(0, READ_CHUNK)) {
      const rows = await ctx.db
        .query("marketplaceListingLinks")
        .withIndex("by_owner_platform_card_condition", (q) =>
          q.eq("ownerId", args.ownerId).eq("platform", "ebay").eq("cardId", cardId),
        )
        .take(8);
      for (const row of rows) {
        out.push({
          linkId: row._id,
          cardId: row.cardId,
          conditionCode: row.conditionCode,
          sku: row.sku,
          offerId: row.offerId ?? null,
          listingId: row.listingId ?? null,
          status: row.status,
          pushed: row.pushed ?? null,
          images: row.images ?? [],
        });
      }
    }
    return out;
  },
});

const cardFactsValidator = v.object({
  cardId: v.id("cardChecklist"),
  listingTitle: v.string(),
  listingDescription: v.optional(v.string()),
  facts: v.object({
    sport: v.optional(v.string()),
    playerNames: v.array(v.string()),
    teamNames: v.array(v.string()),
    season: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    manufacturerBrandUnknown: v.optional(v.boolean()),
    setName: v.optional(v.string()),
    insertName: v.optional(v.string()),
    cardNumber: v.string(),
    parallelName: v.optional(v.string()),
    isRookie: v.optional(v.boolean()),
    autographed: v.optional(v.string()),
    shortPrint: v.optional(v.string()),
    printRun: v.optional(v.number()),
  }),
});
type CardFacts = typeof cardFactsValidator.type;

/**
 * NB's facts for some cards: the stored listing title and description, and
 * the aspect facts (the card's own features, players and teams, and its
 * chain's set, brand and insert, read the way the title generator reads
 * them: `listingShortName.titleChainFacts`). All NB data.
 */
export const ebayCardFacts = internalQuery({
  args: { cardIds: v.array(v.id("cardChecklist")) },
  returns: v.array(cardFactsValidator),
  handler: async (ctx, args) => {
    const chains = new Map<string, { setName?: string; manufacturer?: Doc<"selectorOptions">; insertName?: string; parallelLeaf?: string }>();
    const chainOf = async (leafId: Id<"selectorOptions">) => {
      const known = chains.get(leafId);
      if (known) return known;
      const rows: Array<Doc<"selectorOptions">> = [];
      let cursor: Doc<"selectorOptions"> | null = await ctx.db.get(leafId);
      for (let depth = 0; cursor && depth < 16; depth += 1) {
        rows.push(cursor);
        cursor = cursor.parentId ? await ctx.db.get(cursor.parentId) : null;
      }
      const facts = titleChainFacts(rows);
      const setNameRow = rows.find((r) => r.level === "setName");
      const manufacturer = rows.find((r) => r.level === "manufacturer");
      const out = {
        ...(setNameRow ? { setName: setNameRow.value } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        ...(facts.insertIsRole && facts.insertNameValue ? { insertName: facts.insertNameValue } : {}),
        ...(facts.parallelLeafValue ? { parallelLeaf: facts.parallelLeafValue } : {}),
      };
      chains.set(leafId, out);
      return out;
    };
    const sports = new Map<string, string | undefined>();
    const out: CardFacts[] = [];
    for (const cardId of args.cardIds.slice(0, READ_CHUNK)) {
      const card = await ctx.db.get(cardId);
      if (!card) continue;
      const chain = await chainOf(card.selectorOptionId);
      if (!sports.has(card.sportId)) sports.set(card.sportId, (await ctx.db.get(card.sportId))?.value);
      const playerNames: string[] = [];
      for (const id of (card.playerIds ?? []).slice(0, 10)) {
        const player = await ctx.db.get(id);
        if (player) playerNames.push(player.name);
      }
      const teamNames: string[] = [];
      for (const id of (card.teamOnCardIds ?? []).slice(0, 10)) {
        const team = await ctx.db.get(id);
        if (team) teamNames.push(teamFullName(team));
      }
      const features = card.features ?? {};
      const parallel = features.parallelName?.trim() ? features.parallelName : chain.parallelLeaf;
      const sport = sports.get(card.sportId);
      out.push({
        cardId,
        listingTitle: card.listingTitle,
        ...(card.listingDescription !== undefined ? { listingDescription: card.listingDescription } : {}),
        facts: {
          ...(sport ? { sport } : {}),
          playerNames,
          teamNames,
          ...(features.season ? { season: features.season } : {}),
          ...(features.manufacturer ? { manufacturer: features.manufacturer } : chain.manufacturer ? { manufacturer: chain.manufacturer.value } : {}),
          ...(chain.manufacturer?.metadata?.isBrandUnknown === true ? { manufacturerBrandUnknown: true } : {}),
          ...(chain.setName ? { setName: chain.setName } : {}),
          ...(chain.insertName ? { insertName: chain.insertName } : {}),
          cardNumber: card.cardNumber,
          ...(parallel ? { parallelName: parallel } : {}),
          ...(card.isRookie ? { isRookie: true } : {}),
          ...(features.autographed ? { autographed: features.autographed } : {}),
          ...(features.shortPrint ? { shortPrint: features.shortPrint } : {}),
          ...(typeof card.printRun === "number" ? { printRun: card.printRun } : {}),
        },
      });
    }
    return out;
  },
});

/** The live front and back photos of some copies (object keys; no cap beyond the chunk). */
export const ebayCopyPhotos = internalQuery({
  args: { ownerId: v.string(), copyIds: v.array(v.id("collectionCopies")) },
  returns: v.array(
    v.object({
      copyId: v.id("collectionCopies"),
      side: v.union(v.literal("front"), v.literal("back")),
      key: v.string(),
      contentType: v.union(v.literal("image/jpeg"), v.literal("image/webp")),
      imageBytes: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const out = [];
    for (const copyId of args.copyIds.slice(0, READ_CHUNK)) {
      const photos = await ctx.db
        .query("collectionCopyPhotos")
        .withIndex("by_copy_and_status", (q) => q.eq("copyId", copyId).eq("status", "live"))
        .take(2);
      for (const photo of photos) {
        if (photo.ownerId !== args.ownerId) continue;
        out.push({
          copyId,
          side: photo.side,
          key: copyPhotoObjectKey(photo.token, "image", photo.contentType),
          contentType: photo.contentType,
          imageBytes: photo.imageBytes,
        });
      }
    }
    return out;
  },
});

// ── Writes ─────────────────────────────────────────────────────────────────

const linkWriteValidator = v.object({
  cardId: v.id("cardChecklist"),
  conditionCode: ebayConditionCodeValidator,
  sku: v.string(),
  offerId: v.optional(v.string()),
  listingId: v.optional(v.string()),
  /** The listing id a republish just replaced; kept in `previousListingIds` so a late sale on it still routes. */
  retiredListingId: v.optional(v.string()),
  status: v.union(v.literal("draft"), v.literal("live"), v.literal("ended")),
  /** null clears what was pushed (a withdrawn listing keeps it: pass it again). */
  pushed: v.optional(
    v.object({
      quantity: v.number(),
      priceCents: v.number(),
      fulfillmentPolicyId: v.string(),
      paymentPolicyId: v.string(),
      returnPolicyId: v.string(),
      bestOffer: v.boolean(),
      contentHash: v.string(),
    }),
  ),
  images: v.optional(v.array(v.object({ url: v.string(), photoToken: v.string(), expiresAt: v.optional(v.number()) }))),
});
type LinkWrite = typeof linkWriteValidator.type;

/** Earlier listing ids one link remembers (`marketplaceListingLinks.previousListingIds`). */
const MAX_PREVIOUS_LISTING_IDS = 5;

/**
 * Upserts link rows (one per owner, eBay, card, bucket). Only the run
 * holding the owner's drain lease writes; a run that lost it writes nothing.
 * A field absent on a write keeps the stored value.
 */
export const recordEbayLinks = internalMutation({
  args: { ownerId: v.string(), leaseToken: v.string(), links: v.array(linkWriteValidator) },
  returns: v.object({ written: v.number() }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", args.ownerId).eq("platform", "ebay"))
      .unique();
    // A listing NB made on eBay must stay linked even if the run lost its
    // lease mid-step (product invariant 5): the ids are recorded regardless,
    // only a row the run does not own is never created from nothing.
    const leaseHeld = state?.drainLeaseToken === args.leaseToken;
    const now = Date.now();
    let written = 0;
    for (const link of args.links.slice(0, 200)) {
      const existing = await ctx.db
        .query("marketplaceListingLinks")
        .withIndex("by_owner_platform_card_condition", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("platform", "ebay")
            .eq("cardId", link.cardId)
            .eq("conditionCode", link.conditionCode),
        )
        .unique();
      const previous = existing?.previousListingIds ?? [];
      const retired =
        link.retiredListingId !== undefined &&
        link.retiredListingId !== (link.listingId ?? existing?.listingId) &&
        !previous.includes(link.retiredListingId)
          ? { previousListingIds: [link.retiredListingId, ...previous].slice(0, MAX_PREVIOUS_LISTING_IDS) }
          : {};
      const fields = {
        sku: link.sku,
        status: link.status,
        ...retired,
        ...(link.offerId !== undefined ? { offerId: link.offerId } : {}),
        ...(link.listingId !== undefined ? { listingId: link.listingId } : {}),
        ...(link.pushed !== undefined ? { pushed: link.pushed } : {}),
        ...(link.images !== undefined ? { images: link.images } : {}),
        lastPushedAt: now,
        lastUpdated: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
      } else if (leaseHeld || link.offerId !== undefined) {
        await ctx.db.insert("marketplaceListingLinks", {
          ownerId: args.ownerId,
          platform: "ebay",
          cardId: link.cardId,
          conditionCode: link.conditionCode,
          ...fields,
        });
      } else {
        continue;
      }
      written += 1;
    }
    return { written };
  },
});

// ── The drain ──────────────────────────────────────────────────────────────

type VariantResult =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "skipped" }
  | { kind: "stop"; failure: EbayFailure }
  | { kind: "off" }
  | { kind: "sellerConflict" };

/** What one run learns once and reuses across variants. */
interface RunState {
  session: EbaySellerSession | null;
  sessionFailure: EbayFailure | null;
  aspects: { required: string[]; maxLengths: Map<string, number> } | null;
  aspectsFailure: EbayFailure | null;
  boundAccount: string | null;
}

const STOPPING: ReadonlySet<EbayFailure["kind"]> = new Set(["signed_out", "paused", "no_token", "notConfigured"]);

/** The eBay steps a variant run takes, in order (`marketplaceListingSyncs.progress`). */
type EbayStep = "photos" | "items" | "offers" | "publish" | "withdraw";

/**
 * NEO-415 — what the Sync status tab says when eBay stops a whole step:
 * which step, and what the seller can do. `refused` is eBay saying no (a
 * 4xx); `busy` is eBay busy, slow, unreachable or unreadable. eBay's status,
 * operation and error ids stay in the structured log lines, never here.
 */
export const EBAY_STEP_SAYS: Record<EbayStep | "aspects", { refused: string; busy: string }> = {
  aspects: {
    refused: "eBay wouldn't say what a sports card listing needs, so nothing in this set went up. Press Sync to try again in a bit.",
    busy: "eBay's not answering about what a card listing needs right now. This set goes up on the next sync, or press Sync.",
  },
  photos: {
    refused: "eBay turned down this set's card photos, so nothing new went up. Check the photos on these cards, then press Sync.",
    busy: "eBay's photo upload isn't answering right now. These cards go up on the next sync, or press Sync.",
  },
  items: {
    refused: "eBay turned down the card details for this set, so nothing new went up. Press Sync to try again; if it keeps happening, let us know.",
    busy: "eBay wasn't taking card details just now. This set goes up on the next sync, or press Sync.",
  },
  offers: {
    refused: "eBay turned down this set's prices and policies. Check your shipping, payment and returns picks in Profile → Credentials → eBay, then press Sync.",
    busy: "eBay wasn't taking prices just now. This set catches up on the next sync, or press Sync.",
  },
  publish: {
    refused: "eBay wouldn't put this set's listings live. Check eBay's Seller Hub for a selling limit or an account hold, then press Sync.",
    busy: "eBay wasn't putting listings live just now. They go up on the next sync, or press Sync.",
  },
  withdraw: {
    refused: "eBay wouldn't take down the listings that sold out here. Press Sync to try again, or end them in eBay's Seller Hub.",
    busy: "eBay wasn't taking listings down just now. NeonBinder tries again on the next sync, or press Sync.",
  },
};

/**
 * One card eBay turned down, by step (shown after "eBay turned this one
 * down."). Never eBay's text or error ids: those go to the log line.
 */
export const EBAY_CARD_REJECTED: Record<EbayStep, string> = {
  photos: "Its photos didn't go through. Check them on the card, then press Sync.",
  items: "Its card details (title, photos or facts) didn't pass. Check the card, then press Sync.",
  offers: "Its price or your eBay shipping, payment and returns picks didn't pass. Check them in Profile → Credentials → eBay, then press Sync.",
  publish: "It didn't go live. Check eBay's Seller Hub for a selling limit, then press Sync.",
  withdraw: "eBay didn't take NeonBinder's zero for this listing.",
};

/** A step's failure in NB words: the adapter's own sentences for a session or pause; the step's for the rest. */
export function sayEbayStepFailure(step: EbayStep | "aspects", failure: EbayFailure): string {
  const says = EBAY_STEP_SAYS[step];
  if (failure.kind === "timeout" || failure.kind === "network") return says.busy;
  return sayEbayFailure(failure, says.refused, says.busy);
}

/**
 * A picture upload eBay refused for that card's file: a 400 (the Media API's
 * own refusals, too large, too many pixels or an unsupported format, are
 * 400s). Every other failure is about eBay or the account, not the picture.
 */
export function photoRefused(failure: EbayFailure): boolean {
  return failure.kind === "http" && failure.httpStatus === 400;
}

function rejectedDetail(step: EbayStep, errorIds: readonly number[]): string {
  // eBay's numeric ids go to the log, never the sync record.
  console.log(
    JSON.stringify({ msg: "ebay_listing_rejected", platform: "ebay", operation: step, errorIds: errorIds.slice(0, 5) }),
  );
  return EBAY_CARD_REJECTED[step].slice(0, MAX_DETAIL);
}

const SELLER_CONFLICT_ERROR =
  "This eBay seller account already lists from another NeonBinder account, so NeonBinder stopped listing from this one.";
const STOPPED_ERROR = "Listing on eBay stopped part-way through (eBay was disconnected).";

/**
 * The eBay drain (`listingDrain.drainOwnerImpl` dispatches here). Same
 * shape as the BSC one: claim the owner, walk variants until the budget runs
 * out, release (rescheduling when work remains).
 */
export async function drainEbayOwnerImpl(
  ctx: DrainCtx,
  args: { ownerId: string; platform: "bsc" | "ebay"; fullVariantIds?: Array<Id<"selectorOptions">> },
  opts: DrainOptions = {},
): Promise<DrainReport> {
  const platform: Platform = "ebay";
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS;
  const startedAt = now();
  const leaseToken = newToken();
  const report: DrainReport = { claimed: false, variants: [], stoppedFor: "done" };

  const claim = await ctx.runMutation(internal.listingDrain.claimDrain, {
    ownerId: args.ownerId,
    platform,
    leaseToken,
    ...(args.fullVariantIds ? { fullVariantIds: args.fullVariantIds } : {}),
  });
  if (!claim.claimed) {
    report.stoppedFor =
      claim.reason === "noCredentials"
        ? "noCredentials"
        : claim.reason === "needsReauth"
          ? "needsReauth"
          : claim.reason === "setupIncomplete"
            ? "setupIncomplete"
            : "notClaimed";
    return report;
  }
  report.claimed = true;

  const run: RunState = { session: null, sessionFailure: null, aspects: null, aspectsFailure: null, boundAccount: null };
  let next: "continue" | "done" | "stop" = "done";
  const fullQueue = [...new Set(args.fullVariantIds ?? [])];
  try {
    const done = new Set<string>();
    let afterVariantId: Id<"selectorOptions"> | undefined;
    for (;;) {
      if (now() - startedAt >= budgetMs) {
        report.stoppedFor = "budget";
        next = "continue";
        break;
      }
      let variantId: Id<"selectorOptions"> | null;
      let full = false;
      if (fullQueue.length > 0) {
        variantId = fullQueue.shift() ?? null;
        full = true;
      } else {
        variantId = await ctx.runQuery(internal.listingDrain.nextOutboxVariant, {
          ownerId: args.ownerId,
          platform,
          ...(afterVariantId ? { afterVariantId } : {}),
        });
        if (variantId === null) break;
        afterVariantId = variantId;
        if (done.has(variantId)) continue;
      }
      if (variantId === null) continue;
      done.add(variantId);
      const result = await syncEbayVariant(ctx, { ownerId: args.ownerId, variantId, full, leaseToken }, run, opts);
      report.variants.push({ variantId, result: result.kind === "stop" ? "stop" : result.kind });
      if (result.kind === "sellerConflict") {
        report.stoppedFor = "sellerConflict";
        next = "stop";
        fullQueue.length = 0;
        break;
      }
      if (result.kind === "off") {
        report.stoppedFor = "listingOff";
        fullQueue.length = 0;
        break;
      }
      if (result.kind === "stop") {
        report.stoppedFor =
          result.failure.kind === "paused"
            ? "paused"
            : result.failure.kind === "no_token"
              ? "noToken"
              : result.failure.kind === "notConfigured"
                ? "notConfigured"
                : "signedOut";
        next = "stop";
        if (full) fullQueue.unshift(variantId);
        break;
      }
    }
  } finally {
    await ctx.runMutation(internal.listingDrain.releaseDrain, {
      ownerId: args.ownerId,
      platform,
      leaseToken,
      next,
      ...(fullQueue.length > 0 ? { leftoverFullVariantIds: fullQueue } : {}),
    });
  }
  console.log(
    JSON.stringify({
      msg: "listing_drain",
      platform,
      operation: "drainOwner",
      variants: report.variants.length,
      stoppedFor: report.stoppedFor,
      durationMs: now() - startedAt,
    }),
  );
  return report;
}

/** One planned listing write. */
interface Plan {
  target: EbayTarget;
  link: LinkOut | null;
  facts: CardFacts;
  aspects: Record<string, string[]>;
  text: { title: string; description: string };
  fulfillmentPolicyId: string;
  photos: Array<{ side: "front" | "back"; key: string; contentType: "image/jpeg" | "image/webp"; imageBytes: number }>;
  /** Pictures in listing order, once uploaded (or reused). */
  imageUrls: string[];
  /** The pictures as uploaded (or reused), front first; null until step 1 ran. */
  images: Array<{ url: string; photoToken: string; expiresAt?: number }> | null;
  contentHash: string;
  /** What the step list must do. */
  needsItem: boolean;
  needsOffer: "create" | "replace" | null;
  needsPublish: boolean;
  needsPriceQty: boolean;
  offerId: string | null;
  listingId: string | null;
  /** The listing id a publish in this run replaced (a republish), for `previousListingIds`. */
  retiredListingId: string | null;
  failed: boolean;
}

/**
 * Withdraws the owner's live eBay listings for some cards (a gone variant's
 * queued cards) and records each one ended. Best effort per listing; a 404
 * is already down. `failedCards` are cards whose listing eBay would not end.
 */
async function withdrawLiveForCards(
  ctx: DrainCtx,
  run: RunState,
  args: { ownerId: string; leaseToken: string },
  cardIds: ReadonlyArray<Id<"cardChecklist">>,
): Promise<{ kind: "done" | "off"; failedCards: string[] } | { kind: "stop"; failure: EbayFailure; failedCards: string[] }> {
  const live: LinkOut[] = [];
  for (let i = 0; i < cardIds.length; i += READ_CHUNK) {
    const page = await ctx.runQuery(internal.listingDrainEbay.ebayLinksForCards, {
      ownerId: args.ownerId,
      cardIds: cardIds.slice(i, i + READ_CHUNK),
    });
    for (const link of page) if (link.status === "live" && link.offerId) live.push(link);
  }
  if (live.length === 0) return { kind: "done", failedCards: [] };
  if (!run.session && !run.sessionFailure) {
    const opened = await openEbaySellerSession(ctx, args.ownerId);
    if (opened.ok) run.session = opened.value;
    else run.sessionFailure = opened.failure;
  }
  const failedCards = new Set<string>();
  if (!run.session) {
    for (const link of live) failedCards.add(link.cardId);
    return { kind: "stop", failure: run.sessionFailure as EbayFailure, failedCards: [...failedCards] };
  }
  const writes: LinkWrite[] = [];
  const flush = async () => {
    for (let i = 0; i < writes.length; i += 100) {
      await ctx.runMutation(internal.listingDrainEbay.recordEbayLinks, {
        ownerId: args.ownerId,
        leaseToken: args.leaseToken,
        links: writes.slice(i, i + 100),
      });
    }
    writes.length = 0;
  };
  for (const link of live) {
    const held = await ctx.runQuery(internal.listingDrain.drainHeld, {
      ownerId: args.ownerId,
      platform: "ebay",
      leaseToken: args.leaseToken,
    });
    if (!held) {
      await flush();
      return { kind: "off", failedCards: [...failedCards] };
    }
    const r = await withdrawOffer(ctx, run.session, link.offerId as string);
    if (!r.ok && STOPPING.has(r.failure.kind)) {
      await flush();
      for (const l of live) if (l.status === "live") failedCards.add(l.cardId);
      return { kind: "stop", failure: r.failure, failedCards: [...failedCards] };
    }
    if (!r.ok && r.failure.httpStatus !== 404) {
      failedCards.add(link.cardId);
      continue;
    }
    link.status = "ended";
    writes.push({
      cardId: link.cardId,
      conditionCode: link.conditionCode,
      sku: link.sku,
      status: "ended",
      ...(link.pushed ? { pushed: { ...link.pushed, quantity: 0 } } : {}),
    });
  }
  await flush();
  return { kind: "done", failedCards: [...failedCards] };
}

async function syncEbayVariant(
  ctx: DrainCtx,
  args: { ownerId: string; variantId: Id<"selectorOptions">; full: boolean; leaseToken: string },
  run: RunState,
  opts: DrainOptions,
): Promise<VariantResult> {
  const platform: Platform = "ebay";
  const { ownerId, variantId, leaseToken } = args;
  const snapshot = await ctx.runQuery(internal.listingDrain.outboxSnapshot, { ownerId, platform, variantId });
  const rows = settleRows(snapshot, variantId);
  const claim = await ctx.runMutation(internal.listingDrain.claimVariant, { ownerId, platform, variantId, leaseToken });
  if (!claim.claimed && claim.reason === "listingOff") return { kind: "off" };
  if (!claim.claimed) {
    await ctx.runMutation(internal.listingDrain.finishVariant, {
      ownerId,
      platform,
      variantId,
      leaseToken,
      outcome: { kind: "error", error: "busy" },
      clear: rows.gone,
      repoint: rows.repoint,
    });
    return { kind: "skipped" };
  }
  // Cards whose queued rows must survive this run (a photo upload deferred).
  const keepQueued = new Set<string>();
  const mineCards = new Map(snapshot.map((r) => [r.rowId as string, r.cardId as string]));
  // NEO-415: the run's steps, ticked off on the sync record as they land.
  const ledger = new ProgressLedger(ctx, { ownerId, platform, variantId, leaseToken }, opts.now);
  const finish = async (outcome: FinishOutcome, clearMine: boolean): Promise<void> => {
    const kept = (r: { rowId: string }) => !keepQueued.has(mineCards.get(r.rowId) ?? "");
    const mine = clearMine ? rows.mine.filter(kept) : [];
    await ctx.runMutation(internal.listingDrain.finishVariant, {
      ownerId,
      platform,
      variantId,
      leaseToken,
      outcome,
      clear: [...mine, ...rows.gone.filter(kept)],
      repoint: rows.repoint,
      progress: ledger.steps(),
    });
  };

  const input = await ctx.runQuery(internal.listingDrainEbay.ebayVariantInput, { ownerId, variantId });
  if (input.kind === "gone") {
    // Nothing can be listed under a gone variant, but a live listing NB made
    // for one of its queued cards still comes down.
    const goneCards = [...new Set(snapshot.map((r) => r.cardId))];
    const left = await withdrawLiveForCards(ctx, run, { ownerId, leaseToken }, goneCards);
    if (left.kind === "off") {
      await finish({ kind: "error", error: STOPPED_ERROR }, false);
      return { kind: "off" };
    }
    for (const cardId of left.failedCards) keepQueued.add(cardId);
    await finish({ kind: "error", error: "This variant is gone from NeonBinder." }, true);
    return left.kind === "stop" ? { kind: "stop", failure: left.failure } : { kind: "error" };
  }
  if (input.settings === null) {
    // claimDrain checked; settings cleared under the run. Leave the queue.
    await finish({ kind: "error", error: EBAY_SETUP_INCOMPLETE_ERROR }, false);
    return { kind: "error" };
  }
  const settings = input.settings;

  // NB's side: the owner's copies of the variant.
  const copies: CopyOut[] = [];
  if (input.setId !== null) {
    for (let cursor: string | null = null; ; ) {
      const page: { copies: CopyOut[]; cursor: string; isDone: boolean } = await ctx.runQuery(
        internal.listingDrain.variantCopiesPage,
        { ownerId, setId: input.setId, variantId, cursor },
      );
      copies.push(...page.copies);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  const fold = foldEbayTargets({ copies, commonPriceCents: input.commonPriceCents });

  // Which cards are in play: the targets, the queued cards, and on a full
  // read (first run, a Sync press, an explicit full) every card of the variant.
  const fullRead = args.full || claim.lastSuccessAt === null || claim.fullReadRequested;
  const inPlay = new Set<string>(fold.targets.map((t) => t.cardId as string));
  for (const r of snapshot) if (r.currentVariantId === variantId) inPlay.add(r.cardId);
  // A card gone from the catalog with a queued row: its live listing (if
  // any) is not a target, so it is withdrawn below like any count at zero.
  const goneCardIds = new Set<string>(snapshot.filter((r) => r.currentVariantId === null).map((r) => r.cardId as string));
  for (const id of goneCardIds) inPlay.add(id);
  for (const h of fold.holds) inPlay.add(h.cardId);
  if (fullRead) {
    for (let cursor: string | null = null; ; ) {
      const page: { cardIds: Array<Id<"cardChecklist">>; cursor: string; isDone: boolean } = await ctx.runQuery(
        internal.listingDrainEbay.ebayVariantCardIdsPage,
        { variantId, cursor },
      );
      for (const id of page.cardIds) inPlay.add(id);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  const cardIds = [...inPlay] as Array<Id<"cardChecklist">>;
  const links = new Map<string, LinkOut>();
  for (let i = 0; i < cardIds.length; i += READ_CHUNK) {
    const page = await ctx.runQuery(internal.listingDrainEbay.ebayLinksForCards, {
      ownerId,
      cardIds: cardIds.slice(i, i + READ_CHUNK),
    });
    for (const link of page) links.set(link.sku, link);
  }

  const problems: StoredProblem[] = [];
  const addHold = (h: EbayHold) => {
    problems.push({
      cardId: h.cardId,
      reason: h.reason,
      ...(h.detail ? { detail: h.detail.slice(0, MAX_DETAIL) } : {}),
    });
  };
  for (const h of fold.holds) addHold(h);

  // Targets eBay can take, after the price and photo holds.
  const priced: EbayTarget[] = [];
  for (const t of fold.targets) {
    if (t.priceCents === null) addHold({ cardId: t.cardId, reason: "noPrice", conditionCode: t.conditionCode });
    else if (!t.oldestHasPhotos) addHold({ cardId: t.cardId, reason: "noPhoto", conditionCode: t.conditionCode });
    else priced.push(t);
  }
  const targetSkus = new Set(fold.targets.map((t) => t.sku));
  const toWithdraw = [...links.values()].filter((l) => l.status === "live" && !targetSkus.has(l.sku) && l.offerId);

  if (priced.length === 0 && toWithdraw.length === 0) {
    const listed = [...links.values()].filter((l) => l.status === "live").length;
    await finish(
      {
        kind: "ok",
        counts: { listed, pushed: 0, zeroed: 0, skipped: distinctCards(problems) },
        problems: problems.slice(0, MAX_STORED_PROBLEMS),
        problemsTotal: problems.length,
        conditionsPushed: [],
      },
      true,
    );
    return { kind: "ok" };
  }

  // eBay's side from here on: a session, the seller binding, the aspects.
  if (!run.session && !run.sessionFailure) {
    const opened = await openEbaySellerSession(ctx, ownerId);
    if (opened.ok) run.session = opened.value;
    else run.sessionFailure = opened.failure;
  }
  /** The step a failure is said against (none: the adapter's own sentence, e.g. a dead session). */
  let failingStep: EbayStep | "aspects" | null = null;
  const fail = async (failure: EbayFailure): Promise<VariantResult> => {
    await finish(
      {
        kind: "error",
        error: failingStep === null ? failure.message : sayEbayStepFailure(failingStep, failure),
        problems: problems.slice(0, MAX_STORED_PROBLEMS),
        problemsTotal: problems.length,
      },
      false,
    );
    return STOPPING.has(failure.kind) ? { kind: "stop", failure } : { kind: "error" };
  };
  if (!run.session) return await fail(run.sessionFailure as EbayFailure);
  const session = run.session;

  if (input.ebayUserId === null) {
    return await fail({ kind: "bad_response", message: "NeonBinder doesn't know which eBay account this is. Connect eBay again in Profile → Credentials → eBay." });
  }
  if (run.boundAccount !== input.ebayUserId) {
    const binding = await ctx.runMutation(internal.listingDrain.bindSellerAccount, {
      ownerId,
      platform,
      leaseToken,
      accountId: input.ebayUserId,
    });
    if (binding === "off") {
      await finish({ kind: "error", error: STOPPED_ERROR }, false);
      return { kind: "off" };
    }
    if (binding === "conflict") {
      await finish({ kind: "error", error: SELLER_CONFLICT_ERROR, problems: problems.slice(0, MAX_STORED_PROBLEMS), problemsTotal: problems.length }, false);
      return { kind: "sellerConflict" };
    }
    run.boundAccount = input.ebayUserId;
  }

  if (!run.aspects && !run.aspectsFailure && priced.length > 0) {
    const read = await getCardCategoryAspects(ctx, session);
    if (read.ok) run.aspects = readCategoryAspects(read.value);
    else run.aspectsFailure = read.failure;
  }
  if (priced.length > 0 && !run.aspects) {
    failingStep = "aspects";
    return await fail(run.aspectsFailure as EbayFailure);
  }
  const aspectRules = run.aspects ?? { required: [], maxLengths: new Map<string, number>() };

  // NB facts and photos for the priced targets.
  const facts = new Map<string, CardFacts>();
  const pricedCards = [...new Set(priced.map((t) => t.cardId))];
  for (let i = 0; i < pricedCards.length; i += READ_CHUNK) {
    const page = await ctx.runQuery(internal.listingDrainEbay.ebayCardFacts, { cardIds: pricedCards.slice(i, i + READ_CHUNK) });
    for (const f of page) facts.set(f.cardId, f);
  }
  const photosByCopy = new Map<string, Plan["photos"]>();
  const oldest = [...new Set(priced.map((t) => t.oldestCopyId))];
  for (let i = 0; i < oldest.length; i += READ_CHUNK) {
    const page = await ctx.runQuery(internal.listingDrainEbay.ebayCopyPhotos, { ownerId, copyIds: oldest.slice(i, i + READ_CHUNK) });
    for (const p of page) {
      const list = photosByCopy.get(p.copyId) ?? [];
      list.push({ side: p.side, key: p.key, contentType: p.contentType, imageBytes: p.imageBytes });
      photosByCopy.set(p.copyId, list);
    }
  }

  // Plan each listing.
  const plans: Plan[] = [];
  for (const t of priced) {
    const f = facts.get(t.cardId);
    if (!f) continue; // the card left the catalog under the run
    const photos = (photosByCopy.get(t.oldestCopyId) ?? [])
      .filter((p) => p.imageBytes <= MAX_COPY_PHOTO_BYTES)
      .sort((a, b) => (a.side === b.side ? 0 : a.side === "front" ? -1 : 1));
    if (photos.length === 0) {
      addHold({ cardId: t.cardId, reason: "noPhoto", conditionCode: t.conditionCode });
      continue;
    }
    const aspects = buildEbayAspects(f.facts as EbayAspectFacts, aspectRules.maxLengths);
    const missing = missingRequiredAspects(aspects, aspectRules.required);
    if (missing.length > 0) {
      addHold({
        cardId: t.cardId,
        reason: "missingAspect",
        conditionCode: t.conditionCode,
        // The web reads the detail as the aspect name(s): "eBay wants this card's <detail>".
        detail: missing.slice(0, 3).join(", "),
      });
      continue;
    }
    const text = ebayListingText(f);
    const priceCents = t.priceCents as number;
    const slot = fulfillmentSlotFor(priceCents);
    const fulfillmentPolicyId = slot === "twentyPlus" ? settings.fulfillmentPolicy20PlusId : settings.fulfillmentPolicyUnder20Id;
    const contentHash = contentFingerprint({
      text,
      aspects,
      condition: EBAY_DESCRIPTOR_VALUE[t.conditionCode],
      photos: photos.map((p) => p.key),
      // The package follows the price slot, so a price crossing $20 re-sends
      // the item with its new weight even when nothing else changed.
      package: ebayPackageFor(priceCents),
    });
    const link = links.get(t.sku) ?? null;
    const pushed = link?.pushed ?? null;
    const policiesSame =
      pushed !== null &&
      pushed.fulfillmentPolicyId === fulfillmentPolicyId &&
      pushed.paymentPolicyId === settings.paymentPolicyId &&
      pushed.returnPolicyId === settings.returnPolicyId &&
      pushed.bestOffer === settings.bestOffer;
    const contentSame = pushed !== null && pushed.contentHash === contentHash;
    const qtyPriceSame = pushed !== null && pushed.quantity === t.quantity && pushed.priceCents === priceCents;
    const live = link?.status === "live" && link.offerId !== null && link.listingId !== null;
    if (live && policiesSame && contentSame && qtyPriceSame) continue; // nothing changed
    const plan: Plan = {
      target: t,
      link,
      facts: f,
      aspects,
      text,
      fulfillmentPolicyId,
      photos,
      imageUrls: [],
      images: null,
      contentHash,
      needsItem: true,
      needsOffer: link?.offerId ? "replace" : "create",
      needsPublish: true,
      needsPriceQty: false,
      offerId: link?.offerId ?? null,
      listingId: link?.listingId ?? null,
      retiredListingId: null,
      failed: false,
    };
    if (live) {
      // Already on eBay: send only what changed.
      plan.needsPublish = false;
      const qtyChanged = pushed === null || pushed.quantity !== t.quantity;
      const priceChanged = pushed === null || pushed.priceCents !== priceCents;
      if (contentSame && policiesSame) {
        // Price and/or quantity only: the cheap update.
        plan.needsItem = false;
        plan.needsOffer = null;
        plan.needsPriceQty = true;
      } else {
        // The item carries content and quantity; the offer policies, price and quantity.
        plan.needsItem = !contentSame || qtyChanged;
        plan.needsOffer = !policiesSame || priceChanged || qtyChanged ? "replace" : null;
      }
    }
    // Not live (new, draft, or ended and stock is back): item, offer and publish.
    plans.push(plan);
  }

  const drainHeld = async (): Promise<boolean> =>
    await ctx.runQuery(internal.listingDrain.drainHeld, { ownerId, platform, leaseToken });
  const linkWrites: LinkWrite[] = [];
  const flushLinks = async () => {
    for (let i = 0; i < linkWrites.length; i += 100) {
      await ctx.runMutation(internal.listingDrainEbay.recordEbayLinks, {
        ownerId,
        leaseToken,
        links: linkWrites.slice(i, i + 100),
      });
    }
    linkWrites.length = 0;
  };
  const reject = (plan: Plan, step: EbayStep, errorIds: readonly number[]) => {
    plan.failed = true;
    problems.push({ cardId: plan.target.cardId, reason: "rejected", detail: rejectedDetail(step, errorIds) });
  };
  const stopOn = async (r: EbayResult<unknown>): Promise<VariantResult | null> => {
    if (r.ok) return null;
    await flushLinks();
    return await fail(r.failure);
  };

  // 1. Pictures (only for listings whose item content is being sent). A
  //    picture NB already uploaded for the same photo is reused while the
  //    listing is live (eBay keeps a listing's pictures) or the upload has
  //    not expired; otherwise it is uploaded again.
  const fetchPhoto = opts.fetchPhoto ?? defaultFetchPhoto;
  let uploads = 0;
  const reusable = (image: { photoToken: string; expiresAt?: number }, key: string, live: boolean): boolean =>
    image.photoToken === key &&
    (live || image.expiresAt === undefined || image.expiresAt > Date.now() + IMAGE_FRESH_MS);

  // NEO-415: the plan, the steps this run will take, in order. A step the
  // run turns out not to need (every card before it fell out) is dropped.
  const needsUpload = plans.some(
    (p) =>
      p.needsItem &&
      p.photos.some((photo) => !(p.link?.images ?? []).some((image) => reusable(image, photo.key, p.link?.status === "live"))),
  );
  ledger.plan(
    (
      [
        ["photos", needsUpload],
        ["items", plans.some((p) => p.needsItem)],
        ["offers", plans.some((p) => p.needsOffer !== null || p.needsPriceQty)],
        ["publish", plans.some((p) => p.needsPublish)],
        ["withdraw", toWithdraw.length > 0],
      ] as Array<[EbayStep, boolean]>
    )
      .filter(([, wanted]) => wanted)
      .map(([kind]) => ({ key: kind, kind })),
  );
  // No write here: the first step's start writes the whole plan.
  /** Starts a step (one write) and names it for a failure; not needed now: dropped. */
  const step = async (kind: EbayStep, needed: boolean): Promise<void> => {
    if (!needed) {
      ledger.drop(kind);
      return;
    }
    failingStep = kind;
    await ledger.start(kind);
  };

  await step("photos", needsUpload);
  // An upload eBay answers with a 400 is that card's picture refused
  // (`photoRefused`): the card says so and is not retried until something
  // about it changes. Any other upload failure (eBay busy: a 5xx such as
  // its 190000, a 429, slow, unreachable or unreadable; or a 403) stops the
  // uploads for this run: every card still needing one stays queued, the
  // photos step ends failed and the variant ends saying so in NB words, so
  // the next run (the sales poll's kick or a Sync press) tries again.
  let photosStopped: EbayFailure | null = null;
  for (const plan of plans.filter((p) => p.needsItem)) {
    const live = plan.link?.status === "live";
    const stored = plan.link?.images ?? [];
    const images: Array<{ url: string; photoToken: string; expiresAt?: number }> = [];
    let complete = true;
    let refused: readonly number[] | null = null;
    for (const photo of plan.photos) {
      const known = stored.find((image) => reusable(image, photo.key, live));
      if (known) {
        images.push(known);
        continue;
      }
      if (uploads >= MAX_EBAY_UPLOADS_PER_VARIANT || photosStopped !== null) {
        complete = false;
        break;
      }
      let bytes: ArrayBuffer | null = null;
      try {
        bytes = await fetchPhoto(photo.key, MAX_COPY_PHOTO_BYTES);
      } catch {
        bytes = null;
      }
      if (!bytes) {
        complete = false;
        break;
      }
      uploads += 1;
      const up = await uploadImage(ctx, session, {
        bytes,
        contentType: photo.contentType,
        fileName: `${photo.side}.${photo.contentType === "image/webp" ? "webp" : "jpg"}`,
      });
      if (!up.ok) {
        if (STOPPING.has(up.failure.kind)) return (await stopOn(up)) as VariantResult;
        if (photoRefused(up.failure)) refused = up.failure.errorIds ?? [];
        else photosStopped = up.failure;
        complete = false;
        break;
      }
      images.push({
        url: up.value.url,
        photoToken: photo.key,
        ...(up.value.expiresAt !== null ? { expiresAt: up.value.expiresAt } : {}),
      });
    }
    if (refused !== null) {
      // eBay said no to this card's picture: the card says so in NB words.
      reject(plan, "photos", refused);
      continue;
    }
    if (!complete) {
      // Some picture could not be sent this run: the card stays queued for the next.
      plan.failed = true;
      keepQueued.add(plan.target.cardId);
      continue;
    }
    plan.images = images;
    plan.imageUrls = images.map((image) => image.url);
  }
  // The photos step failed when eBay's upload stopped; the run goes on for
  // the cards whose pictures are in hand, and ends naming the photos step.
  if (photosStopped !== null) ledger.fail("photos");

  // 2. Inventory items.
  const itemPlans = plans.filter((p) => p.needsItem && !p.failed);
  await step("items", itemPlans.length > 0);
  for (let i = 0; i < itemPlans.length; i += EBAY_BULK_LIMIT) {
    if (!(await drainHeld())) {
      await flushLinks();
      await finish({ kind: "error", error: STOPPED_ERROR }, false);
      return { kind: "off" };
    }
    const chunk = itemPlans.slice(i, i + EBAY_BULK_LIMIT);
    const r = await bulkCreateOrReplaceInventoryItems(ctx, session, chunk.map(inventoryItemBody));
    const stop = await stopOn(r);
    if (stop) return stop;
    if (!r.ok) continue;
    const bySku = new Map(r.value.map((e) => [e.sku, e]));
    for (const plan of chunk) {
      const e = bySku.get(plan.target.sku);
      if (!e || e.statusCode < 200 || e.statusCode >= 300) reject(plan, "items", e?.errorIds ?? []);
    }
  }

  // 3. Offers: create new ones (adopting one eBay already holds for the SKU).
  const offerBody = (plan: Plan, withKeys: boolean): Record<string, unknown> => ({
    ...(withKeys ? { sku: plan.target.sku, marketplaceId: EBAY_MARKETPLACE_ID, format: "FIXED_PRICE" } : {}),
    availableQuantity: plan.target.quantity,
    categoryId: EBAY_CARD_CATEGORY_ID,
    listingDescription: plan.text.description,
    listingDuration: "GTC",
    listingPolicies: {
      fulfillmentPolicyId: plan.fulfillmentPolicyId,
      paymentPolicyId: settings.paymentPolicyId,
      returnPolicyId: settings.returnPolicyId,
      bestOfferTerms: { bestOfferEnabled: settings.bestOffer },
    },
    pricingSummary: { price: { value: centsToEbayValue(plan.target.priceCents as number), currency: "USD" } },
    merchantLocationKey: settings.merchantLocationKey,
  });
  const creates = plans.filter((p) => p.needsOffer === "create" && !p.failed);
  await step(
    "offers",
    plans.some((p) => !p.failed && ((p.needsOffer !== null && (p.needsOffer === "create" || p.offerId)) || (p.needsPriceQty && p.offerId))),
  );
  for (let i = 0; i < creates.length; i += EBAY_BULK_LIMIT) {
    const chunk = creates.slice(i, i + EBAY_BULK_LIMIT);
    const r = await bulkCreateOffers(ctx, session, chunk.map((p) => offerBody(p, true)));
    const stop = await stopOn(r);
    if (stop) return stop;
    if (!r.ok) continue;
    const bySku = new Map(r.value.map((e) => [e.sku, e]));
    for (const plan of chunk) {
      const e = bySku.get(plan.target.sku);
      if (e && e.statusCode >= 200 && e.statusCode < 300 && e.offerId) {
        plan.offerId = e.offerId;
      } else if (e && e.errorIds.some((id) => OFFER_EXISTS_ERROR_IDS.has(id))) {
        // An offer for this SKU already exists (a run that died before it
        // could record one): adopt it and bring it to NB's values.
        const found = await getOfferBySku(ctx, session, plan.target.sku);
        const s2 = await stopOn(found);
        if (s2) return s2;
        if (found.ok && found.value) {
          plan.offerId = found.value.offerId;
          plan.listingId = found.value.listingId;
          plan.needsOffer = "replace";
          if (found.value.published && found.value.listingId) plan.needsPublish = false;
        } else {
          reject(plan, "offers", e.errorIds);
        }
      } else {
        reject(plan, "offers", e?.errorIds ?? []);
      }
      if (plan.offerId && !plan.failed) {
        linkWrites.push({
          cardId: plan.target.cardId,
          conditionCode: plan.target.conditionCode,
          sku: plan.target.sku,
          offerId: plan.offerId,
          ...(plan.listingId ? { listingId: plan.listingId } : {}),
          status: plan.listingId && !plan.needsPublish ? "live" : "draft",
          ...(plan.images ? { images: plan.images } : {}),
        });
      }
    }
    await flushLinks();
  }

  // 4. Offers: replace the ones whose policies (or, for a returning or
  //    adopted listing, anything) changed. One call each.
  for (const plan of plans.filter((p) => p.needsOffer === "replace" && !p.failed && p.offerId)) {
    if (!(await drainHeld())) {
      await flushLinks();
      await finish({ kind: "error", error: STOPPED_ERROR }, false);
      return { kind: "off" };
    }
    const r = await updateOffer(ctx, session, plan.offerId as string, offerBody(plan, false));
    if (!r.ok && STOPPING.has(r.failure.kind)) return (await stopOn(r)) as VariantResult;
    if (!r.ok) reject(plan, "offers", r.failure.errorIds ?? []);
  }

  // 5. Price and quantity on live listings that changed only those (the
  //    offers step: an update of the offer and its item's quantity).
  const priceQty = plans.filter((p) => p.needsPriceQty && !p.failed && p.offerId);
  for (let i = 0; i < priceQty.length; i += EBAY_BULK_LIMIT) {
    const chunk = priceQty.slice(i, i + EBAY_BULK_LIMIT);
    const r = await bulkUpdatePriceQuantity(
      ctx,
      session,
      chunk.map((p) => ({
        sku: p.target.sku,
        offerId: p.offerId as string,
        quantity: p.target.quantity,
        price: { value: centsToEbayValue(p.target.priceCents as number), currency: "USD" as const },
      })),
    );
    const stop = await stopOn(r);
    if (stop) return stop;
    if (!r.ok) continue;
    for (const plan of chunk) {
      const e = r.value.find((x) => x.offerId === plan.offerId || x.sku === plan.target.sku);
      if (!e || e.statusCode < 200 || e.statusCode >= 300) reject(plan, "offers", e?.errorIds ?? []);
    }
  }

  // 6. Publish new and returning listings.
  const publishes = plans.filter((p) => p.needsPublish && !p.failed && p.offerId);
  await step("publish", publishes.length > 0);
  for (let i = 0; i < publishes.length; i += EBAY_BULK_LIMIT) {
    const chunk = publishes.slice(i, i + EBAY_BULK_LIMIT);
    const r = await bulkPublishOffers(ctx, session, chunk.map((p) => p.offerId as string));
    const stop = await stopOn(r);
    if (stop) return stop;
    if (!r.ok) continue;
    const byOffer = new Map(r.value.map((e) => [e.offerId, e]));
    for (const plan of chunk) {
      const e = byOffer.get(plan.offerId);
      if (e && e.statusCode >= 200 && e.statusCode < 300 && e.listingId) {
        // A republish gets a new listing id; a late sale may still name the old one.
        if (plan.listingId !== null && plan.listingId !== e.listingId) plan.retiredListingId = plan.listingId;
        plan.listingId = e.listingId;
      } else reject(plan, "publish", e?.errorIds ?? []);
    }
  }

  // Record every listing that landed.
  let pushedCount = 0;
  for (const plan of plans) {
    if (plan.failed || !plan.offerId) continue;
    // Every plan still standing either was live or was published just now.
    const isLive = plan.listingId !== null;
    pushedCount += 1;
    linkWrites.push({
      cardId: plan.target.cardId,
      conditionCode: plan.target.conditionCode,
      sku: plan.target.sku,
      offerId: plan.offerId,
      ...(plan.listingId ? { listingId: plan.listingId } : {}),
      ...(plan.retiredListingId ? { retiredListingId: plan.retiredListingId } : {}),
      status: isLive ? "live" : "draft",
      ...(plan.images ? { images: plan.images } : {}),
      pushed: {
        quantity: plan.target.quantity,
        priceCents: plan.target.priceCents as number,
        fulfillmentPolicyId: plan.fulfillmentPolicyId,
        paymentPolicyId: settings.paymentPolicyId,
        returnPolicyId: settings.returnPolicyId,
        bestOffer: settings.bestOffer,
        contentHash: plan.contentHash,
      },
    });
  }
  // A listing that failed after its offer existed keeps its link, unchanged.
  await flushLinks();

  // 7. Withdraw live listings whose count went to 0.
  let zeroed = 0;
  const withdrawn = new Set<string>();
  await step("withdraw", toWithdraw.length > 0);
  for (const link of toWithdraw) {
    if (!(await drainHeld())) {
      await finish({ kind: "error", error: STOPPED_ERROR }, false);
      return { kind: "off" };
    }
    const r = await withdrawOffer(ctx, session, link.offerId as string);
    if (!r.ok && STOPPING.has(r.failure.kind)) return (await stopOn(r)) as VariantResult;
    // 404: eBay no longer has the offer live (ended or sold out elsewhere).
    if (!r.ok && r.failure.httpStatus !== 404) {
      problems.push({ cardId: link.cardId, reason: "rejected", detail: rejectedDetail("withdraw", r.failure.errorIds ?? []) });
      // A gone card has no other way back to this listing: keep its row queued.
      if (goneCardIds.has(link.cardId)) keepQueued.add(link.cardId);
      continue;
    }
    zeroed += 1;
    withdrawn.add(link.sku);
    linkWrites.push({
      cardId: link.cardId,
      conditionCode: link.conditionCode,
      sku: link.sku,
      status: "ended",
      ...(link.pushed ? { pushed: { ...link.pushed, quantity: 0 } } : {}),
    });
  }
  await flushLinks();

  // Listed now: the live listings read at the start, plus those published
  // this run, less those withdrawn.
  const liveNow = new Set([...links.values()].filter((l) => l.status === "live").map((l) => l.sku));
  for (const plan of plans) if (!plan.failed && plan.listingId !== null) liveNow.add(plan.target.sku);
  for (const sku of withdrawn) liveNow.delete(sku);
  const listedNow = liveNow.size;
  const conditionsPushed = [
    ...new Set(plans.filter((p) => !p.failed && p.listingId !== null).map((p) => p.target.conditionCode as EbayConditionCode)),
  ];
  if (photosStopped !== null) {
    // eBay's photo upload stopped part-way: what landed is recorded and its
    // rows clear; the cards still waiting on a picture keep theirs. The steps
    // after the photos finished, so they end done; only photos reads failed.
    ledger.endWorking();
    await finish(
      {
        kind: "error",
        error: sayEbayStepFailure("photos", photosStopped),
        problems: problems.slice(0, MAX_STORED_PROBLEMS),
        problemsTotal: problems.length,
        conditionsPushed,
      },
      true,
    );
    return { kind: "error" };
  }
  await finish(
    {
      kind: "ok",
      counts: { listed: listedNow, pushed: pushedCount + zeroed, zeroed, skipped: distinctCards(problems) },
      problems: problems.slice(0, MAX_STORED_PROBLEMS),
      problemsTotal: problems.length,
      conditionsPushed,
    },
    true,
  );
  return { kind: "ok" };
}

/** The inventory item NB sends for one listing (Sell Inventory InventoryItem). */
function inventoryItemBody(plan: Plan): Record<string, unknown> {
  return {
    sku: plan.target.sku,
    locale: EBAY_LOCALE,
    condition: EBAY_UNGRADED_CONDITION,
    conditionDescriptors: [
      { name: EBAY_CARD_CONDITION_DESCRIPTOR, values: [EBAY_DESCRIPTOR_VALUE[plan.target.conditionCode]] },
    ],
    availability: { shipToLocationAvailability: { quantity: plan.target.quantity } },
    packageWeightAndSize: ebayPackageFor(plan.target.priceCents as number),
    product: {
      title: plan.text.title,
      description: plan.text.description,
      aspects: plan.aspects,
      imageUrls: plan.imageUrls,
    },
  };
}
