/**
 * PR 451 (NEO-487) — "Waiting on BuySportsCards…": the rows behind the status
 * the client shows while a checklist fetch, Build from Base or the Base match
 * probe waits on BSC. See the `marketplaceWaits` table note in schema.ts.
 *
 * Writers: `lib/marketplaceWaitWriter.ts`, fed by a BSC call recorder's wait
 * edges (`onWaitEdge`, lib/bscCallTelemetry.ts). One row per recorder:
 * `open` inserts it on the first edge, `edge` patches it by id, `expire`
 * deletes it an hour later (scheduled at insert, so a dead action's row
 * still goes).
 *
 * Reader: `forRun`, the one public function, scoped to the caller's own
 * identity. The owner is always the identity the action runs as (it
 * propagates through `runAction` / `runMutation`), never an argument, so
 * one admin cannot read or write another's waits.
 */
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUserIdentity } from "./auth";
import { isValidWaitKey } from "./lib/marketplaceWaitWriter";

/** How long a row lives after insert. Longer than any fetch or build. */
export const MARKETPLACE_WAIT_TTL_MS = 60 * 60 * 1000;
/** Rows one run can hold (one per recorder); the reader reads no more. */
export const MARKETPLACE_WAIT_ROWS_PER_RUN = 50;

const platformValidator = v.literal("bsc");

/**
 * The first wait edge of one recorder: insert its row, already waiting.
 * `null` when there is no caller identity (a scheduled run, nobody to show it
 * to) or the run key fails its shape check — nothing is written.
 */
export const open = internalMutation({
  args: {
    runKey: v.string(),
    platform: platformValidator,
    waitingSince: v.number(),
  },
  returns: v.union(v.id("marketplaceWaits"), v.null()),
  handler: async (ctx, args) => {
    if (!isValidWaitKey(args.runKey)) return null;
    const identity = await getCurrentUserIdentity(ctx);
    if (!identity) return null;
    const now = Date.now();
    const waitId = await ctx.db.insert("marketplaceWaits", {
      ownerId: identity.userId,
      runKey: args.runKey,
      platform: args.platform,
      waitingSince: args.waitingSince,
      accumulatedMs: 0,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(MARKETPLACE_WAIT_TTL_MS, internal.marketplaceWaits.expire, {
      waitId,
    });
    return waitId;
  },
});

/**
 * A later edge of the same recorder: patch its own row by id (no index read,
 * so no conflict with another recorder of the run). `waitingSince: null`
 * closes the wait. A row already expired is left alone.
 */
export const edge = internalMutation({
  args: {
    waitId: v.id("marketplaceWaits"),
    waitingSince: v.union(v.number(), v.null()),
    accumulatedMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitId);
    if (!row) return null;
    await ctx.db.patch(args.waitId, {
      waitingSince: args.waitingSince ?? undefined,
      accumulatedMs: Math.max(0, args.accumulatedMs),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Deletes one row (scheduled by `open`). */
export const expire = internalMutation({
  args: { waitId: v.id("marketplaceWaits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitId);
    if (row) await ctx.db.delete(args.waitId);
    return null;
  },
});

/**
 * The caller's own wait for one run: `waitingSince` is the earliest open
 * wait across the run's recorders (absent when none is waiting), and
 * `accumulatedMs` the closed waiting time summed over them. The client counts
 * the running seconds from its own clock, from when it first saw
 * `waitingSince`. No identity, or a malformed key: nothing.
 */
export const forRun = query({
  args: { runKey: v.string() },
  returns: v.object({
    waitingSince: v.optional(v.number()),
    accumulatedMs: v.number(),
  }),
  handler: async (ctx, args) => {
    if (!isValidWaitKey(args.runKey)) return { accumulatedMs: 0 };
    const identity = await getCurrentUserIdentity(ctx);
    if (!identity) return { accumulatedMs: 0 };
    const rows = await ctx.db
      .query("marketplaceWaits")
      .withIndex("by_owner_and_run", (q) =>
        q.eq("ownerId", identity.userId).eq("runKey", args.runKey),
      )
      .take(MARKETPLACE_WAIT_ROWS_PER_RUN);
    let waitingSince: number | undefined;
    let accumulatedMs = 0;
    for (const row of rows) {
      accumulatedMs += row.accumulatedMs;
      if (row.waitingSince !== undefined) {
        waitingSince =
          waitingSince === undefined ? row.waitingSince : Math.min(waitingSince, row.waitingSince);
      }
    }
    return waitingSince !== undefined ? { waitingSince, accumulatedMs } : { accumulatedMs };
  },
});
