/**
 * NEO-293 — one-shot backfill: tag the untagged BSC slots of every parallel
 * that was PROMOTED from an insert as the `variantName` facet, so the id the
 * insert-level sync fetched stops being inert the moment the operator groups
 * the row under the insert it parallels.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillPromotedParallelFacet:run '{}'
 *
 *   # 2. arm the deployment, then run for real
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillPromotedParallelFacet:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # production: same three steps, with --prod
 *
 *   # one variant type only (also the escape hatch when `truncated` is true)
 *   npx convex run backfillPromotedParallelFacet:run '{"variantTypeId":"<id>"}'
 *
 * TWO INDEPENDENT ARMING STEPS, and that is the project rule for a scripted
 * admin task rather than belt-and-braces:
 *
 *   `confirm: "BACKFILL"` is a per-INVOCATION statement of intent. It cannot be
 *   arrived at by autocomplete or by re-running the dry-run command.
 *
 *   `ALLOW_SELECTOR_BACKFILL` is a per-DEPLOYMENT one, and it is the half that
 *   protects the deployment you did not mean to be pointed at. A `--prod` typed
 *   out of habit is exactly the mistake a per-invocation token cannot catch,
 *   because the token is the same on every deployment. Set it, run, remove it.
 *
 * The flag is the SAME one `backfillVariantFacetAndBaseRole` and
 * `backfillBrandUnknownRole` use, for the reason the latter spells out: it
 * names "this deployment is open for a `selectorOptions` backfill right now",
 * and the function path in the `convex run` command is what selects the run.
 *
 * Dry run is the DEFAULT: omit `confirm` and nothing is written whatever the
 * environment says. An armed invocation on an UNARMED deployment is REFUSED,
 * not thrown — the report still comes back, naming the flag, so the operator
 * sees what the run would have done and what to do about it in one step.
 *
 * No `--identity` flag: this is an `internalMutation`, unreachable from any
 * client, so it carries no `requireAdmin` that would need an identity to
 * satisfy — and `npx convex run --identity` cannot reach internal functions at
 * all. Reaching `--prod` requires prod deploy credentials, which is the real
 * gate. There is no TTY prompt anywhere in it: the confirm arg IS the prompt,
 * so it runs the same from a shell, from CI, or from a `!` command.
 *
 * ## No validator change, so no deploy ordering
 *
 * `variantName` has been in the `platformFacets.bsc` union since NEO-189, and
 * every row this task touches already carries a `platformData.bsc` map. It
 * adds entries to a record the schema already accepts, so a deployment running
 * either side of this ticket can read the result. Deploy and run in either
 * order.
 *
 * ## What it selects, and why that is evidence enough
 *
 * A row is a candidate when ALL of:
 *
 *   - `level === "parallel"`;
 *   - its parent is `level === "insert"` — the shape `applyParallelGroupings`'
 *     insert→parallel promotion produces, and also the shape of a parallel an
 *     operator created by hand under an insert (ParallelForm);
 *   - it has at least one BSC slot with no facet tag.
 *
 * Those slots are tagged `variantName`, and nothing else on the row moves.
 *
 * The second origin is why the dry run is not a formality. A promoted row's
 * untagged id came from the insert-level variantName fetch and IS a
 * variantName. A hand-made parallel's untagged slot came from a pre-NEO-189
 * `attachPlatformIds`, and its facet is whatever the operator pasted at the
 * time — usually a variantName, occasionally a setName slug. **Before arming,
 * read `rows[].path` and `rows[].slots` in the dry run for any parallel you
 * created by hand rather than through Group Parallels, and re-map that slot
 * through the attach dialog instead if its id is not a variantName.**
 *
 * The evidence is the same fact the promotion now records live (NEO-293,
 * `applyParallelGroupings`): BSC files a parallel of an insert as a
 * `variantName` under `variant=insert`, so the insert-level sync fetched the
 * row's BSC id from the variantName facet and stored it untagged, because at
 * `insert` the level rule (`legacyBscFacetForLevel`) already answered
 * `variantName`. The move to `parallel` silenced that rule without changing
 * the id. This task writes down what the level rule was already saying about
 * the row before it moved — it re-derives nothing from a level, a display
 * value or a marketplace string.
 *
 * ## What it refuses to touch
 *
 *   - A parallel whose parent is a `variantType` (or has no parent). That is
 *     the base-set-parallel shape: its slots, if any, sit on a different
 *     `variant` axis and `legacyBscFacetForLevel("parallel")` is silent there
 *     on purpose. Counted as `parentNotInsert`, never tagged.
 *   - A slot that already carries ANY tag. A `setName` on a parallel is an
 *     operator's split (NEO-189) and is a real setName. Left as written.
 *   - A parallel with no BSC side at all. Nothing to tag; counted.
 *
 * ## Idempotent, and it never clears a tag
 *
 * A second run reports every candidate as `already_tagged` and writes nothing.
 * Nothing here removes or rewrites a tag, so a run cannot undo an operator's
 * attach-dialog decision.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  PROMOTED_PARALLEL_BSC_FACET,
  untaggedBscSlots,
  withBscFacetTags,
} from "./bscFacets";
import { slotEntries } from "./platformSlots";

/** The string an armed run must carry. */
const CONFIRM_TOKEN = "BACKFILL";

/**
 * The deployment-level arm. Absent, an armed invocation degrades to a dry run.
 *
 * `"1"` is what the operator command above sets; `"true"` is accepted because
 * that is what `ALLOW_RESET_SET_BUILDER_DATA` uses one file over, and an
 * operator who reaches for the wrong one of two conventions should not be
 * answered with a silent no-op.
 */
const ENV_FLAG = "ALLOW_SELECTOR_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * FIXED text, naming the flag and nothing else. This is an operator-facing
 * refusal on a CLI, not reactive state, but the same discipline applies: it
 * says what to do, and it carries no row values or marketplace strings.
 */
const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the report below is what ` +
  `an armed run would have done.`;

/** What a completed run says when it did write. */
const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";

/** What a dry run says. */
const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

/**
 * The per-row list is what the operator reads to sanity-check the selection
 * before arming; a several-hundred-entry array is a payload the CLI truncates
 * rather than an answer. The COUNTS are always exact.
 */
const MAX_REPORTED = 50;

/**
 * Convex caps the documents one transaction may read (16,384 at the time of
 * writing), and blowing the cap fails the whole transaction — strictly worse
 * than reporting a short read. The scan is held well under it because it is
 * not the only read: every candidate additionally costs one parent read
 * (memoised per insert, so a dozen parallels under one insert cost one), and
 * each REPORTED row costs an ancestor walk for its path (memoised too, and
 * capped by MAX_REPORTED). `parallel` rows exist only where an operator has
 * grouped or hand-built them, so this is comfortably above a real deployment
 * today.
 *
 * ⚠️ Truncation is NOT self-healing: a re-run reads the same prefix of the same
 * index. If `truncated` comes back true, drain the deployment one variant type
 * at a time with `variantTypeId` rather than re-running the whole-level scan
 * and believing the second report.
 */
const SCAN_LIMIT = 2000;

/** Why a parallel row was left untouched. */
type SkipReason =
  /** Has BSC slots and every one already carries a tag. The steady state. */
  | "already_tagged"
  /** No BSC slots at all — nothing to tag. */
  | "no_bsc_slot"
  /**
   * The parent is not an `insert` row (a variantType, or missing). The
   * base-set-parallel shape; its untagged slots stay inert by design.
   */
  | "parent_not_insert";

type PlannedTag = {
  id: Id<"selectorOptions">;
  /** The row's existing facets, carried so the apply step needs no re-read. */
  platformFacets: Doc<"selectorOptions">["platformFacets"];
  /** The slots that will (or would) be tagged, in slot order. */
  slots: string[];
};

type Plan = {
  tag: PlannedTag[];
  skipped: Array<{ id: Id<"selectorOptions">; reason: SkipReason }>;
};

/**
 * ONE planner, shared by the dry run and the armed run.
 *
 * The two differ only in whether the writes below are applied — never in what
 * they decide. A dry run that computes its answer a second, subtly different
 * way is not a dry run of anything.
 *
 * `parentLevel` is a lookup rather than a pre-joined row so the unscoped scan
 * can skip the parent read for rows it will never tag: a parallel with no
 * untagged BSC slot is skipped on its own evidence, whoever its parent is.
 */
async function planBackfill(
  rows: readonly Doc<"selectorOptions">[],
  parentLevel: (
    parentId: Id<"selectorOptions"> | undefined,
  ) => Promise<string | undefined>,
): Promise<Plan> {
  const plan: Plan = { tag: [], skipped: [] };

  for (const row of rows) {
    // Belt for any caller that ever hands this planner a wider scan.
    if (row.level !== "parallel") continue;

    if (slotEntries(row, "bsc").length === 0) {
      plan.skipped.push({ id: row._id, reason: "no_bsc_slot" });
      continue;
    }
    const slots = untaggedBscSlots(row);
    if (slots.length === 0) {
      plan.skipped.push({ id: row._id, reason: "already_tagged" });
      continue;
    }
    if ((await parentLevel(row.parentId)) !== "insert") {
      plan.skipped.push({ id: row._id, reason: "parent_not_insert" });
      continue;
    }
    plan.tag.push({ id: row._id, platformFacets: row.platformFacets, slots });
  }

  return plan;
}

/**
 * Root→leaf display values for the report, e.g.
 * `["2026", "Bowman", "Insert", "Anime", "Anime Kanji"]`. Bounded by the
 * fixed depth of the selector tree; `seen` guards a malformed cycle.
 */
async function valuePath(
  ctx: MutationCtx,
  rowId: Id<"selectorOptions">,
  cache: Map<Id<"selectorOptions">, Doc<"selectorOptions"> | null>,
): Promise<string[]> {
  const path: string[] = [];
  const seen = new Set<Id<"selectorOptions">>();
  let cursor: Id<"selectorOptions"> | undefined = rowId;
  while (cursor && !seen.has(cursor) && seen.size < 10) {
    seen.add(cursor);
    let row = cache.get(cursor);
    if (row === undefined) {
      row = await ctx.db.get(cursor);
      cache.set(cursor, row);
    }
    if (!row) break;
    path.unshift(row.value);
    cursor = row.parentId;
  }
  return path;
}

export const run = internalMutation({
  args: {
    /**
     * `"BACKFILL"` states the intent to write. Anything else — including
     * omitting it — is a dry run. NOT sufficient on its own: the deployment
     * must also carry `ALLOW_SELECTOR_BACKFILL`.
     */
    confirm: v.optional(v.string()),
    /**
     * Optional narrowing to the parallels grouped under ONE variant type's
     * inserts. Omitted — the normal case — scans every parallel row on the
     * deployment.
     *
     * This exists for the truncation case above, and because a variant type
     * is the unit the grouping modal works in, so it is the scope an operator
     * checking one set will reach for. It narrows what is READ; it changes
     * nothing about what is decided.
     */
    variantTypeId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    /** True only when BOTH arms were present and the writes actually applied. */
    armed: v.boolean(),
    /**
     * Fixed operator text: applied, dry run, or refused-for-want-of-the-flag.
     * A refusal is reported here rather than thrown, so the report still
     * reaches the operator who asked for it.
     */
    message: v.string(),
    /** Parallel rows read. */
    scanned: v.number(),
    /** The scan hit `SCAN_LIMIT`. Re-scope by `variantTypeId`; do not just re-run. */
    truncated: v.boolean(),
    /** Rows whose slots were tagged (on a dry run: would be). */
    rowsTagged: v.number(),
    /** Slots tagged across those rows (on a dry run: would be). */
    slotsTagged: v.number(),
    /** Rows left alone, by reason. Counts are exact. */
    skippedCounts: v.object({
      alreadyTagged: v.number(),
      noBscSlot: v.number(),
      parentNotInsert: v.number(),
    }),
    /**
     * Per-row detail for the rows tagged, capped at MAX_REPORTED. `rowsTagged`
     * is the real total. `path` is root→leaf display values so the operator
     * can recognise the row without opening it.
     */
    rows: v.array(
      v.object({
        id: v.id("selectorOptions"),
        path: v.array(v.string()),
        slots: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    /** Every row read, by id — parents, ancestors, scoped inserts. */
    const cache = new Map<Id<"selectorOptions">, Doc<"selectorOptions"> | null>();
    const getCached = async (
      id: Id<"selectorOptions">,
    ): Promise<Doc<"selectorOptions"> | null> => {
      let row = cache.get(id);
      if (row === undefined) {
        row = await ctx.db.get(id);
        cache.set(id, row);
      }
      return row;
    };

    // Bounded read, asking for one row past the cap so truncation is DETECTED
    // rather than passed off as a clean result. Both branches go through an
    // index — `.filter()` on this table is the slow read the schema rules
    // forbid.
    let scanned: Doc<"selectorOptions">[];
    const variantTypeId = args.variantTypeId;
    if (variantTypeId === undefined) {
      scanned = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level", (q) => q.eq("level", "parallel"))
        .take(SCAN_LIMIT + 1);
    } else {
      // Validate the scope BEFORE any read of children or any write. The arg
      // is an unchecked `v.id("selectorOptions")`; a mistyped or wrong-level
      // id would otherwise walk an index that finds no children and return
      // `scanned: 0`, which reads exactly like a clean steady state.
      const scope = await getCached(variantTypeId);
      if (!scope || scope.level !== "variantType") {
        throw new Error("variantTypeId is not a variantType row");
      }
      // The parallels an insert→parallel promotion can produce under this
      // variant type are exactly the `parallel` children of its `insert`
      // children. A parallel filed directly under the variant type is the
      // base-set shape and is out of scope by construction here, as it is by
      // the planner's parent test on the unscoped path.
      const inserts = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", variantTypeId),
        )
        .collect();
      scanned = [];
      for (const insert of inserts) {
        cache.set(insert._id, insert);
        if (scanned.length > SCAN_LIMIT) break;
        const parallels = await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "parallel").eq("parentId", insert._id),
          )
          .take(SCAN_LIMIT + 1 - scanned.length);
        scanned.push(...parallels);
      }
    }
    const truncated = scanned.length > SCAN_LIMIT;
    const rows = truncated ? scanned.slice(0, SCAN_LIMIT) : scanned;
    for (const row of rows) cache.set(row._id, row);

    const plan = await planBackfill(rows, async (parentId) =>
      parentId ? (await getCached(parentId))?.level : undefined,
    );

    if (armed) {
      const now = Date.now();
      for (const { id, platformFacets, slots } of plan.tag) {
        await ctx.db.patch(id, {
          platformFacets: withBscFacetTags(
            platformFacets,
            slots,
            PROMOTED_PARALLEL_BSC_FACET,
          ),
          lastUpdated: now,
        });
      }
    }

    const skippedCounts = {
      alreadyTagged: plan.skipped.filter((s) => s.reason === "already_tagged")
        .length,
      noBscSlot: plan.skipped.filter((s) => s.reason === "no_bsc_slot").length,
      parentNotInsert: plan.skipped.filter(
        (s) => s.reason === "parent_not_insert",
      ).length,
    };
    const slotsTagged = plan.tag.reduce((n, t) => n + t.slots.length, 0);

    // ONE audit line. Counts and the armed flag only — no slugs, no labels, no
    // row names: this runs against production and the log is not the place for
    // marketplace text or operator content (NEO-47's rule, applied to logs).
    // There is no `userId` to record: an internalMutation reached from
    // `npx convex run` has no identity, and the deploy credential is the actor.
    console.log(
      JSON.stringify({
        msg: "backfill_promoted_parallel_facet",
        armed,
        refusedForFlag,
        scoped: variantTypeId !== undefined,
        scanned: rows.length,
        truncated,
        rowsTagged: plan.tag.length,
        slotsTagged,
        ...skippedCounts,
      }),
    );

    // Paths only for the rows that go in the report — the ancestor walk is
    // reads, and the cap bounds them.
    const reported: Array<{
      id: Id<"selectorOptions">;
      path: string[];
      slots: string[];
    }> = [];
    for (const { id, slots } of plan.tag.slice(0, MAX_REPORTED)) {
      reported.push({ id, path: await valuePath(ctx, id, cache), slots });
    }

    return {
      armed,
      message: refusedForFlag
        ? NOT_ARMED_MESSAGE
        : armed
          ? APPLIED_MESSAGE
          : DRY_RUN_MESSAGE,
      scanned: rows.length,
      truncated,
      rowsTagged: plan.tag.length,
      slotsTagged,
      skippedCounts,
      rows: reported,
    };
  },
});
