/**
 * NEO-334 — a variant type's title is its kind; this module retires the flags
 * that used to say it.
 *
 * Until NEO-334 a variant type's kind lived in two NB flags beside its title:
 * `metadata.isBase` (NEO-239) and `metadata.variantRole` (NEO-306), and the
 * rows beneath it carried `metadata.isInsert` / `metadata.isParallel`
 * (NEO-291). Jason, 2026-10-10: the title IS the kind ("Base", "Insert(s)",
 * "Parallel(s)"), read by `variantTypeKind` in `variantRole.ts`, and no flag
 * mirrors it. The code stopped reading and writing all four in NEO-334; this
 * module is the data half.
 *
 * ## Operator commands
 *
 *   # 1. READ-ONLY: would reading the title change any row's kind?
 *   npx convex run backfillVariantTypeRole:reportTitleKind '{}'
 *   #    (resumes with '{"cursor":"<continueCursor>"}')
 *
 *   # 2. READ-ONLY: sets with no Base / two Bases / two same-word types
 *   npx convex run backfillVariantTypeRole:reportBaseAnomalies '{}'
 *
 *   # 3. dry run of the strip — reports what an armed run would remove
 *   npx convex run backfillVariantTypeRole:stripRoleFlags '{}'
 *
 *   # 4. arm the deployment, strip for real, disarm
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillVariantTypeRole:stripRoleFlags '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # a strip that stops at the page cap says so and returns where it was:
 *   npx convex run backfillVariantTypeRole:stripRoleFlags \
 *     '{"confirm":"BACKFILL","level":"<continueLevel>","cursor":"<continueCursor>"}'
 *
 *   # production: the same steps with --prod
 *
 * Run the strip only AFTER the NEO-334 code is deployed: an older deployment
 * still reads the flags. The schema keeps the four fields until the follow-up
 * PR removes them, which must land after the strip has run on every
 * deployment (Convex validates stored documents against the schema).
 *
 * Two independent arms, the house rule (`backfillBrandUnknownRole` explains
 * why both): `confirm: "BACKFILL"` per invocation, `ALLOW_SELECTOR_BACKFILL`
 * per deployment. Dry run is the default; an armed invocation on an unarmed
 * deployment is REFUSED (reported, not thrown) and writes nothing. No
 * `--identity`: these are internal functions and the deploy credential is the
 * gate.
 *
 * ## The strip: an action paging a mutation
 *
 * `stripRoleFlags` (internalAction) loops `stripRoleFlagsPage`
 * (internalMutation) over the `by_level` index, variantType rows first, then
 * insert, then parallel, `PAGE_SIZE` per page, until every level is exhausted
 * or `MAX_PAGES` is reached. Every page re-asserts both arms itself, so an
 * internal caller that skips the action gets the same refusal.
 *
 * It writes `metadata` only: the four keys are removed, every other key is
 * kept, and a `metadata` left empty is removed rather than stored as `{}`.
 * Never `platformData`, `platformFacets`, `platformLabels` or `value`.
 * `lastUpdated` is not bumped: it is the optimistic version open dialogs
 * compare against, and removing a dead flag is not an operator's edit.
 * Idempotent: a second run finds nothing to strip.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sameTitleWord, variantTypeKind, type VariantTypeKind } from "./variantRole";

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_SELECTOR_BACKFILL";
/** Rows per page: ~501 system operations, `RESET_BATCH_SIZE`'s order. */
export const PAGE_SIZE = 500;
/** Pages per `stripRoleFlags` call: 100,000 rows. Resume with the cursor. */
export const MAX_PAGES = 200;
/** Ids returned per finding, so a deployment-wide fault stays readable. */
export const SAMPLE_LIMIT = 25;

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the counts below are what ` +
  `an armed run would have done.`;
const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";
const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;
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
// The strip. ARMED.
// ───────────────────────────────────────────────────────────────────────────

/** The levels the strip walks, in order, and the flags each may carry. */
export const STRIP_LEVELS = ["variantType", "insert", "parallel"] as const;
type StripLevel = (typeof STRIP_LEVELS)[number];
const stripLevelValidator = v.union(
  v.literal("variantType"),
  v.literal("insert"),
  v.literal("parallel"),
);

/** The retired metadata keys (NEO-334). */
export const RETIRED_ROLE_KEYS = [
  "isBase",
  "variantRole",
  "isInsert",
  "isParallel",
] as const;

/**
 * `metadata` without the retired keys, or `undefined` when nothing is left;
 * `null` when the row carries none of them (nothing to write).
 */
export function strippedMetadata(
  metadata: Doc<"selectorOptions">["metadata"],
): Doc<"selectorOptions">["metadata"] | null {
  if (!metadata) return null;
  const rest: Record<string, unknown> = { ...metadata };
  let removed = false;
  for (const key of RETIRED_ROLE_KEYS) {
    if (key in rest) {
      delete rest[key];
      removed = true;
    }
  }
  if (!removed) return null;
  return Object.keys(rest).length > 0
    ? (rest as Doc<"selectorOptions">["metadata"])
    : undefined;
}

const stripCountsValidator = v.object({
  scanned: v.number(),
  stripped: v.number(),
  clean: v.number(),
});
type StripCounts = { scanned: number; stripped: number; clean: number };

export const stripRoleFlagsPage = internalMutation({
  args: {
    confirm: v.optional(v.string()),
    level: stripLevelValidator,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    armed: v.boolean(),
    refusedForFlag: v.boolean(),
    counts: stripCountsValidator,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", args.level))
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor });

    const counts: StripCounts = { scanned: 0, stripped: 0, clean: 0 };
    for (const row of page.page) {
      // Belt: the index is keyed on level, but the guard is here.
      if (row.level !== args.level) continue;
      counts.scanned++;
      const next = strippedMetadata(row.metadata);
      if (next === null) {
        counts.clean++;
        continue;
      }
      counts.stripped++;
      if (armed) {
        // Metadata only. `undefined` removes the field.
        await ctx.db.patch(row._id, { metadata: next });
      }
    }

    // One audit line per page: counts, level and arm state only.
    console.log(
      JSON.stringify({
        msg: "strip_variant_role_flags_page",
        level: args.level,
        armed,
        refusedForFlag,
        ...counts,
        isDone: page.isDone,
      }),
    );

    return {
      armed,
      refusedForFlag,
      counts,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const stripRoleFlags = internalAction({
  args: {
    /** `"BACKFILL"` to write; anything else (or nothing) is a dry run. */
    confirm: v.optional(v.string()),
    /** Resume: the `continueLevel` of a truncated run. */
    level: v.optional(stripLevelValidator),
    /** Resume: the `continueCursor` of a truncated run (within `level`). */
    cursor: v.optional(v.string()),
    /** Pages this run walks, 1..`MAX_PAGES` (default `MAX_PAGES`). */
    maxPages: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    pages: v.number(),
    truncated: v.boolean(),
    /** Present when `truncated`: pass both back to carry on. */
    continueLevel: v.optional(stripLevelValidator),
    continueCursor: v.optional(v.string()),
    counts: stripCountsValidator,
  }),
  handler: async (ctx, args) => {
    const totals: StripCounts = { scanned: 0, stripped: 0, clean: 0 };
    const maxPages = Math.max(
      1,
      Math.min(MAX_PAGES, Math.floor(args.maxPages ?? MAX_PAGES)),
    );
    let levelIndex = args.level ? STRIP_LEVELS.indexOf(args.level) : 0;
    let cursor: string | null = args.cursor ?? null;
    let pages = 0;
    let armed = false;
    let refusedForFlag = false;
    while (pages < maxPages && levelIndex < STRIP_LEVELS.length) {
      const level: StripLevel = STRIP_LEVELS[levelIndex];
      const page: {
        armed: boolean;
        refusedForFlag: boolean;
        counts: StripCounts;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.backfillVariantTypeRole.stripRoleFlagsPage, {
        confirm: args.confirm,
        level,
        cursor,
      });
      pages++;
      armed = page.armed;
      refusedForFlag = page.refusedForFlag;
      for (const key of Object.keys(totals) as Array<keyof StripCounts>) {
        totals[key] += page.counts[key];
      }
      if (page.isDone) {
        levelIndex++;
        cursor = null;
      } else {
        cursor = page.continueCursor;
      }
    }
    const truncated = levelIndex < STRIP_LEVELS.length;
    return {
      armed,
      message: refusedForFlag
        ? NOT_ARMED_MESSAGE
        : truncated
          ? truncatedMessage(pages)
          : armed
            ? APPLIED_MESSAGE
            : DRY_RUN_MESSAGE,
      pages,
      truncated,
      ...(truncated ? { continueLevel: STRIP_LEVELS[levelIndex] } : {}),
      ...(truncated && cursor !== null ? { continueCursor: cursor } : {}),
      counts: totals,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Title vs flags. READ-ONLY.
// ───────────────────────────────────────────────────────────────────────────

/** The kind the retired flags gave a variant type, or `undefined`. */
function flaggedKind(
  metadata: Doc<"selectorOptions">["metadata"],
): VariantTypeKind | undefined {
  if (metadata?.isBase === true) return "base";
  return metadata?.variantRole;
}

const titleKindCountsValidator = v.object({
  scanned: v.number(),
  /** Title and flags give the same kind (or both none). */
  agree: v.number(),
  /** No flag, but the title names a kind: the row GAINS one. */
  gained: v.number(),
  /** A flag, but the title names no kind: the row LOSES it. */
  lost: v.number(),
  /** Both name a kind, and they differ. */
  switched: v.number(),
});
type TitleKindCounts = {
  scanned: number;
  agree: number;
  gained: number;
  lost: number;
  switched: number;
};
const titleKindSamplesValidator = v.object({
  gained: v.array(v.id("selectorOptions")),
  lost: v.array(v.id("selectorOptions")),
  switched: v.array(v.id("selectorOptions")),
});
type TitleKindSamples = {
  gained: Array<Id<"selectorOptions">>;
  lost: Array<Id<"selectorOptions">>;
  switched: Array<Id<"selectorOptions">>;
};

export const reportTitleKindPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    counts: titleKindCountsValidator,
    samples: titleKindSamplesValidator,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "variantType"))
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
    const counts: TitleKindCounts = {
      scanned: 0,
      agree: 0,
      gained: 0,
      lost: 0,
      switched: 0,
    };
    const samples: TitleKindSamples = { gained: [], lost: [], switched: [] };
    for (const row of page.page) {
      if (row.level !== "variantType") continue;
      counts.scanned++;
      const byTitle = variantTypeKind(row);
      const byFlag = flaggedKind(row.metadata);
      if (byTitle === byFlag) {
        counts.agree++;
      } else if (byFlag === undefined) {
        counts.gained++;
        pushSample(samples.gained, row._id);
      } else if (byTitle === undefined) {
        counts.lost++;
        pushSample(samples.lost, row._id);
      } else {
        counts.switched++;
        pushSample(samples.switched, row._id);
      }
    }
    return {
      counts,
      samples,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * NEO-334 — does reading the title change any variant type's kind, against
 * the retired flags? Writes nothing, ever. Ids only in the result and the log
 * line: a row's name is operator content. Meaningful only while rows still
 * carry the flags, so run it before `stripRoleFlags`.
 */
export const reportTitleKind = internalAction({
  args: {
    /** A previous report's `continueCursor`; absent starts at the first row. */
    cursor: v.optional(v.string()),
    /** Pages this report walks, 1..`MAX_PAGES` (default the max). */
    maxPages: v.optional(v.number()),
  },
  returns: v.object({
    message: v.string(),
    pages: v.number(),
    truncated: v.boolean(),
    continueCursor: v.optional(v.string()),
    counts: titleKindCountsValidator,
    /** Up to `SAMPLE_LIMIT` ids of each, in scan order. */
    samples: titleKindSamplesValidator,
  }),
  handler: async (ctx, args) => {
    const totals: TitleKindCounts = {
      scanned: 0,
      agree: 0,
      gained: 0,
      lost: 0,
      switched: 0,
    };
    const samples: TitleKindSamples = { gained: [], lost: [], switched: [] };
    let cursor: string | null = args.cursor ?? null;
    const maxPages = Math.max(
      1,
      Math.min(MAX_PAGES, Math.floor(args.maxPages ?? MAX_PAGES)),
    );
    let pages = 0;
    let isDone = false;
    while (pages < maxPages) {
      const page: {
        counts: TitleKindCounts;
        samples: TitleKindSamples;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.backfillVariantTypeRole.reportTitleKindPage, {
        cursor,
      });
      pages++;
      for (const key of Object.keys(totals) as Array<keyof TitleKindCounts>) {
        totals[key] += page.counts[key];
      }
      for (const key of Object.keys(samples) as Array<keyof TitleKindSamples>) {
        for (const id of page.samples[key]) pushSample(samples[key], id);
      }
      if (page.isDone) {
        isDone = true;
        break;
      }
      cursor = page.continueCursor;
    }
    const truncated = !isDone;
    console.log(
      JSON.stringify({ msg: "report_variant_title_kind", ...totals, pages, truncated }),
    );
    return {
      message: truncated
        ? truncatedMessage(pages)
        : "Report only — nothing written. `gained`, `lost` and `switched` are " +
          "the variant types whose kind changes when it is read from the title.",
      pages,
      truncated,
      ...(truncated && cursor !== null ? { continueCursor: cursor } : {}),
      counts: totals,
      samples,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The per-set Base report. READ-ONLY.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sets per report page. A set is read with ALL its variant types (each
 * carrying its `children` id array) plus one card probe per type, so the
 * per-transaction read budget, not a row count, is the bound — hence far
 * fewer than `PAGE_SIZE`.
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
