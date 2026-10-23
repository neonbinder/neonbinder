/**
 * NEO-358 — `selectorOptions.cardCount` and `nonVariationCardCount`: how many
 * `cardChecklist` rows point at a row, kept so a collector's "1 of N" never
 * reads a whole checklist.
 *
 * ## Two counts (Jason, 2026-10-23)
 *
 *  - `cardCount`: every home row, variations included;
 *  - `nonVariationCardCount`: home rows WITHOUT `variationOfCardId`, the base
 *    count the UI shows by default.
 *
 * So the second count moves on a card insert or delete AND on any write that
 * sets or clears `variationOfCardId` on a card that stays put
 * (`setCardVariationParent`, the commit finalize's variation pass,
 * `orphanVariationsOf` promoting a deleted parent's children). Every such
 * writer owns a ledger and flushes it.
 *
 * ## The ledger
 *
 * Every mutation that inserts, deletes or moves a card, or changes a card's
 * variation parent, owns one `CardCountLedger`. Each write adds its deltas
 * (`addCard`, `removeCard`, `variationChanged`, or the raw `add`) and the
 * mutation calls `await ledger.flush(ctx)` ONCE, at the end of the
 * transaction. Deltas, not recounts: a commit chunk that inserts 900 cards
 * patches the variant row once and never reads the checklist it just wrote.
 *
 * `flush` patches `count = stored + delta` for both counts and skips a row
 * whose deltas are both zero. Two cases recount BOTH instead, in place, inside
 * the same transaction (so the count includes this mutation's own writes):
 *
 *  - either stored count is ABSENT: the row was never counted (written before
 *    these fields, and not reached by the backfill yet);
 *  - either `stored + delta` would go NEGATIVE: the stored count has drifted.
 *    The recount repairs it and logs `card_count_drift`.
 *
 * A recount is bounded (`RECOUNT_MAX`). A row past it is left exactly as it
 * stood and logged `card_count_recount_skipped`; the armed backfill
 * (`backfillVariantCardCounts`) is the tool for a row that big.
 *
 * Concurrent chunks on one variant serialise on the variant row itself: each
 * flush reads and patches it, so OCC retries the loser.
 *
 * ## What it counts
 *
 * Home rows only (`by_selector_option`); a cross-listed guest is not a card OF
 * the row. A set's total is the sum over its card-bearing rows (variant types,
 * inserts, parallels) and is never cached on the set row.
 *
 * ## Writers
 *
 * `cardCounts.pin.test.ts` greps every card insert, delete and move, and every
 * `variationOfCardId` write, for its ledger. The one exemption is the E2E reset
 * drain (`selectorOptions.resetCardChecklistBatch`), which drains the selector
 * rows too.
 *
 * ## Operator command (the backfill)
 *
 *   # 1. dry run: reports what an armed run would write, writes nothing
 *   npx convex run cardCounts:backfillVariantCardCounts '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_CARD_COUNT_BACKFILL 1
 *   npx convex run cardCounts:backfillVariantCardCounts '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_CARD_COUNT_BACKFILL
 *
 *   # production: the same three steps with --prod. Re-run until the report
 *   # says "complete": true; pass the returned `cursor` back to resume.
 *   # `"repair": true` also rewrites a stored count that disagrees with the
 *   # recount (by default only an ABSENT count is filled).
 *
 * See docs/operations/neo358-backfill-card-search-fields.md.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * The most cards a recount reads for one row inside a mutation that is doing
 * other work. The backfill's per-row ceiling, so a row the ledger cannot count
 * is exactly a row the backfill refuses too.
 */
export const RECOUNT_MAX = 10_000;

type CountCtx = { db: MutationCtx["db"] };

/** Both counts for one row. */
export type CardCounts = { cardCount: number; nonVariationCardCount: number };

/** Both counts of the cards pointing at `rowId`, or `null` past `RECOUNT_MAX`. */
export async function recountCards(
  ctx: CountCtx,
  rowId: Id<"selectorOptions">,
): Promise<CardCounts | null> {
  const rows = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
    .take(RECOUNT_MAX + 1);
  if (rows.length > RECOUNT_MAX) return null;
  let nonVariationCardCount = 0;
  for (const row of rows) {
    if (row.variationOfCardId === undefined) nonVariationCardCount++;
  }
  return { cardCount: rows.length, nonVariationCardCount };
}

type Delta = { all: number; nonVariation: number };

/** What `addCard` / `removeCard` read off a card. */
type CountedCard = Pick<Doc<"cardChecklist">, "selectorOptionId" | "variationOfCardId">;

/**
 * One mutation's card-count deltas, per selector row. See the header.
 */
export class CardCountLedger {
  private readonly deltas = new Map<Id<"selectorOptions">, Delta>();

  /**
   * Raw deltas: `all` cards added to (negative: removed from) `rowId`, of
   * which `nonVariation` were not variations.
   */
  add(rowId: Id<"selectorOptions">, all: number, nonVariation: number): void {
    if (all === 0 && nonVariation === 0) return;
    const held = this.deltas.get(rowId) ?? { all: 0, nonVariation: 0 };
    this.deltas.set(rowId, {
      all: held.all + all,
      nonVariation: held.nonVariation + nonVariation,
    });
  }

  /** A card row was inserted (or moved IN), as it now stands. */
  addCard(card: CountedCard): void {
    this.add(card.selectorOptionId, 1, card.variationOfCardId === undefined ? 1 : 0);
  }

  /** A card row was deleted (or moved OUT), as it stood. */
  removeCard(card: CountedCard): void {
    this.add(card.selectorOptionId, -1, card.variationOfCardId === undefined ? -1 : 0);
  }

  /**
   * A card that stays on `rowId` gained or lost its variation parent. Only the
   * transition counts: re-parenting a variation onto another parent is no
   * change.
   */
  variationChanged(
    rowId: Id<"selectorOptions">,
    wasVariation: boolean,
    isVariation: boolean,
  ): void {
    if (wasVariation === isVariation) return;
    this.add(rowId, 0, isVariation ? -1 : 1);
  }

  /** The pending deltas for one row; for tests and logging. */
  deltaFor(rowId: Id<"selectorOptions">): Delta {
    return this.deltas.get(rowId) ?? { all: 0, nonVariation: 0 };
  }

  /**
   * Write every non-zero delta, once, and clear the ledger (a second flush is
   * a no-op). Call it last in the transaction, after every card write.
   */
  async flush(ctx: CountCtx): Promise<void> {
    const entries = [...this.deltas.entries()];
    this.deltas.clear();
    for (const [rowId, delta] of entries) {
      if (delta.all === 0 && delta.nonVariation === 0) continue;
      const row = await ctx.db.get(rowId);
      // The row went in this same transaction (an emptied row ended through
      // `deleteEmptySelectorOptionRow`): there is nothing to count onto.
      if (!row) continue;
      const stored = row.cardCount;
      const storedBase = row.nonVariationCardCount;
      let next: CardCounts;
      if (
        stored === undefined ||
        storedBase === undefined ||
        stored + delta.all < 0 ||
        storedBase + delta.nonVariation < 0
      ) {
        const counted = await recountCards(ctx, rowId);
        if (counted === null) {
          console.warn(
            JSON.stringify({
              msg: "card_count_recount_skipped",
              selectorOptionId: rowId,
              limit: RECOUNT_MAX,
            }),
          );
          continue;
        }
        if (stored !== undefined && storedBase !== undefined) {
          console.warn(
            JSON.stringify({
              msg: "card_count_drift",
              selectorOptionId: rowId,
              stored,
              storedBase,
              delta: delta.all,
              deltaBase: delta.nonVariation,
              counted: counted.cardCount,
              countedBase: counted.nonVariationCardCount,
            }),
          );
        }
        next = counted;
      } else {
        next = {
          cardCount: stored + delta.all,
          nonVariationCardCount: storedBase + delta.nonVariation,
        };
      }
      if (next.cardCount !== stored || next.nonVariationCardCount !== storedBase) {
        await ctx.db.patch(rowId, next);
      }
    }
  }
}

export function createCardCountLedger(): CardCountLedger {
  return new CardCountLedger();
}

// ───────────────────────────────────────────────────────────────────────────
// The backfill
// ───────────────────────────────────────────────────────────────────────────

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_CARD_COUNT_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/** The levels a card can sit on. */
export const CARD_BEARING_LEVELS = ["variantType", "insert", "parallel"] as const;
type CardBearingLevel = (typeof CARD_BEARING_LEVELS)[number];

/** Rows read per page. Each costs one `.take` and at most one patch. */
const ROWS_PER_PAGE = 100;
/**
 * Cards read per page, across its rows. A page stops after the row that
 * crosses this; the next page resumes after that row. Document count, not
 * operations: one `.take` is one operation however many rows it returns.
 */
const CARDS_READ_PER_PAGE = 3_000;

/** A call stops after the first page that lands past this; re-run to resume. */
const TIME_BUDGET_MS = 150_000;

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the counts below are what ` +
  `an armed run would have done.`;
const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";
const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

const pageResultValidator = v.object({
  scanned: v.number(),
  filled: v.number(),
  repaired: v.number(),
  disagreed: v.number(),
  cardsRead: v.number(),
  /**
   * Set when the page stopped on the card budget before its last row: call
   * again with the SAME cursor and `skip` = this, and the rows already done
   * are passed over. Absent when the whole page was walked.
   */
  resumeSkip: v.optional(v.number()),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of one level. `apply: false` computes the same answer and writes
 * nothing. A row over `RECOUNT_MAX` throws rather than writing a count it
 * could not read.
 *
 * `filled`: a row missing either count, both written. `disagreed`: stored
 * counts that do not match the recount; written (`repaired`) only with
 * `repair: true`.
 */
export const backfillVariantCardCountsPage = internalMutation({
  args: {
    level: v.union(
      v.literal("variantType"),
      v.literal("insert"),
      v.literal("parallel"),
    ),
    cursor: v.union(v.string(), v.null()),
    /** Rows at the head of this page already handled by an earlier call. */
    skip: v.optional(v.number()),
    apply: v.boolean(),
    repair: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => {
    if (args.apply && !deploymentIsArmed()) {
      throw new ConvexError(NOT_ARMED_MESSAGE);
    }
    const numItems = Math.max(1, Math.min(args.numItems ?? ROWS_PER_PAGE, ROWS_PER_PAGE));
    const page = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", args.level))
      .paginate({ cursor: args.cursor, numItems });

    let filled = 0;
    let repaired = 0;
    let disagreed = 0;
    let cardsRead = 0;
    let scanned = 0;
    let resumeSkip: number | undefined;
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    for (let i = skip; i < page.page.length; i++) {
      // The card budget is checked BETWEEN rows, and the first row is always
      // attempted, so a page always advances.
      if (i > skip && cardsRead >= CARDS_READ_PER_PAGE) {
        resumeSkip = i;
        break;
      }
      const row = page.page[i];
      scanned++;
      const counted = await recountCards(ctx, row._id);
      if (counted === null) {
        throw new ConvexError(
          `Refused: ${args.level} row ${row._id} has more than ${RECOUNT_MAX} ` +
            `cards; count it by hand. Nothing on this page was written.`,
        );
      }
      cardsRead += counted.cardCount;
      // Both counts are written together, always: a row never carries one
      // without the other.
      const absent =
        row.cardCount === undefined || row.nonVariationCardCount === undefined;
      const differs =
        row.cardCount !== counted.cardCount ||
        row.nonVariationCardCount !== counted.nonVariationCardCount;
      if (absent) {
        filled++;
        if (args.apply) await ctx.db.patch(row._id, counted);
      } else if (differs) {
        disagreed++;
        if (args.repair) {
          repaired++;
          if (args.apply) await ctx.db.patch(row._id, counted);
        }
      }
    }
    return {
      scanned,
      filled,
      repaired,
      disagreed,
      cardsRead,
      ...(resumeSkip !== undefined ? { resumeSkip } : {}),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Parse the action's resume cursor; see `backfillVariantCardCounts`. */
export function parseResumeCursor(raw: string): {
  levelIndex: number;
  skip: number;
  cursor: string | null;
} {
  const first = raw.indexOf(":");
  const second = first === -1 ? -1 : raw.indexOf(":", first + 1);
  const level = first === -1 ? raw : raw.slice(0, first);
  const levelIndex = CARD_BEARING_LEVELS.indexOf(level as CardBearingLevel);
  const skipText = first === -1 ? "0" : raw.slice(first + 1, second === -1 ? undefined : second);
  const skip = Number(skipText);
  if (levelIndex === -1 || !Number.isInteger(skip) || skip < 0) {
    throw new ConvexError(`Refused: cursor ${raw} is not one this backfill returned.`);
  }
  const rest = second === -1 ? "" : raw.slice(second + 1);
  return { levelIndex, skip, cursor: rest.length > 0 ? rest : null };
}

/**
 * NEO-358 — fill `selectorOptions.cardCount` and `nonVariationCardCount` for
 * every card-bearing row.
 * Dry run by default; see the header for the operator commands.
 *
 * Walks `variantType`, then `insert`, then `parallel`, paging each. The
 * returned `cursor` is `<level>:<skip>:<page cursor>` and resumes exactly
 * there.
 * Idempotent: a row whose count already matches costs one read.
 */
export const backfillVariantCardCounts = internalAction({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.optional(v.string()),
    repair: v.optional(v.literal(true)),
    /** Lowers the rows per page; for tests. */
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    filled: v.number(),
    repaired: v.number(),
    disagreed: v.number(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const repair = args.repair === true;
    const startedAt = Date.now();

    let levelIndex = 0;
    let cursor: string | null = null;
    let skip = 0;
    if (args.cursor) {
      const parsed = parseResumeCursor(args.cursor);
      levelIndex = parsed.levelIndex;
      skip = parsed.skip;
      cursor = parsed.cursor;
    }

    const totals = { scanned: 0, filled: 0, repaired: 0, disagreed: 0 };
    let complete = false;
    for (;;) {
      if (levelIndex >= CARD_BEARING_LEVELS.length) {
        complete = true;
        break;
      }
      const level = CARD_BEARING_LEVELS[levelIndex];
      const page: {
        scanned: number;
        filled: number;
        repaired: number;
        disagreed: number;
        cardsRead: number;
        resumeSkip?: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.cardCounts.backfillVariantCardCountsPage, {
        level,
        cursor,
        ...(skip > 0 ? { skip } : {}),
        apply: armed,
        repair,
        ...(args.numItems !== undefined ? { numItems: args.numItems } : {}),
      });
      totals.scanned += page.scanned;
      totals.filled += page.filled;
      totals.repaired += page.repaired;
      totals.disagreed += page.disagreed;
      if (page.resumeSkip !== undefined) {
        // Same page again, past the rows it already did.
        skip = page.resumeSkip;
      } else if (page.isDone) {
        levelIndex += 1;
        cursor = null;
        skip = 0;
      } else {
        cursor = page.continueCursor;
        skip = 0;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    // One audit line: counts and flags only.
    console.log(
      JSON.stringify({
        msg: "backfill_variant_card_counts",
        armed,
        refusedForFlag,
        repair,
        complete,
        ...totals,
      }),
    );

    // `<level>:<skip>:<page cursor>` — the page cursor goes last because it
    // is opaque and may itself contain a colon.
    const resumeAt =
      complete || levelIndex >= CARD_BEARING_LEVELS.length
        ? undefined
        : `${CARD_BEARING_LEVELS[levelIndex]}:${skip}:${cursor ?? ""}`;
    return {
      armed,
      message: refusedForFlag ? NOT_ARMED_MESSAGE : armed ? APPLIED_MESSAGE : DRY_RUN_MESSAGE,
      complete,
      ...(resumeAt !== undefined ? { cursor: resumeAt } : {}),
      ...totals,
    };
  },
});
