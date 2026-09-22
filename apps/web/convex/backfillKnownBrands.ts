/**
 * NEO-294 — the one-shot backfill that applies the KNOWN BRANDS list to the
 * sets already sitting in every year's Unknown bucket.
 *
 * Sync Sets files a matching set under its known brand from now on, but only
 * for sets a marketplace returns on that run. On dev, 2026-09-22, 955 sets
 * were already under Unknown across the synced years, ~700 of them claimed
 * by this list. This sweeps them in one pass: for each year's Unknown row,
 * every set whose NB name matches a known brand gets that brand created (if
 * the year has not got one) and is RE-HOMED to it with the shared NB
 * operation — same `_id`, same subtree, same marketplace links, both
 * `children` caches updated, `features.manufacturer` following the new
 * parent (`brandRehome.ts`). Nothing is deleted and nothing is renamed.
 *
 * Three rows are left exactly where they are, each counted:
 *
 *   • one an OPERATOR placed (`metadata.brandSetByOperator`) — their
 *     decision outlives every automatic path, this one included;
 *   • one whose name already exists under the target brand (the NEO-219
 *     sibling-fold rule: two same-named sets under one parent is a question
 *     about which is which, and a migration must not answer it);
 *   • one whose known brand's name is worn by the year's FLAGGED row (an
 *     operator renamed Unknown to it), where there is no brand row to move
 *     to and creating a second row of that name is refused.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillKnownBrands:run '{}'
 *
 *   # 2. arm the deployment, then run for real
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillKnownBrands:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # production: same three steps, with --prod
 *
 * The same two independent arms as `backfillBrandPrefixAndUnknownName`, and
 * the same shared `ALLOW_SELECTOR_BACKFILL` flag rather than a new name to
 * get wrong: `confirm` is per-invocation intent, the env flag is
 * per-deployment. Dry run is the DEFAULT; an armed invocation on an unarmed
 * deployment is REFUSED with the report, not thrown. No `--identity` — an
 * internal function, the deploy credential is the gate.
 *
 * ## The read and write budget
 *
 * A year with thousands of sets must not blow one transaction, so this is
 * bounded the way `buildSetNameIndex` is: ONE running budget of
 * `MAX_YEAR_SET_ROWS` set-row reads across the whole run (the year's Unknown
 * bucket plus each target brand's existing sets, read once per brand for the
 * clash check), and at most `MAX_MOVES_PER_RUN` moves. Hitting either sets
 * `truncated` and the run stops planning — it does not silently do half a
 * year without saying so.
 *
 * UNLIKE NEO-237's backfill, truncation here IS self-healing: every row this
 * run moves leaves the Unknown bucket, so the next run reads further into
 * what is left. "Re-run until `truncated` comes back false, then once more
 * to see the steady state" is the whole recovery procedure; `parentId`
 * (one year at a time) is there for the operator who would rather go year by
 * year.
 *
 * ## Idempotent
 *
 * A second run over a swept deployment reports every remaining row as
 * `no_match` (or one of the three skips) and writes nothing: the rows it
 * moved are no longer under Unknown, and `ensureBrandRowForName` finds the
 * brands it created rather than minting second ones.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { selectorValueKey } from "./selectorSyncMatch";
import { matchKnownBrand } from "./knownBrands";
import { ensureBrandRowForName, rehomeSetRowsToBrand } from "./brandRehome";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";

/** The string an armed run must carry. */
const CONFIRM_TOKEN = "BACKFILL";

/** The deployment-level arm — shared with the other selector backfills. */
const ENV_FLAG = "ALLOW_SELECTOR_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the report below is what ` +
  `an armed run would have done.`;

const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";

const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

const TRUNCATED_SUFFIX =
  ` The run hit its read or move bound and did not reach every row — ` +
  `re-run (rows it moved have left the Unknown bucket, so the next run ` +
  `reaches further), or narrow it with {"parentId":"<yearId>"}.`;

/** Per-row detail is capped for the CLI's sake; the counts are exact. */
const MAX_REPORTED = 50;

/**
 * One transaction's manufacturer-row scan — the same bound and the same
 * escape hatch as `backfillBrandPrefixAndUnknownName`.
 */
const SCAN_LIMIT = 4000;

/**
 * Moves per run. Each is a row patch plus two `children` patches, so this is
 * a WRITE bound, not a read one. Self-healing: see the header.
 */
const MAX_MOVES_PER_RUN = 500;

type RowAction =
  /** Matched a known brand and was (or would be) re-homed to it. */
  | "moved"
  /** The target brand already has a set folding to this name. Left alone. */
  | "clash_at_target"
  /** An operator placed this row (`brandSetByOperator`). Left alone. */
  | "operator_placed"
  /** No known brand claims this name. The steady state for most rows. */
  | "no_match"
  /** The year's FLAGGED row wears the brand's name; there is nowhere to move to. */
  | "brand_unavailable";

type PlannedRow = {
  id: Id<"selectorOptions">;
  value: string;
  action: RowAction;
  /** The known brand that claimed it, on the actions where one did. */
  brand?: string;
};

const actionValidator = v.union(
  v.literal("moved"),
  v.literal("clash_at_target"),
  v.literal("operator_placed"),
  v.literal("no_match"),
  v.literal("brand_unavailable"),
);

/** Report order: the interesting rows first, so the cap never hides them. */
const REPORT_ORDER: Record<RowAction, number> = {
  moved: 0,
  clash_at_target: 1,
  brand_unavailable: 2,
  operator_placed: 3,
  no_match: 4,
};

export const run = internalMutation({
  args: {
    /** `"BACKFILL"` states the intent to write. Anything else is a dry run. */
    confirm: v.optional(v.string()),
    /** Optional narrowing to ONE year's manufacturers — the bound's escape hatch. */
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    /** Manufacturer rows scanned (the Unknown rows among them are the work). */
    scanned: v.number(),
    /** Set rows read, against the `MAX_YEAR_SET_ROWS` budget. */
    setRowsRead: v.number(),
    truncated: v.boolean(),
    counts: v.object({
      /** Brands minted from the known list. 0 on a dry run — nothing is written. */
      brandsCreated: v.number(),
      moved: v.number(),
      clashAtTarget: v.number(),
      operatorPlaced: v.number(),
      noMatch: v.number(),
      brandUnavailable: v.number(),
    }),
    rows: v.array(
      v.object({
        id: v.id("selectorOptions"),
        value: v.string(),
        action: actionValidator,
        brand: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    const parentId = args.parentId;
    const scannedRows = await (parentId === undefined
      ? ctx.db
          .query("selectorOptions")
          .withIndex("by_level", (q) => q.eq("level", "manufacturer"))
      : ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "manufacturer").eq("parentId", parentId),
          )
    ).take(SCAN_LIMIT + 1);
    let truncated = scannedRows.length > SCAN_LIMIT;
    const manufacturers = truncated
      ? scannedRows.slice(0, SCAN_LIMIT)
      : scannedRows;

    // Group by year, so a brand's existing row is found without a second
    // read — the clash check needs the year's other manufacturers anyway.
    const byYear = new Map<string, Doc<"selectorOptions">[]>();
    for (const row of manufacturers) {
      if (!row.parentId) continue;
      const list = byYear.get(row.parentId);
      if (list) list.push(row);
      else byYear.set(row.parentId, [row]);
    }

    // ONE running budget across the whole run, `buildSetNameIndex`'s rule.
    let setRowsRead = 0;
    /**
     * NEO-294 (audit condition 4) — a `setsUnder` call came back SHORT, so
     * every later one is blind: it returns `[]` whether the parent has no
     * sets or the budget is simply gone. An empty answer cannot be told from
     * a complete one, and treating it as complete would plan rows as `moved`
     * with no clash check behind them — in the DRY RUN an operator reads
     * before arming prod. Planning stops instead; `truncated` says so and
     * the re-run reaches further.
     */
    let setReadsExhausted = false;
    const setsUnder = async (
      parent: Id<"selectorOptions">,
    ): Promise<Doc<"selectorOptions">[]> => {
      const remaining = MAX_YEAR_SET_ROWS - setRowsRead;
      if (remaining <= 0) {
        truncated = true;
        setReadsExhausted = true;
        return [];
      }
      const rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "setName").eq("parentId", parent),
        )
        .take(remaining + 1);
      if (rows.length > remaining) {
        truncated = true;
        setReadsExhausted = true;
      }
      const kept = rows.slice(0, remaining);
      setRowsRead += kept.length;
      return kept;
    };

    const plan: PlannedRow[] = [];
    /** Per year, per target brand: the rows to move and the names taken. */
    type Target = {
      brand: string;
      yearId: Id<"selectorOptions">;
      existingId?: Id<"selectorOptions">;
      rows: Doc<"selectorOptions">[];
    };
    const targets: Target[] = [];
    let plannedMoves = 0;

    for (const [yearKey, siblings] of byYear) {
      const unknown = siblings.find((m) => m.metadata?.isBrandUnknown === true);
      if (!unknown) continue;
      const yearId = yearKey as Id<"selectorOptions">;
      const sets = await setsUnder(unknown._id);
      if (truncated && sets.length === 0) break;

      // The year's manufacturers by folded name, for "does this brand exist
      // already, and is the row a usable one?".
      const byName = new Map<string, Doc<"selectorOptions">>();
      for (const m of siblings) byName.set(selectorValueKey(m.value), m);
      /** Target-brand key → the names already taken under it, grown as rows land. */
      const takenByBrand = new Map<string, Set<string>>();
      const targetByBrand = new Map<string, Target>();

      for (const row of sets) {
        if (row.metadata?.brandSetByOperator === true) {
          plan.push({ id: row._id, value: row.value, action: "operator_placed" });
          continue;
        }
        const brand = matchKnownBrand(row.value);
        if (brand === undefined) {
          plan.push({ id: row._id, value: row.value, action: "no_match" });
          continue;
        }
        const brandKey = selectorValueKey(brand);
        const existing = byName.get(brandKey);
        if (existing && existing.metadata?.isBrandUnknown === true) {
          // The flagged row itself wears the brand's name. `ensureBrandRow`
          // would refuse, and so does this.
          plan.push({
            id: row._id,
            value: row.value,
            action: "brand_unavailable",
            brand,
          });
          continue;
        }
        if (plannedMoves >= MAX_MOVES_PER_RUN) {
          truncated = true;
          break;
        }

        let taken = takenByBrand.get(brandKey);
        if (!taken) {
          // Read the target's sets ONCE per brand, for the NEO-219 fold.
          const existingSets = existing ? await setsUnder(existing._id) : [];
          // NEO-294 (audit condition 4) — that read came back short (or not
          // at all), so this brand's taken-names set is a guess. A guess
          // plans `moved` for rows that may clash, which is a promise the
          // armed run cannot keep: stop planning the year, exactly as the
          // year's own truncated read does above. A brand with NO row yet
          // (`existing` undefined) reads nothing and is unaffected.
          if (existing && setReadsExhausted) break;
          taken = new Set(existingSets.map((r) => selectorValueKey(r.value)));
          takenByBrand.set(brandKey, taken);
        }
        const key = selectorValueKey(row.value);
        if (taken.has(key)) {
          plan.push({
            id: row._id,
            value: row.value,
            action: "clash_at_target",
            brand,
          });
          continue;
        }
        taken.add(key);

        let target = targetByBrand.get(brandKey);
        if (!target) {
          target = {
            brand,
            yearId,
            ...(existing ? { existingId: existing._id } : {}),
            rows: [],
          };
          targetByBrand.set(brandKey, target);
          targets.push(target);
        }
        target.rows.push(row);
        plannedMoves++;
        plan.push({ id: row._id, value: row.value, action: "moved", brand });
      }
      if (truncated) break;
    }

    let brandsCreated = 0;
    let actuallyMoved = 0;
    let actualClashes = 0;
    if (armed) {
      for (const target of targets) {
        const ensured = await ensureBrandRowForName(ctx, {
          yearId: target.yearId,
          name: target.brand,
        });
        if (ensured.id === null) {
          // Cannot happen — a flagged row wearing the name was planned as
          // `brand_unavailable` above — but a refusal is never a write.
          continue;
        }
        if (ensured.created) brandsCreated++;
        const result = await rehomeSetRowsToBrand(ctx, {
          rows: target.rows,
          brandId: ensured.id,
        });
        actuallyMoved += result.rehomed;
        actualClashes += result.clashes;
      }
    }

    const counts = {
      brandsCreated,
      moved: plan.filter((r) => r.action === "moved").length,
      clashAtTarget: plan.filter((r) => r.action === "clash_at_target").length,
      operatorPlaced: plan.filter((r) => r.action === "operator_placed").length,
      noMatch: plan.filter((r) => r.action === "no_match").length,
      brandUnavailable: plan.filter((r) => r.action === "brand_unavailable")
        .length,
    };

    // ONE audit line. Counts and the armed flag only — no row values and no
    // brand names (NEO-47's rule, applied to logs); no `userId`, because an
    // internalMutation reached from `npx convex run` has no identity and the
    // deploy credential is the actor. `applied*` are the mover's OWN numbers,
    // beside the plan's: a divergence would mean the plan and the
    // in-transaction fold disagreed, which is worth seeing.
    console.log(
      JSON.stringify({
        msg: "backfill_known_brands",
        armed,
        refusedForFlag,
        scoped: parentId !== undefined,
        scanned: manufacturers.length,
        setRowsRead,
        truncated,
        ...counts,
        appliedMoved: actuallyMoved,
        appliedClashes: actualClashes,
      }),
    );

    const reported = [...plan]
      .sort((a, b) => REPORT_ORDER[a.action] - REPORT_ORDER[b.action])
      .slice(0, MAX_REPORTED)
      .map(({ id, value, action, brand }) => ({
        id,
        value,
        action,
        ...(brand !== undefined ? { brand } : {}),
      }));

    const base = refusedForFlag
      ? NOT_ARMED_MESSAGE
      : armed
        ? APPLIED_MESSAGE
        : DRY_RUN_MESSAGE;

    return {
      armed,
      message: truncated ? base + TRUNCATED_SUFFIX : base,
      scanned: manufacturers.length,
      setRowsRead,
      truncated,
      counts,
      rows: reported,
    };
  },
});
