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
 *   J3  A parallel that already has cards is REBUILT from a fresh copy.
 *   J4  "Fetch from Marketplaces" on a parallel row runs the same build for
 *       that one parallel.
 *
 * ## What a build does, in order (M2)
 *
 *   1. Judge which sides the PARALLEL can be fetched on, from its own ids only
 *      (`leafGate`, and the chain with the insert row taken out — see
 *      `chainWithoutInsertAncestors`). The insert's ids and every NB name stay
 *      out of every request.
 *   2. Refuse, touching nothing, if the parallel is blocked: a card with scans,
 *      a card that is the home of a cross-listing, a checklist review staged on
 *      it, or (on a rebuild) a side whose links would be lost because it is
 *      paused.
 *   3. Fetch EVERY side. A side that fails blocks the build and nothing changes.
 *   4. Link each insert card per side (`lib/parallelCardLink.ts`, exactly-one on
 *      both ends) and decide the copies.
 *   5. Check the blocks again, then delete the parallel's old cards (pages of
 *      100), then insert the copies (pages of 150).
 *
 * A crash between 5's delete and insert leaves the parallel short; running the
 * build again rebuilds it (risk 1 in the plan, accepted).
 *
 * ## Operator-facing words
 *
 * `blockedReason` and every ConvexError here are read by an operator. They are
 * fixed sentences: no marketplace string, no internal word.
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
  chainWithoutInsertAncestors,
  bscFacetValidator,
  resolveBscFacetFilters,
  type BscFacet,
} from "./bscFacets";
import {
  leafOwnsSource,
  missingSummary,
  resolvableSides,
  type ResolvableRow,
} from "./marketplaceResolvability";
import { pausedSides } from "./marketplacePause";
import { slotIds, type PlatformSide } from "./platformSlots";
import { platformSideValidator } from "./selectorSyncStore";
import { orphanVariationsOf, resolveCardSlots } from "./selectorOptions";
import { insertCardRow, type CardRowSetContext } from "./cardRowCreate";
import {
  linkCardsToSide,
  type CardLinkOutcome,
  type FetchedParallelCard,
  type LinkableNbCard,
} from "./lib/parallelCardLink";
import { teamFullName } from "../lib/teams/team-name";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The most cards an insert may have for its parallels to be built. */
export const MAX_INSERT_CARDS_FOR_BUILD = 5000;
/** Parallels listed per insert; more sets `truncated`. */
export const MAX_PARALLELS_PER_INSERT = 500;
/**
 * Copies inserted per transaction. Per copy: one `db.get` of the source, one
 * insert, one SKU patch, plus a variation-parent `db.get` for a variation and
 * the player/team name reads (cached per page). ~150 × 3 + names ≈ 600–700
 * operations, inside the ~900 `CARDS_PER_COMMIT_CHUNK` is calibrated to.
 */
export const INSERT_COPIES_PER_PAGE = 150;
/**
 * Old cards deleted per transaction. Per card: one cross-listing lookup, one
 * variation-children lookup (plus a patch per child), one delete ≈ 300–400.
 */
export const DELETE_CARDS_PER_PAGE = 100;
/**
 * Cards whose blocks are checked per read page: one page read plus one
 * cross-listing lookup per card.
 */
export const BLOCK_CHECK_CARDS_PER_PAGE = 400;
/** SportLots sets fetched per parallel; mirrors `fetchCardChecklist`. */
const MAX_SL_FAN_OUT = 10;
/**
 * `getParallelsForBuild` is a live subscription over up to 500 parallels, so
 * its block check is budgeted: at most this many cards read and this many
 * cross-listing lookups across the whole list. Past the budget a parallel's
 * `blocked` is simply left unset — the build itself checks every card.
 */
const LIST_BLOCK_CARD_BUDGET = 4000;
const LIST_BLOCK_LOOKUP_BUDGET = 1000;
const LIST_BLOCK_CARDS_PER_PARALLEL = 200;

// ---------------------------------------------------------------------------
// Operator-facing sentences (DRAFT — Jason signs off). Each reads after
// "Blocked — " on the parallel's own line, so none names the parallel.
// ---------------------------------------------------------------------------

export const BLOCKED_SCANS =
  "some of its cards have scans on them, and a rebuild would lose them";
export const BLOCKED_CROSS_LISTED =
  "some of its cards also show up in another set";
export const BLOCKED_REVIEW_OPEN =
  "a checklist review is still open on it — finish or discard it first";
export const BLOCKED_NO_IDS =
  "it has no marketplace ids of its own to build from";
export const BLOCKED_IDS_UNREACHABLE =
  "its marketplace ids can't be looked up from where it sits — the set above it is missing some";
export const BLOCKED_TOO_MANY_CARDS =
  "the insert has more than 5,000 cards, which is more than one build can copy";
export const BLOCKED_NOTHING_MATCHED =
  "none of the insert's cards matched a card on its marketplace sets, so its cards were left alone";
export const BLOCKED_CHANGED_MID_BUILD =
  "its cards changed while it was being rebuilt — run it again";

const MARKETPLACE_NAME: Record<PlatformSide, string> = {
  bsc: "BuySportsCards",
  sportlots: "SportLots",
};

export function blockedSideFailed(side: PlatformSide): string {
  return `${MARKETPLACE_NAME[side]} didn't answer, so nothing was changed — try again in a bit`;
}

export function blockedSidePaused(side: PlatformSide): string {
  return `${MARKETPLACE_NAME[side]} is paused, and a rebuild now would drop its links`;
}

export function blockedAllPaused(sides: readonly PlatformSide[]): string {
  const names = sides.map((s) => MARKETPLACE_NAME[s]).join(" and ");
  return `${names} ${sides.length > 1 ? "are" : "is"} paused right now`;
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
  bscFilters: Record<string, string[]>;
  bscSourceFacet?: BscFacet;
  /** The parallel's OWN SportLots set ids, in slot order. */
  slIds: string[];
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
  return {
    owned: {
      bsc: !!leaf && leafOwnsSource(leaf, "bsc"),
      sportlots: !!leaf && leafOwnsSource(leaf, "sportlots"),
    },
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
    bscFilters: plan.filters,
    ...(plan.sourceFacet ? { bscSourceFacet: plan.sourceFacet } : {}),
    slIds: leaf ? slotIds(leaf, "sportlots").slice(0, MAX_SL_FAN_OUT) : [],
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
      if (await reviewStagedOn(ctx, parallel._id)) {
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

export const loadParallelBuildContext = internalQuery({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    insertId: v.id("selectorOptions"),
    owned: sideFlagsValidator,
    fetch: sideFlagsValidator,
    paused: sideFlagsValidator,
    missing: v.object({ bsc: v.string(), sportlots: v.string() }),
    bscFilters: v.record(v.string(), v.array(v.string())),
    bscSourceFacet: v.optional(bscFacetValidator),
    slIds: v.array(v.string()),
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
      bscFilters: plan.bscFilters,
      ...(plan.bscSourceFacet ? { bscSourceFacet: plan.bscSourceFacet } : {}),
      slIds: plan.slIds,
      ...(insertPrefix ? { insertPrefix } : {}),
      ...(parallelPrefix ? { parallelPrefix } : {}),
    };
  },
});

/**
 * One page of the block check over the parallel's current cards, plus how
 * many of them carry a link on each side (for the paused-side rebuild block).
 * The staged-review check runs on the first page only.
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

const linkableCardValidator = v.object({
  _id: v.id("cardChecklist"),
  cardNumber: v.string(),
  cardName: v.string(),
  namesOnCard: v.array(v.string()),
  isTeamCard: v.boolean(),
  isVariation: v.boolean(),
  cardVariation: v.optional(v.string()),
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
      cards: rows.map((row) => {
        const namesOnCard = [
          ...(row.playerLinks ?? []).map((l) => l.nameOnCard),
          ...(row.pendingPlayerNames ?? []),
        ];
        const hasTeams =
          (row.teamOnCardIds?.length ?? 0) > 0 ||
          (row.pendingTeamNames?.length ?? 0) > 0;
        const hasPlayers =
          namesOnCard.length > 0 || (row.playerIds?.length ?? 0) > 0;
        return {
          _id: row._id,
          cardNumber: row.cardNumber,
          cardName: row.cardName,
          namesOnCard,
          isTeamCard: !hasPlayers && hasTeams,
          isVariation: !!row.variationOfCardId || !!row.cardVariation?.trim(),
          ...(row.cardVariation ? { cardVariation: row.cardVariation } : {}),
          ...(row.variationOfCardId
            ? { variationOfCardId: row.variationOfCardId }
            : {}),
          sortOrder: row.sortOrder,
        };
      }),
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

/**
 * Insert one page of copies onto the parallel.
 *
 * Each copy re-reads its source card HERE, inside the transaction, and copies
 * the NB-owned fields (M3). What is recomputed for the parallel — features,
 * listing text, SKU, `platformData` with `src` on the parallel's own slots,
 * and `printRun` (from the linked SportLots card only) — goes through the
 * shared `insertCardRow`, so a copy is born exactly like a synced card.
 * `imageUrls` is never copied and no team enrichment is queued.
 *
 * `remap` carries the new ids of variation PARENTS copied on earlier pages; a
 * variation whose parent was not copied loses the link (and its manual flag)
 * together, never one without the other.
 */
export const insertParallelCardsPage = internalMutation({
  args: {
    parallelId: v.id("selectorOptions"),
    insertId: v.id("selectorOptions"),
    copies: v.array(
      v.object({
        sourceCardId: v.id("cardChecklist"),
        bsc: v.optional(copyLinkValidator),
        sportlots: v.optional(copyLinkValidator),
        printRun: v.optional(v.number()),
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
    missing: v.number(),
  }),
  handler: async (ctx, args) => {
    const parallel = await ctx.db.get(args.parallelId);
    if (!parallel || parallel.level !== "parallel") {
      throw new ConvexError(PARALLEL_GONE);
    }
    if (parallel.parentId !== args.insertId) {
      throw new ConvexError(NO_INSERT_ABOVE);
    }
    const set = await parallelSetContext(ctx, parallel);
    const toStored = await resolveCardSlots(ctx, args.parallelId);

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
    for (const copy of args.copies) {
      const source = await ctx.db.get(copy.sourceCardId);
      if (!source || source.selectorOptionId !== args.insertId) {
        missing++;
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
          carried: {
            teamCheckDoneAt: source.teamCheckDoneAt,
            bscTeamName: source.bscTeamName,
            teamNoneConfirmedAt: source.teamNoneConfirmedAt,
            teamNoneConfirmedByUserId: source.teamNoneConfirmedByUserId,
            ...variation,
          },
        },
        set,
      );
      newIdOf.set(source._id, newId);
      created.push({ from: source._id, to: newId });
    }
    return { created, missing };
  },
});

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

type SideCounts = { bsc: number; sportlots: number };

export type BuildParallelResult = {
  status: "built" | "blocked";
  copied: number;
  notCopied: number;
  unlinked: SideCounts;
  ambiguous: SideCounts;
  sidesFetched: PlatformSide[];
  sidesSkipped: PlatformSide[];
  earlierLinksMissing: SideCounts;
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

export const buildParallelChecklist = action({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.object({
    status: v.union(v.literal("built"), v.literal("blocked")),
    /** Insert cards copied onto the parallel (linked on at least one side). */
    copied: v.number(),
    /** Insert cards left off: linked on no side (J2). */
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
    /** Per side: links the old cards had that no copy carries. */
    earlierLinksMissing: sideCountsValidator,
    /** The parallel had cards, and they were replaced. */
    rebuilt: v.boolean(),
    blockedReason: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<BuildParallelResult> => {
    await requireAdmin(ctx);
    const startedAt = Date.now();
    const zero = (): SideCounts => ({ bsc: 0, sportlots: 0 });

    const plan = await ctx.runQuery(
      internal.parallelChecklistBuild.loadParallelBuildContext,
      { parallelId: args.parallelId },
    );
    const toFetch = SIDES.filter((side) => plan.fetch[side]);
    const skipped = SIDES.filter((side) => !plan.fetch[side]);

    const blocked = (
      blockedReason: string,
      sidesFetched: PlatformSide[] = [],
    ): BuildParallelResult => {
      const result: BuildParallelResult = {
        status: "blocked",
        copied: 0,
        notCopied: 0,
        unlinked: zero(),
        ambiguous: zero(),
        sidesFetched,
        sidesSkipped: skipped,
        earlierLinksMissing: zero(),
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
      return blocked(
        SIDES.some((side) => plan.owned[side])
          ? BLOCKED_IDS_UNREACHABLE
          : BLOCKED_NO_IDS,
      );
    }

    // ── 2. blocks, before any marketplace is asked ──────────────────────────
    const existing = await checkBlocks(ctx, args.parallelId);
    if (existing.blockedReason) return blocked(existing.blockedReason);
    for (const side of SIDES) {
      // A rebuild with a side the pause keeps us from asking would drop every
      // link the old cards hold there (invariant 5).
      if (plan.owned[side] && plan.paused[side] && existing.linked[side] > 0) {
        return blocked(blockedSidePaused(side));
      }
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
      if (!fetched[side]?.ok) return blocked(blockedSideFailed(side), answered);
    }

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
    const outcomes: Partial<Record<PlatformSide, Map<string, CardLinkOutcome>>> = {};
    const ambiguous = zero();
    for (const side of toFetch) {
      const got = fetched[side];
      if (!got?.ok) continue;
      const result = linkCardsToSide(linkable, got.cards, {
        nb: plan.insertPrefix,
        fetched: plan.parallelPrefix,
      });
      outcomes[side] = result.outcomes;
      ambiguous[side] = result.ambiguous;
    }

    type Copy = {
      sourceCardId: Id<"cardChecklist">;
      bsc?: { ref: string; setId?: string };
      sportlots?: { ref: string; setId?: string };
      printRun?: number;
      variationOfCardId?: Id<"cardChecklist">;
      sortOrder: number;
    };
    const copies: Copy[] = [];
    const unlinked = zero();
    for (const card of insertCards.cards) {
      const link = (side: PlatformSide): FetchedParallelCard | undefined => {
        const outcome = outcomes[side]?.get(card._id);
        return outcome?.kind === "linked" ? outcome.card : undefined;
      };
      const bsc = link("bsc");
      const sl = link("sportlots");
      if (!bsc && !sl) continue;
      for (const side of toFetch) {
        if (outcomes[side]?.get(card._id)?.kind === "none") unlinked[side]++;
      }
      copies.push({
        sourceCardId: card._id,
        ...(bsc ? { bsc: { ref: bsc.ref, ...(bsc.setId ? { setId: bsc.setId } : {}) } } : {}),
        ...(sl ? { sportlots: { ref: sl.ref, ...(sl.setId ? { setId: sl.setId } : {}) } } : {}),
        // M3 — the print run is the PARALLEL's, and only SportLots states it.
        ...(sl?.printRun !== undefined ? { printRun: sl.printRun } : {}),
        ...(card.variationOfCardId ? { variationOfCardId: card.variationOfCardId } : {}),
        sortOrder: card.sortOrder,
      });
    }
    if (copies.length === 0 && existing.cards > 0) {
      return blocked(BLOCKED_NOTHING_MATCHED, answered);
    }

    // ── 5. blocks again, then delete, then insert ───────────────────────────
    const recheck = await checkBlocks(ctx, args.parallelId);
    if (recheck.blockedReason) return blocked(recheck.blockedReason, answered);

    const oldRefs = { bsc: new Set<string>(), sportlots: new Set<string>() };
    let deletedTotal = 0;
    for (;;) {
      const page = await ctx.runMutation(
        internal.parallelChecklistBuild.deleteParallelCardsPage,
        { parallelId: args.parallelId },
      );
      if (page.blockedReason) {
        return blocked(
          deletedTotal > 0 ? BLOCKED_CHANGED_MID_BUILD : page.blockedReason,
          answered,
        );
      }
      deletedTotal += page.deleted;
      for (const ref of page.refs.bsc) oldRefs.bsc.add(ref);
      for (const ref of page.refs.sportlots) oldRefs.sportlots.add(ref);
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
    let missing = 0;
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
          copies: pageCopies.map((c) => ({
            sourceCardId: c.sourceCardId,
            ...(c.bsc ? { bsc: c.bsc } : {}),
            ...(c.sportlots ? { sportlots: c.sportlots } : {}),
            ...(c.printRun !== undefined ? { printRun: c.printRun } : {}),
          })),
          remap,
        },
      );
      for (const { from, to } of page.created) newIdOf.set(from, to);
      missing += page.missing;
    }

    const newRefs = { bsc: new Set<string>(), sportlots: new Set<string>() };
    for (const copy of copies) {
      if (!newIdOf.has(copy.sourceCardId)) continue;
      if (copy.bsc) newRefs.bsc.add(copy.bsc.ref);
      if (copy.sportlots) newRefs.sportlots.add(copy.sportlots.ref);
    }
    const earlierLinksMissing = zero();
    for (const side of SIDES) {
      for (const ref of oldRefs[side]) {
        if (!newRefs[side].has(ref)) earlierLinksMissing[side]++;
      }
    }

    const copied = copies.length - missing;
    const result: BuildParallelResult = {
      status: "built",
      copied,
      notCopied: insertCards.cards.length - copied,
      unlinked,
      ambiguous,
      sidesFetched: answered,
      sidesSkipped: skipped,
      earlierLinksMissing,
      rebuilt: deletedTotal > 0,
    };
    logBuild(args.parallelId, result, startedAt);
    return result;
  },
});

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
      sidesFetched: result.sidesFetched,
      sidesSkipped: result.sidesSkipped,
      rebuilt: result.rebuilt,
      blocked: result.status === "blocked",
      duration_ms: Date.now() - startedAt,
    }),
  );
}
