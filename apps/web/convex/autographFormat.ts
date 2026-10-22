/**
 * NEO-345 — an autograph's FORMAT (On Card vs Sticker/Label) is NB data.
 *
 * Jason: "Features belong to NB and that is the only place we care about On
 * Card vs Sticker because the marketplaces don't tell us which it is." A card
 * carries the AU token when it is signed; HOW it is signed is the operator's
 * answer, given once per synced LEAF (the base variant, insert or parallel
 * whose cards are committed — never the whole set) and stored on that leaf as
 * `features.autographFormat`. The leaf's AU cards inherit it as
 * `features.autographed`, with Signed By seeded from their players.
 *
 * Three doors write it:
 *
 *   - the sync wizard's "Autographed cards" step, as the commit's
 *     `autographFormat` arg (`selectorOptions.commitCardChecklist`), for a
 *     leaf whose NEW rows carry AU — the rows are born formatted;
 *   - `setAutographFormat` below, from the checklist header prompt and the
 *     set attributes panel, for a leaf whose cards are already stored — it
 *     writes the leaf and then cascades onto the leaf's AU cards;
 *   - the armed backfill (`backfillBscAttributeFeatures`), which formats
 *     stored AU rows whose leaf already has an answer.
 *
 * ## An answer reaches the leaf's parallels (Jason, 2026-10-18)
 *
 * "Insert info should be copied to its parallels." A parallel is a copy of
 * the row it is built from (`parallelChecklistBuild.resolveBuildSource`): a
 * `parallel`-level row is built from its parent insert, and an `insert`-level
 * row under the set's Parallel(s) variant type is built from the set's one
 * Base. So an answer on an insert, or on the Base, also lands on each of those
 * parallels whose OWN format is unset (`adoptAutographFormatOnParallels`), and
 * the cascade then walks their AU cards too. When the answer CHANGES, a
 * parallel still holding the previous answer moves with it (the cards' own
 * rule, so a corrected misclick carries the parallels). A parallel holding
 * any other format is never overwritten, and nothing below it inherits
 * through it. A parallel holding the SAME format has its cards walked again,
 * as a re-pick walks the leaf's. The step is transitive: a Base answer that
 * reaches a base parallel (an `insert`-level row) reaches that row's own
 * parallels the same way. A parallel BUILT later takes its source's format at
 * build time (`parallelChecklistBuild.insertParallelCardsPage`).
 *
 * Both answering doors reach them (the backfill answers nothing, so it
 * reaches no parallel): the public door adopts in its own transaction (so
 * the header prompt on each parallel clears with the answer, and the
 * set-build tool is told which rows to wait on), and the commit's
 * `autographFormat` schedules `inheritAutographFormatToParallels`.
 *
 * ## Titles follow the format
 *
 * Each card the walk formats has its listing title rebuilt when the title is
 * still exactly the generated one (the fill does it:
 * `cardChecklist.applyBscAttributeFill` → `storedCardTitle`), so the title
 * gains "AUTO"; the listing description likewise, under the same rule. An
 * operator's own title or description is never touched.
 *
 * ## The cascade is chunked
 *
 * A parallel can hold thousands of cards, so the leaf write is one small
 * mutation and the card walk is an internal ACTION that runs one bounded
 * mutation per page (`cascadeAutographFormatPage`). Each page commits on its
 * own, re-reads the leaf, and abandons the walk the moment the leaf no longer
 * holds the format it is spreading — a later answer schedules its own walk,
 * and two walks must never fight over the same cards.
 *
 * ## What a card write means
 *
 * The card rules are `cardChecklist.applyBscAttributeFill`'s, not this
 * file's: `autographed` is written only when the card is absent / "None" /
 * still the leaf's PREVIOUS format, and Signed By is seeded when empty. A card
 * whose `autographed` is anything else is an operator's override: it is
 * skipped before the fill is called, and counted.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { requireAdmin } from "./auth";
import { applyBscAttributeFill } from "./cardChecklist";
import {
  AUTOGRAPH_FORMAT_LEVELS,
  carriesAutographToken,
  validateFeatureValue,
  type AutographFormat,
} from "./features/deriveCardFeatures";
import {
  MAX_PARALLELS_PER_INSERT,
  MAX_VARIANT_TYPES_PER_SET,
  pickBaseVariantType,
} from "./parallelChecklistBuild";
import { variantTypeKind } from "./variantRole";
import {
  findAncestorLabels,
  newTitleNameCache,
  type StoredCardTitleChain,
} from "./storedCardTitle";

/** One of the two formats. "" (clear) is accepted only by the public door. */
const formatValidator = v.union(v.literal("On Card"), v.literal("Sticker/Label"));

/**
 * Rows one cascade page READS. A page is one transaction; the leaf's cards are
 * read through `by_selector_option` in `_creationTime` order, resuming
 * strictly after the last card the previous page examined.
 */
export const CASCADE_SCAN_PER_PAGE = 500;

/**
 * Fills one cascade page may make before it ends. A fill is one patch plus
 * the player reads Signed By needs, and (NEO-345, 2026-10-18) the title
 * rebuild's player and team reads (cached per page) and the leaf's ancestor
 * walk (once per page): up to ~9 operations for a two-player card, so 100
 * keeps a page near the ~900-operation band. Separate from the scan bound so
 * a re-run over a mostly-formatted leaf does not pay one call per 100 rows.
 */
export const CASCADE_WRITES_PER_PAGE = 100;

/**
 * The most parallels one answer reaches, across every level it passes
 * through: the parallel build's own list bound, so an answer never reaches a
 * parallel the build would not list. Per parallel the adopt costs a read (in
 * the page it was listed in), a patch and an id in the scheduled walk, so the
 * worst case stays inside one transaction; real inserts carry tens.
 */
export const MAX_PARALLELS_PER_ANSWER = MAX_PARALLELS_PER_INSERT;

/**
 * Runaway guard for the walk. 500 rows a page × 2,000 pages is far beyond
 * any leaf (a commit is capped at 5,000 cards); reaching it means the cursor
 * is not advancing, which must not loop forever.
 */
const CASCADE_MAX_PAGES = 2000;

/** Operator-facing refusals. Never echo a value. */
const ROW_GONE = "That row is gone. Refresh and try again.";
const WRONG_LEVEL = "An autograph format goes on a base, insert or parallel.";

/**
 * Set or clear how a leaf's autographed cards are signed.
 *
 * `value` is "On Card", "Sticker/Label", or "" to clear. A clear removes the
 * key from the leaf (the NEO-217 spelling of "not set") and touches no card:
 * cards already formatted keep their `autographed`, which is now their own.
 * A set writes the leaf (only when it changed) and schedules the cascade —
 * also when it did not change, so re-picking the same answer re-applies it to
 * AU cards that arrived since (the fill is idempotent; a formatted card costs
 * nothing).
 */
export const setAutographFormat = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    value: v.union(formatValidator, v.literal("")),
  },
  returns: v.object({
    /**
     * The parallels this answer also reached (their own format was unset, or
     * already this one), whose AU cards the scheduled walk formats too. Empty
     * for a clear. The set-build tool waits on them (NEO-339 `nb_fix`).
     */
    parallelIds: v.array(v.id("selectorOptions")),
    /**
     * Of `parallelIds`, the ones that MOVED with a changed answer (they still
     * held the previous one), so the saved line can say so. Empty otherwise.
     */
    movedIds: v.array(v.id("selectorOptions")),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const leaf = await ctx.db.get(args.selectorOptionId);
    if (!leaf) throw new ConvexError(ROW_GONE);
    if (!AUTOGRAPH_FORMAT_LEVELS.has(leaf.level)) {
      throw new ConvexError(WRONG_LEVEL);
    }
    const stored = leaf.features?.autographFormat;

    if (args.value === "") {
      // A clear is this row's alone: parallels that took the answer keep it.
      if (stored === undefined) return { parallelIds: [], movedIds: [] };
      const features = { ...(leaf.features ?? {}) };
      delete features.autographFormat;
      await ctx.db.patch(args.selectorOptionId, {
        features,
        lastUpdated: Date.now(),
      });
      return { parallelIds: [], movedIds: [] };
    }

    // The validator already holds the vocabulary; this is the same guard
    // every feature write passes, so the two doors cannot drift.
    validateFeatureValue("autographFormat", args.value);
    if (stored !== args.value) {
      await ctx.db.patch(args.selectorOptionId, {
        features: { ...(leaf.features ?? {}), autographFormat: args.value },
        lastUpdated: Date.now(),
      });
    }
    // The PREVIOUS format is what cards formatted by an earlier answer carry;
    // the cascade may move those along with it. A stored value outside the
    // vocabulary (hand-edited data) is no previous answer at all.
    const previousFormat =
      stored === "On Card" || stored === "Sticker/Label" ? stored : undefined;
    const moving =
      previousFormat && previousFormat !== args.value ? previousFormat : undefined;
    // The leaf's parallels take the answer in this same transaction, and a
    // parallel still holding the PREVIOUS answer moves with it.
    const { parallelIds, movedIds } = await adoptAutographFormatOnParallels(
      ctx,
      leaf,
      args.value,
      moving,
    );
    await ctx.scheduler.runAfter(
      0,
      internal.autographFormat.cascadeAutographFormat,
      {
        selectorOptionId: args.selectorOptionId,
        format: args.value,
        ...(previousFormat && previousFormat !== args.value
          ? { previousFormat }
          : {}),
        ...(parallelIds.length > 0 ? { parallelIds } : {}),
        ...(movedIds.length > 0 ? { movedParallelIds: movedIds } : {}),
      },
    );
    return { parallelIds, movedIds };
  },
});

/**
 * The commit door (`selectorOptions.commitCardChecklist`'s `autographFormat`):
 * the prelude writes the answer onto a leaf that had none, and schedules this
 * so the leaf's parallels take it too, without adding their reads to the
 * commit's own transaction. The leaf's new cards are born formatted, so the
 * walk it schedules covers the parallels only.
 *
 * Re-reads the leaf and does nothing unless it still holds `format`: a later
 * answer (the header prompt, Set details) carries its own.
 */
export const inheritAutographFormatToParallels = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    format: formatValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaf = await ctx.db.get(args.selectorOptionId);
    if (!leaf || leaf.features?.autographFormat !== args.format) return null;
    const { parallelIds } = await adoptAutographFormatOnParallels(
      ctx,
      leaf,
      args.format,
    );
    if (parallelIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.autographFormat.cascadeAutographFormat,
        {
          selectorOptionId: args.selectorOptionId,
          format: args.format,
          parallelIds,
          walkLeaf: false,
        },
      );
    }
    return null;
  },
});

/**
 * The rows `source`'s cards are copied onto (the inverse of
 * `parallelChecklistBuild.resolveBuildSource`), read by level and the variant
 * type's kind only, never a row's name:
 *
 *   - an `insert` row → its `parallel`-level children;
 *   - the set's Base (a `variantType` of kind "base", and the ONLY one: the
 *     build refuses a set with none or several, and so does this) → the
 *     `insert`-level children of every sibling variant type of kind
 *     "parallel";
 *   - anything else → none.
 *
 * At most `limit` rows; `truncated` when there were more.
 */
async function directParallelsOf(
  ctx: { db: MutationCtx["db"] },
  source: Doc<"selectorOptions">,
  limit: number,
): Promise<{ rows: Array<Doc<"selectorOptions">>; truncated: boolean }> {
  if (limit <= 0) return { rows: [], truncated: true };
  if (source.level === "insert") {
    const rows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "parallel").eq("parentId", source._id),
      )
      .take(limit + 1);
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  }
  if (
    source.level !== "variantType" ||
    variantTypeKind(source) !== "base" ||
    !source.parentId
  ) {
    return { rows: [], truncated: false };
  }
  const setNameId = source.parentId;
  const siblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "variantType").eq("parentId", setNameId),
    )
    .take(MAX_VARIANT_TYPES_PER_SET + 1);
  // Past the bound the one Base cannot be told; the build refuses it too.
  if (siblings.length > MAX_VARIANT_TYPES_PER_SET) {
    return { rows: [], truncated: true };
  }
  const picked = pickBaseVariantType(siblings);
  if (!("base" in picked) || picked.base._id !== source._id) {
    return { rows: [], truncated: false };
  }
  const rows: Array<Doc<"selectorOptions">> = [];
  for (const type of siblings) {
    if (variantTypeKind(type) !== "parallel") continue;
    const room = limit - rows.length;
    const found = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", type._id),
      )
      .take(room + 1);
    rows.push(...found.slice(0, room));
    if (found.length > room) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * Write `format` onto every parallel of `source` (`directParallelsOf`, and
 * through each one that takes it, ITS parallels) whose own format is unset —
 * or, when the source's answer CHANGED, still holds the source's
 * `previousFormat`: the cards' own house rule (`applyBscAttributeFill` moves
 * a card still holding the leaf's previous format), applied one level up, so
 * a corrected misclick carries the parallels with it. Returns the parallels
 * that now hold `format` — written, moved, or already holding it — for the
 * cascade to walk, and which of them MOVED (their cards still holding the
 * previous format move too). A parallel holding any other format is left
 * exactly as it is, and the walk does not pass through it. A parallel that
 * was answered on its own with the same value as the previous answer cannot
 * be told from one that took it, exactly as for a card, and moves. Bounded by
 * `MAX_PARALLELS_PER_ANSWER` rows in all.
 */
export async function adoptAutographFormatOnParallels(
  ctx: { db: MutationCtx["db"] },
  source: Doc<"selectorOptions">,
  format: AutographFormat,
  previousFormat?: AutographFormat,
  /** Tests only: a SMALLER bound than `MAX_PARALLELS_PER_ANSWER`, never larger. */
  options: { limit?: number } = {},
): Promise<{
  parallelIds: Array<Id<"selectorOptions">>;
  /** Of `parallelIds`, the ones moved off `previousFormat`. */
  movedIds: Array<Id<"selectorOptions">>;
  /** Parallels holding a different format of their own, left alone. */
  keptOwn: number;
  truncated: boolean;
}> {
  const parallelIds: Array<Id<"selectorOptions">> = [];
  const movedIds: Array<Id<"selectorOptions">> = [];
  const moving = previousFormat !== undefined && previousFormat !== format;
  const seen = new Set<string>([source._id]);
  const queue: Array<Doc<"selectorOptions">> = [source];
  let keptOwn = 0;
  let truncated = false;
  const limit = clampLimit(options.limit, MAX_PARALLELS_PER_ANSWER);
  let budget = limit;
  const now = Date.now();
  while (queue.length > 0 && budget > 0) {
    const current = queue.shift()!;
    const found = await directParallelsOf(ctx, current, budget);
    if (found.truncated) truncated = true;
    for (const parallel of found.rows) {
      if (seen.has(parallel._id)) continue;
      seen.add(parallel._id);
      budget--;
      const own = parallel.features?.autographFormat;
      const moves = moving && own === previousFormat;
      if (own === undefined || moves) {
        await ctx.db.patch(parallel._id, {
          features: { ...(parallel.features ?? {}), autographFormat: format },
          lastUpdated: now,
        });
        if (moves) movedIds.push(parallel._id);
      } else if (own !== format) {
        keptOwn++;
        continue;
      }
      parallelIds.push(parallel._id);
      // A base parallel (an insert-level row) is a source in its own right.
      if (parallel.level === "insert") queue.push(parallel);
    }
  }
  if (queue.length > 0) truncated = true;
  if (truncated) {
    // Ids and counts only.
    console.warn(
      JSON.stringify({
        msg: "autograph_format_parallels_truncated",
        selectorOptionId: source._id,
        reached: parallelIds.length,
        limit,
      }),
    );
  }
  return { parallelIds, movedIds, keptOwn, truncated };
}

const pageResultValidator = v.object({
  /** The leaf no longer holds `format`; the walk stops (a newer one runs). */
  abandoned: v.boolean(),
  /** Every card of the leaf has been examined. */
  done: v.boolean(),
  /** `_creationTime` of the last card examined; the next page starts after it. */
  after: v.union(v.number(), v.null()),
  scanned: v.number(),
  /** AU cards whose `autographed` this page wrote. */
  formatted: v.number(),
  /** AU cards carrying an operator's own `autographed`, left alone. */
  skippedOverride: v.number(),
  /** Formatted cards whose still-generated title was rebuilt. */
  retitled: v.number(),
  /** Formatted cards whose still-generated listing description was rebuilt. */
  redescribed: v.number(),
});

/**
 * One bounded page of the cascade: the leaf's cards after `after`, AU cards
 * only, through `applyBscAttributeFill`.
 */
export const cascadeAutographFormatPage = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    format: formatValidator,
    previousFormat: v.optional(formatValidator),
    after: v.optional(v.number()),
    /** Tests only: can make a page SMALLER, never larger. */
    scanLimit: v.optional(v.number()),
    /** Tests only: can make a page SMALLER, never larger. */
    writeLimit: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => {
    const leaf = await ctx.db.get(args.selectorOptionId);
    if (!leaf || leaf.features?.autographFormat !== args.format) {
      return {
        abandoned: true,
        done: true,
        after: args.after ?? null,
        scanned: 0,
        formatted: 0,
        skippedOverride: 0,
        retitled: 0,
        redescribed: 0,
      };
    }
    const scanLimit = clampLimit(args.scanLimit, CASCADE_SCAN_PER_PAGE);
    const writeLimit = clampLimit(args.writeLimit, CASCADE_WRITES_PER_PAGE);
    const after = args.after;
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        after === undefined
          ? q.eq("selectorOptionId", args.selectorOptionId)
          : q
              .eq("selectorOptionId", args.selectorOptionId)
              .gt("_creationTime", after),
      )
      .take(scanLimit);

    let lastExamined: number | null = args.after ?? null;
    let scanned = 0;
    let writes = 0;
    let formatted = 0;
    let skippedOverride = 0;
    let retitled = 0;
    let redescribed = 0;
    let stoppedOnWrites = false;
    // The title rebuild's set-level facts: the leaf's ancestor walk, read
    // once for the page and only if a card is formatted; names once per id.
    let chain: Promise<StoredCardTitleChain> | undefined;
    const titleChain = () => (chain ??= findAncestorLabels(ctx, leaf));
    const titleNames = newTitleNameCache();
    for (const row of rows) {
      // End the page BEFORE a row it cannot afford, so the cursor points at
      // it and the next page decides it whole. The first row of a page is
      // always affordable (writes starts at 0, limit >= 1).
      if (writes >= writeLimit) {
        stoppedOnWrites = true;
        break;
      }
      lastExamined = row._creationTime;
      scanned++;
      if (!carriesAutographToken(row.attributes)) continue;
      const current = row.features?.autographed;
      if (
        current !== undefined &&
        current !== "None" &&
        current !== args.format &&
        current !== args.previousFormat
      ) {
        skippedOverride++;
        continue;
      }
      const result = await applyBscAttributeFill(ctx, row, {
        tokens: row.attributes ?? [],
        autographFormat: args.format,
        ...(args.previousFormat
          ? { previousAutographFormat: args.previousFormat }
          : {}),
        titleChain,
        titleNames,
      });
      if (result.wrote) writes++;
      if (result.autographFormatted) formatted++;
      if (result.retitled) retitled++;
      if (result.redescribed) redescribed++;
    }
    return {
      abandoned: false,
      done: !stoppedOnWrites && rows.length < scanLimit,
      after: lastExamined,
      scanned,
      formatted,
      skippedOverride,
      retitled,
      redescribed,
    };
  },
});

/** Totals one or more walks add up. */
type WalkTotals = {
  pages: number;
  formatted: number;
  skippedOverride: number;
  retitled: number;
  redescribed: number;
};

const emptyTotals = (): WalkTotals => ({
  pages: 0,
  formatted: 0,
  skippedOverride: 0,
  retitled: 0,
  redescribed: 0,
});

/**
 * One row's walk: its cards one bounded page at a time
 * (`cascadeAutographFormatPage`), adding to `totals`. True when the walk was
 * abandoned (the row no longer holds `format`). Throws on a runaway (no
 * progress, or past `CASCADE_MAX_PAGES`); every page before it stays applied.
 */
async function walkRowCards(
  ctx: ActionCtx,
  selectorOptionId: Id<"selectorOptions">,
  format: AutographFormat,
  previousFormat: AutographFormat | undefined,
  totals: WalkTotals,
): Promise<boolean> {
  let after: number | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= CASCADE_MAX_PAGES) {
      throw new Error(
        `cascadeAutographFormat: did not finish within ${CASCADE_MAX_PAGES} pages`,
      );
    }
    const page: {
      abandoned: boolean;
      done: boolean;
      after: number | null;
      formatted: number;
      skippedOverride: number;
      retitled: number;
      redescribed: number;
    } = await ctx.runMutation(internal.autographFormat.cascadeAutographFormatPage, {
      selectorOptionId,
      format,
      ...(previousFormat ? { previousFormat } : {}),
      ...(after !== undefined ? { after } : {}),
    });
    pages++;
    totals.pages++;
    totals.formatted += page.formatted;
    totals.skippedOverride += page.skippedOverride;
    totals.retitled += page.retitled;
    totals.redescribed += page.redescribed;
    if (page.abandoned) return true;
    if (page.done) return false;
    if (page.after === null || page.after === after) {
      // A page that examined nothing cannot advance; stop rather than spin.
      throw new Error("cascadeAutographFormat: cursor did not advance");
    }
    after = page.after;
  }
}

/**
 * Parallels one scheduled `cascadeAutographFormatParallels` action walks. A
 * reached parallel already holds the format, so its header never asks again:
 * a walk that dies must strand as few of them as possible. Small chunks keep
 * each action far from the action time limit, and each chunk is its own
 * scheduled function, so one failing chunk never stops the others.
 */
export const PARALLEL_WALKS_PER_ACTION = 25;

/**
 * Walk a leaf's cards one page at a time. Scheduled by `setAutographFormat`
 * and `inheritAutographFormatToParallels`; each page is its own transaction,
 * so partial progress is durable and a failure part-way leaves every earlier
 * page applied (re-picking the answer finishes the rest — the fill is
 * idempotent).
 *
 * The parallels the answer reached (`parallelIds`) are NOT walked here: they
 * are scheduled FIRST, in chunks of `PARALLEL_WALKS_PER_ACTION`
 * (`cascadeAutographFormatParallels`), so neither a failure of the leaf's own
 * walk nor one parallel's can strand the rest. `previousFormat` is the LEAF's
 * previous answer: it moves the leaf's cards, and the cards of each parallel
 * in `movedParallelIds` (the ones that moved off it with the leaf). A parallel
 * that took the answer while unset, or already held it, has no previous one.
 */
export const cascadeAutographFormat = internalAction({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    format: formatValidator,
    previousFormat: v.optional(formatValidator),
    /** The parallels the answer reached, walked in their own scheduled chunks. */
    parallelIds: v.optional(v.array(v.id("selectorOptions"))),
    /** Of `parallelIds`, the ones that moved off `previousFormat` with the leaf. */
    movedParallelIds: v.optional(v.array(v.id("selectorOptions"))),
    /** False: the leaf's own cards are already formatted (the commit door). */
    walkLeaf: v.optional(v.boolean()),
  },
  returns: v.object({
    pages: v.number(),
    formatted: v.number(),
    skippedOverride: v.number(),
    /** The LEAF's walk was abandoned (a newer answer runs its own). */
    abandoned: v.boolean(),
    retitled: v.number(),
    redescribed: v.number(),
    /** Parallels whose walks were scheduled (in chunks). */
    parallels: v.number(),
  }),
  handler: async (ctx, args) => {
    const parallelIds = args.parallelIds ?? [];
    const moved = new Set<string>(args.movedParallelIds ?? []);
    for (let i = 0; i < parallelIds.length; i += PARALLEL_WALKS_PER_ACTION) {
      const chunk = parallelIds.slice(i, i + PARALLEL_WALKS_PER_ACTION);
      const chunkMoved = chunk.filter((id) => moved.has(id));
      await ctx.scheduler.runAfter(
        0,
        internal.autographFormat.cascadeAutographFormatParallels,
        {
          format: args.format,
          parallelIds: chunk,
          ...(args.previousFormat && chunkMoved.length > 0
            ? { previousFormat: args.previousFormat, movedParallelIds: chunkMoved }
            : {}),
        },
      );
    }

    const totals = emptyTotals();
    const abandoned =
      args.walkLeaf === false
        ? false
        : await walkRowCards(ctx, args.selectorOptionId, args.format, args.previousFormat, totals);
    const result = {
      ...totals,
      abandoned,
      parallels: parallelIds.length,
    };
    // One audit line: counts only, never a value or a name.
    console.log(
      JSON.stringify({
        msg: "autograph_format_cascade",
        selectorOptionId: args.selectorOptionId as Id<"selectorOptions">,
        ...result,
      }),
    );
    return result;
  },
});

/**
 * One chunk of reached parallels (at most `PARALLEL_WALKS_PER_ACTION`), each
 * walked like the leaf. A walk that fails is logged (ids and the error's
 * class only, never a value or a message) and the next parallel is walked:
 * one parallel's failure strands only itself, and re-picking the answer
 * finishes it.
 */
export const cascadeAutographFormatParallels = internalAction({
  args: {
    format: formatValidator,
    parallelIds: v.array(v.id("selectorOptions")),
    previousFormat: v.optional(formatValidator),
    /** Of `parallelIds`, the ones that moved off `previousFormat`. */
    movedParallelIds: v.optional(v.array(v.id("selectorOptions"))),
  },
  returns: v.object({
    walked: v.number(),
    failed: v.number(),
    formatted: v.number(),
    retitled: v.number(),
    redescribed: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.parallelIds.length > PARALLEL_WALKS_PER_ACTION) {
      throw new Error(
        `cascadeAutographFormatParallels: at most ${PARALLEL_WALKS_PER_ACTION} parallels per call`,
      );
    }
    const moved = new Set<string>(args.movedParallelIds ?? []);
    const totals = emptyTotals();
    let walked = 0;
    let failed = 0;
    for (const parallelId of args.parallelIds) {
      try {
        await walkRowCards(
          ctx,
          parallelId,
          args.format,
          moved.has(parallelId) ? args.previousFormat : undefined,
          totals,
        );
        walked++;
      } catch (err) {
        failed++;
        console.error(
          JSON.stringify({
            msg: "autograph_format_parallel_walk_failed",
            selectorOptionId: parallelId,
            errorClass: errorClassOf(err),
          }),
        );
      }
    }
    return {
      walked,
      failed,
      formatted: totals.formatted,
      retitled: totals.retitled,
      redescribed: totals.redescribed,
    };
  },
});

/** An error's class for a log line: its constructor's name, never its message. */
function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

/** A caller may make a bound smaller, never larger, and never below one. */
function clampLimit(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
