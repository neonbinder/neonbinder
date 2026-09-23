/**
 * NEO-237 — one-shot backfill over every `manufacturer` row, two passes in
 * one scan:
 *
 *   1. the flagged brand-unknown row (`metadata.isBrandUnknown`) still named
 *      "All Brands" is renamed to "Unknown" — "All Brands" is now the VIEW
 *      pinned at the top of the Manufacturers column, and a row wearing the
 *      view's name in the same column is what this ticket removes. The rename
 *      goes through `planValueRename`, the one validated rename, so `features`
 *      re-derive and a sibling already called "Unknown" is a reported clash,
 *      not a duplicate. The flagged row also loses `features.manufacturer`:
 *      NEO-272 already treats its manufacturer as ABSENT in titles, and the
 *      snapshot on the row should say the same (row-level only; committed
 *      cards are not rewritten).
 *   2. every UNFLAGGED row lacking `metadata.setNamePrefix` gets one equal to
 *      its display value — the default every creation path writes from now on
 *      (`storeSelectorOptions`, `addCustomSelectorOption`). A row lacking the
 *      field buckets no BSC set and narrows nothing, so until this runs a
 *      synced year's brands claim nothing on the next Sync Sets.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillBrandPrefixAndUnknownName:run '{}'
 *
 *   # 2. arm the deployment, then run for real
 *   npx convex env set ALLOW_SELECTOR_BACKFILL 1
 *   npx convex run backfillBrandPrefixAndUnknownName:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_SELECTOR_BACKFILL
 *
 *   # production: same three steps, with --prod
 *
 * Same two independent arms as `backfillBrandUnknownRole` and for the same
 * reasons (read that file's header): `confirm` is per-invocation intent,
 * `ALLOW_SELECTOR_BACKFILL` is per-deployment, and the flag is the shared
 * "this deployment is open for a `selectorOptions` backfill" switch rather
 * than a new name to get wrong. Dry run is the DEFAULT; an armed invocation
 * on an unarmed deployment is REFUSED with the report, not thrown. No
 * `--identity` — internal function, the deploy credential is the gate.
 *
 * ## Deploy first; then roll FORWARD only
 *
 * No preview-schema hazard on the way in: `setNamePrefix` is an additive
 * optional field and nothing is removed, so the schema deploys with no
 * backfill in front of it. The hazard is on the way OUT, and it is larger
 * than NEO-272's: after this runs EVERY manufacturer row carries the new
 * metadata key, and a Convex object validator is exact on read as well as on
 * write — so a rollback to a pre-NEO-237 deploy cannot read any Manufacturers
 * column at all. Prod order is deploy → READY → smoke → dry run → armed run,
 * and recovery from a bad deploy after the armed run is a fix-forward.
 *
 * ## Why the name match is allowed HERE and nowhere at runtime
 *
 * The runtime path reads the FLAG. The name "All Brands" on a flagged row is
 * the residue of the pre-NEO-237 mint (and of SportLots' brand-list option,
 * which used to be stored as that row), and a one-time migration is the one
 * place the literal may decide anything — the same split
 * `backfillBrandUnknownRole` drew, in the same words. A flagged row wearing
 * any OTHER name is an operator's rename and is left exactly as it is.
 *
 * ## Idempotent
 *
 * A second run reports every flagged row as `already_named` and every other
 * row as `already_prefixed`, and writes nothing.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { planValueRename, selectorValueKey } from "./selectorSyncMatch";

/** The string an armed run must carry. */
const CONFIRM_TOKEN = "BACKFILL";

/** The deployment-level arm — see `backfillBrandUnknownRole`. */
const ENV_FLAG = "ALLOW_SELECTOR_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * The name NB used to mint the brand-unknown row under, folded through the
 * project's one normaliser. The whole of the name matching in this file.
 */
const LEGACY_BRAND_UNKNOWN_KEY = selectorValueKey("All Brands");

/** What the row is called from now on. NB's own word. */
const BRAND_UNKNOWN_VALUE = "Unknown";

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the report below is what ` +
  `an armed run would have done.`;

const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";

const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

/**
 * The per-row list is capped for the CLI's sake; the counts are exact. Every
 * manufacturer row is a candidate here (unlike NEO-272, where only the
 * flagged ones were), so a deployment with a few synced years already has
 * more rows than an operator wants to scroll.
 */
const MAX_REPORTED = 50;

/**
 * One transaction's read budget, minus headroom — see `backfillCardFeatures`.
 * ⚠️ Truncation is not self-healing: a re-run reads the same prefix of the
 * same index. Drain by `parentId` (one year at a time) if it comes back true.
 */
const SCAN_LIMIT = 4000;

type RowAction =
  /** Flagged, named "All Brands" → renamed to "Unknown". */
  | "renamed"
  /** Flagged, named "All Brands", but a sibling is already "Unknown". Left alone; fix by hand. */
  | "rename_clash"
  /** Flagged, named anything else (already "Unknown", or an operator's rename). */
  | "already_named"
  /** Unflagged, no prefix → `setNamePrefix = value`. */
  | "prefixed"
  /** Unflagged, prefix present. The steady state. */
  | "already_prefixed";

type PlannedRow = {
  id: Id<"selectorOptions">;
  value: string;
  action: RowAction;
  patch?: Partial<Doc<"selectorOptions">>;
};

/**
 * ONE planner, shared by the dry run and the armed run — they differ only in
 * whether `patch` is applied.
 *
 * Siblings are grouped from the same scan so the rename's clash check sees
 * the whole parent even when the scan was narrowed by `parentId`. The
 * in-transaction rule from `planValueRename`'s contract still holds: one
 * flagged row per year is the only shape `ensureBrandUnknownRow` produces, so
 * two renames under one parent cannot both land — and if a hand edit ever
 * produced two, the second reads the first's new name as a clash.
 */
function planBackfill(rows: readonly Doc<"selectorOptions">[]): PlannedRow[] {
  const byParent = new Map<string, Doc<"selectorOptions">[]>();
  for (const row of rows) {
    if (row.level !== "manufacturer") continue;
    const key = row.parentId ?? "";
    const list = byParent.get(key);
    if (list) list.push(row);
    else byParent.set(key, [row]);
  }

  const out: PlannedRow[] = [];
  for (const siblings of byParent.values()) {
    const working = siblings.map((r) => ({ _id: r._id as string, value: r.value }));
    for (const row of siblings) {
      if (row.metadata?.isBrandUnknown === true) {
        // Pass 1 — the flagged row. Its `features.manufacturer` goes in the
        // same patch whatever its name: the manufacturer is ABSENT for it.
        const features = row.features ? { ...row.features } : undefined;
        const clearsFeature = features !== undefined && "manufacturer" in features;
        if (clearsFeature) delete features!.manufacturer;

        if (selectorValueKey(row.value) !== LEGACY_BRAND_UNKNOWN_KEY) {
          out.push({
            id: row._id,
            value: row.value,
            action: "already_named",
            ...(clearsFeature ? { patch: { features } } : {}),
          });
          continue;
        }
        const plan = planValueRename({
          row: {
            _id: row._id,
            level: row.level,
            value: row.value,
            features: row.features,
            sportConfig: row.sportConfig,
            metadata: row.metadata,
          },
          nextValue: BRAND_UNKNOWN_VALUE,
          // NEO-294 — Jason froze the flagged row's name against every
          // OPERATOR door ("Unknown should not be renamable"), and this is
          // the one rename that must still land: NB retiring its own legacy
          // word on its own row. An internal backfill, armed and one-shot,
          // renaming "All Brands" to "Unknown" — the opposite of the case
          // the refusal exists to stop.
          allowBrandUnknownRename: true,
          siblings: working,
        });
        if (!plan.ok) {
          out.push({
            id: row._id,
            value: row.value,
            action: "rename_clash",
            ...(clearsFeature ? { patch: { features } } : {}),
          });
          continue;
        }
        if (plan.unchanged) {
          out.push({
            id: row._id,
            value: row.value,
            action: "already_named",
            ...(clearsFeature ? { patch: { features } } : {}),
          });
          continue;
        }
        // `planValueRename` re-derived `features.manufacturer` = "Unknown";
        // that key is exactly the one the flagged row must not carry.
        const rederived = { ...(plan.features ?? {}) };
        delete rederived.manufacturer;
        const slot = working.find((w) => w._id === row._id);
        if (slot) slot.value = plan.value;
        out.push({
          id: row._id,
          value: row.value,
          action: "renamed",
          patch: {
            value: plan.value,
            features: rederived,
          },
        });
        continue;
      }

      // Pass 2 — every other manufacturer row gets the default prefix.
      const current = row.metadata?.setNamePrefix?.trim();
      if (current) {
        out.push({ id: row._id, value: row.value, action: "already_prefixed" });
        continue;
      }
      out.push({
        id: row._id,
        value: row.value,
        action: "prefixed",
        patch: {
          metadata: { ...(row.metadata ?? {}), setNamePrefix: row.value.trim() },
        },
      });
    }
  }
  return out;
}

const actionValidator = v.union(
  v.literal("renamed"),
  v.literal("rename_clash"),
  v.literal("already_named"),
  v.literal("prefixed"),
  v.literal("already_prefixed"),
);

export const run = internalMutation({
  args: {
    /** `"BACKFILL"` states the intent to write. Anything else is a dry run. */
    confirm: v.optional(v.string()),
    /** Optional narrowing to ONE year's manufacturers — the truncation escape hatch. */
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    scanned: v.number(),
    truncated: v.boolean(),
    counts: v.object({
      renamed: v.number(),
      renameClash: v.number(),
      alreadyNamed: v.number(),
      prefixed: v.number(),
      alreadyPrefixed: v.number(),
    }),
    /** Per-row detail, capped at MAX_REPORTED; the counts are the totals. */
    rows: v.array(
      v.object({
        id: v.id("selectorOptions"),
        value: v.string(),
        action: actionValidator,
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

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

    if (armed) {
      const now = Date.now();
      for (const row of plan) {
        if (!row.patch) continue;
        await ctx.db.patch(row.id, { ...row.patch, lastUpdated: now });
      }
    }

    const counts = {
      renamed: plan.filter((r) => r.action === "renamed").length,
      renameClash: plan.filter((r) => r.action === "rename_clash").length,
      alreadyNamed: plan.filter((r) => r.action === "already_named").length,
      prefixed: plan.filter((r) => r.action === "prefixed").length,
      alreadyPrefixed: plan.filter((r) => r.action === "already_prefixed").length,
    };

    // ONE audit line. Counts and the armed flag only — no row values (NEO-47's
    // rule, applied to logs); no `userId`, because an internalMutation reached
    // from `npx convex run` has no identity and the deploy credential is the
    // actor.
    console.log(
      JSON.stringify({
        msg: "backfill_brand_prefix_and_unknown_name",
        armed,
        refusedForFlag,
        scoped: parentId !== undefined,
        scanned: rows.length,
        truncated,
        ...counts,
      }),
    );

    // The prefixed/already-prefixed rows are the bulk; list the flagged ones
    // first so the rename outcome is always visible in the capped window.
    const order: Record<RowAction, number> = {
      renamed: 0,
      rename_clash: 1,
      already_named: 2,
      prefixed: 3,
      already_prefixed: 4,
    };
    const reported = [...plan]
      .sort((a, b) => order[a.action] - order[b.action])
      .slice(0, MAX_REPORTED)
      .map(({ id, value, action }) => ({ id, value, action }));

    return {
      armed,
      message: refusedForFlag
        ? NOT_ARMED_MESSAGE
        : armed
          ? APPLIED_MESSAGE
          : DRY_RUN_MESSAGE,
      scanned: rows.length,
      truncated,
      counts,
      rows: reported,
    };
  },
});
