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
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { applyBscAttributeFill } from "./cardChecklist";
import {
  AUTOGRAPH_FORMAT_LEVELS,
  carriesAutographToken,
  validateFeatureValue,
} from "./features/deriveCardFeatures";

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
 * the player reads Signed By needs — a handful of operations — so 150 keeps a
 * page near the ~900-operation band. Separate from the scan bound so a
 * re-run over a mostly-formatted leaf does not pay one call per 150 rows.
 */
export const CASCADE_WRITES_PER_PAGE = 150;

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
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const leaf = await ctx.db.get(args.selectorOptionId);
    if (!leaf) throw new ConvexError(ROW_GONE);
    if (!AUTOGRAPH_FORMAT_LEVELS.has(leaf.level)) {
      throw new ConvexError(WRONG_LEVEL);
    }
    const stored = leaf.features?.autographFormat;

    if (args.value === "") {
      if (stored === undefined) return null;
      const features = { ...(leaf.features ?? {}) };
      delete features.autographFormat;
      await ctx.db.patch(args.selectorOptionId, {
        features,
        lastUpdated: Date.now(),
      });
      return null;
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
    await ctx.scheduler.runAfter(
      0,
      internal.autographFormat.cascadeAutographFormat,
      {
        selectorOptionId: args.selectorOptionId,
        format: args.value,
        ...(previousFormat && previousFormat !== args.value
          ? { previousFormat }
          : {}),
      },
    );
    return null;
  },
});

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
    let stoppedOnWrites = false;
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
      });
      if (result.wrote) writes++;
      if (result.autographFormatted) formatted++;
    }
    return {
      abandoned: false,
      done: !stoppedOnWrites && rows.length < scanLimit,
      after: lastExamined,
      scanned,
      formatted,
      skippedOverride,
    };
  },
});

/**
 * Walk a leaf's cards one page at a time. Scheduled by `setAutographFormat`;
 * each page is its own transaction, so partial progress is durable and a
 * failure part-way leaves every earlier page applied (re-picking the answer
 * finishes the rest — the fill is idempotent).
 */
export const cascadeAutographFormat = internalAction({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    format: formatValidator,
    previousFormat: v.optional(formatValidator),
  },
  returns: v.object({
    pages: v.number(),
    formatted: v.number(),
    skippedOverride: v.number(),
    abandoned: v.boolean(),
  }),
  handler: async (ctx, args) => {
    let after: number | undefined;
    let pages = 0;
    let formatted = 0;
    let skippedOverride = 0;
    let abandoned = false;
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
      } = await ctx.runMutation(internal.autographFormat.cascadeAutographFormatPage, {
        selectorOptionId: args.selectorOptionId,
        format: args.format,
        ...(args.previousFormat ? { previousFormat: args.previousFormat } : {}),
        ...(after !== undefined ? { after } : {}),
      });
      pages++;
      formatted += page.formatted;
      skippedOverride += page.skippedOverride;
      if (page.abandoned) {
        abandoned = true;
        break;
      }
      if (page.done) break;
      if (page.after === null || page.after === after) {
        // A page that examined nothing cannot advance; stop rather than spin.
        throw new Error("cascadeAutographFormat: cursor did not advance");
      }
      after = page.after;
    }
    // One audit line: counts only, never a value or a name.
    console.log(
      JSON.stringify({
        msg: "autograph_format_cascade",
        selectorOptionId: args.selectorOptionId as Id<"selectorOptions">,
        pages,
        formatted,
        skippedOverride,
        abandoned,
      }),
    );
    return { pages, formatted, skippedOverride, abandoned };
  },
});

/** A caller may make a bound smaller, never larger, and never below one. */
function clampLimit(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
