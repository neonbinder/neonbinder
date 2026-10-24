/**
 * NEO-358 — how a `cardChecklist` row is deleted, in one place.
 *
 * Every card delete in the catalog goes through `removeCardRow`, which does, in
 * this order and in the caller's transaction:
 *
 *   1. the COLLECTOR GUARD: a card a collector owns a copy of
 *      (`collectionCopies.by_card`) is never deleted. It throws, so a caller
 *      that forgot its page-level check still loses nothing;
 *   2. its cross-listing junctions (NEO-21), so a guest checklist never links
 *      to a card that is gone;
 *   3. its variation children are PROMOTED, not deleted (NEO-189);
 *   4. its derived player index rows (NEO-313, `cardPlayerLinks`);
 *   5. its derived team index rows (NEO-358, `cardTeamLinks`);
 *   6. the row itself;
 *   7. its row's card counts go down, and the subtree counts of every row
 *      above it (`CardCountLedger`; the caller flushes).
 *
 * Callers that delete a PAGE of cards ask `collectedCardIds` for the whole page
 * BEFORE deleting any of it, and refuse, skip or block from that answer: the
 * guard inside `removeCardRow` is the backstop, not the plan, because a throw
 * mid-page rolls the page back rather than telling the operator which card.
 *
 * The callers, and what each does with a collected card:
 *   - `selectorOptions.deleteCard`: refuses (`collectedCardRefusal`, with how
 *     many collectors hold the card);
 *   - `selectorOptions.commitCardChecklistFinalize`: skips it, counted;
 *   - `parallelChecklistBuild.deleteParallelCardsPage`: blocks the rebuild;
 *   - `wipeVariantTypeSubtree.wipeCardsPage`: refuses, and the dry run lists it.
 *
 * `cardCounts.pin.test.ts` and `cardTeamLinks.pin.test.ts` pin that no other
 * module deletes a card.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deleteCardPlayerLinks } from "./cardPlayerLinks";
import { deleteCardTeamLinks } from "./cardTeamLinks";
import type { CardCountLedger } from "./cardCounts";
import { collectedCardRefusal, type CollectorCount } from "../lib/collection/collectors";

/**
 * Copy lines `countCollectors` reads before it settles for a floor ("20+").
 * A refusal names how many collectors are in the way; it never walks every
 * copy of a card to say so.
 */
export const COLLECTOR_COUNT_LINES = 100;

/**
 * NEO-21: every card delete drops its `cardCrossListings` junction rows first,
 * or a guest checklist keeps rendering a link to a card that no longer exists.
 */
async function deleteCardCrossListingsFor(
  ctx: MutationCtx,
  cardChecklistId: Id<"cardChecklist">,
): Promise<Array<Id<"cardCrossListings">>> {
  const crossListings = await ctx.db
    .query("cardCrossListings")
    .withIndex("by_card", (q) => q.eq("cardChecklistId", cardChecklistId))
    .collect();
  for (const link of crossListings) {
    await ctx.db.delete(link._id);
  }
  return crossListings.map((link) => link._id);
}

/**
 * NEO-189 — a deleted card must not leave its VARIATIONS pointing at a row that
 * no longer exists.
 *
 * The children are PROMOTED, not deleted. A variation is a full card in its own
 * right — its own players, its own SKU, its own platform refs — so losing its
 * parent must not lose the card. It becomes an ordinary card, and an operator
 * can re-parent it. A promoted child stays on its own row, so `cardCount` is
 * unchanged, but it is a base card now: `nonVariationCardCount` rises by one
 * per child, through the caller's `ledger`.
 */
export async function orphanVariationsOf(
  ctx: MutationCtx,
  cardChecklistId: Id<"cardChecklist">,
  ledger: CardCountLedger,
): Promise<void> {
  const children = await ctx.db
    .query("cardChecklist")
    .withIndex("by_variation_parent", (q) =>
      q.eq("variationOfCardId", cardChecklistId),
    )
    .collect();
  for (const child of children) {
    await ctx.db.patch(child._id, {
      variationOfCardId: undefined,
      lastUpdated: Date.now(),
    });
    ledger.variationChanged(child.selectorOptionId, true, false);
  }
}

/** Does any collector own a copy of this card? One indexed read. */
export async function cardIsCollected(
  ctx: { db: QueryCtx["db"] },
  cardId: Id<"cardChecklist">,
): Promise<boolean> {
  const copy = await ctx.db
    .query("collectionCopies")
    .withIndex("by_card", (q) => q.eq("cardId", cardId))
    .first();
  return copy !== null;
}

/**
 * The cards among `cardIds` a collector owns a copy of, for a caller to check
 * a whole page BEFORE deleting any of it. One indexed read per card.
 */
export async function collectedCardIds(
  ctx: { db: QueryCtx["db"] },
  cardIds: ReadonlyArray<Id<"cardChecklist">>,
): Promise<Set<Id<"cardChecklist">>> {
  const out = new Set<Id<"cardChecklist">>();
  for (const cardId of cardIds) {
    if (await cardIsCollected(ctx, cardId)) out.add(cardId);
  }
  return out;
}

/**
 * How many collectors own copies of `cardIds`, for a refusal to name: distinct
 * owners over at most `budget` copy lines across all the cards (one indexed
 * read per card). `atLeast` when the read stopped before seeing every copy,
 * so the count is a floor. Pass only cards known to be collected.
 */
export async function countCollectors(
  ctx: { db: QueryCtx["db"] },
  cardIds: ReadonlyArray<Id<"cardChecklist">>,
  budget: number = COLLECTOR_COUNT_LINES,
): Promise<CollectorCount> {
  const owners = new Set<string>();
  let left = budget;
  let atLeast = false;
  for (const cardId of cardIds) {
    if (left <= 0) {
      atLeast = true;
      break;
    }
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_card", (q) => q.eq("cardId", cardId))
      .take(left + 1);
    if (rows.length > left) {
      atLeast = true;
      rows.length = left;
    }
    left -= rows.length;
    for (const row of rows) owners.add(row.ownerId);
  }
  return { collectors: owners.size, atLeast };
}

/** The ids of everything `removeCardRow` deleted with the card, for logging. */
export type RemovedCardRow = {
  crossListingIds: Array<Id<"cardCrossListings">>;
  playerLinkIds: Array<Id<"cardPlayerLinks">>;
  teamLinkIds: Array<Id<"cardTeamLinks">>;
};

/**
 * Delete one card and everything derived from it. See the header for the
 * order. Throws `collectedCardRefusal` (writing nothing, and saying how many
 * collectors hold it) for a card a collector owns a copy of.
 *
 * `ledger` is REQUIRED: a card delete that does not move its row's count is
 * the drift the count exists to avoid. The caller flushes it once, last.
 */
export async function removeCardRow(
  ctx: MutationCtx,
  card: Doc<"cardChecklist">,
  ledger: CardCountLedger,
): Promise<RemovedCardRow> {
  // 1. the collector guard
  if (await cardIsCollected(ctx, card._id)) {
    throw new ConvexError(collectedCardRefusal(await countCollectors(ctx, [card._id])));
  }
  // 2. cross-listings
  const crossListingIds = await deleteCardCrossListingsFor(ctx, card._id);
  // 3. variation children are promoted
  await orphanVariationsOf(ctx, card._id, ledger);
  // 4. the player index
  const playerLinkIds = await deleteCardPlayerLinks(ctx, card._id);
  // 5. the team index
  const teamLinkIds = await deleteCardTeamLinks(ctx, card._id);
  // 6. the card
  await ctx.db.delete(card._id);
  // 7. its row's count, and (NEO-358) its row's chain remembered while the
  //    row still exists, so the subtree counts above it still move if the
  //    caller ends the emptied row before it flushes.
  ledger.removeCard(card);
  await ledger.rememberChain(ctx, card.selectorOptionId);
  return { crossListingIds, playerLinkIds, teamLinkIds };
}
