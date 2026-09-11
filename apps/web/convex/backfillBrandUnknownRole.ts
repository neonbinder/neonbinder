/**
 * NEO-272 — one-shot backfill: give the existing "All Brands" manufacturer
 * rows the `metadata.isBrandUnknown` NB role, so the listing-title composer
 * can drop them from a generated title by reading a flag instead of comparing
 * a display value.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillBrandUnknownRole:run '{}'
 *
 *   # 2. arm the deployment, then run for real
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillBrandUnknownRole:run '{"confirm":"BACKFILL"}'
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
 * The flag is the SAME one `backfillVariantFacetAndBaseRole` uses, deliberately
 * and not by inertia. It names what it protects — "this deployment is open for
 * a `selectorOptions` backfill right now" — and both tasks are exactly that:
 * one operator, one table, one armed window that is opened and closed around a
 * single command. A second flag would not separate the two runs, because the
 * thing that selects a run is the function path in the `convex run` command,
 * not the environment; it would only add a name to get wrong. If a future
 * backfill ever needs to be armable while THIS one is not, that is the moment
 * to split the flag — not before.
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
 * gate. Same shape as `backfillVariantFacetAndBaseRole` (NEO-239) and
 * `selectorOptions:resetSetBuilderDataFromCli`.
 *
 * ## DEPLOY THE VALIDATORS FIRST
 *
 * Yes, the hazard applies here too, and "purely additive" is why it is easy to
 * talk yourself out of it. `metadata` is `v.optional(v.object(...))` and a
 * Convex object validator is EXACT — a document carrying a field the validator
 * does not list fails validation, and Convex validates on READ as well as on
 * write. Additive describes the SCHEMA (the new validators still accept every
 * old row, so the schema deploys with no backfill in front of it); it does not
 * describe the DOCUMENT. The moment this task writes `isBrandUnknown` onto
 * a row, that row is unreadable by any deployment whose `metadata` validator
 * predates the field — which is every set-selector query in the app.
 *
 * So: **deploy `convex/schema.ts` with `isBrandUnknown`, then run.** And
 * rolling back after a run means rolling FORWARD again, not restoring: a
 * deploy that reverts the validator cannot read the rows this task tagged.
 *
 * ## What "All Brands" is, and why the name match is allowed HERE
 *
 * "All Brands" is NOT a brand and never was. It is the marketplace's no-filter
 * option on its brand axis — "show all cards from all brands" — and NB carries
 * it as a `manufacturer` row because the brand axis is where the marketplace
 * offers it.
 *
 * It matters here because of what ends up underneath it.
 * `syncSetsAcrossManufacturers` is BSC-only: BSC has no manufacturer axis, so
 * NB's Manufacturer rows come from SportLots and BSC's flat set list is
 * bucketed under them by name prefix. Every BSC set that prefix-matches no
 * manufacturer is filed under the "All Brands" row — the minor-league, junior,
 * college and team sets. Those are the sets whose brand NB has not identified
 * YET; they are expected to acquire real brands, so this is a current data
 * state and not a category. `isBrandUnknown` records the part the row plays
 * while they have not.
 *
 * And it is why the name must never reach a listing title: a row whose name
 * means "show everything" says nothing about any card beneath it, so composing
 * it into a title is meaningless text in a buyer-facing field — which also
 * spends 11 of an 80-character budget.
 *
 * The ticket is explicit about the split, and so is the product invariant:
 * **the one-time migration may match by name; the runtime path never may.**
 * Runtime reads `metadata.isBrandUnknown`, an NB flag on an NB row, so it is
 * free of both the operator's rename and — the sharper point — of a
 * marketplace filter label NB does not own. A runtime name comparison would be
 * NB behaviour keyed on a marketplace value, exactly the forward dependency
 * product invariant 4 (CLAUDE.md) forbids. This file is the single place the
 * literal is allowed to decide anything, and it runs once.
 *
 * (The field is `isBrandUnknown`, not anything spelled "placeholder", because
 * this repo already spends that word on the unrelated placeholder-CARD upload
 * pipeline — `placeholderJobs`, `convex/placeholderPipeline.ts`.)
 *
 * The fold is `selectorValueKey` — the project's one normaliser — and that is
 * not merely tidier than a hand-rolled `toLowerCase().trim()`: it is the
 * IDENTICAL fold `syncSetsAcrossManufacturers` applies when it looks for an
 * existing row to adopt (`norm === "all brands"`). Using the same fold is what
 * makes it impossible for this task and the runtime row-selection to disagree
 * about which row is which.
 *
 * ## Is there an "All Brands" manufacturer that must NOT get the role? No.
 *
 * Some of these rows are marketplace-supplied rather than minted by NB and
 * carry a SportLots id: SportLots' own hockey brand list offers "All Brands" as
 * its no-filter option (measured on PR #242's preview, 2026-09-07; see the
 * comments in `.maestro/flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml`
 * and `.maestro/SET-REGISTRY.md`). That is the NORMAL case, not a curiosity —
 * the row is the marketplace's filter option, so of course the marketplace
 * supplies it. **Those rows still get the role, and that is correct, not a bug
 * to fix later.** NB's runtime already files brand-unknown sets under whichever
 * such row the year has: `syncSetsAcrossManufacturers` looks for a manufacturer
 * folding to "all brands" and mints one only if none exists, so a
 * marketplace-supplied row and an NB-minted one are the same row playing the
 * same part. Treating them differently would be the "custom vs not" distinction
 * the product invariant says does not exist. Do not "correct" this by excluding
 * rows with a SportLots id.
 *
 * The other candidates, and why none of them is one:
 *   - Rows at another level named "All Brands" — a setName, say. Out of scope
 *     by construction: only `level: "manufacturer"` is scanned.
 *   - A genuine card manufacturer named "All Brands". There is none, and the
 *     question is moot regardless: `syncSetsAcrossManufacturers` would already
 *     have adopted such a row and filed its unmatched sets under it, so NB's
 *     runtime behaviour already treats the sets beneath it as brand-unknown.
 *     This task records the role NB is already acting on; it does not invent a
 *     claim.
 *   - A row an operator has already ruled on. Left alone — see below.
 *
 * ## What it will NOT find
 *
 * An "All Brands" row an operator RENAMED before this ran. The name is the only
 * evidence a one-shot migration has, and after a rename there is none; such a
 * row is skipped silently as a row whose brand is known. The fix is to set
 * `metadata.isBrandUnknown` on that row directly — which is the same door
 * every operator decision on this field goes through, and the reason the next
 * paragraph exists.
 *
 * ## Idempotent, and it never clears a role
 *
 * A row that ALREADY carries `isBrandUnknown` — `true` OR `false` — keeps
 * exactly what it has. `false` is a deliberate operator decision ("this really
 * is a brand, leave it in my titles"), and re-deriving the role from the name
 * on every run would undo that answer the next time anybody ran the command.
 * Same reasoning `backfillVariantFacetAndBaseRole` applies to `isBase`.
 *
 * A second run therefore reports every row as `already_has_role` and writes
 * nothing.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
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
 * The row's name as NB mints it, folded through the project's ONE normaliser —
 * the same fold `syncSetsAcrossManufacturers` uses to find a row to adopt.
 *
 * This literal is the whole of the name matching in this file, it decides
 * nothing at runtime, and it exists only until this task has been run once on
 * each deployment.
 */
const ALL_BRANDS_VALUE_KEY = selectorValueKey("All Brands");

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
 * There is one "All Brands" row per YEAR per SPORT — it is created under a
 * `year` parent by `syncSetsAcrossManufacturers`, so a deployment with a
 * century of synced hockey years has a century of these rows, not one. The
 * per-row list is therefore capped: an operator reads it to sanity-check the
 * match, and a several-hundred-entry array is a payload the CLI truncates
 * rather than an answer. The COUNTS are always exact.
 */
const MAX_REPORTED = 50;

/**
 * The per-mutation read budget in this repo's notes is ~4096 documents
 * (`backfillCardFeatures.ts`), and blowing it fails the whole transaction —
 * strictly worse than reporting a short read. Manufacturer rows exist only
 * under years an operator has actually synced (~18 brands per synced year per
 * sport), so this is comfortably above a real deployment today.
 *
 * ⚠️ Truncation is NOT self-healing: a re-run reads the same prefix of the same
 * index and would grant the same rows again. If `truncated` comes back true,
 * drain the deployment a year at a time with `parentId` rather than re-running
 * the whole-level scan and believing the second report.
 */
const SCAN_LIMIT = 4000;

/** What this task did to a candidate row, or why it did not. */
type RowAction =
  /** Gets (or, on a dry run, would get) `isBrandUnknown: true`. */
  | "granted"
  /**
   * Already carries the flag — `true` or `false`. `false` is an operator's
   * "this really is a brand"; neither is overwritten. The steady state after
   * a run.
   */
  | "already_has_role";

type PlannedRow = {
  id: Id<"selectorOptions">;
  value: string;
  action: RowAction;
  /**
   * The row's existing `metadata`, carried from the scan so the apply step
   * needs no second read. Within one Convex transaction a re-`get` cannot
   * return anything the scan did not already see, and the reads it would cost
   * come out of the same budget `SCAN_LIMIT` is sized against.
   */
  metadata: Doc<"selectorOptions">["metadata"];
};

type Plan = {
  /** Candidate rows, in scan order. Capped in the RETURN, not here. */
  rows: PlannedRow[];
  /** Manufacturer rows naming a brand NB knows. Counted, never listed. */
  brandKnown: number;
};

/**
 * ONE planner, shared by the dry run and the armed run.
 *
 * The two differ only in whether the writes below are applied — never in what
 * they decide. A dry run that computes its answer a second, subtly different
 * way is not a dry run of anything.
 */
function planBackfill(rows: readonly Doc<"selectorOptions">[]): Plan {
  const plan: Plan = { rows: [], brandKnown: 0 };

  for (const row of rows) {
    // Belt for the `parentId` path, which reaches the table through an index
    // that is keyed on level anyway — and the honest guard for any caller that
    // ever hands this planner a wider scan.
    if (row.level !== "manufacturer") continue;

    if (selectorValueKey(row.value) !== ALL_BRANDS_VALUE_KEY) {
      // A row naming a brand NB knows. Not reported per row: a listing-title
      // fix has no business emitting the whole manufacturer catalogue.
      plan.brandKnown++;
      continue;
    }

    plan.rows.push({
      id: row._id,
      value: row.value,
      action:
        row.metadata?.isBrandUnknown === undefined
          ? "granted"
          : "already_has_role",
      metadata: row.metadata,
    });
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
    /**
     * Optional narrowing to ONE year's manufacturers. Omitted — the normal
     * case — scans every manufacturer row on the deployment.
     *
     * This exists for the truncation case above, and only for it: a `year` row
     * is the manufacturer level's parent, so draining year by year is a
     * bounded, index-backed way to finish a deployment too large for one
     * transaction. It narrows what is READ; it changes nothing about what is
     * decided.
     */
    parentId: v.optional(v.id("selectorOptions")),
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
    /** Manufacturer rows read. */
    scanned: v.number(),
    /** The scan hit `SCAN_LIMIT`. Re-scope by `parentId`; do not just re-run. */
    truncated: v.boolean(),
    /** Rows granted the role (on a dry run: rows that would be). */
    granted: v.number(),
    /** Rows left alone, by reason. Counts are exact. */
    skippedCounts: v.object({
      alreadyHasRole: v.number(),
      brandKnown: v.number(),
    }),
    /**
     * Per-row detail for the "All Brands" rows only, capped at MAX_REPORTED.
     * `granted` and `skippedCounts.alreadyHasRole` are the real totals.
     */
    rows: v.array(
      v.object({
        id: v.id("selectorOptions"),
        value: v.string(),
        action: v.union(v.literal("granted"), v.literal("already_has_role")),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    // Bounded read, asking for one row past the cap so truncation is DETECTED
    // rather than passed off as a clean result. Both branches go through an
    // index — `.filter()` on a table this size is the slow read the schema
    // rules forbid.
    const parentId = args.parentId;
    const scanned = await (parentId === undefined
      ? ctx.db
          .query("selectorOptions")
          .withIndex("by_level", (q) => q.eq("level", "manufacturer"))
      : ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "manufacturer").eq("parentId", parentId),
          )
    ).take(SCAN_LIMIT + 1);
    const truncated = scanned.length > SCAN_LIMIT;
    const rows = truncated ? scanned.slice(0, SCAN_LIMIT) : scanned;

    const plan = planBackfill(rows);
    const toGrant = plan.rows.filter((r) => r.action === "granted");

    if (armed) {
      for (const row of toGrant) {
        // Spread the existing metadata: `cardNumberPrefix`, `isInsert` and the
        // rest of the object are none of this task's business, and a bare
        // `{ isBrandUnknown: true }` patch would drop them.
        await ctx.db.patch(row.id, {
          metadata: { ...(row.metadata ?? {}), isBrandUnknown: true },
          lastUpdated: Date.now(),
        });
      }
    }

    const skippedCounts = {
      alreadyHasRole: plan.rows.length - toGrant.length,
      brandKnown: plan.brandKnown,
    };

    // ONE audit line. Counts and the armed flag only — no row values, no
    // marketplace strings: this runs against production and the log is not the
    // place for operator content (NEO-47's rule, applied to logs). There is no
    // `userId` to record: an internalMutation reached from `npx convex run` has
    // no identity, and the deploy credential is the actor.
    console.log(
      JSON.stringify({
        msg: "backfill_brand_unknown_role",
        armed,
        refusedForFlag,
        scoped: parentId !== undefined,
        scanned: rows.length,
        truncated,
        granted: toGrant.length,
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
      granted: toGrant.length,
      skippedCounts,
      rows: plan.rows
        .slice(0, MAX_REPORTED)
        .map(({ id, value, action }) => ({ id, value, action })),
    };
  },
});
