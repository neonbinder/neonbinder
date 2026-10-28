/**
 * NEO-358 — the ONE writer of `cardTeamLinks`, and its backfill.
 *
 * The twin of `cardPlayerLinks.ts`, for the team PRINTED on a card
 * (`cardChecklist.teamOnCardIds`). Convex indexes fields, not array members,
 * so "which cards show this team?" has no index on the card table;
 * `cardTeamLinks` is that index, stored flat: one row per (card, team). A
 * collector searching "every Padres card" reads it (`collectionCatalog`).
 *
 * The table is DERIVED. It holds nothing that is not already on a card, and if
 * the two ever disagree the card wins and this is rebuilt from it. So exactly
 * two helpers here touch the table — `syncCardTeamLinks` for every
 * `teamOnCardIds` write and `deleteCardTeamLinks` for every card delete (which
 * `cardRowDelete.removeCardRow` calls) — and `cardTeamLinks.pin.test.ts` greps
 * every other module for anything else inserting into or deleting from it. The
 * E2E reset drain (`selectorOptions.resetCardTeamLinksBatch`) and this file's
 * backfill are the named exceptions.
 *
 * No sport on the row: a team belongs to one league and so to one sport, so a
 * team's cards need no sport filter. That also means a card with no sport
 * ancestor still gets its rows, unlike the player index.
 *
 * ## Operator command (the backfill)
 *
 *   # 1. dry run — reports what an armed run would write, writes nothing
 *   npx convex run cardTeamLinks:backfillCardTeamLinks '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_CARD_TEAM_LINKS_BACKFILL 1
 *   npx convex run cardTeamLinks:backfillCardTeamLinks '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_CARD_TEAM_LINKS_BACKFILL
 *
 *   # production: the same three steps with --prod. Re-run until the report
 *   # says "complete": true; pass the returned `cursor` back to resume.
 *
 * Two independent arms, the NEO-214 pair, exactly as the player-index backfill:
 * `confirm: "BACKFILL"` per invocation, the deployment flag per deployment. An
 * armed invocation on an unarmed deployment is REPORTED as refused rather than
 * thrown, so the dry-run numbers still come back.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

/**
 * What one card's rows must change by to match its `teamOnCardIds`.
 *
 * Pure, and shared by the writer and the backfill's dry run. A card that lists
 * the same team twice gets ONE row; a duplicate stored row is removed.
 */
export function planCardTeamLinks(
  existing: ReadonlyArray<Pick<Doc<"cardTeamLinks">, "_id" | "teamId">>,
  teamOnCardIds: ReadonlyArray<Id<"teams">> | undefined,
): {
  toDelete: Array<Id<"cardTeamLinks">>;
  toInsert: Array<Id<"teams">>;
} {
  const wanted = new Set<string>(teamOnCardIds ?? []);
  const held = new Set<string>();
  const toDelete: Array<Id<"cardTeamLinks">> = [];
  for (const row of existing) {
    const key = row.teamId as string;
    if (wanted.has(key) && !held.has(key)) {
      held.add(key);
      continue;
    }
    toDelete.push(row._id);
  }
  const toInsert: Array<Id<"teams">> = [];
  for (const key of wanted) {
    if (!held.has(key)) toInsert.push(key as Id<"teams">);
  }
  return { toDelete, toInsert };
}

/**
 * ── The ONE writer of `cardTeamLinks` for a card ───────────────────────────
 *
 * Called by every writer of `cardChecklist.teamOnCardIds` with the list it just
 * wrote. Diffs against `by_card`, so a save with the teams unchanged costs one
 * read and no writes.
 *
 * `fresh: true` is for a card inserted in the same transaction: there is
 * nothing to diff against, so the read is skipped (the commit chunk inserts up
 * to `CARDS_PER_COMMIT_CHUNK` cards per transaction and counts every read).
 */
export async function syncCardTeamLinks(
  ctx: Pick<MutationCtx, "db">,
  cardId: Id<"cardChecklist">,
  teamOnCardIds: ReadonlyArray<Id<"teams">> | undefined,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  if (opts.fresh && (teamOnCardIds ?? []).length === 0) return;
  const existing = opts.fresh
    ? []
    : await ctx.db
        .query("cardTeamLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
        .collect();
  const { toDelete, toInsert } = planCardTeamLinks(existing, teamOnCardIds);
  for (const id of toDelete) await ctx.db.delete(id);
  for (const teamId of toInsert) {
    await ctx.db.insert("cardTeamLinks", { cardChecklistId: cardId, teamId });
  }
}

/**
 * NEO-362 — up to `limit` cards showing a team, for a smart binder's empty
 * slots (`binderRules.ts`). A READ that lives here so this module stays the
 * one writer and a sanctioned reader of the index (`cardTeamLinks.pin.test.ts`).
 */
export async function cardIdsForTeam(
  ctx: Pick<QueryCtx, "db">,
  teamId: Id<"teams">,
  limit: number,
): Promise<Array<Id<"cardChecklist">>> {
  const rows = await ctx.db
    .query("cardTeamLinks")
    .withIndex("by_team", (q) => q.eq("teamId", teamId))
    .take(limit);
  return rows.map((row) => row.cardChecklistId);
}

/**
 * Every row for one card, removed. Called by `removeCardRow`, beside the card
 * delete, in the same transaction, so the index never names a card that is
 * gone. Returns the ids for a caller that logs every row it deletes.
 */
export async function deleteCardTeamLinks(
  ctx: Pick<MutationCtx, "db">,
  cardId: Id<"cardChecklist">,
): Promise<Array<Id<"cardTeamLinks">>> {
  const rows = await ctx.db
    .query("cardTeamLinks")
    .withIndex("by_card", (q) => q.eq("cardChecklistId", cardId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.map((row) => row._id);
}

// ───────────────────────────────────────────────────────────────────────────
// The backfill
// ───────────────────────────────────────────────────────────────────────────

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_CARD_TEAM_LINKS_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * Cards per page. A card costs one `by_card` read plus one write per missing
 * row; 200 cards is ~400-600 operations, under the ~900 comfortable line.
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
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page of the backfill. `apply: false` computes the same plan and writes
 * nothing. Re-asserts the arming itself when applying.
 */
export const backfillCardTeamLinksPage = internalMutation({
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

    let cardsChanged = 0;
    let rowsInserted = 0;
    let rowsDeleted = 0;
    for (const card of page.page) {
      const existing = await ctx.db
        .query("cardTeamLinks")
        .withIndex("by_card", (q) => q.eq("cardChecklistId", card._id))
        .collect();
      if (existing.length === 0 && (card.teamOnCardIds ?? []).length === 0) continue;
      const plan = planCardTeamLinks(existing, card.teamOnCardIds);
      if (plan.toDelete.length === 0 && plan.toInsert.length === 0) continue;
      cardsChanged++;
      rowsInserted += plan.toInsert.length;
      rowsDeleted += plan.toDelete.length;
      if (args.apply) {
        await syncCardTeamLinks(ctx, card._id, card.teamOnCardIds);
      }
    }
    return {
      scanned: page.page.length,
      cardsChanged,
      rowsInserted,
      rowsDeleted,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * NEO-358 — fill `cardTeamLinks` for cards written before the table existed.
 * Dry run by default; see the header for the operator commands. Idempotent: a
 * card whose rows already match costs one read and is not counted.
 */
export const backfillCardTeamLinks = internalAction({
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
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const startedAt = Date.now();

    const totals = { scanned: 0, cardsChanged: 0, rowsInserted: 0, rowsDeleted: 0 };
    let cursor: string | null = args.cursor ?? null;
    let complete = false;
    for (;;) {
      const page: {
        scanned: number;
        cardsChanged: number;
        rowsInserted: number;
        rowsDeleted: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(internal.cardTeamLinks.backfillCardTeamLinksPage, {
        cursor,
        apply: armed,
      });
      totals.scanned += page.scanned;
      totals.cardsChanged += page.cardsChanged;
      totals.rowsInserted += page.rowsInserted;
      totals.rowsDeleted += page.rowsDeleted;
      cursor = page.continueCursor;
      if (page.isDone) {
        complete = true;
        break;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    console.log(
      JSON.stringify({ msg: "backfill_card_team_links", armed, refusedForFlag, complete, ...totals }),
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
