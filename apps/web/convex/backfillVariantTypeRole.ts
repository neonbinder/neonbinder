/**
 * NEO-306 — one-shot backfill: give every existing `variantType` row the
 * `metadata.variantRole` NB flag its `variant`-tagged BSC slot says it has.
 *
 * ## Why this exists
 *
 * Until NEO-306 `variantTypeRole` re-read the id in a variant type's
 * `variant`-tagged BSC slot at RUNTIME, every time a child was created or a
 * set-shape door asked what a type was — NB behaviour keyed on a marketplace
 * value (product invariant 4). The role is now an NB flag, conferred once by
 * the sync that writes the row (`conferredVariantRole` in both stores). Rows
 * written before that, and never re-synced since, carry no flag and read as
 * "no role" — so "Make parallel of…" refuses and a reconcile under them mints
 * children with no `isInsert`/`isParallel`. This task closes that window.
 *
 * ## Operator commands
 *
 *   # 0. first, on a deployment that has never had it, the NEO-239 tag
 *   #    backfill: this one reads only `variant`-TAGGED slots, so untagged
 *   #    legacy slots land in `noEvidence` until that has run.
 *   npx convex run backfillVariantFacetAndBaseRole:run '{}'
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillVariantTypeRole:run '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillVariantTypeRole:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # a run that stops at the page cap says so and returns continueCursor:
 *   npx convex run backfillVariantTypeRole:run \
 *     '{"confirm":"BACKFILL","cursor":"<continueCursor>"}'
 *
 *   # production: the same steps with --prod
 *
 *   # NEO-306 — READ-ONLY: sets whose base role is not exactly one row
 *   npx convex run backfillVariantTypeRole:reportBaseAnomalies '{}'
 *   # (resumes the same way: '{"cursor":"<continueCursor>"}')
 *
 * Two independent arms, the house rule (`backfillBrandUnknownRole` explains
 * why both): `confirm: "BACKFILL"` per invocation, `ALLOW_SELECTOR_BACKFILL`
 * per deployment. Dry run is the default; an armed invocation on an unarmed
 * deployment is REFUSED (reported, not thrown) and writes nothing. The confirm
 * is an argument, so a `!` run with no TTY works. No `--identity`: these are
 * internal functions and the deploy credential is the gate.
 *
 * ## Shape: an action paging a mutation
 *
 * `run` (internalAction) loops `runPage` (internalMutation) over the
 * `by_level` variantType rows, 500 per page, until the index is exhausted or
 * `MAX_PAGES` is reached. A variantType row carries its `children` id array
 * (hundreds of ids on an Insert or Parallel type), so the bound that matters
 * is the per-transaction read budget, not a row count — which is why neither
 * of the older single-transaction models (`SCAN_LIMIT` + `.take`) is copied.
 * Every page re-asserts both arms itself, so an internal caller that skips
 * `run` gets the same refusal.
 *
 * ## What it decides — one planner, both runs
 *
 *   flagged        no role yet, single evidence → gets `variantRole`
 *   alreadyFlagged carries a role → left exactly as it is (never flipped)
 *   base           `isBase` → never written (the reader checks `isBase` first)
 *   ambiguous      tagged ids name both roles, or two tagged slots disagree
 *   noEvidence     no tagged slot, or tagged ids name neither role
 *
 * `conferredVariantRole` / `bscVariantEvidence` are the SAME functions the
 * sync conferral calls, so this task and the sync cannot decide differently.
 *
 * ## What it writes
 *
 * `metadata` only, through a spread of the existing object. Never
 * `platformData`, `platformFacets` or `platformLabels` — the BSC slots are
 * what listing reads (Jason's condition on NEO-306 D1). `lastUpdated` is not
 * bumped: it is the optimistic version open dialogs compare against, and a
 * role flag is not an edit an operator made.
 *
 * ## The base-role anomaly report (NEO-306)
 *
 * The base role and the Base row are one thing: `setBaseVariantType` grants
 * the role only to a set that has none, and the only way to take it away is
 * to delete the (empty) row. Data written before that rule can still break
 * it, and `reportBaseAnomalies` counts the two shapes that matter, per SET:
 *
 *   multipleBase      more than one variant type carries `isBase` — the
 *                     readers pick by document order, or (teamFill) give up
 *   noBaseWithCards   no variant type carries `isBase`, yet one of them has
 *                     cards hanging straight off it — the shape a Base that
 *                     lost its flag leaves behind (the retired "Clear base
 *                     set"); the row is no longer terminal in the builder
 *
 * It NEVER writes and needs no arm: which row is the base is the operator's
 * decision, so the report hands back sample set ids and stops there.
 *
 * ## Deploy the validator first; roll forward only
 *
 * `metadata` is an exact object validator, validated on read. Deploy the
 * schema carrying `variantRole` first; once a row carries it, no deployment
 * whose validator predates the field can read that row.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { bscVariantEvidence, conferredVariantRole } from "./variantRole";

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_SELECTOR_BACKFILL";
/** Rows per page: ~501 system operations, `RESET_BATCH_SIZE`'s order. */
export const PAGE_SIZE = 500;
/** Pages per `run`: 100,000 variant types, far above any deployment today. */
export const MAX_PAGES = 200;

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
    `"cursor" set to the continueCursor below; the run carries on from there.`
  );
}

const countsValidator = v.object({
  scanned: v.number(),
  flagged: v.number(),
  alreadyFlagged: v.number(),
  base: v.number(),
  ambiguous: v.number(),
  noEvidence: v.number(),
});
type Counts = {
  scanned: number;
  flagged: number;
  alreadyFlagged: number;
  base: number;
  ambiguous: number;
  noEvidence: number;
};

function emptyCounts(): Counts {
  return { scanned: 0, flagged: 0, alreadyFlagged: 0, base: 0, ambiguous: 0, noEvidence: 0 };
}

export const runPage = internalMutation({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    armed: v.boolean(),
    refusedForFlag: v.boolean(),
    counts: countsValidator,
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "variantType"))
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor });

    const counts = emptyCounts();
    for (const row of page.page) {
      // Belt: the index is keyed on level, but the planner is the guard.
      if (row.level !== "variantType") continue;
      counts.scanned++;
      if (row.metadata?.isBase === true) {
        counts.base++;
        continue;
      }
      if (row.metadata?.variantRole !== undefined) {
        counts.alreadyFlagged++;
        continue;
      }
      const role = conferredVariantRole(row.metadata, row);
      if (!role) {
        if (bscVariantEvidence(row) === "ambiguous") counts.ambiguous++;
        else counts.noEvidence++;
        continue;
      }
      counts.flagged++;
      if (armed) {
        // Metadata only, spread: `cardNumberPrefix` and the rest stay. No
        // platform field is in this patch, so the BSC slots cannot move.
        await ctx.db.patch(row._id, {
          metadata: { ...(row.metadata ?? {}), variantRole: role },
        });
      }
    }

    // One audit line per page. Counts and the arm state only — no row
    // values, no marketplace ids. No identity exists to record: the deploy
    // credential is the actor.
    console.log(
      JSON.stringify({
        msg: "backfill_variant_type_role_page",
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

export const run = internalAction({
  args: {
    /** `"BACKFILL"` to write; anything else (or nothing) is a dry run. */
    confirm: v.optional(v.string()),
    /**
     * Resume point: a previous run's `continueCursor`. Absent starts from the
     * first variant type. (Re-running from the top is also safe — flagged
     * rows write nothing — but only a cursor gets PAST the page cap.)
     */
    cursor: v.optional(v.string()),
    /** Pages this run walks, 1..`MAX_PAGES` (default `MAX_PAGES`). */
    maxPages: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    pages: v.number(),
    truncated: v.boolean(),
    /** Present when `truncated`: pass it back as `cursor` to carry on. */
    continueCursor: v.optional(v.string()),
    counts: countsValidator,
  }),
  handler: async (ctx, args) => {
    const totals = emptyCounts();
    let cursor: string | null = args.cursor ?? null;
    const maxPages = Math.max(
      1,
      Math.min(MAX_PAGES, Math.floor(args.maxPages ?? MAX_PAGES)),
    );
    let pages = 0;
    let armed = false;
    let refusedForFlag = false;
    let isDone = false;
    while (pages < maxPages) {
      const page: {
        armed: boolean;
        refusedForFlag: boolean;
        counts: Counts;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.backfillVariantTypeRole.runPage, {
        confirm: args.confirm,
        cursor,
      });
      pages++;
      armed = page.armed;
      refusedForFlag = page.refusedForFlag;
      for (const key of Object.keys(totals) as Array<keyof Counts>) {
        totals[key] += page.counts[key];
      }
      if (page.isDone) {
        isDone = true;
        break;
      }
      cursor = page.continueCursor;
    }
    const truncated = !isDone;
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
      ...(truncated && cursor !== null ? { continueCursor: cursor } : {}),
      counts: totals,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-306 — the base-role anomaly report. READ-ONLY.
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
export const REPORT_SAMPLE_LIMIT = 25;

const anomalyCountsValidator = v.object({
  setsScanned: v.number(),
  multipleBase: v.number(),
  noBaseWithCards: v.number(),
});
type AnomalyCounts = {
  setsScanned: number;
  multipleBase: number;
  noBaseWithCards: number;
};

export const reportBaseAnomaliesPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    counts: anomalyCountsValidator,
    multipleBaseSetIds: v.array(v.id("selectorOptions")),
    noBaseWithCardsSetIds: v.array(v.id("selectorOptions")),
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
    };
    const multipleBaseSetIds: Array<Id<"selectorOptions">> = [];
    const noBaseWithCardsSetIds: Array<Id<"selectorOptions">> = [];

    for (const set of page.page) {
      if (set.level !== "setName") continue;
      counts.setsScanned++;
      const types = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", set._id),
        )
        .collect();
      const bases = types.filter((type) => type.metadata?.isBase === true);
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
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * NEO-306 — count the sets whose base role is not exactly one row. Writes
 * nothing, ever; see the header. Ids only in the result and the log line —
 * a set's name is operator content.
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
  }),
  handler: async (ctx, args) => {
    const totals: AnomalyCounts = {
      setsScanned: 0,
      multipleBase: 0,
      noBaseWithCards: 0,
    };
    const multipleBaseSetIds: Array<Id<"selectorOptions">> = [];
    const noBaseWithCardsSetIds: Array<Id<"selectorOptions">> = [];
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
      for (const id of page.multipleBaseSetIds) {
        if (multipleBaseSetIds.length < REPORT_SAMPLE_LIMIT) multipleBaseSetIds.push(id);
      }
      for (const id of page.noBaseWithCardsSetIds) {
        if (noBaseWithCardsSetIds.length < REPORT_SAMPLE_LIMIT) {
          noBaseWithCardsSetIds.push(id);
        }
      }
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
          "is each set's base is the operator's decision.",
      pages,
      truncated,
      ...(truncated && cursor !== null ? { continueCursor: cursor } : {}),
      counts: totals,
      multipleBaseSetIds,
      noBaseWithCardsSetIds,
    };
  },
});
