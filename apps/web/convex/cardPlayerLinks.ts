/**
 * NEO-313 — the ONE writer of `cardPlayerLinks`, and its backfill.
 *
 * `cardChecklist.playerIds` is an array, and Convex indexes fields, not array
 * members, so "which cards carry this player?" has no index on the card table.
 * `cardPlayerLinks` is that index, stored flat: one row per (card, player),
 * tagged with the CARD's sport. See the table note in schema.ts for why the
 * sport and not the card's selector row.
 *
 * The table is DERIVED. It holds nothing that is not already on a card, and if
 * the two ever disagree the card wins and this is rebuilt from it. Two copies
 * of one fact can disagree, so exactly two helpers here touch the table —
 * `syncCardPlayerLinks` for every `playerIds` write and `deleteCardPlayerLinks`
 * for every card delete — and `cardPlayerLinks.pin.test.ts` greps every other
 * module for anything else inserting into or deleting from it. The E2E reset
 * drain (`selectorOptions.resetCardPlayerLinksBatch`) and this file's backfill
 * are the named exceptions.
 *
 * ## Operator command (the backfill)
 *
 *   # 1. dry run — reports what an armed run would write, writes nothing
 *   npx convex run cardPlayerLinks:backfillCardPlayerLinks '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_CARD_PLAYER_LINKS_BACKFILL 1
 *   npx convex run cardPlayerLinks:backfillCardPlayerLinks '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_CARD_PLAYER_LINKS_BACKFILL
 *
 *   # production: the same three steps with --prod. Re-run until the report
 *   # says "complete": true; pass the returned `cursor` back to resume.
 *
 * Two independent arms, the NEO-214 pair: `confirm: "BACKFILL"` states the
 * intent per invocation, the deployment flag guards the deployment you did not
 * mean to be pointed at. An armed invocation on an unarmed deployment is
 * REPORTED as refused rather than thrown, so the dry-run numbers still come
 * back. No `--identity`: these are internal functions, and the deploy
 * credential is the gate.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { findSportForSelectorOption } from "./cardChecklist";

/**
 * What one card's rows must change by to match its `playerIds`.
 *
 * Pure, and shared by the writer and the backfill's dry run, so the dry run
 * reports exactly what an armed run would write rather than a second,
 * subtly-different derivation of it.
 *
 * A card that lists the same player twice gets ONE row: the question the
 * index answers is "does this card carry this player", not "how many times".
 * A row in the wrong sport (a card whose ancestor chain was repaired since) or
 * a duplicate row is removed.
 */
export function planCardPlayerLinks(
  existing: ReadonlyArray<Pick<Doc<"cardPlayerLinks">, "_id" | "playerId" | "sportId">>,
  playerIds: ReadonlyArray<Id<"players">> | undefined,
  sportId: Id<"selectorOptions"> | undefined,
): {
  toDelete: Array<Id<"cardPlayerLinks">>;
  toInsert: Array<Id<"players">>;
} {
  // No sport, no index row: the table's `sportId` is required, and a card whose
  // ancestor chain does not reach a sport is orphaned data. Every stale row is
  // still removed so the index never claims more than the card does.
  const wanted = new Set<string>(sportId ? (playerIds ?? []) : []);
  const held = new Set<string>();
  const toDelete: Array<Id<"cardPlayerLinks">> = [];
  for (const row of existing) {
    const key = row.playerId as string;
    if (wanted.has(key) && row.sportId === sportId && !held.has(key)) {
      held.add(key);
      continue;
    }
    toDelete.push(row._id);
  }
  const toInsert: Array<Id<"players">> = [];
  for (const key of wanted) {
    if (!held.has(key)) toInsert.push(key as Id<"players">);
  }
  return { toDelete, toInsert };
}

/**
 * ── The ONE writer of `cardPlayerLinks` for a card ─────────────────────────
 *
 * Called by every writer of `cardChecklist.playerIds` with the list it just
 * wrote and the card's sport (the root of its selector chain). Diffs against
 * `by_card`, so a save with the players unchanged costs one read and no
 * writes.
 *
 * `fresh: true` is for a card inserted in the same transaction: there is
 * nothing to diff against, so the read is skipped. The commit chunk inserts up
 * to `CARDS_PER_COMMIT_CHUNK` cards per transaction and every read there is
 * counted against the system-operation budget.
 *
 * `sportId` undefined (an orphaned ancestor chain) writes no rows and removes
 * any the card had; the structured log line says which card, so the orphan can
 * be found.
 */
export async function syncCardPlayerLinks(
  ctx: MutationCtx,
  cardId: Id<"cardChecklist">,
  playerIds: ReadonlyArray<Id<"players">> | undefined,
  sportId: Id<"selectorOptions"> | undefined,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  if (opts.fresh && (playerIds ?? []).length === 0) return;
  const existing = opts.fresh
    ? []
    : await ctx.db
        .query("cardPlayerLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
        .collect();
  const { toDelete, toInsert } = planCardPlayerLinks(existing, playerIds, sportId);
  for (const id of toDelete) await ctx.db.delete(id);
  if (!sportId) {
    if ((playerIds ?? []).length > 0) {
      console.warn(
        JSON.stringify({ msg: "card_player_links_no_sport", cardChecklistId: cardId }),
      );
    }
    return;
  }
  for (const playerId of toInsert) {
    await ctx.db.insert("cardPlayerLinks", {
      cardChecklistId: cardId,
      playerId,
      sportId,
    });
  }
}

/**
 * Every row for one card, removed. Called beside every `cardChecklist` delete,
 * in the same transaction, so the index never names a card that is gone.
 */
export async function deleteCardPlayerLinks(
  ctx: MutationCtx,
  cardId: Id<"cardChecklist">,
): Promise<Array<Id<"cardPlayerLinks">>> {
  const rows = await ctx.db
    .query("cardPlayerLinks")
    .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  // The ids, for a caller that logs every row it deletes (the subtree wipe).
  return rows.map((row) => row._id);
}

// ───────────────────────────────────────────────────────────────────────────
// The backfill
// ───────────────────────────────────────────────────────────────────────────

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_CARD_PLAYER_LINKS_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * Cards per page. A card with players costs one `by_card` read plus one write
 * per missing row; the sport walk is cached per selector row within the page.
 * 200 cards is ~400-600 operations, under the ~900 comfortable line.
 */
const CARDS_PER_PAGE = 200;

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
  cardsChanged: v.number(),
  rowsInserted: v.number(),
  rowsDeleted: v.number(),
  noSport: v.number(),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of the backfill. `apply: false` computes the same plan and writes
 * nothing. Re-asserts the arming itself when applying, so an internal caller
 * that skips the action gets the same refusal.
 */
export const backfillCardPlayerLinksPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => {
    if (args.apply && !deploymentIsArmed()) {
      throw new ConvexError(NOT_ARMED_MESSAGE);
    }
    const numItems = Math.max(1, Math.min(args.numItems ?? CARDS_PER_PAGE, CARDS_PER_PAGE));
    const page = await ctx.db
      .query("cardChecklist")
      .paginate({ cursor: args.cursor, numItems });

    const sportBySelector = new Map<string, Id<"selectorOptions"> | undefined>();
    let cardsChanged = 0;
    let rowsInserted = 0;
    let rowsDeleted = 0;
    let noSport = 0;
    for (const card of page.page) {
      const key = card.selectorOptionId as string;
      if (!sportBySelector.has(key)) {
        sportBySelector.set(key, await findSportForSelectorOption(ctx, card.selectorOptionId));
      }
      const sportId = sportBySelector.get(key);
      const existing = await ctx.db
        .query("cardPlayerLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      if (existing.length === 0 && (card.playerIds ?? []).length === 0) continue;
      if (!sportId && (card.playerIds ?? []).length > 0) noSport++;
      const plan = planCardPlayerLinks(existing, card.playerIds, sportId);
      if (plan.toDelete.length === 0 && plan.toInsert.length === 0) continue;
      cardsChanged++;
      rowsInserted += sportId ? plan.toInsert.length : 0;
      rowsDeleted += plan.toDelete.length;
      if (args.apply) {
        await syncCardPlayerLinks(ctx, card._id, card.playerIds, sportId);
      }
    }
    return {
      scanned: page.page.length,
      cardsChanged,
      rowsInserted,
      rowsDeleted,
      noSport,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * NEO-313 — fill `cardPlayerLinks` for cards written before the table
 * existed. Dry run by default; see the header for the operator commands.
 *
 * Loops pages until the table is walked or the time budget is spent, and
 * returns the cursor to resume from. Idempotent: a card whose rows already
 * match costs one read and is not counted, so a second run reports zeros.
 */
export const backfillCardPlayerLinks = internalAction({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    cardsChanged: v.number(),
    rowsInserted: v.number(),
    rowsDeleted: v.number(),
    noSport: v.number(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const startedAt = Date.now();

    const totals = { scanned: 0, cardsChanged: 0, rowsInserted: 0, rowsDeleted: 0, noSport: 0 };
    let cursor: string | null = args.cursor ?? null;
    let complete = false;
    for (;;) {
      const page: {
        scanned: number;
        cardsChanged: number;
        rowsInserted: number;
        rowsDeleted: number;
        noSport: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.cardPlayerLinks.backfillCardPlayerLinksPage, {
        cursor,
        apply: armed,
      });
      totals.scanned += page.scanned;
      totals.cardsChanged += page.cardsChanged;
      totals.rowsInserted += page.rowsInserted;
      totals.rowsDeleted += page.rowsDeleted;
      totals.noSport += page.noSport;
      cursor = page.continueCursor;
      if (page.isDone) {
        complete = true;
        break;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    // One audit line: counts and flags only.
    console.log(
      JSON.stringify({ msg: "backfill_card_player_links", armed, refusedForFlag, complete, ...totals }),
    );

    return {
      armed,
      message: refusedForFlag ? NOT_ARMED_MESSAGE : armed ? APPLIED_MESSAGE : DRY_RUN_MESSAGE,
      complete,
      ...(complete || cursor === null ? {} : { cursor }),
      ...totals,
    };
  },
});
