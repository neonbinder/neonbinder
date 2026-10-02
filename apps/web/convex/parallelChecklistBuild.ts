/**
 * NEO-312 — building an insert's parallels from the insert's checklist.
 *
 * ## The model (Jason, 2026-09-28)
 *
 * A parallel's cards are a COPY of its insert's NB cards, each re-linked to the
 * parallel's OWN marketplace card per side. Nothing is stored beyond the
 * checklist rows and their `platformData`: no decisions, no pairings, no
 * review. It is a one-time build, re-runnable as a rebuild.
 *
 *   J1  After an insert's checklist is saved, the client builds its parallels
 *       one at a time, calling `buildParallelChecklist` for each.
 *   J2  A card is copied only if it links on at least one marketplace side;
 *       the rest are left off and reported.
 *   J3  A parallel that already has cards is REBUILT from a fresh copy — the
 *       automatic run included (R1: no confirm, no "empty only").
 *   J4  "Fetch from Marketplaces" on a parallel row runs the same build for
 *       that one parallel.
 *   R2  A rebuilt card that is clearly the old one keeps the old SKU.
 *
 * ## What a build does, in order (M2)
 *
 *   1. Judge which sides the PARALLEL can be fetched on, from its own ids only
 *      (`leafGate`, and the chain with the insert row taken out — see
 *      `chainWithoutInsertAncestors`). The insert's ids and every NB name stay
 *      out of every request.
 *   2. Clear the parallel's abandoned review state (candidates, entity-review
 *      rows — transient wizard state a parallel can no longer reach). Then
 *      refuse, touching nothing else, if the parallel is blocked: a card with
 *      scans, a card that is the home of a cross-listing, a review live in
 *      another window, more marketplace sets than one build reads, or a side the parallel
 *      owns that cannot be fetched while its old cards hold links there.
 *   3. Fetch EVERY side. A side that fails blocks the build and nothing changes.
 *   4. Link each insert card per side (`lib/parallelCardLink.ts`, exactly-one on
 *      both ends; the old cards' links break ties) and decide the copies.
 *      Classify every old link BEFORE anything is deleted.
 *   5. Check the blocks again, then delete the parallel's old cards (pages of
 *      100), then insert the copies (pages of 150).
 *
 * A crash between 5's delete and insert leaves the parallel short; running the
 * build again rebuilds it (risk 1 in the plan, accepted). A block that fires
 * partway through the delete says so, with the count removed.
 *
 * ## Two builds of one parallel at once (no schema)
 *
 * The first insert page requires the parallel to hold NO cards, inside its own
 * transaction; every later page requires the run's first created card to still
 * exist. Whichever run loses that race stops with `BLOCKED_CHANGED_MID_BUILD`.
 *
 * ## Operator-facing words
 *
 * `blockedReason` and every ConvexError here are read by an operator. They are
 * fixed sentences apart from an NB row's own name: no marketplace string, no
 * internal word. The one deliberate exception is `extraOnMarketplace.cards`,
 * see there.
 */

import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import {
  MAX_BSC_FAN_OUT,
  chainWithoutInsertAncestors,
  bscFacetValidator,
  missingBscChecklistScope,
  planBscFanOut,
  resolveBscFacetFilters,
  type BscFacet,
} from "./bscFacets";
import {
  leafOwnsSource,
  missingSummary,
  resolvableSides,
  rowHasSideId,
  type ResolvableRow,
} from "./marketplaceResolvability";
import { pausedSides } from "./marketplacePause";
import { slotIds, type PlatformSide } from "./platformSlots";
import { platformSideValidator } from "./selectorSyncStore";
import { orphanVariationsOf, resolveCardSlots } from "./selectorOptions";
import {
  copyFeaturesForParallel,
  insertCardRow,
  type CardRowSetContext,
} from "./cardRowCreate";
import {
  cardKey,
  linkCardsToSide,
  type CardLinkOutcome,
  type FetchedParallelCard,
  type LinkableNbCard,
} from "./lib/parallelCardLink";
import { teamFullName } from "../lib/teams/team-name";
import { deleteCardPlayerLinks } from "./cardPlayerLinks";
import { findSportForSelectorOption } from "./cardChecklist";
import { safeMarketplaceText } from "../lib/marketplace/safe-text";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The most cards an insert (or a parallel being rebuilt) may have. */
export const MAX_INSERT_CARDS_FOR_BUILD = 5000;
/** Parallels listed per insert; more sets `truncated`. */
export const MAX_PARALLELS_PER_INSERT = 500;
/**
 * Copies inserted per transaction. Per copy: one `db.get` of the source, one
 * insert, one SKU patch (none when the old SKU is kept), one player-index
 * insert per player (NEO-313, usually one), plus a variation-parent `db.get`
 * for a variation and the player/team name reads (cached per page). ~150 × 4
 * + names ≈ 750–850 operations, inside the ~900 `CARDS_PER_COMMIT_CHUNK` is
 * calibrated to.
 */
export const INSERT_COPIES_PER_PAGE = 150;
/**
 * Old cards deleted per transaction. Per card: one cross-listing lookup, one
 * variation-children lookup (plus a patch per child), one player-index lookup
 * plus a delete per index row (NEO-313, usually one), one delete ≈ 500–600.
 */
export const DELETE_CARDS_PER_PAGE = 100;
/**
 * Cards whose blocks are checked per read page: one page read plus one
 * cross-listing lookup per card.
 */
export const BLOCK_CHECK_CARDS_PER_PAGE = 400;
/** SportLots sets one build reads; more BLOCKS (never truncated). */
export const MAX_SL_SETS_PER_BUILD = 10;
/** Cards named per bucket in the result; the counts stay exact. */
export const MAX_LISTED_CARDS = 50;
/**
 * `getParallelsForBuild` is a live subscription over up to 500 parallels, so
 * its block check is budgeted: at most this many cards read and this many
 * cross-listing lookups across the whole list. Past the budget a parallel's
 * `blocked` is simply left unset — the build itself checks every card.
 */
const LIST_BLOCK_CARD_BUDGET = 4000;
const LIST_BLOCK_LOOKUP_BUDGET = 1000;
const LIST_BLOCK_CARDS_PER_PARALLEL = 200;
/**
 * Review state touched within this window is someone's live session and is
 * left alone (the build blocks instead); anything older is abandoned wizard
 * state and the build clears it.
 */
export const REVIEW_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
/** Review rows read per scan page (one paginate, no per-row reads). */
const REVIEW_SCAN_PAGE = 500;
/** Review rows deleted per transaction (one delete each). */
const REVIEW_CLEAR_PAGE = 400;

// ---------------------------------------------------------------------------
// Operator-facing sentences (DRAFT — Jason signs off). Each reads after
// "Blocked — " on the parallel's own line, so none names the parallel.
// ---------------------------------------------------------------------------

export const BLOCKED_SCANS =
  "some of its cards have scans, and a rebuild would lose them";
export const BLOCKED_CROSS_LISTED =
  "some of its cards also show under another set — take them off there first";
/**
 * Only for a review someone is working in RIGHT NOW (activity within
 * `REVIEW_ACTIVE_WINDOW_MS`). A parallel has no way to start or reach a review
 * any more, so stale review state is cleared by the build instead of blocking
 * it (see `clearStaleReviewState`); a fresh one can only be an old tab.
 */
export const BLOCKED_REVIEW_OPEN =
  "a checklist review is running on it in another window — try again in a few minutes";
export const BLOCKED_NO_IDS = "it isn't linked to a marketplace yet";
/** The no-name fallback of `blockedIdsUnreachable`. */
export const BLOCKED_IDS_UNREACHABLE =
  "its marketplace links need the set above it linked too — link that first";
export const BLOCKED_TOO_MANY_CARDS =
  "the insert has more than 5,000 cards, which is more than one build can copy";
export const BLOCKED_PARALLEL_TOO_MANY_CARDS =
  "it has more than 5,000 cards, which is more than one rebuild can replace";
export const BLOCKED_NOTHING_MATCHED =
  "none of the insert's cards turned up on its marketplace checklists, so its cards were left as they were";
export const BLOCKED_CHANGED_MID_BUILD =
  "its cards changed partway through the rebuild, and some were already cleared — build it again to put them back";
export const BLOCKED_TOO_MANY_SL_SETS =
  "it has more than 10 SportLots sets linked, which is more than one build reads — unlink the extras first";
export const BLOCKED_TOO_MANY_BSC_SETS =
  "its BSC links add up to more than 10 lookups, which is more than one build reads — unlink the extras first";

/**
 * The short marketplace names operators see. Mirrors `SIDE_LABEL` in
 * `components/SetSelector/selector-sync-feedback.ts`, which a Convex module
 * cannot import.
 */
const SIDE_LABEL: Record<PlatformSide, string> = {
  bsc: "BSC",
  sportlots: "SportLots",
};

export function blockedSideFailed(side: PlatformSide): string {
  return `${SIDE_LABEL[side]} didn't answer, so nothing changed — try again in a bit`;
}

/** A rebuild with a paused side the parallel's old cards hold links on. */
export function blockedSidePaused(side: PlatformSide): string {
  return `${SIDE_LABEL[side]} is paused right now — rebuild once it's back, or its links would drop`;
}

/** Nothing can be fetched because every side the parallel owns is paused. */
export function blockedAllPaused(sides: readonly PlatformSide[]): string {
  const names = sides.map((s) => SIDE_LABEL[s]).join(" and ");
  return sides.length > 1
    ? `${names} are paused right now — build it once they're back`
    : `${names} is paused right now — build it once it's back`;
}

/**
 * A side the parallel owns cannot be asked because a row above it is missing
 * that side's id. `rowName` is that NB row's own name when it could be found.
 */
export function blockedIdsUnreachable(
  rowName?: string,
  side?: PlatformSide,
): string {
  if (!rowName) return BLOCKED_IDS_UNREACHABLE;
  const whose = side ? `its ${SIDE_LABEL[side]} links` : "its marketplace links";
  return `${whose} need ${rowName} linked too — link ${rowName} first`;
}

const NOT_A_PARALLEL =
  "That row isn't a parallel, so there's nothing to build.";
const PARALLEL_GONE =
  "That parallel is gone — it may have just been deleted.";
const NO_INSERT_ABOVE =
  "This parallel doesn't sit under an insert, so there's no checklist to copy.";

// ---------------------------------------------------------------------------
// Chains and the side plan
// ---------------------------------------------------------------------------

type ChainRow = ResolvableRow & { cardNumberPrefix?: string };

async function loadChain(
  ctx: { db: QueryCtx["db"] },
  leafId: Id<"selectorOptions">,
): Promise<{ chain: ChainRow[]; rows: Array<Doc<"selectorOptions">> }> {
  const chain: ChainRow[] = [];
  const rows: Array<Doc<"selectorOptions">> = [];
  let currentId: Id<"selectorOptions"> | undefined = leafId;
  while (currentId) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(currentId);
    if (!row) break;
    rows.unshift(row);
    chain.unshift(chainRowOf(row));
    currentId = row.parentId;
  }
  return { chain, rows };
}

function chainRowOf(row: Doc<"selectorOptions">): ChainRow {
  const prefix = row.metadata?.cardNumberPrefix;
  return {
    level: row.level,
    value: row.value,
    platformData: row.platformData ?? {},
    platformFacets: row.platformFacets,
    ...(prefix ? { cardNumberPrefix: prefix } : {}),
  };
}

/** The deepest `cardNumberPrefix` on the chain, as `fetchCardChecklist` reads it. */
function prefixOf(chain: readonly ChainRow[]): string | undefined {
  let prefix: string | undefined;
  for (const row of chain) if (row.cardNumberPrefix) prefix = row.cardNumberPrefix;
  return prefix;
}

export type ParallelSidePlan = {
  /** Per side: the parallel holds a source id of its own there. */
  owned: Record<PlatformSide, boolean>;
  /** Per side: this build will ask it (ids complete, not paused). */
  fetch: Record<PlatformSide, boolean>;
  /** Per side: ids complete, and only the operator's pause stops it. */
  paused: Record<PlatformSide, boolean>;
  /** Log-safe (`missingSummary`) — never shown to an operator. */
  missing: Record<PlatformSide, string>;
  /**
   * Per side the parallel OWNS but cannot be asked for want of an ancestor
   * id: the NB name of the first row missing it, for the operator's sentence.
   */
  unreachableRow: Partial<Record<PlatformSide, string>>;
  bscFilters: Record<string, string[]>;
  bscSourceFacet?: BscFacet;
  /** BSC would need more requests than one build sends (`MAX_BSC_FAN_OUT`). */
  bscOverCap: boolean;
  /** The parallel's OWN SportLots set ids, in slot order — never truncated. */
  slIds: string[];
  /** More SportLots sets than one build reads (`MAX_SL_SETS_PER_BUILD`). */
  slOverCap: boolean;
};

/** Which NB level supplies each required BSC checklist facet. */
const BSC_FACET_LEVEL: Record<string, string> = {
  sport: "sport",
  year: "year",
  setName: "setName",
  variant: "variantType",
};

/**
 * Which sides a parallel is built from, and with what. Pure; shared by the
 * list query (no pause) and the build (with it), so what the list says and
 * what the build does come from one function.
 *
 * The chain is judged AND queried with its insert row taken out, and the
 * checklist gate runs with `leafGate`: only the parallel's own ids scope a
 * request, and a side it holds none on is skipped.
 */
export function planParallelSides(
  chain: readonly ResolvableRow[],
  paused?: ReadonlySet<PlatformSide>,
): ParallelSidePlan {
  const leaf = chain[chain.length - 1];
  const judged = chainWithoutInsertAncestors(chain);
  const resolution = resolvableSides(judged, {
    bscScope: "checklist",
    leafGate: true,
    ...(paused ? { paused } : {}),
  });
  const plan = resolveBscFacetFilters(judged);
  const owned = {
    bsc: !!leaf && leafOwnsSource(leaf, "bsc"),
    sportlots: !!leaf && leafOwnsSource(leaf, "sportlots"),
  };

  // The row an operator has to link for an owned side to become reachable.
  const unreachableRow: Partial<Record<PlatformSide, string>> = {};
  const nameAt = (level: string): string | undefined =>
    judged.find((row) => row.level === level)?.value;
  if (owned.bsc && !resolution.bsc.resolvable && !resolution.bsc.paused) {
    const facet = missingBscChecklistScope(plan.filters)[0];
    const name = facet ? nameAt(BSC_FACET_LEVEL[facet] ?? "") : undefined;
    if (name) unreachableRow.bsc = name;
  }
  if (
    owned.sportlots &&
    !resolution.sportlots.resolvable &&
    !resolution.sportlots.paused
  ) {
    const row = judged.find(
      (r) =>
        (r.level === "sport" || r.level === "year") &&
        !rowHasSideId(r, "sportlots"),
    );
    if (row?.value) unreachableRow.sportlots = row.value;
  }

  const slIds = leaf ? slotIds(leaf, "sportlots") : [];
  return {
    owned,
    fetch: {
      bsc: resolution.bsc.resolvable,
      sportlots: resolution.sportlots.resolvable,
    },
    paused: {
      bsc: resolution.bsc.paused,
      sportlots: resolution.sportlots.paused,
    },
    missing: {
      bsc: missingSummary(resolution.bsc),
      sportlots: missingSummary(resolution.sportlots),
    },
    unreachableRow,
    bscFilters: plan.filters,
    ...(plan.sourceFacet ? { bscSourceFacet: plan.sourceFacet } : {}),
    bscOverCap: planBscFanOut(plan.filters, MAX_BSC_FAN_OUT).capped,
    slIds,
    slOverCap: slIds.length > MAX_SL_SETS_PER_BUILD,
  };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

async function reviewStagedOn(
  ctx: { db: QueryCtx["db"] },
  selectorOptionId: Id<"selectorOptions">,
): Promise<boolean> {
  const candidate = await ctx.db
    .query("checklistCandidates")
    .withIndex("by_selector_option_and_user", (q) =>
      q.eq("selectorOptionId", selectorOptionId),
    )
    .first();
  if (candidate) return true;
  const queued = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option", (q) =>
      q.eq("selectorOptionId", selectorOptionId),
    )
    .first();
  return queued !== null;
}

/** The last sign of life of a review row — see `sweepAbandonedBatches`. */
function reviewRowLastActive(row: Doc<"entityReviewQueue">): number {
  return Math.max(row._creationTime, row.lastTouchedAt ?? 0);
}

/**
 * The list's cheap early warning: the first staged row of each kind, judged
 * for freshness. Approximate on purpose (one read each); the build scans every
 * row before it clears anything.
 */
async function reviewLooksLive(
  ctx: { db: QueryCtx["db"] },
  selectorOptionId: Id<"selectorOptions">,
  cutoff: number,
): Promise<boolean> {
  const candidate = await ctx.db
    .query("checklistCandidates")
    .withIndex("by_selector_option_and_user", (q) =>
      q.eq("selectorOptionId", selectorOptionId),
    )
    .first();
  if (candidate && candidate._creationTime >= cutoff) return true;
  const queued = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option", (q) =>
      q.eq("selectorOptionId", selectorOptionId),
    )
    .first();
  return queued !== null && reviewRowLastActive(queued) >= cutoff;
}

function hasScans(card: Doc<"cardChecklist">): boolean {
  return !!(card.imageUrls?.front || card.imageUrls?.back);
}

async function isCrossListingHome(
  ctx: { db: QueryCtx["db"] },
  cardId: Id<"cardChecklist">,
): Promise<boolean> {
  const link = await ctx.db
    .query("cardCrossListings")
    .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
    .first();
  return link !== null;
}

// ---------------------------------------------------------------------------
// The link key, read off a stored card
// ---------------------------------------------------------------------------

/**
 * The printed names on a card, as the link key reads them: the resolved ones'
 * printed spellings, then any still waiting on review. Also what an insert
 * page compares to tell whether its source card changed mid-build.
 */
function namesOnCardOf(row: Doc<"cardChecklist">): string[] {
  return [
    ...(row.playerLinks ?? []).map((l) => l.nameOnCard),
    ...(row.pendingPlayerNames ?? []),
  ];
}

/** A stored card reduced to what the link key reads. */
function linkableOf(row: Doc<"cardChecklist">) {
  const namesOnCard = namesOnCardOf(row);
  const hasTeams =
    (row.teamOnCardIds?.length ?? 0) > 0 ||
    (row.pendingTeamNames?.length ?? 0) > 0;
  const hasPlayers = namesOnCard.length > 0 || (row.playerIds?.length ?? 0) > 0;
  return {
    _id: row._id,
    cardNumber: row.cardNumber,
    cardName: row.cardName,
    namesOnCard,
    isTeamCard: !hasPlayers && hasTeams,
    isVariation: !!row.variationOfCardId || !!row.cardVariation?.trim(),
    ...(row.cardVariation ? { cardVariation: row.cardVariation } : {}),
  };
}

/** The NB display string a result list names a card by: `#12 Player Name`. */
function cardLabel(card: { cardNumber: string; cardName: string }): string {
  return `#${card.cardNumber} ${card.cardName}`;
}

// ---------------------------------------------------------------------------
// The list the client builds from
// ---------------------------------------------------------------------------

/**
 * The parallels of an insert, with what the build needs to show before it
 * runs. A live subscription: a missing or non-insert row answers an empty list
 * rather than throwing, so a row deleted under an open panel does not turn it
 * into an error boundary.
 *
 * `sides` is judged on ids alone (no pause), from `planParallelSides`.
 * `blocked` is a budgeted early warning; the build re-checks every card.
 */
export const getParallelsForBuild = query({
  args: { insertId: v.id("selectorOptions") },
  returns: v.object({
    parallels: v.array(
      v.object({
        _id: v.id("selectorOptions"),
        value: v.string(),
        sides: v.object({ bsc: v.boolean(), sportlots: v.boolean() }),
        hasCards: v.boolean(),
        blocked: v.optional(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const insert = await ctx.db.get(args.insertId);
    if (!insert || insert.level !== "insert") {
      return { parallels: [], truncated: false };
    }
    const { chain: insertChain } = await loadChain(ctx, args.insertId);

    const found = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "parallel").eq("parentId", args.insertId),
      )
      .take(MAX_PARALLELS_PER_INSERT + 1);
    const truncated = found.length > MAX_PARALLELS_PER_INSERT;
    // The insert's own child order, which is the order its column shows.
    const position = new Map<string, number>(
      (insert.children ?? []).map((id, i) => [id, i]),
    );
    const parallels = found
      .slice(0, MAX_PARALLELS_PER_INSERT)
      .sort(
        (a, b) =>
          (position.get(a._id) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b._id) ?? Number.MAX_SAFE_INTEGER),
      );

    let cardBudget = LIST_BLOCK_CARD_BUDGET;
    let lookupBudget = LIST_BLOCK_LOOKUP_BUDGET;
    const out = [];
    for (const parallel of parallels) {
      const plan = planParallelSides([...insertChain, chainRowOf(parallel)]);
      const take = Math.max(
        1,
        Math.min(LIST_BLOCK_CARDS_PER_PARALLEL, cardBudget),
      );
      const cards = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", parallel._id),
        )
        .take(take);
      cardBudget -= cards.length;

      let blocked: string | undefined;
      if (await reviewLooksLive(ctx, parallel._id, Date.now() - REVIEW_ACTIVE_WINDOW_MS)) {
        blocked = BLOCKED_REVIEW_OPEN;
      } else if (cards.some(hasScans)) {
        blocked = BLOCKED_SCANS;
      } else {
        for (const card of cards) {
          if (lookupBudget <= 0) break;
          lookupBudget--;
          if (await isCrossListingHome(ctx, card._id)) {
            blocked = BLOCKED_CROSS_LISTED;
            break;
          }
        }
      }

      out.push({
        _id: parallel._id,
        value: parallel.value,
        sides: { bsc: plan.fetch.bsc, sportlots: plan.fetch.sportlots },
        hasCards: cards.length > 0,
        ...(blocked ? { blocked } : {}),
      });
    }
    return { parallels: out, truncated };
  },
});

// ---------------------------------------------------------------------------
// Internal reads for the action
// ---------------------------------------------------------------------------

const sideFlagsValidator = v.object({
  bsc: v.boolean(),
  sportlots: v.boolean(),
});

const sideCountsValidator = v.object({
  bsc: v.number(),
  sportlots: v.number(),
});

const sideCardListsValidator = v.object({
  bsc: v.array(v.string()),
  sportlots: v.array(v.string()),
});

export const loadParallelBuildContext = internalQuery({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    insertId: v.id("selectorOptions"),
    owned: sideFlagsValidator,
    fetch: sideFlagsValidator,
    paused: sideFlagsValidator,
    missing: v.object({ bsc: v.string(), sportlots: v.string() }),
    unreachableRow: v.object({
      bsc: v.optional(v.string()),
      sportlots: v.optional(v.string()),
    }),
    bscFilters: v.record(v.string(), v.array(v.string())),
    bscSourceFacet: v.optional(bscFacetValidator),
    bscOverCap: v.boolean(),
    slIds: v.array(v.string()),
    slOverCap: v.boolean(),
    insertPrefix: v.optional(v.string()),
    parallelPrefix: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const parallel = await ctx.db.get(args.parallelId);
    if (!parallel) throw new ConvexError(PARALLEL_GONE);
    if (parallel.level !== "parallel") throw new ConvexError(NOT_A_PARALLEL);
    const insertId = parallel.parentId;
    const insert = insertId ? await ctx.db.get(insertId) : null;
    if (!insertId || !insert || insert.level !== "insert") {
      throw new ConvexError(NO_INSERT_ABOVE);
    }
    const { chain } = await loadChain(ctx, args.parallelId);
    const plan = planParallelSides(chain, pausedSides());
    const insertPrefix = prefixOf(chain.slice(0, -1));
    const parallelPrefix = prefixOf(chain);
    return {
      insertId,
      owned: plan.owned,
      fetch: plan.fetch,
      paused: plan.paused,
      missing: plan.missing,
      unreachableRow: plan.unreachableRow,
      bscFilters: plan.bscFilters,
      ...(plan.bscSourceFacet ? { bscSourceFacet: plan.bscSourceFacet } : {}),
      bscOverCap: plan.bscOverCap,
      slIds: plan.slIds,
      slOverCap: plan.slOverCap,
      ...(insertPrefix ? { insertPrefix } : {}),
      ...(parallelPrefix ? { parallelPrefix } : {}),
    };
  },
});

/**
 * One page of the block check over the parallel's current cards, plus how
 * many of them carry a link on each side. The staged-review check runs on the
 * first page only.
 */
export const checkParallelBuildBlocksPage = internalQuery({
  args: {
    parallelId: v.id("selectorOptions"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    blockedReason: v.optional(v.string()),
    cards: v.number(),
    linked: sideCountsValidator,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    if (args.cursor === null && (await reviewStagedOn(ctx, args.parallelId))) {
      return {
        blockedReason: BLOCKED_REVIEW_OPEN,
        cards: 0,
        linked: { bsc: 0, sportlots: 0 },
        isDone: true,
        continueCursor: "",
      };
    }
    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .paginate({ numItems: BLOCK_CHECK_CARDS_PER_PAGE, cursor: args.cursor });
    const linked = { bsc: 0, sportlots: 0 };
    let blockedReason: string | undefined;
    for (const card of page.page) {
      if (card.platformData?.bsc?.ref) linked.bsc++;
      if (card.platformData?.sportlots?.ref) linked.sportlots++;
      if (blockedReason) continue;
      if (hasScans(card)) blockedReason = BLOCKED_SCANS;
      else if (await isCrossListingHome(ctx, card._id)) {
        blockedReason = BLOCKED_CROSS_LISTED;
      }
    }
    return {
      ...(blockedReason ? { blockedReason } : {}),
      cards: page.page.length,
      linked,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

const linkableCardFields = {
  _id: v.id("cardChecklist"),
  cardNumber: v.string(),
  cardName: v.string(),
  namesOnCard: v.array(v.string()),
  isTeamCard: v.boolean(),
  isVariation: v.boolean(),
  cardVariation: v.optional(v.string()),
};

const linkableCardValidator = v.object({
  ...linkableCardFields,
  variationOfCardId: v.optional(v.id("cardChecklist")),
  sortOrder: v.number(),
});

/** The insert's cards, reduced to what the link key reads. */
export const loadInsertCardsForLink = internalQuery({
  args: { insertId: v.id("selectorOptions") },
  returns: v.object({
    cards: v.array(linkableCardValidator),
    overLimit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.insertId),
      )
      .take(MAX_INSERT_CARDS_FOR_BUILD + 1);
    if (rows.length > MAX_INSERT_CARDS_FOR_BUILD) {
      return { cards: [], overLimit: true };
    }
    return {
      overLimit: false,
      cards: rows.map((row) => ({
        ...linkableOf(row),
        ...(row.variationOfCardId
          ? { variationOfCardId: row.variationOfCardId }
          : {}),
        sortOrder: row.sortOrder,
      })),
    };
  },
});

/**
 * The parallel's CURRENT (old) cards: the link key, the refs each holds and
 * its SKU. Read once, before anything is fetched or deleted — it is what the
 * earlier-link tiebreak, the SKU carry (R2) and the classification of every
 * old link are computed from.
 */
export const loadParallelCardsForLink = internalQuery({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    cards: v.array(
      v.object({
        ...linkableCardFields,
        bscRef: v.optional(v.string()),
        slRef: v.optional(v.string()),
        sku: v.optional(v.string()),
      }),
    ),
    overLimit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .take(MAX_INSERT_CARDS_FOR_BUILD + 1);
    if (rows.length > MAX_INSERT_CARDS_FOR_BUILD) {
      return { cards: [], overLimit: true };
    }
    return {
      overLimit: false,
      cards: rows.map((row) => {
        const bscRef = row.platformData?.bsc?.ref;
        const slRef = row.platformData?.sportlots?.ref;
        return {
          ...linkableOf(row),
          ...(bscRef ? { bscRef } : {}),
          ...(slRef ? { slRef } : {}),
          ...(row.sku ? { sku: row.sku } : {}),
        };
      }),
    };
  },
});

/**
 * One page of the parallel's staged review state, for the build's freshness
 * scan: how many rows, and the newest sign of life among them. Reads only;
 * the clear runs after EVERY page of both tables has been judged, so a live
 * session is never half-deleted.
 */
export const scanParallelReviewPage = internalQuery({
  args: {
    parallelId: v.id("selectorOptions"),
    table: v.union(v.literal("candidates"), v.literal("entityReview")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    rows: v.number(),
    lastActiveAt: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const opts = { numItems: REVIEW_SCAN_PAGE, cursor: args.cursor };
    if (args.table === "candidates") {
      const page = await ctx.db
        .query("checklistCandidates")
        .withIndex("by_selector_option_and_user", (q) =>
          q.eq("selectorOptionId", args.parallelId),
        )
        .paginate(opts);
      return {
        rows: page.page.length,
        lastActiveAt: Math.max(0, ...page.page.map((r) => r._creationTime)),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    const page = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .paginate(opts);
    return {
      rows: page.page.length,
      lastActiveAt: Math.max(0, ...page.page.map(reviewRowLastActive)),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Delete one page of the parallel's STALE review state: `checklistCandidates`
 * first, then `entityReviewQueue`. Both are transient wizard/dialog state
 * (a Cancel deletes exactly these rows); no player, team, league, card or
 * `entityReviewSkips` ruling is touched.
 *
 * A row fresher than `cutoff` stops the page before anything in it is
 * deleted and answers `live` — a session started since the scan.
 */
export const clearParallelReviewPage = internalMutation({
  args: { parallelId: v.id("selectorOptions"), cutoff: v.number() },
  returns: v.object({
    candidates: v.number(),
    reviewRows: v.number(),
    done: v.boolean(),
    live: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_selector_option_and_user", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .take(REVIEW_CLEAR_PAGE);
    if (candidates.some((r) => r._creationTime >= args.cutoff)) {
      return { candidates: 0, reviewRows: 0, done: true, live: true };
    }
    for (const row of candidates) await ctx.db.delete(row._id);
    if (candidates.length === REVIEW_CLEAR_PAGE) {
      return { candidates: candidates.length, reviewRows: 0, done: false, live: false };
    }
    const budget = REVIEW_CLEAR_PAGE - candidates.length;
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .take(budget + 1);
    const page = rows.slice(0, budget);
    if (page.some((r) => reviewRowLastActive(r) >= args.cutoff)) {
      return { candidates: candidates.length, reviewRows: 0, done: true, live: true };
    }
    for (const row of page) await ctx.db.delete(row._id);
    return {
      candidates: candidates.length,
      reviewRows: page.length,
      done: rows.length <= budget,
      live: false,
    };
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Delete one page of the parallel's current cards.
 *
 * Every card in the page is checked BEFORE any is deleted: a scan, a
 * cross-listing home or a staged review found here refuses the whole page, so
 * a block that appeared since the action's own check still loses nothing on
 * this page. Variation children are promoted exactly as `deleteCard` does.
 */
export const deleteParallelCardsPage = internalMutation({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    deleted: v.number(),
    done: v.boolean(),
    blockedReason: v.optional(v.string()),
    refs: v.object({
      bsc: v.array(v.string()),
      sportlots: v.array(v.string()),
    }),
  }),
  handler: async (ctx, args) => {
    const empty = { bsc: [] as string[], sportlots: [] as string[] };
    if (await reviewStagedOn(ctx, args.parallelId)) {
      return { deleted: 0, done: true, blockedReason: BLOCKED_REVIEW_OPEN, refs: empty };
    }
    const page = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.parallelId),
      )
      .take(DELETE_CARDS_PER_PAGE);
    for (const card of page) {
      if (hasScans(card)) {
        return { deleted: 0, done: true, blockedReason: BLOCKED_SCANS, refs: empty };
      }
      if (await isCrossListingHome(ctx, card._id)) {
        return {
          deleted: 0,
          done: true,
          blockedReason: BLOCKED_CROSS_LISTED,
          refs: empty,
        };
      }
    }
    const refs = { bsc: [] as string[], sportlots: [] as string[] };
    for (const card of page) {
      const bscRef = card.platformData?.bsc?.ref;
      const slRef = card.platformData?.sportlots?.ref;
      if (bscRef) refs.bsc.push(bscRef);
      if (slRef) refs.sportlots.push(slRef);
      await orphanVariationsOf(ctx, card._id);
      // NEO-313 — the derived player index goes with the card, in the same
      // transaction, exactly as `deleteCard` does it.
      await deleteCardPlayerLinks(ctx, card._id);
      await ctx.db.delete(card._id);
    }
    return {
      deleted: page.length,
      done: page.length < DELETE_CARDS_PER_PAGE,
      refs,
    };
  },
});

const copyLinkValidator = v.object({
  ref: v.string(),
  setId: v.optional(v.string()),
});

/** Set-level values for the parallel's new rows, resolved once per page. */
async function parallelSetContext(
  ctx: { db: MutationCtx["db"] },
  parallel: Doc<"selectorOptions">,
): Promise<CardRowSetContext> {
  const { rows } = await loadChain(ctx, parallel._id);
  const sport = rows.find((r) => r.level === "sport");
  const setIndex = rows.findIndex((r) => r.level === "setName");
  const setRow = setIndex === -1 ? undefined : rows[setIndex];
  const brandRow = setIndex > 0 ? rows[setIndex - 1] : undefined;
  const features =
    parallel.features && Object.keys(parallel.features).length > 0
      ? parallel.features
      : undefined;
  return {
    sportSkuCode: sport?.sportConfig?.skuCode,
    sportValue: sport?.value ?? "",
    setNameValue: setRow?.value,
    // NEO-272 — read off a row that IS a manufacturer, or not at all.
    manufacturerBrandUnknown:
      brandRow?.level === "manufacturer"
        ? brandRow.metadata?.isBrandUnknown === true
        : undefined,
    inheritedFeatures: features,
  };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Insert one page of copies onto the parallel.
 *
 * Each copy re-reads its source card HERE, inside the transaction, and skips
 * it (counted in `skippedChangedSource`) when its number, name or printed
 * names are no longer what the action linked — or it is gone. The NB-owned
 * fields are copied (M3); features are the parallel's snapshot, the insert
 * card's own card-level facts and then its observed facts
 * (`copyFeaturesForParallel`); listing text, SKU (or the kept SKU, R2) and
 * `platformData` with `src` on the parallel's own slots go through the shared
 * `insertCardRow`, so a copy is born exactly like a synced card. `printRun` is
 * the linked SportLots card's only. `imageUrls` is never copied and no team
 * enrichment is queued.
 *
 * `remap` carries the new ids of variation PARENTS copied on earlier pages; a
 * variation whose parent was not copied loses the link (and its manual flag)
 * together, never one without the other.
 *
 * The concurrency guard runs before any write: with no `firstCreatedId` (this
 * run has created nothing yet) the parallel must hold no cards; with one, that
 * card must still exist on the parallel. Otherwise `changed` and nothing is
 * written.
 */
export const insertParallelCardsPage = internalMutation({
  args: {
    parallelId: v.id("selectorOptions"),
    insertId: v.id("selectorOptions"),
    firstCreatedId: v.optional(v.id("cardChecklist")),
    copies: v.array(
      v.object({
        sourceCardId: v.id("cardChecklist"),
        /** What the action linked; the source must still say exactly this. */
        expect: v.object({
          cardNumber: v.string(),
          cardName: v.string(),
          namesOnCard: v.array(v.string()),
        }),
        bsc: v.optional(copyLinkValidator),
        sportlots: v.optional(copyLinkValidator),
        printRun: v.optional(v.number()),
        keepSku: v.optional(v.string()),
      }),
    ),
    remap: v.array(
      v.object({ from: v.id("cardChecklist"), to: v.id("cardChecklist") }),
    ),
  },
  returns: v.object({
    created: v.array(
      v.object({ from: v.id("cardChecklist"), to: v.id("cardChecklist") }),
    ),
    /** Sources gone since the action read them. */
    missing: v.number(),
    /** Sources whose number, name or printed names changed since. */
    skippedChangedSource: v.number(),
    /** Another build got here first; nothing was written. */
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const parallel = await ctx.db.get(args.parallelId);
    if (!parallel || parallel.level !== "parallel") {
      throw new ConvexError(PARALLEL_GONE);
    }
    const insert = await ctx.db.get(args.insertId);
    if (parallel.parentId !== args.insertId || !insert) {
      throw new ConvexError(NO_INSERT_ABOVE);
    }

    // ── the concurrency guard, before any write ─────────────────────────────
    if (args.firstCreatedId === undefined) {
      const any = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", args.parallelId),
        )
        .first();
      if (any) {
        return { created: [], missing: 0, skippedChangedSource: 0, changed: true };
      }
    } else {
      const first = await ctx.db.get(args.firstCreatedId);
      if (!first || first.selectorOptionId !== args.parallelId) {
        return { created: [], missing: 0, skippedChangedSource: 0, changed: true };
      }
    }

    const set = await parallelSetContext(ctx, parallel);
    const toStored = await resolveCardSlots(ctx, args.parallelId);
    // NEO-313 — the copies' player index is keyed by the PARALLEL's sport
    // (the card's own chain), walked once per page and only if a copy carries
    // players; `insertCardRow` writes the rows.
    let pageSport: { id: Id<"selectorOptions"> | undefined } | undefined;
    const parallelSport = async (): Promise<Id<"selectorOptions"> | undefined> => {
      pageSport ??= {
        id: await findSportForSelectorOption(ctx, args.parallelId),
      };
      return pageSport.id;
    };

    const newIdOf = new Map<string, Id<"cardChecklist">>();
    for (const { from, to } of args.remap) newIdOf.set(from, to);

    const playerName = new Map<string, string | null>();
    const teamName = new Map<string, string | null>();
    const namesOf = async <T extends "players" | "teams">(
      ids: Array<Id<T>> | undefined,
      cache: Map<string, string | null>,
      read: (id: Id<T>) => Promise<string | null>,
    ): Promise<string[]> => {
      const out: string[] = [];
      for (const id of ids ?? []) {
        if (!cache.has(id)) cache.set(id, await read(id));
        const name = cache.get(id);
        if (name) out.push(name);
      }
      return out;
    };

    const created: Array<{ from: Id<"cardChecklist">; to: Id<"cardChecklist"> }> = [];
    let missing = 0;
    let skippedChangedSource = 0;
    for (const copy of args.copies) {
      const source = await ctx.db.get(copy.sourceCardId);
      if (!source || source.selectorOptionId !== args.insertId) {
        missing++;
        continue;
      }
      if (
        source.cardNumber !== copy.expect.cardNumber ||
        source.cardName !== copy.expect.cardName ||
        !sameStrings(namesOnCardOf(source), copy.expect.namesOnCard)
      ) {
        // The insert card was edited after it was linked: its link may no
        // longer be its own. Left off rather than copied on a stale match.
        skippedChangedSource++;
        continue;
      }

      // The variation pair travels together or not at all.
      let variation: {
        variationOfCardId?: Id<"cardChecklist">;
        variationParentManual?: boolean;
      } = {};
      if (source.variationOfCardId) {
        const parentCopy = newIdOf.get(source.variationOfCardId);
        const parentRow = parentCopy ? await ctx.db.get(parentCopy) : null;
        if (parentCopy && parentRow?.selectorOptionId === args.parallelId) {
          variation = {
            variationOfCardId: parentCopy,
            ...(source.variationParentManual !== undefined
              ? { variationParentManual: source.variationParentManual }
              : {}),
          };
        }
      } else if (source.variationParentManual !== undefined) {
        variation = { variationParentManual: source.variationParentManual };
      }

      const playerNames = await namesOf(
        source.playerIds,
        playerName,
        async (id) => (await ctx.db.get(id))?.name ?? null,
      );
      const teamNames = await namesOf(
        source.teamOnCardIds,
        teamName,
        async (id) => {
          const team = await ctx.db.get(id);
          return team ? teamFullName(team) : null;
        },
      );

      const newId = await insertCardRow(
        ctx,
        {
          selectorOptionId: args.parallelId,
          cardNumber: source.cardNumber,
          cardName: source.cardName,
          // NEO-254 — the pair, together.
          playerIds: source.playerIds,
          playerLinks: source.playerLinks,
          teamOnCardIds: source.teamOnCardIds,
          attributes: source.attributes,
          isRookie: source.isRookie,
          isRelic: source.isRelic,
          printRun: copy.printRun,
          cardVariation: source.cardVariation,
          // A legacy row may still carry it; observed only, never stored.
          autographType: source.autographType,
          platformData: toStored({
            ...(copy.bsc ? { bsc: copy.bsc } : {}),
            ...(copy.sportlots ? { sportlots: copy.sportlots } : {}),
          }),
          pendingPlayerNames: source.pendingPlayerNames ?? [],
          pendingTeamNames: source.pendingTeamNames ?? [],
          sortOrder: source.sortOrder,
          playerNames,
          teamNames,
          // Hobby A4 — the insert card's own facts (an autograph, Signed By,
          // a short print) survive; the parallel's snapshot wins on what the
          // parallel IS.
          baseFeatures: copyFeaturesForParallel({
            insertSnapshot: insert.features,
            parallelSnapshot: parallel.features,
            insertCardFeatures: source.features,
          }),
          ...(copy.keepSku ? { keepSku: copy.keepSku } : {}),
          carried: {
            teamCheckDoneAt: source.teamCheckDoneAt,
            bscTeamName: source.bscTeamName,
            teamNoneConfirmedAt: source.teamNoneConfirmedAt,
            teamNoneConfirmedByUserId: source.teamNoneConfirmedByUserId,
            ...variation,
          },
        },
        set,
        { sport: parallelSport },
      );
      newIdOf.set(source._id, newId);
      created.push({ from: source._id, to: newId });
    }
    return { created, missing, skippedChangedSource, changed: false };
  },
});

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

type SideCounts = { bsc: number; sportlots: number };
type SideLists = { bsc: string[]; sportlots: string[] };

export type BuildParallelResult = {
  status: "built" | "blocked";
  copied: number;
  notCopied: number;
  unlinked: SideCounts;
  ambiguous: SideCounts;
  sidesFetched: PlatformSide[];
  sidesSkipped: PlatformSide[];
  earlierLinksMissing: SideCounts;
  stillListedNotRelinked: SideCounts;
  legacyLinksRemoved: SideCounts;
  skippedChangedSource: number;
  deletedCount?: number;
  extraOnMarketplace: {
    bsc: { count: number; cards: string[] };
    sportlots: { count: number; cards: string[] };
  };
  cards: {
    leftOff: string[];
    unlinked: SideLists;
    ambiguous: SideLists;
  };
  rebuilt: boolean;
  blockedReason?: string;
};

const SIDES: readonly PlatformSide[] = ["bsc", "sportlots"];

/** Cards as the BSC checklist adapter returns them — the fields read here. */
type BscChecklistCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  platformRef?: string;
  sourceBscSetSlug?: string;
};

/** Cards as the SportLots checklist adapter returns them — the fields read here. */
type SlChecklistCard = {
  cardNumber: string;
  cardName: string;
  players?: string[];
  isVariation?: boolean;
  cardVariation?: string;
  printRun?: number;
  platformRef?: string;
};

type SideFetch =
  | { ok: true; cards: FetchedParallelCard[] }
  | { ok: false };

const extraValidator = v.object({
  count: v.number(),
  cards: v.array(v.string()),
});

export const buildParallelChecklist = action({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    status: v.union(v.literal("built"), v.literal("blocked")),
    /** Insert cards copied onto the parallel (linked on at least one side). */
    copied: v.number(),
    /** Insert cards left off: linked on no side (J2), or changed mid-build. */
    notCopied: v.number(),
    /** Per fetched side: COPIED cards with no card on that side. */
    unlinked: sideCountsValidator,
    /**
     * Per fetched side: insert cards that matched more than one card there
     * (or one card another insert card also matched), so were not linked on
     * it. Overlaps `notCopied` for a card ambiguous on every side.
     */
    ambiguous: sideCountsValidator,
    sidesFetched: v.array(platformSideValidator),
    sidesSkipped: v.array(platformSideValidator),
    /**
     * Per side the parallel owns: links the old cards held that the
     * marketplace no longer lists (invariant 5's "no longer returns it").
     */
    earlierLinksMissing: sideCountsValidator,
    /**
     * Per side the parallel owns: links the old cards held that the
     * marketplace STILL lists but no copy was re-linked to (the insert card
     * matched nothing, or more than one, and no earlier link broke the tie).
     */
    stillListedNotRelinked: sideCountsValidator,
    /**
     * Per side the parallel does NOT own: links the old cards carried anyway —
     * the pre-NEO-312 inheritance bug, pointing at the insert's cards. Removed
     * with the old cards and never re-created.
     */
    legacyLinksRemoved: sideCountsValidator,
    /** Insert cards edited or removed after they were linked; left off. */
    skippedChangedSource: v.number(),
    /** Old cards deleted — present on a block that fired mid-delete. */
    deletedCount: v.optional(v.number()),
    /**
     * Per fetched side: the parallel's marketplace cards no insert card
     * matched. The count is exact; `cards` names at most `MAX_LISTED_CARDS`.
     *
     * The ONE place a marketplace's display string (its number and name,
     * passed through `safeMarketplaceText`) is returned to a client. The
     * caller is an admin, and the string says what to add by hand — there is
     * no NB card to name it by, because that is the point of the list.
     */
    extraOnMarketplace: v.object({
      bsc: extraValidator,
      sportlots: extraValidator,
    }),
    /**
     * Which insert cards landed in each bucket, as NB display strings
     * (`#12 Player Name`), at most `MAX_LISTED_CARDS` each. No marketplace
     * ref or string.
     */
    cards: v.object({
      leftOff: v.array(v.string()),
      unlinked: sideCardListsValidator,
      ambiguous: sideCardListsValidator,
    }),
    /** The parallel had cards, and they were replaced. */
    rebuilt: v.boolean(),
    blockedReason: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<BuildParallelResult> => {
    await requireAdmin(ctx);
    const startedAt = Date.now();
    const zero = (): SideCounts => ({ bsc: 0, sportlots: 0 });
    const emptyLists = (): SideLists => ({ bsc: [], sportlots: [] });

    const plan = await ctx.runQuery(
      internal.parallelChecklistBuild.loadParallelBuildContext,
      { parallelId: args.parallelId },
    );
    const toFetch = SIDES.filter((side) => plan.fetch[side]);
    const skipped = SIDES.filter((side) => !plan.fetch[side]);

    const blocked = (
      blockedReason: string,
      extra: {
        sidesFetched?: PlatformSide[];
        deletedCount?: number;
        earlierLinksMissing?: SideCounts;
        stillListedNotRelinked?: SideCounts;
        legacyLinksRemoved?: SideCounts;
      } = {},
    ): BuildParallelResult => {
      const result: BuildParallelResult = {
        status: "blocked",
        copied: 0,
        notCopied: 0,
        unlinked: zero(),
        ambiguous: zero(),
        sidesFetched: extra.sidesFetched ?? [],
        sidesSkipped: skipped,
        earlierLinksMissing: extra.earlierLinksMissing ?? zero(),
        stillListedNotRelinked: extra.stillListedNotRelinked ?? zero(),
        legacyLinksRemoved: extra.legacyLinksRemoved ?? zero(),
        skippedChangedSource: 0,
        ...(extra.deletedCount !== undefined
          ? { deletedCount: extra.deletedCount }
          : {}),
        extraOnMarketplace: {
          bsc: { count: 0, cards: [] },
          sportlots: { count: 0, cards: [] },
        },
        cards: { leftOff: [], unlinked: emptyLists(), ambiguous: emptyLists() },
        rebuilt: false,
        blockedReason,
      };
      logBuild(args.parallelId, result, startedAt);
      return result;
    };

    for (const side of skipped) {
      console.log(
        `[buildParallelChecklist] ${side} skipped — missing=${plan.missing[side]}`,
      );
    }

    if (toFetch.length === 0) {
      const pausedOwned = SIDES.filter(
        (side) => plan.owned[side] && plan.paused[side],
      );
      if (pausedOwned.length > 0) return blocked(blockedAllPaused(pausedOwned));
      const ownedSides = SIDES.filter((side) => plan.owned[side]);
      if (ownedSides.length === 0) return blocked(BLOCKED_NO_IDS);
      const side = ownedSides.find((s) => plan.unreachableRow[s]);
      return blocked(
        side
          ? blockedIdsUnreachable(
              plan.unreachableRow[side],
              ownedSides.length === 1 ? side : undefined,
            )
          : BLOCKED_IDS_UNREACHABLE,
      );
    }
    // Security 6 — more sets than one build reads is refused, never truncated:
    // a truncated fetch would call every card of the unread sets unlisted.
    if (plan.owned.sportlots && plan.slOverCap) {
      return blocked(BLOCKED_TOO_MANY_SL_SETS);
    }
    if (plan.fetch.bsc && plan.bscOverCap) {
      return blocked(BLOCKED_TOO_MANY_BSC_SETS);
    }

    // ── 2. blocks, before any marketplace is asked ──────────────────────────
    // A parallel no longer uses candidates or the entity review, so review
    // state left on it is abandoned and is cleared here; only a live session
    // (another window, an old tab) blocks.
    const review = await clearStaleReviewState(ctx, args.parallelId);
    if (review.live) return blocked(BLOCKED_REVIEW_OPEN);
    const existing = await checkBlocks(ctx, args.parallelId);
    if (existing.blockedReason) return blocked(existing.blockedReason);

    const old = await ctx.runQuery(
      internal.parallelChecklistBuild.loadParallelCardsForLink,
      { parallelId: args.parallelId },
    );
    if (old.overLimit) return blocked(BLOCKED_PARALLEL_TOO_MANY_CARDS);
    const oldRefOf = (
      card: (typeof old.cards)[number],
      side: PlatformSide,
    ): string | undefined => (side === "bsc" ? card.bscRef : card.slRef);

    // Security 1 — a side the parallel owns but this build cannot ask, while
    // old cards hold links there: rebuilding would drop every one of them.
    for (const side of SIDES) {
      if (!plan.owned[side] || plan.fetch[side]) continue;
      if (!old.cards.some((card) => oldRefOf(card, side))) continue;
      return blocked(
        plan.paused[side]
          ? blockedSidePaused(side)
          : blockedIdsUnreachable(plan.unreachableRow[side], side),
      );
    }

    const insertCards = await ctx.runQuery(
      internal.parallelChecklistBuild.loadInsertCardsForLink,
      { insertId: plan.insertId },
    );
    if (insertCards.overLimit) return blocked(BLOCKED_TOO_MANY_CARDS);

    // ── 3. fetch every side before anything is touched ──────────────────────
    const fetchBsc = async (): Promise<SideFetch> => {
      try {
        const result = await ctx.runAction(
          api.adapters.buysportscards.fetchBscChecklist,
          {
            // Telemetry only in the adapter; no NB value is sent.
            parentFilters: {},
            facetFilters: plan.bscFilters,
            ...(plan.bscSourceFacet ? { sourceFacet: plan.bscSourceFacet } : {}),
          },
        );
        if (!result.success) return { ok: false };
        const cards: BscChecklistCard[] = result.cards;
        return {
          ok: true,
          cards: cards.flatMap((c) =>
            c.platformRef
              ? [
                  {
                    ref: c.platformRef,
                    ...(c.sourceBscSetSlug ? { setId: c.sourceBscSetSlug } : {}),
                    cardNumber: c.cardNumber,
                    cardName: c.cardName,
                    ...(c.players ? { players: c.players } : {}),
                    ...(c.isVariation !== undefined
                      ? { isVariation: c.isVariation }
                      : {}),
                    ...(c.cardVariation ? { cardVariation: c.cardVariation } : {}),
                  },
                ]
              : [],
          ),
        };
      } catch (err) {
        console.error(
          `[buildParallelChecklist] bsc fetch threw: ${err instanceof Error ? err.name : "unknown"}`,
        );
        return { ok: false };
      }
    };
    const fetchSl = async (): Promise<SideFetch> => {
      const cards: FetchedParallelCard[] = [];
      for (const slId of plan.slIds) {
        try {
          const result = await ctx.runAction(
            api.adapters.sportlots.fetchSportLotsChecklist,
            // The parallel's own set id, at the parallel level, and nothing
            // else: no ancestor id and no NB name can reach `selset`.
            { parentFilters: {}, platformFilters: { parallel: slId } },
          );
          if (!result.success) return { ok: false };
          const slCards: SlChecklistCard[] = result.cards;
          for (const c of slCards) {
            if (!c.platformRef) continue;
            cards.push({
              ref: c.platformRef,
              setId: slId,
              cardNumber: c.cardNumber,
              cardName: c.cardName,
              ...(c.players ? { players: c.players } : {}),
              ...(c.isVariation !== undefined ? { isVariation: c.isVariation } : {}),
              ...(c.cardVariation ? { cardVariation: c.cardVariation } : {}),
              ...(c.printRun !== undefined ? { printRun: c.printRun } : {}),
            });
          }
        } catch (err) {
          console.error(
            `[buildParallelChecklist] sportlots fetch threw: ${err instanceof Error ? err.name : "unknown"}`,
          );
          return { ok: false };
        }
      }
      return { ok: true, cards };
    };

    const fetched: Partial<Record<PlatformSide, SideFetch>> = {};
    const [bscFetch, slFetch] = await Promise.all([
      plan.fetch.bsc ? fetchBsc() : Promise.resolve(undefined),
      plan.fetch.sportlots ? fetchSl() : Promise.resolve(undefined),
    ]);
    if (bscFetch) fetched.bsc = bscFetch;
    if (slFetch) fetched.sportlots = slFetch;
    const answered = SIDES.filter((side) => fetched[side]?.ok);
    for (const side of toFetch) {
      if (!fetched[side]?.ok) {
        return blocked(blockedSideFailed(side), { sidesFetched: answered });
      }
    }
    const fetchedCards = (side: PlatformSide): FetchedParallelCard[] => {
      const got = fetched[side];
      return got?.ok ? got.cards : [];
    };

    // ── 4. link and decide the copies ───────────────────────────────────────
    const linkable: LinkableNbCard[] = insertCards.cards.map((c) => ({
      id: c._id,
      cardNumber: c.cardNumber,
      cardName: c.cardName,
      namesOnCard: c.namesOnCard,
      isTeamCard: c.isTeamCard,
      isVariation: c.isVariation,
      ...(c.cardVariation ? { cardVariation: c.cardVariation } : {}),
    }));
    const keyOfOld = (card: (typeof old.cards)[number]): string =>
      cardKey({
        cardNumber: card.cardNumber,
        cardName: card.cardName,
        namesOnCard: card.namesOnCard,
        isTeamCard: card.isTeamCard,
        isVariation: card.isVariation,
        ...(card.cardVariation ? { cardVariation: card.cardVariation } : {}),
      });

    // Each old card's key, once — every lookup below goes through it.
    const oldKeys = old.cards.map(keyOfOld);

    const outcomes: Partial<Record<PlatformSide, Map<string, CardLinkOutcome>>> = {};
    const ambiguous = zero();
    const extraOnMarketplace = {
      bsc: { count: 0, cards: [] as string[] },
      sportlots: { count: 0, cards: [] as string[] },
    };
    for (const side of toFetch) {
      // Security 2 — the old cards' links, by key, break a tie.
      const earlierRefsByKey = new Map<string, Set<string>>();
      for (const [i, card] of old.cards.entries()) {
        const ref = oldRefOf(card, side);
        if (!ref) continue;
        const key = oldKeys[i];
        const refs = earlierRefsByKey.get(key);
        if (refs) refs.add(ref);
        else earlierRefsByKey.set(key, new Set([ref]));
      }
      const result = linkCardsToSide(
        linkable,
        fetchedCards(side),
        { nb: plan.insertPrefix, fetched: plan.parallelPrefix },
        { earlierRefsByKey },
      );
      outcomes[side] = result.outcomes;
      ambiguous[side] = result.ambiguous;
      extraOnMarketplace[side] = {
        count: result.unclaimed.length,
        cards: result.unclaimed
          .slice(0, MAX_LISTED_CARDS)
          .map((c) => safeMarketplaceText(cardLabel(c))),
      };
    }

    type Copy = {
      sourceCardId: Id<"cardChecklist">;
      expect: { cardNumber: string; cardName: string; namesOnCard: string[] };
      key: string;
      bsc?: { ref: string; setId?: string };
      sportlots?: { ref: string; setId?: string };
      printRun?: number;
      keepSku?: string;
      variationOfCardId?: Id<"cardChecklist">;
      sortOrder: number;
    };
    const copies: Copy[] = [];
    const unlinked = zero();
    const lists = {
      leftOff: [] as string[],
      unlinked: emptyLists(),
      ambiguous: emptyLists(),
    };
    const listPush = (list: string[], label: string) => {
      if (list.length < MAX_LISTED_CARDS) list.push(label);
    };
    for (const card of insertCards.cards) {
      const label = cardLabel(card);
      const outcomeOn = (side: PlatformSide) => outcomes[side]?.get(card._id);
      for (const side of toFetch) {
        if (outcomeOn(side)?.kind === "ambiguous") {
          listPush(lists.ambiguous[side], label);
        }
      }
      const link = (side: PlatformSide): FetchedParallelCard | undefined => {
        const outcome = outcomeOn(side);
        return outcome?.kind === "linked" ? outcome.card : undefined;
      };
      const bsc = link("bsc");
      const sl = link("sportlots");
      if (!bsc && !sl) {
        listPush(lists.leftOff, label);
        continue;
      }
      for (const side of toFetch) {
        if (outcomeOn(side)?.kind === "none") {
          unlinked[side]++;
          listPush(lists.unlinked[side], label);
        }
      }
      copies.push({
        sourceCardId: card._id,
        expect: {
          cardNumber: card.cardNumber,
          cardName: card.cardName,
          namesOnCard: card.namesOnCard,
        },
        key: cardKey({
          cardNumber: card.cardNumber,
          cardName: card.cardName,
          namesOnCard: card.namesOnCard,
          isTeamCard: card.isTeamCard,
          isVariation: card.isVariation,
          ...(card.cardVariation ? { cardVariation: card.cardVariation } : {}),
        }),
        ...(bsc ? { bsc: { ref: bsc.ref, ...(bsc.setId ? { setId: bsc.setId } : {}) } } : {}),
        ...(sl ? { sportlots: { ref: sl.ref, ...(sl.setId ? { setId: sl.setId } : {}) } } : {}),
        // M3 — the print run is the PARALLEL's, and only SportLots states it
        // per card. NB has no parallel-level print run to fall back on.
        ...(sl?.printRun !== undefined ? { printRun: sl.printRun } : {}),
        ...(card.variationOfCardId ? { variationOfCardId: card.variationOfCardId } : {}),
        sortOrder: card.sortOrder,
      });
    }
    if (copies.length === 0 && old.cards.length > 0) {
      return blocked(BLOCKED_NOTHING_MATCHED, { sidesFetched: answered });
    }

    // R2 — a copy keeps the SKU of the old card it clearly replaces: same key
    // (so the same insert card) AND the same marketplace ref on a side.
    // Exactly one old card for the copy, and that old card claimed by exactly
    // one copy; anything else gets a fresh SKU.
    const oldByKey = new Map<string, number[]>();
    oldKeys.forEach((key, i) => {
      const bucket = oldByKey.get(key);
      if (bucket) bucket.push(i);
      else oldByKey.set(key, [i]);
    });
    const oldForCopy = new Map<Copy, number>();
    const copiesPerOld = new Map<number, number>();
    for (const copy of copies) {
      const hits = (oldByKey.get(copy.key) ?? []).filter((i) => {
        const card = old.cards[i];
        return (
          (copy.bsc !== undefined && card.bscRef === copy.bsc.ref) ||
          (copy.sportlots !== undefined && card.slRef === copy.sportlots.ref)
        );
      });
      if (hits.length === 1) {
        oldForCopy.set(copy, hits[0]);
        copiesPerOld.set(hits[0], (copiesPerOld.get(hits[0]) ?? 0) + 1);
      }
    }
    for (const [copy, i] of oldForCopy) {
      const sku = old.cards[i].sku;
      if (sku && copiesPerOld.get(i) === 1) copy.keepSku = sku;
    }

    // Classify every old link BEFORE anything is deleted.
    const newRefs = { bsc: new Set<string>(), sportlots: new Set<string>() };
    for (const copy of copies) {
      if (copy.bsc) newRefs.bsc.add(copy.bsc.ref);
      if (copy.sportlots) newRefs.sportlots.add(copy.sportlots.ref);
    }
    const listedRefs = {
      bsc: new Set(fetchedCards("bsc").map((c) => c.ref)),
      sportlots: new Set(fetchedCards("sportlots").map((c) => c.ref)),
    };
    const classify = (refsBySide: Record<PlatformSide, Iterable<string>>, relinked: typeof newRefs) => {
      const gone = zero();
      const listed = zero();
      const legacy = zero();
      for (const side of SIDES) {
        for (const ref of new Set(refsBySide[side])) {
          if (!plan.owned[side]) legacy[side]++;
          else if (!listedRefs[side].has(ref)) gone[side]++;
          else if (!relinked[side].has(ref)) listed[side]++;
        }
      }
      return { gone, listed, legacy };
    };
    const oldRefsBySide = {
      bsc: old.cards.flatMap((c) => (c.bscRef ? [c.bscRef] : [])),
      sportlots: old.cards.flatMap((c) => (c.slRef ? [c.slRef] : [])),
    };
    const classified = classify(oldRefsBySide, newRefs);

    // ── 5. blocks again, then delete, then insert ───────────────────────────
    const recheck = await checkBlocks(ctx, args.parallelId);
    if (recheck.blockedReason) {
      return blocked(recheck.blockedReason, { sidesFetched: answered });
    }

    const dropped = { bsc: [] as string[], sportlots: [] as string[] };
    let deletedTotal = 0;
    for (;;) {
      const page = await ctx.runMutation(
        internal.parallelChecklistBuild.deleteParallelCardsPage,
        { parallelId: args.parallelId },
      );
      if (page.blockedReason) {
        // Security 3 — a block after the first page is a PARTIAL WIPE, and is
        // said out loud: the sentence, the count removed and the links that
        // went with them. Before the first page nothing was touched.
        const lost = classify(dropped, { bsc: new Set(), sportlots: new Set() });
        return blocked(
          deletedTotal > 0 ? BLOCKED_CHANGED_MID_BUILD : page.blockedReason,
          {
            sidesFetched: answered,
            ...(deletedTotal > 0
              ? {
                  deletedCount: deletedTotal,
                  earlierLinksMissing: lost.gone,
                  stillListedNotRelinked: lost.listed,
                  legacyLinksRemoved: lost.legacy,
                }
              : {}),
          },
        );
      }
      deletedTotal += page.deleted;
      dropped.bsc.push(...page.refs.bsc);
      dropped.sportlots.push(...page.refs.sportlots);
      if (page.done) break;
    }

    // Parents before their variations, so a variation's parent copy exists
    // by the time it is inserted; ties keep the checklist's own order.
    copies.sort((a, b) => {
      const va = a.variationOfCardId ? 1 : 0;
      const vb = b.variationOfCardId ? 1 : 0;
      return va - vb || a.sortOrder - b.sortOrder;
    });
    const newIdOf = new Map<string, Id<"cardChecklist">>();
    let firstCreatedId: Id<"cardChecklist"> | undefined;
    let missing = 0;
    let changedSources = 0;
    for (let i = 0; i < copies.length; i += INSERT_COPIES_PER_PAGE) {
      const pageCopies = copies.slice(i, i + INSERT_COPIES_PER_PAGE);
      const remap: Array<{ from: Id<"cardChecklist">; to: Id<"cardChecklist"> }> = [];
      for (const copy of pageCopies) {
        const parent = copy.variationOfCardId;
        const to = parent ? newIdOf.get(parent) : undefined;
        if (parent && to) remap.push({ from: parent, to });
      }
      const page = await ctx.runMutation(
        internal.parallelChecklistBuild.insertParallelCardsPage,
        {
          parallelId: args.parallelId,
          insertId: plan.insertId,
          ...(firstCreatedId ? { firstCreatedId } : {}),
          copies: pageCopies.map((c) => ({
            sourceCardId: c.sourceCardId,
            expect: c.expect,
            ...(c.bsc ? { bsc: c.bsc } : {}),
            ...(c.sportlots ? { sportlots: c.sportlots } : {}),
            ...(c.printRun !== undefined ? { printRun: c.printRun } : {}),
            ...(c.keepSku ? { keepSku: c.keepSku } : {}),
          })),
          remap,
        },
      );
      if (page.changed) {
        // Security 4 — another build got here first.
        const lost = classify(dropped, { bsc: new Set(), sportlots: new Set() });
        return blocked(BLOCKED_CHANGED_MID_BUILD, {
          sidesFetched: answered,
          deletedCount: deletedTotal,
          earlierLinksMissing: lost.gone,
          stillListedNotRelinked: lost.listed,
          legacyLinksRemoved: lost.legacy,
        });
      }
      for (const { from, to } of page.created) {
        newIdOf.set(from, to);
        firstCreatedId ??= to;
      }
      missing += page.missing;
      changedSources += page.skippedChangedSource;
    }

    // A copy skipped for a changed source re-links nothing: re-classify with
    // the refs that actually landed.
    const landedRefs = { bsc: new Set<string>(), sportlots: new Set<string>() };
    for (const copy of copies) {
      if (!newIdOf.has(copy.sourceCardId)) continue;
      if (copy.bsc) landedRefs.bsc.add(copy.bsc.ref);
      if (copy.sportlots) landedRefs.sportlots.add(copy.sportlots.ref);
    }
    const final =
      missing + changedSources > 0
        ? classify(oldRefsBySide, landedRefs)
        : classified;

    const copied = newIdOf.size;
    const result: BuildParallelResult = {
      status: "built",
      copied,
      notCopied: insertCards.cards.length - copied,
      unlinked,
      ambiguous,
      sidesFetched: answered,
      sidesSkipped: skipped,
      earlierLinksMissing: final.gone,
      stillListedNotRelinked: final.listed,
      legacyLinksRemoved: final.legacy,
      skippedChangedSource: missing + changedSources,
      extraOnMarketplace,
      cards: lists,
      rebuilt: deletedTotal > 0,
    };
    logBuild(args.parallelId, result, startedAt);
    return result;
  },
});

/**
 * Clear the parallel's stale review state in bounded pages, after judging
 * EVERY staged row: if any shows life within `REVIEW_ACTIVE_WINDOW_MS`,
 * nothing is deleted and the answer is `live`. Logs the counts cleared.
 */
async function clearStaleReviewState(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  parallelId: Id<"selectorOptions">,
): Promise<{ live: boolean; candidates: number; reviewRows: number }> {
  const cutoff = Date.now() - REVIEW_ACTIVE_WINDOW_MS;
  let staged = 0;
  for (const table of ["candidates", "entityReview"] as const) {
    let cursor: string | null = null;
    for (;;) {
      const page: {
        rows: number;
        lastActiveAt: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        internal.parallelChecklistBuild.scanParallelReviewPage,
        { parallelId, table, cursor },
      );
      if (page.lastActiveAt >= cutoff) {
        return { live: true, candidates: 0, reviewRows: 0 };
      }
      staged += page.rows;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  if (staged === 0) return { live: false, candidates: 0, reviewRows: 0 };

  let candidates = 0;
  let reviewRows = 0;
  for (;;) {
    const page = await ctx.runMutation(
      internal.parallelChecklistBuild.clearParallelReviewPage,
      { parallelId, cutoff },
    );
    candidates += page.candidates;
    reviewRows += page.reviewRows;
    if (page.live || page.done) {
      // Ids and counts only.
      console.log(
        JSON.stringify({
          msg: "parallel_review_state_cleared",
          parallelId,
          candidates,
          reviewRows,
          stoppedOnLiveSession: page.live,
        }),
      );
      return { live: page.live, candidates, reviewRows };
    }
  }
}

/** Walk every page of the block check; the first block found wins. */
async function checkBlocks(
  ctx: Pick<ActionCtx, "runQuery">,
  parallelId: Id<"selectorOptions">,
): Promise<{ blockedReason?: string; cards: number; linked: SideCounts }> {
  let cursor: string | null = null;
  let cards = 0;
  const linked: SideCounts = { bsc: 0, sportlots: 0 };
  for (;;) {
    const page: {
      blockedReason?: string;
      cards: number;
      linked: SideCounts;
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(
      internal.parallelChecklistBuild.checkParallelBuildBlocksPage,
      { parallelId, cursor },
    );
    if (page.blockedReason) {
      return { blockedReason: page.blockedReason, cards, linked };
    }
    cards += page.cards;
    linked.bsc += page.linked.bsc;
    linked.sportlots += page.linked.sportlots;
    if (page.isDone) return { cards, linked };
    cursor = page.continueCursor;
  }
}

/** The audit line. Counts, sides and timing only — no names, no refs. */
function logBuild(
  parallelId: Id<"selectorOptions">,
  result: BuildParallelResult,
  startedAt: number,
): void {
  console.log(
    JSON.stringify({
      msg: "parallel_checklist_built",
      parallelId,
      status: result.status,
      copied: result.copied,
      notCopied: result.notCopied,
      unlinked: result.unlinked,
      ambiguous: result.ambiguous,
      earlierLinksMissing: result.earlierLinksMissing,
      stillListedNotRelinked: result.stillListedNotRelinked,
      legacyLinksRemoved: result.legacyLinksRemoved,
      skippedChangedSource: result.skippedChangedSource,
      extraOnMarketplace: {
        bsc: result.extraOnMarketplace.bsc.count,
        sportlots: result.extraOnMarketplace.sportlots.count,
      },
      sidesFetched: result.sidesFetched,
      sidesSkipped: result.sidesSkipped,
      rebuilt: result.rebuilt,
      blocked: result.status === "blocked",
      // Security 3 — a partial wipe is visible in the log, not only the UI.
      ...(result.deletedCount !== undefined
        ? { deletedCount: result.deletedCount, partialWipe: result.deletedCount > 0 }
        : {}),
      duration_ms: Date.now() - startedAt,
    }),
  );
}
