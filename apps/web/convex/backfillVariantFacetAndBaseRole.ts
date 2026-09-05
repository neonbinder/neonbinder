/**
 * NEO-239 — one-shot backfill: tag every existing `variantType` row's BSC slot
 * as the `variant` facet, and give the set's Base row the `metadata.isBase`
 * role.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillVariantFacetAndBaseRole:run '{}'
 *
 *   # 2. arm the deployment, then run for real
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillVariantFacetAndBaseRole:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # production: same three steps, with --prod
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
 * Dry run is the DEFAULT: omit `confirm` and nothing is written whatever the
 * environment says. An armed invocation on an UNARMED deployment is REFUSED,
 * not thrown — the report still comes back, naming the flag, so the operator
 * sees what the run would have done and what to do about it in one step.
 *
 * No `--identity` flag: this is an `internalMutation`, unreachable from any
 * client, so it carries no `requireAdmin` that would need an identity to
 * satisfy — and `npx convex run --identity` cannot reach internal functions at
 * all. Reaching `--prod` requires prod deploy credentials, which is the real
 * gate. Same shape as `repairSportHallOfFameQids` (NEO-235) and
 * `selectorOptions:resetSetBuilderDataFromCli`.
 *
 * ## DEPLOY THE VALIDATORS FIRST
 *
 * `platformFacets.bsc` was a two-literal union (`setName` | `variantName`) and
 * `metadata` had no `isBase`. Both are widened in `convex/schema.ts` in this
 * same ticket. Convex validates documents on READ as well as on write, so a row
 * this backfill has tagged cannot be read by a deployment running the old
 * validators. **Deploy, then run.** Rolling back after a run means rolling
 * forward again, not restoring.
 *
 * ## What it does, and what it refuses to do
 *
 * The variantType level sync stored BSC's own `variant` facet value as the
 * row's marketplace id and seeded the row's display value from the same string
 * — so on a healthy row the untagged slot id FOLDS EQUAL to the display value
 * ("base"/"Base", "insert"/"Insert"). That equality is the evidence, and it is
 * the only evidence this task will act on.
 *
 * A slot whose id does NOT fold to the row's value is the known corruption: a
 * mis-saved Base mapping wrote the parent's **setName** slug into variantType
 * rows (confirmed live in dev). Tagging one of those `variant` would send a
 * setName slug as BSC's variant axis on every checklist fetch below it. Those
 * rows are REPORTED and left exactly as they are — inert, BSC-unresolvable
 * (see `marketplaceResolvability.ts`), and waiting for an operator to re-map
 * them through the attach dialog.
 *
 * `metadata.isBase` is set from the SLOT ID folding to "base", never from the
 * display value. A row whose name is "Base" but whose slot says otherwise gets
 * no role from this task; an operator grants it with
 * `selectorOptions:setBaseVariantType`.
 *
 * ## Idempotent
 *
 * A second run reports every row as `already_tagged` / `already_has_role` and
 * writes nothing. Nothing here ever clears a tag or a role, so a run cannot
 * undo an operator's `setBaseVariantType` decision.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { slotEntries, slotFacet } from "./platformSlots";
import { selectorValueKey } from "./selectorSyncMatch";

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
 * A corrupted-slug report is a list of operator TODOs, not a data dump. Capped
 * so a deployment with thousands of bad rows returns a usable answer instead of
 * a payload the CLI truncates; the count is always exact.
 */
const MAX_REPORTED = 50;

/** Why a row (or one of its slots) was left untouched. */
type SkipReason =
  /** Already carries the `variant` tag. The steady state after a run. */
  | "already_tagged"
  /** No BSC slots at all — nothing to tag. Attach an id to link this row. */
  | "no_bsc_slot"
  /**
   * The slot id does not fold to the row's display value. This is the mis-saved
   * BaseSetPicker corruption. NOT tagged, NOT guessed — reported.
   */
  | "slug_does_not_match_value";

type Plan = {
  /** Slots to tag `variant`, with the row they sit on. */
  tag: Array<{ id: Id<"selectorOptions">; value: string; slot: string }>;
  /** Rows to grant `metadata.isBase`. */
  role: Array<{ id: Id<"selectorOptions">; value: string }>;
  /** Everything left alone, with the reason. Capped in the RETURN, not here. */
  skipped: Array<{ id: Id<"selectorOptions">; value: string; reason: SkipReason }>;
};

/**
 * ONE planner, shared by the dry run and the armed run.
 *
 * The two differ only in whether the writes below are applied — never in what
 * they decide. A dry run that computes its answer a second, subtly different
 * way is not a dry run of anything.
 */
function planBackfill(rows: readonly Doc<"selectorOptions">[]): Plan {
  const plan: Plan = { tag: [], role: [], skipped: [] };

  for (const row of rows) {
    if (row.level !== "variantType") continue;

    const valueKey = selectorValueKey(row.value);
    const slots = slotEntries(row, "bsc");
    if (slots.length === 0) {
      plan.skipped.push({ id: row._id, value: row.value, reason: "no_bsc_slot" });
      continue;
    }

    let addedTag = false;
    let hadVariantTag = false;
    let corrupted = false;
    /** Ids that WILL carry the `variant` facet once this run is applied. */
    const variantIds: string[] = [];

    for (const { slot, id } of slots) {
      const existing = slotFacet(row, "bsc", slot);
      if (existing !== undefined) {
        // Any tag at all is a deliberate operator/sync decision and is never
        // overwritten — including a `setName` tag on a Base row holding a
        // series split (NEO-189's motivating case), which genuinely IS a
        // setName slot.
        if (existing === "variant") {
          hadVariantTag = true;
          variantIds.push(id);
        }
        continue;
      }
      if (selectorValueKey(id) !== valueKey) {
        corrupted = true; // the mis-saved setName slug — reported, not tagged
        continue;
      }
      plan.tag.push({ id: row._id, value: row.value, slot });
      addedTag = true;
      variantIds.push(id);
    }

    // At most one skip line per row, so the counts read as "rows", not "slots".
    if (corrupted) {
      plan.skipped.push({
        id: row._id,
        value: row.value,
        reason: "slug_does_not_match_value",
      });
    } else if (!addedTag && hadVariantTag) {
      plan.skipped.push({
        id: row._id,
        value: row.value,
        reason: "already_tagged",
      });
    }

    // The role comes from the SLOT ID, never the display value. A row already
    // carrying `isBase` (true OR false) keeps it: an operator may have made
    // that call through `setBaseVariantType`.
    if (
      row.metadata?.isBase === undefined &&
      variantIds.some((id) => selectorValueKey(id) === "base")
    ) {
      plan.role.push({ id: row._id, value: row.value });
    }
  }

  return plan;
}

export const run = internalMutation({
  args: {
    /**
     * `"BACKFILL"` states the intent to write. Anything else — including
     * omitting it — is a dry run. NOT sufficient on its own: the deployment
     * must also carry `ALLOW_SELECTOR_BACKFILL`.
     */
    confirm: v.optional(v.string()),
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
    scanned: v.number(),
    truncated: v.boolean(),
    tagged: v.number(),
    rolesSet: v.number(),
    /** Rows left alone, by reason. Counts are exact. */
    skippedCounts: v.object({
      alreadyTagged: v.number(),
      noBscSlot: v.number(),
      slugDoesNotMatchValue: v.number(),
    }),
    /**
     * The corrupted rows an operator has to re-map by hand, capped at
     * MAX_REPORTED. `skippedCounts.slugDoesNotMatchValue` is the real total.
     */
    needsRemapping: v.array(
      v.object({
        id: v.id("selectorOptions"),
        value: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    // Bounded read. `variantType` rows are a handful per set; the cap is one
    // order of magnitude above any plausible deployment, and asking for one
    // row past it is how truncation is detected rather than passed off as a
    // clean result.
    const SCAN_LIMIT = 20000;
    const scanned = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "variantType"))
      .take(SCAN_LIMIT + 1);
    const truncated = scanned.length > SCAN_LIMIT;
    const rows = truncated ? scanned.slice(0, SCAN_LIMIT) : scanned;

    const plan = planBackfill(rows);

    if (armed) {
      // Group the tags per row so a row with two untagged slots is one patch.
      const tagsByRow = new Map<Id<"selectorOptions">, string[]>();
      for (const t of plan.tag) {
        const slots = tagsByRow.get(t.id);
        if (slots) slots.push(t.slot);
        else tagsByRow.set(t.id, [t.slot]);
      }
      const roleRows = new Set(plan.role.map((r) => r.id));

      for (const rowId of new Set([...tagsByRow.keys(), ...roleRows])) {
        const row = await ctx.db.get(rowId);
        if (!row) continue;
        const patch: {
          platformFacets?: Doc<"selectorOptions">["platformFacets"];
          metadata?: Doc<"selectorOptions">["metadata"];
          lastUpdated: number;
        } = { lastUpdated: Date.now() };

        const slots = tagsByRow.get(rowId);
        if (slots?.length) {
          patch.platformFacets = {
            ...(row.platformFacets ?? {}),
            bsc: {
              ...(row.platformFacets?.bsc ?? {}),
              ...Object.fromEntries(slots.map((s) => [s, "variant" as const])),
            },
          };
        }
        if (roleRows.has(rowId)) {
          patch.metadata = { ...(row.metadata ?? {}), isBase: true };
        }
        await ctx.db.patch(rowId, patch);
      }
    }

    const skippedCounts = {
      alreadyTagged: plan.skipped.filter((s) => s.reason === "already_tagged")
        .length,
      noBscSlot: plan.skipped.filter((s) => s.reason === "no_bsc_slot").length,
      slugDoesNotMatchValue: plan.skipped.filter(
        (s) => s.reason === "slug_does_not_match_value",
      ).length,
    };

    // ONE audit line. Counts and the armed flag only — no slugs, no labels, no
    // row names: this runs against production and the log is not the place for
    // marketplace text or operator content (NEO-47's rule, applied to logs).
    // There is no `userId` to record: an internalMutation reached from
    // `npx convex run` has no identity, and the deploy credential is the actor.
    console.log(
      JSON.stringify({
        msg: "backfill_variant_facet_and_base_role",
        armed,
        refusedForFlag,
        scanned: rows.length,
        truncated,
        tagged: plan.tag.length,
        rolesSet: plan.role.length,
        ...skippedCounts,
      }),
    );

    return {
      armed,
      message: refusedForFlag
        ? NOT_ARMED_MESSAGE
        : armed
          ? APPLIED_MESSAGE
          : DRY_RUN_MESSAGE,
      scanned: rows.length,
      truncated,
      tagged: plan.tag.length,
      rolesSet: plan.role.length,
      skippedCounts,
      needsRemapping: plan.skipped
        .filter((s) => s.reason === "slug_does_not_match_value")
        .slice(0, MAX_REPORTED)
        .map(({ id, value }) => ({ id, value })),
    };
  },
});
