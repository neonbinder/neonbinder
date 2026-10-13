/**
 * NEO-334 — a variant type's title is its kind; this module is the operator's
 * read-only report on the sets that break the rules that follow from it.
 *
 * Until NEO-334 a variant type's kind lived in two NB flags beside its title
 * (`metadata.isBase`, NEO-239, and `metadata.variantRole`, NEO-306), and the
 * rows beneath it carried `metadata.isInsert` / `metadata.isParallel`
 * (NEO-291). Jason, 2026-10-10: the title IS the kind ("Base", "Insert(s)",
 * "Parallel(s)"), read by `variantTypeKind` in `variantRole.ts`, and no flag
 * mirrors it. The code stopped reading and writing all four in NEO-334 PR A;
 * this module's armed `stripRoleFlags` and its `reportTitleKind` comparison
 * removed them from stored rows and checked nothing changed kind; NEO-334
 * PR B dropped the fields from the schema and, with them, both of those
 * functions (they read fields that no longer exist). What remains reads the
 * title only.
 *
 * ## Operator command
 *
 *   # READ-ONLY: sets with no Base / two Bases / two same-word types
 *   npx convex run backfillVariantTypeRole:reportBaseAnomalies '{}'
 *   #    (resumes with '{"cursor":"<continueCursor>"}')
 *
 *   # production: the same with --prod
 *
 * Writes nothing, ever, so there is no arm. No `--identity`: these are
 * internal functions and the deploy credential is the gate.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sameTitleWord, variantTypeKind } from "./variantRole";

/** Ids returned per finding, so a deployment-wide fault stays readable. */
export const SAMPLE_LIMIT = 25;

function truncatedMessage(pages: number): string {
  return (
    `Stopped after ${pages} pages with rows left. Re-run the same command with ` +
    `the continue values below; the run carries on from there.`
  );
}

function pushSample<T>(into: T[], value: T): void {
  if (into.length < SAMPLE_LIMIT) into.push(value);
}

// ───────────────────────────────────────────────────────────────────────────
// The per-set Base report. READ-ONLY.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sets per report page. A set is read with ALL its variant types (each
 * carrying its `children` id array) plus one card probe per type, so the
 * per-transaction read budget, not a row count, is the bound — hence far
 * fewer than a plain row page.
 */
export const REPORT_PAGE_SIZE = 50;
/** Pages per `reportBaseAnomalies`: 20,000 sets. Resume with the cursor. */
export const REPORT_MAX_PAGES = 400;
/** Set ids returned per anomaly, so a deployment-wide fault stays readable. */
export const REPORT_SAMPLE_LIMIT = SAMPLE_LIMIT;

const anomalyCountsValidator = v.object({
  setsScanned: v.number(),
  multipleBase: v.number(),
  noBaseWithCards: v.number(),
  sameWordSiblings: v.number(),
});
type AnomalyCounts = {
  setsScanned: number;
  multipleBase: number;
  noBaseWithCards: number;
  sameWordSiblings: number;
};

export const reportBaseAnomaliesPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    counts: anomalyCountsValidator,
    multipleBaseSetIds: v.array(v.id("selectorOptions")),
    noBaseWithCardsSetIds: v.array(v.id("selectorOptions")),
    sameWordSiblingsSetIds: v.array(v.id("selectorOptions")),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "setName"))
      .paginate({ numItems: REPORT_PAGE_SIZE, cursor: args.cursor });

    const counts: AnomalyCounts = {
      setsScanned: 0,
      multipleBase: 0,
      noBaseWithCards: 0,
      sameWordSiblings: 0,
    };
    const multipleBaseSetIds: Array<Id<"selectorOptions">> = [];
    const noBaseWithCardsSetIds: Array<Id<"selectorOptions">> = [];
    const sameWordSiblingsSetIds: Array<Id<"selectorOptions">> = [];

    for (const set of page.page) {
      if (set.level !== "setName") continue;
      counts.setsScanned++;
      const types = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", set._id),
        )
        .collect();

      const clash = types.some((a, i) =>
        types.slice(i + 1).some((b) => sameTitleWord(a.value, b.value)),
      );
      if (clash) {
        counts.sameWordSiblings++;
        sameWordSiblingsSetIds.push(set._id);
      }

      const bases = types.filter((type) => variantTypeKind(type) === "base");
      if (bases.length > 1) {
        counts.multipleBase++;
        multipleBaseSetIds.push(set._id);
        continue;
      }
      if (bases.length === 1) continue;
      for (const type of types) {
        const card = await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) =>
            q.eq("selectorOptionId", type._id),
          )
          .first();
        if (card) {
          counts.noBaseWithCards++;
          noBaseWithCardsSetIds.push(set._id);
          break;
        }
      }
    }

    return {
      counts,
      multipleBaseSetIds,
      noBaseWithCardsSetIds,
      sameWordSiblingsSetIds,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Count the sets that break a NEO-334 rule, read from the TITLES: more than
 * one variant type titled "Base" (`multipleBase`), none titled "Base" while
 * one of them has cards hanging straight off it (`noBaseWithCards`: the Base
 * was renamed or never titled), and two variant types whose titles are the
 * same word (`sameWordSiblings`: "Promo" beside "Promos"). Writes nothing,
 * ever: which row is each set's Base is the operator's call, made by renaming.
 * Ids only in the result and the log line.
 */
export const reportBaseAnomalies = internalAction({
  args: {
    /** A previous report's `continueCursor`; absent starts at the first set. */
    cursor: v.optional(v.string()),
    /** Pages this report walks, 1..`REPORT_MAX_PAGES` (default the max). */
    maxPages: v.optional(v.number()),
  },
  returns: v.object({
    message: v.string(),
    pages: v.number(),
    truncated: v.boolean(),
    continueCursor: v.optional(v.string()),
    counts: anomalyCountsValidator,
    /** Up to `REPORT_SAMPLE_LIMIT` of each, in scan order. */
    multipleBaseSetIds: v.array(v.id("selectorOptions")),
    noBaseWithCardsSetIds: v.array(v.id("selectorOptions")),
    sameWordSiblingsSetIds: v.array(v.id("selectorOptions")),
  }),
  handler: async (ctx, args) => {
    const totals: AnomalyCounts = {
      setsScanned: 0,
      multipleBase: 0,
      noBaseWithCards: 0,
      sameWordSiblings: 0,
    };
    const multipleBaseSetIds: Array<Id<"selectorOptions">> = [];
    const noBaseWithCardsSetIds: Array<Id<"selectorOptions">> = [];
    const sameWordSiblingsSetIds: Array<Id<"selectorOptions">> = [];
    let cursor: string | null = args.cursor ?? null;
    const maxPages = Math.max(
      1,
      Math.min(REPORT_MAX_PAGES, Math.floor(args.maxPages ?? REPORT_MAX_PAGES)),
    );
    let pages = 0;
    let isDone = false;
    while (pages < maxPages) {
      const page: {
        counts: AnomalyCounts;
        multipleBaseSetIds: Array<Id<"selectorOptions">>;
        noBaseWithCardsSetIds: Array<Id<"selectorOptions">>;
        sameWordSiblingsSetIds: Array<Id<"selectorOptions">>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(
        internal.backfillVariantTypeRole.reportBaseAnomaliesPage,
        { cursor },
      );
      pages++;
      for (const key of Object.keys(totals) as Array<keyof AnomalyCounts>) {
        totals[key] += page.counts[key];
      }
      for (const id of page.multipleBaseSetIds) pushSample(multipleBaseSetIds, id);
      for (const id of page.noBaseWithCardsSetIds) pushSample(noBaseWithCardsSetIds, id);
      for (const id of page.sameWordSiblingsSetIds) pushSample(sameWordSiblingsSetIds, id);
      if (page.isDone) {
        isDone = true;
        break;
      }
      cursor = page.continueCursor;
    }
    const truncated = !isDone;

    console.log(
      JSON.stringify({
        msg: "report_base_role_anomalies",
        ...totals,
        pages,
        truncated,
      }),
    );

    return {
      message: truncated
        ? truncatedMessage(pages)
        : "Report only — nothing written. The set ids are samples; which row " +
          "is each set's Base is the operator's call, made by renaming.",
      pages,
      truncated,
      ...(truncated && cursor !== null ? { continueCursor: cursor } : {}),
      counts: totals,
      multipleBaseSetIds,
      noBaseWithCardsSetIds,
      sameWordSiblingsSetIds,
    };
  },
});
