/**
 * NEO-370 — the listing gate: a copy headed for a home that lists on
 * marketplaces carries a price and a condition, or it does not go in.
 *
 * Jason, 2026-11-01: a saved marketplace sign-in lists the collector's cards,
 * and a copy with no price or no condition never lists (the drain holds it
 * back as `noPrice` / `noCondition`). So on the inventory checklist and photo
 * intake, a collector who is set up for syncing sets the price and the
 * condition BEFORE adding a quantity or uploading.
 *
 * The gate applies when BOTH hold:
 *   - the owner syncs: a `marketplaceListingStates` row that pushes counts on
 *     a platform NB has not paused (`listingOutbox.listsAnywhereNow`);
 *   - the copies are headed to a LISTED box (`listsOnMarketplaces`: a box
 *     whose "Listed on marketplaces" is not off). A binder and an in-person
 *     box never list, so they need neither.
 * A collector who syncs nowhere sees no change at all.
 *
 * What "a price" and "a condition" mean is the drain's own rule, shared
 * through `lib/listingReadiness.ts`: the copy's own floor, else the owner's
 * common price for the variant (`commonPriceCentsOf`, which the drain reads
 * too), and any NB condition on a raw copy. A graded copy and a copy of a
 * private card never list here, so they are never held.
 *
 * The rule lives here; the screens only mirror it (`forHome`). It guards
 * the ADD doors, the writes that put cards into a listed box:
 *   - every add into a home (`collection.addOne`: Have, a range, a line
 *     item, an intake save);
 *   - a line put back (`collection.restoreCopy`, the undo of a removal);
 *   - a move into a listed box from a home that does not list
 *     (`collection.moveCopyCore`, so `moveCopy`). Sell can name the moving
 *     cards' own price (`moveCopy`'s `minPriceCents`, NEO-479), and the
 *     gate reads that price, so a priced sale passes with no common price;
 *     the condition is still required;
 *   - a quick count that raises a box's number
 *     (`collectionInventory.setBoxQuantity`), and an undo/redo of one that
 *     restores or raises a line (`undoBoxQuantity`; its inverse comes from
 *     the client, so it is checked, not trusted);
 *   - starting a photo intake run into a listed box
 *     (`intakeRuns.createIntakeRun`, which first refuses any run with no set,
 *     listed or not: NEO-452).
 * Lowering, removing and moving out are never held.
 *
 * It is not the only line. State that changes AFTER cards are in can still
 * leave a listed copy with no price or condition: a box emptied into
 * Unsorted, a box's "Listed on marketplaces" turned back on
 * (`setContainerListed` off → on), a copy's own price cleared, a common
 * price removed, a move between listed boxes that clears the copy's own
 * price (the undo of a box-to-box sale: a move between listed homes is not
 * gated, NEO-479). Those are not refused here; the drain's `noPrice` /
 * `noCondition` hold (`lib/bscSheetPlan.ts`) is the backstop: such a copy is
 * held back from the marketplace and shown on Sync status, never listed
 * without a price.
 *
 * Kept free of any import from `collection.ts` (which imports this), so
 * there is no module cycle.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { listsAnywhereNow, listsOnMarketplaces } from "./listingOutbox";
import { listingReadiness, type ListingReadiness } from "./lib/listingReadiness";

type ContainerRow = Doc<"collectionContainers">;

/** The `ConvexError` code a refused add carries. */
export const LISTING_GATE_ERROR = "LISTING_NEEDS_DETAILS";

/** The owner's common price for one variant, cents; null when they set none. The drain reads this too. */
export async function commonPriceCentsOf(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  variantId: Id<"selectorOptions">,
): Promise<number | null> {
  const row = await ctx.db
    .query("variantCommonPrices")
    .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", ownerId).eq("variantId", variantId))
    .unique();
  return row?.priceCents ?? null;
}

/** What one add would put in the home, as the gate reads it. */
export interface GatedCopy {
  /** A copy of the collector's own private card: it never lists, so it is never held. */
  privateCard?: boolean;
  /** The card's variant, for its common price; absent only on a private card, which the gate skips. */
  variantId?: Id<"selectorOptions">;
  graded: boolean;
  /** The condition the copy will carry (its own, else the owner's default). */
  condition: string | undefined;
  /** The copy's own floor, cents. */
  ownPriceCents?: number;
}

/** The refusal's words: what is missing, and where to set it. */
export function listingGateMessage(homeName: string, missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  const what =
    missing.needsPrice && missing.needsCondition ? "a price and a condition" : missing.needsPrice ? "a price" : "a condition";
  const fix = missing.needsPrice
    ? "Set a common price for the checklist, or give the card a price of its own."
    : "Give the card a condition.";
  return `${homeName} sells on your marketplaces, so cards going in need ${what} first. ${fix}`;
}

/**
 * The gate for one transaction's adds, memoised: whether the owner syncs is
 * read once, and each variant's common price once, however many cards one
 * write adds (`addHaves` takes up to 200).
 */
export class ListingGate {
  private syncing: Promise<boolean> | undefined;
  private readonly prices = new Map<string, Promise<number | null>>();

  constructor(
    private readonly ctx: Pick<QueryCtx, "db">,
    private readonly ownerId: string,
  ) {}

  /** The owner is set up for syncing (`listsAnywhereNow`), read once. */
  async syncs(): Promise<boolean> {
    this.syncing ??= listsAnywhereNow(this.ctx, this.ownerId);
    return await this.syncing;
  }

  /** The gate applies to adds into `home`: it lists, and the owner syncs. */
  async applies(home: Pick<ContainerRow, "kind" | "listedOnMarketplaces">): Promise<boolean> {
    if (!listsOnMarketplaces(home)) return false;
    return await this.syncs();
  }

  /** The owner's common price for `variantId`, cents (`commonPriceCentsOf`), read once. */
  async commonPrice(variantId: Id<"selectorOptions">): Promise<number | null> {
    let price = this.prices.get(variantId);
    if (!price) {
      price = commonPriceCentsOf(this.ctx, this.ownerId, variantId);
      this.prices.set(variantId, price);
    }
    return await price;
  }

  /** Refuses (a `ConvexError` the screens show) an add into `home` that would not list. */
  async require(home: Pick<ContainerRow, "name" | "kind" | "listedOnMarketplaces">, copy: GatedCopy): Promise<void> {
    if (copy.graded || copy.privateCard === true) return;
    if (!(await this.applies(home))) return;
    const readiness = listingReadiness({
      applies: true,
      graded: copy.graded,
      condition: copy.condition,
      ownPriceCents: copy.ownPriceCents,
      // Only read when the copy has no price of its own.
      commonPriceCents:
        copy.ownPriceCents === undefined && copy.variantId !== undefined ? await this.commonPrice(copy.variantId) : null,
    });
    if (readiness.ready) return;
    throw new ConvexError({ code: LISTING_GATE_ERROR, message: listingGateMessage(home.name, readiness) });
  }
}

/**
 * For the inventory checklist and photo intake: whether the caller syncs at
 * all (the "See what's syncing" link after Sync and Done adding photos),
 * whether the gate applies to adds into `homeId`, and the caller's common
 * price for `variantId` (cents) when it does. The screen combines it with what the copy will carry through
 * `lib/listingReadiness.ts`, the rule the writers above enforce. Photo intake
 * reads that through `intakeRunReadiness`: with no variant yet it asks for the
 * set first, so a null price here isn't a missing price until a set is picked.
 *
 * NEO-452: `variantHasCards` says whether the picked set holds a card, for every
 * caller and every home, so the screen can stop at an empty set before spending
 * a job start (the hourly budget is shared by every intake door) on a run
 * `createIntakeRun` would refuse. True with no variant: there is nothing to
 * refuse yet. False for a string that is not a variant's id.
 *
 * Small and subscribable (CLAUDE.md, "A subscribed query stays small"): the
 * home, the caller's listing state rows (a handful), one common-price row and
 * one card. The caller's own rows only, bar that one catalog card; an id that is
 * not theirs, not an id, or absent reads as "does not apply". Never a
 * marketplace value.
 */
export const forHome = query({
  args: { homeId: v.optional(v.string()), variantId: v.optional(v.string()) },
  returns: v.object({
    /** The caller is set up for syncing (`listsAnywhereNow`), whatever the home. */
    syncing: v.boolean(),
    /** The gate applies to adds into the home: it lists, and the caller syncs. */
    applies: v.boolean(),
    commonPriceCents: v.union(v.number(), v.null()),
    /** The variant holds at least one card; true when no variant is passed. Answered for every caller and home. */
    variantHasCards: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const gate = new ListingGate(ctx, ownerId);
    const variantId = args.variantId === undefined ? null : ctx.db.normalizeId("selectorOptions", args.variantId);
    const variantHasCards =
      args.variantId === undefined ||
      (variantId !== null &&
        (await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
          .first()) !== null);
    const syncing = await gate.syncs();
    const none = { syncing, applies: false, commonPriceCents: null, variantHasCards };
    if (!syncing) return none;
    const homeId = args.homeId === undefined ? null : ctx.db.normalizeId("collectionContainers", args.homeId);
    if (!homeId) return none;
    const home = await ctx.db.get(homeId);
    if (!home || home.ownerId !== ownerId || !(await gate.applies(home))) return none;
    return { syncing, applies: true, commonPriceCents: variantId ? await gate.commonPrice(variantId) : null, variantHasCards };
  },
});
