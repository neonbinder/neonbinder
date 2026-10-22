/**
 * NEO-345 (D9) — read every stored card's OWN attribute tokens into NB's
 * attribute vocabulary, once.
 *
 * Until NEO-345 BSC's tokens were stored raw: a numbered card carried "SN25"
 * instead of `NUM` + `printRun: 25`, a memorabilia card carried "MEM" without
 * ever becoming a relic, and an AU card's autograph FORMAT was guessed from a
 * marketplace (SportLots' "Unknown" became "On Card"). New syncs now read the
 * tokens at every BSC parse site; this backfill brings the stored rows level.
 *
 * Every row goes through `cardChecklist.applyBscAttributeFill` — the one set
 * of fill rules the background team lookup and the autograph cascade use —
 * with the row's OWN `attributes` and, when the row's leaf has an operator
 * answer (`features.autographFormat`), that format. No BSC call is made.
 * Fill-empty throughout: nothing an operator set is overwritten, and a print
 * run that disagrees with the token is left and counted.
 *
 * ## Operator command
 *
 *   # 1. dry run — reports exactly what an armed run would do, writes nothing
 *   npx convex run backfillBscAttributeFeatures:run '{}'
 *   #    then again with the returned cursor until `done` is true:
 *   npx convex run backfillBscAttributeFeatures:run '{"cursor": <cursor>}'
 *
 *   # 2. arm the deployment, then walk it for real (same cursor loop)
 *   npx convex env set ALLOW_BSC_ATTRIBUTE_BACKFILL 1
 *   npx convex run backfillBscAttributeFeatures:run '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_BSC_ATTRIBUTE_BACKFILL
 *
 *   # production: same steps, with --prod
 *
 * Two independent arms, as in `backfillBrandPrefixAndUnknownName`: `confirm`
 * is per-invocation intent, the env flag is per-deployment. Dry run is the
 * DEFAULT, and an armed invocation on an unarmed deployment is REFUSED with
 * the report, not thrown. No `--identity` — internal function, the deploy
 * credential is the gate.
 *
 * ## One planner for dry and armed
 *
 * The planner IS the fill. A dry run hands it a database whose writes are
 * recorded and dropped; an armed run hands it one whose writes are recorded
 * and applied. Same rows, same rules, same counts — the two runs cannot
 * disagree about what a row needs.
 *
 * ## Paging
 *
 * Cursor-paged over the whole table in `_creationTime` order: up to
 * `SCAN_PER_PAGE` rows read and `WRITES_PER_PAGE` rows written per call, the
 * cursor being the last row EXAMINED, so a page that ends on its write bound
 * resumes at the first row it did not decide. Counts are per page; the
 * operator sums them. Leaf ids awaiting a format are listed per page (capped)
 * so they can be answered from the checklist.
 *
 * ## Idempotent
 *
 * A second walk writes nothing: every row already reads as its normalised
 * self, and `rowsNormalised` comes back 0.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { applyBscAttributeFill } from "./cardChecklist";
import {
  findAncestorLabels,
  newTitleNameCache,
  type StoredCardTitleChain,
} from "./storedCardTitle";
import {
  carriesAutographToken,
  isAutographFormat,
  type AutographFormat,
} from "./features/deriveCardFeatures";

/** The string an armed run must carry. */
const CONFIRM_TOKEN = "BACKFILL";

/** The deployment-level arm. */
const ENV_FLAG = "ALLOW_BSC_ATTRIBUTE_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/** Rows read per call. */
export const SCAN_PER_PAGE = 1000;

/**
 * Rows WRITTEN per call. A write is one patch plus the player reads Signed By
 * needs; 250 keeps an armed page under the ~900-operation band even when
 * every row needs one. A dry run counts would-be writes against the same
 * bound, so its pages are the armed run's pages.
 */
export const WRITES_PER_PAGE = 250;

/** Leaf ids reported per page; the count is exact. */
const MAX_REPORTED_LEAVES = 50;

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the report below is what ` +
  `an armed run would have done.`;

const APPLIED_MESSAGE =
  "Applied. Continue with the returned cursor until done; a second walk should write nothing.";

const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

type RecordedPatch = { id: string; value: Record<string, unknown> };

/**
 * `ctx` with its writes RECORDED. With `apply` false they are dropped (the
 * dry run); with `apply` true they are recorded and then made. Reads pass
 * straight through, so the fill sees the database as it stands.
 */
function recordingCtx(
  ctx: MutationCtx,
  apply: boolean,
): { ctx: MutationCtx; patches: RecordedPatch[] } {
  const patches: RecordedPatch[] = [];
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      if (prop === "patch") {
        return async (...args: unknown[]) => {
          // `patch(id, value)` or the table-named `patch(table, id, value)`.
          const value = args[args.length - 1] as Record<string, unknown>;
          const id = String(args[args.length - 2]);
          patches.push({ id, value });
          if (apply) {
            return Reflect.apply(
              target.patch as (...a: unknown[]) => Promise<void>,
              target,
              args,
            );
          }
        };
      }
      if (prop === "insert" || prop === "replace" || prop === "delete") {
        return async (...args: unknown[]) => {
          // The fill only ever patches the row it was given. Anything else
          // would be a write this backfill never planned; refuse it loudly.
          throw new Error(
            `backfillBscAttributeFeatures: unexpected db.${String(prop)} from the fill (${args.length} args)`,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db } as MutationCtx, patches };
}

export const run = internalMutation({
  args: {
    /** `"BACKFILL"` states the intent to write. Anything else is a dry run. */
    confirm: v.optional(v.string()),
    /** The previous call's `cursor`. Omit to start at the beginning. */
    cursor: v.optional(v.union(v.number(), v.null())),
    /** Tests only: can make a page SMALLER, never larger. */
    scanLimit: v.optional(v.number()),
    /** Tests only: can make a page SMALLER, never larger. */
    writeLimit: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    scanned: v.number(),
    /** Every row has been examined; stop calling. */
    done: v.boolean(),
    /** Pass back as `cursor` for the next page; null when done. */
    cursor: v.union(v.number(), v.null()),
    counts: v.object({
      /** Rows the fill wrote (or would write) anything to. */
      rowsNormalised: v.number(),
      /** Rows whose absent `printRun` was set from an SN<n> / 1/1 token. */
      printRunsSet: v.number(),
      /** Rows whose stored `printRun` differs from their token; left, kept. */
      printRunDisagreements: v.number(),
      /** AU rows given their leaf's format as `autographed`. */
      autographsFormatted: v.number(),
      /** Distinct leaves (this page) with unformatted AU cards and no answer. */
      leavesAwaitingFormat: v.number(),
    }),
    /** Those leaves' ids, capped at MAX_REPORTED_LEAVES. */
    leavesAwaitingFormat: v.array(v.id("selectorOptions")),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;

    const scanLimit = clampLimit(args.scanLimit, SCAN_PER_PAGE);
    const writeLimit = clampLimit(args.writeLimit, WRITES_PER_PAGE);
    const after = args.cursor ?? undefined;
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_creation_time", (q) =>
        after === undefined ? q : q.gt("_creationTime", after),
      )
      .take(scanLimit);

    // One read per distinct leaf, and only for a leaf with an AU card.
    const leafFormat = new Map<string, AutographFormat | undefined>();
    const formatOf = async (
      leafId: Id<"selectorOptions">,
    ): Promise<AutographFormat | undefined> => {
      if (!leafFormat.has(leafId)) {
        const leaf = await ctx.db.get(leafId);
        const stored = leaf?.features?.autographFormat;
        leafFormat.set(leafId, isAutographFormat(stored) ? stored : undefined);
      }
      return leafFormat.get(leafId);
    };

    // NEO-345 — a formatted card's still-generated title is rebuilt by the
    // fill; its leaf's ancestor walk is read once per leaf, names once per page.
    const titleChains = new Map<string, Promise<StoredCardTitleChain>>();
    const titleChainOf = (leafId: Id<"selectorOptions">) => () => {
      let chain = titleChains.get(leafId);
      if (!chain) {
        chain = ctx.db.get(leafId).then((leaf) => findAncestorLabels(ctx, leaf));
        titleChains.set(leafId, chain);
      }
      return chain;
    };
    const titleNames = newTitleNameCache();

    const counts = {
      rowsNormalised: 0,
      printRunsSet: 0,
      printRunDisagreements: 0,
      autographsFormatted: 0,
      leavesAwaitingFormat: 0,
    };
    const awaiting = new Set<Id<"selectorOptions">>();

    let lastExamined: number | null = after ?? null;
    let stoppedOnWrites = false;
    for (const row of rows) {
      if (counts.rowsNormalised >= writeLimit) {
        stoppedOnWrites = true;
        break;
      }
      lastExamined = row._creationTime;
      const tokens = row.attributes ?? [];
      if (tokens.length === 0) continue;

      let autographFormat: AutographFormat | undefined;
      if (carriesAutographToken(tokens)) {
        autographFormat = await formatOf(row.selectorOptionId);
        const unformatted = (row.features?.autographed ?? "None") === "None";
        if (autographFormat === undefined && unformatted) {
          awaiting.add(row.selectorOptionId);
        }
      }

      // The row's OWN tokens; the fill reads a raw SN<n> on them into the
      // print run itself, so no print run is passed.
      const { ctx: fillCtx, patches } = recordingCtx(ctx, armed);
      const result = await applyBscAttributeFill(fillCtx, row as Doc<"cardChecklist">, {
        tokens,
        ...(autographFormat !== undefined ? { autographFormat } : {}),
        titleChain: titleChainOf(row.selectorOptionId),
        titleNames,
      });
      if (result.wrote) counts.rowsNormalised++;
      if (result.printRunDisagreement) counts.printRunDisagreements++;
      if (result.autographFormatted) counts.autographsFormatted++;
      if (
        row.printRun === undefined &&
        patches.some((p) => typeof p.value.printRun === "number")
      ) {
        counts.printRunsSet++;
      }
    }
    counts.leavesAwaitingFormat = awaiting.size;

    const done = !stoppedOnWrites && rows.length < scanLimit;

    // ONE audit line. Counts and the armed flag only — no row values.
    console.log(
      JSON.stringify({
        msg: "backfill_bsc_attribute_features",
        armed,
        refusedForFlag,
        scanned: rows.length,
        done,
        ...counts,
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
      done,
      cursor: done ? null : lastExamined,
      counts,
      leavesAwaitingFormat: [...awaiting].slice(0, MAX_REPORTED_LEAVES),
    };
  },
});

/** A caller may make a bound smaller, never larger, and never below one. */
function clampLimit(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
