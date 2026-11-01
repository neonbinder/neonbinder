import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * NEO-402 — what a checklist fetch already learned about its player names,
 * kept for the commit that follows it.
 *
 * The fetch (`resolveUnknownsAndStartBatch`) asks, for every distinct player
 * name on the checklist, which NB players carry that name. The commit
 * prelude's resolve phase used to ask the same question again, name by name,
 * at three indexed reads each (`sameNamePlayers`: primary name, other sports,
 * aliases). On a real set that was ~530 reads and ~2.5 s of a save the
 * operator waits on, every one of them repeating an answer the fetch had
 * minutes earlier and threw away.
 *
 * So the fetch writes down the one answer the commit can take as it stands:
 * the names that matched EXACTLY ONE player. The commit confirms each with a
 * single `get` (the row may have been deleted since) and skips the lookup.
 *
 * ## Only the unambiguous answers, on purpose
 *
 * A name that matched none or several is not stored. Those are the names the
 * review wizard asks the operator about, and the prelude settles them from the
 * operator's decision, the stored skips, the card-year narrowing and the
 * create path, all of which need the live rows. A name with no match at fetch
 * time may also be CREATED by the commit's own creates phase (a `create`
 * decision), and only a fresh lookup finds that row; storing "none" would
 * make the resolve phase mint it a second time. They stay on today's path,
 * and in a normal set they are a handful.
 *
 * ## The fetch's answer stands until the next fetch
 *
 * Jason, 2026-10-31: a name that becomes ambiguous between the fetch and the
 * commit (another set added a second player of that name) is not re-checked;
 * "do what is better for performance". The answer is replaced whole by the
 * operator's next fetch of the set, deleted with the staged candidates when
 * the operator commits or cancels (`discardCandidates`), ignored after
 * `RESOLUTION_MAX_AGE_MS`, and reaped by the hourly sweep.
 *
 * Scratch, not catalog data: one record per (set, operator), a few documents
 * each, holding NB player ids that NB's own lookup produced. Nothing here
 * reads a marketplace value.
 */

/** Names per document. ~70 bytes an entry keeps a document far under 1 MB. */
export const RESOLUTION_NAMES_PER_DOC = 500;

/**
 * How long a fetch's answers are trusted. A review session longer than this
 * falls back to the full lookup, which is today's behaviour, not a failure.
 */
export const RESOLUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The most answers one fetch stores. Convex caps an array argument at 8,192
 * entries; a name left out is simply looked up by the commit.
 */
export const MAX_STORED_NAME_ANSWERS = 8000;

/** Documents one (set, operator) record spans at most. */
const MAX_DOCS_PER_RECORD = Math.ceil(
  MAX_STORED_NAME_ANSWERS / RESOLUTION_NAMES_PER_DOC,
);

/** Deletes per sweep call; the cron comes back within the hour. */
const SWEEP_PAGE = 200;

const playerAnswerValidator = v.object({
  nameNormalized: v.string(),
  playerId: v.id("players"),
});

async function recordDocs(
  ctx: QueryCtx | MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  createdByUserId: string,
): Promise<Array<Doc<"checklistNameResolutions">>> {
  return await ctx.db
    .query("checklistNameResolutions")
    .withIndex("by_selector_option_and_user", (q) =>
      q
        .eq("selectorOptionId", selectorOptionId)
        .eq("createdByUserId", createdByUserId),
    )
    .take(MAX_DOCS_PER_RECORD);
}

/**
 * The fetch's exactly-one answers for this (set, operator, sport), keyed by
 * normalized name. Empty when there is no record, it is too old, or it was
 * written for another sport, and every caller treats empty as "look it up".
 */
export async function loadPlayerAnswers(
  ctx: QueryCtx | MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  createdByUserId: string,
  sportId: Id<"selectorOptions">,
): Promise<Map<string, Id<"players">>> {
  const answers = new Map<string, Id<"players">>();
  const cutoff = Date.now() - RESOLUTION_MAX_AGE_MS;
  for (const doc of await recordDocs(ctx, selectorOptionId, createdByUserId)) {
    if (doc.sportId !== sportId || doc.createdAt < cutoff) continue;
    for (const { nameNormalized, playerId } of doc.players) {
      answers.set(nameNormalized, playerId);
    }
  }
  return answers;
}

/** Deletes this (set, operator)'s record. Returns how many documents went. */
export async function clearRecord(
  ctx: MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  createdByUserId: string,
): Promise<number> {
  const docs = await recordDocs(ctx, selectorOptionId, createdByUserId);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length;
}

/**
 * Written by the fetch: replaces this (set, operator)'s record whole with the
 * names that matched exactly one player. Internal: the action that resolved
 * the names has already checked the caller is an admin and passes its id.
 */
export const replaceForFetch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    createdByUserId: v.string(),
    sportId: v.id("selectorOptions"),
    players: v.array(playerAnswerValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await clearRecord(ctx, args.selectorOptionId, args.createdByUserId);
    const createdAt = Date.now();
    const players = args.players.slice(0, MAX_STORED_NAME_ANSWERS);
    for (let i = 0; i < players.length; i += RESOLUTION_NAMES_PER_DOC) {
      await ctx.db.insert("checklistNameResolutions", {
        selectorOptionId: args.selectorOptionId,
        createdByUserId: args.createdByUserId,
        sportId: args.sportId,
        createdAt,
        players: players.slice(i, i + RESOLUTION_NAMES_PER_DOC),
      });
    }
    return null;
  },
});

/**
 * Hourly: deletes records older than `RESOLUTION_MAX_AGE_MS`, the ones whose
 * operator neither committed nor cancelled (or whose set was deleted). Readers
 * already ignore them; this only keeps the table from growing. One page an
 * hour, 200 documents, is far above the rate fetches create them, so
 * `hasMore` is reported rather than chased.
 */
export const sweepStaleResolutions = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - RESOLUTION_MAX_AGE_MS;
    const stale = await ctx.db
      .query("checklistNameResolutions")
      .withIndex("by_created_at", (q) => q.lt("createdAt", cutoff))
      .take(SWEEP_PAGE + 1);
    const page = stale.slice(0, SWEEP_PAGE);
    for (const doc of page) await ctx.db.delete(doc._id);
    return { deleted: page.length, hasMore: stale.length > SWEEP_PAGE };
  },
});
