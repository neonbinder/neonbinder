/**
 * PR 451 (NEO-487) — the deployment-wide BSC cooldown after a 429.
 *
 * BSC's edge (an AWS load balancer) answers 429 with an empty body in a few
 * milliseconds and then blocks the calling IP for a while. Convex deployments
 * egress from shared IPs, so a 429 seen by one caller is a block on every
 * caller: the fetch-time team lookup, the background team lane and every
 * other deployment's traffic on that IP. Asking again inside the block only
 * extends it.
 *
 * So the first 429 opens a window during which no caller asks that endpoint
 * at all. Callers read `get` before every wave and hand their remaining work
 * on (the fetch-time lookup marks those cards `failed`, which queues them for
 * the background lane; the background lane pushes the card back to `until`).
 *
 * NEO-482 — the window is sized to the lockout BSC was measured to impose: a
 * count-based burst lockout (a 429 about every 50 calls at 1 call / 2 s as at
 * 1 call / s) that lifts in 15 to 45 s. It is not a per-minute rate a pace
 * can stay under, so a 429 is routine and the window must stay short:
 *
 *  - 15 s, doubling with each consecutive 429 window to at most 120 s
 *    (15, 30, 60, 120);
 *  - or BSC's own Retry-After when that is longer, capped at 10 min (BSC's
 *    explicit instruction outranks our own estimate);
 *  - a 429 that arrives while a window is open does not escalate it (the
 *    calls were already in flight when it opened);
 *  - the streak resets on the first successful answer to a call asked after
 *    the window closed (`recordSuccess`). With a 429 every ~50 calls a
 *    quiet-time reset would never fire and every window would climb to the
 *    cap; a success proves the lockout lifted. A 429 more than 15 min after
 *    the last one also starts over (a backstop for a lost `recordSuccess`).
 *
 * Writes happen only on a 429, and on the first success after a window: the
 * healthy path costs one indexed read per wave and no writes. `get` tells the
 * caller whether a streak is live, so the caller calls `recordSuccess` only
 * then.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export const COOLDOWN_BASE_MS = 15_000;
export const COOLDOWN_MAX_MS = 120_000;
/** BSC's Retry-After is honoured up to this, past `COOLDOWN_MAX_MS`. */
export const RETRY_AFTER_MAX_MS = 10 * 60_000;
/** Backstop only: the streak normally resets on a success (`recordSuccess`). */
export const COOLDOWN_STREAK_RESET_MS = 15 * 60_000;

const platformValidator = v.literal("bsc");
const endpointValidator = v.literal("cardListing");

type CooldownRow = Pick<Doc<"marketplaceCooldowns">, "until" | "last429At" | "streak">;

/** Whether `row` still carries a streak the next 429 would escalate. Pure. */
export function streakIsLive(row: CooldownRow | null, now: number): boolean {
  return row !== null && row.streak > 0 && now - row.last429At <= COOLDOWN_STREAK_RESET_MS;
}

/**
 * The window a 429 at `now` opens, given the stored row. Pure, for tests.
 * `escalated: false` means the 429 landed inside a live window and the row's
 * `until` stands.
 */
export function nextCooldown(
  row: CooldownRow | null,
  now: number,
  retryAfterMs?: number,
): { until: number; streak: number; escalated: boolean } {
  if (row && row.until > now) {
    return { until: row.until, streak: row.streak, escalated: false };
  }
  const streak = row && streakIsLive(row, now) ? row.streak + 1 : 1;
  const doubled = COOLDOWN_BASE_MS * 2 ** Math.min(streak - 1, 16);
  const base = Math.min(doubled, COOLDOWN_MAX_MS);
  const retryAfter =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)
      : 0;
  return { until: now + Math.max(base, retryAfter), streak, escalated: true };
}

/**
 * Whether a successful answer to a call asked at `askedAt` resets the
 * streak. Pure. Only a call asked after the window closed proves the lockout
 * lifted: an answer to a call already in flight when a window opened does
 * not, nor does any answer while a window is open.
 */
export function successResetsStreak(row: CooldownRow | null, now: number, askedAt: number): boolean {
  return row !== null && row.streak > 0 && row.until <= now && askedAt >= row.until;
}

/**
 * Parses a Retry-After header: delta-seconds or an HTTP date. `undefined` for
 * anything else (a third party's header, so nothing is trusted beyond a
 * number; `nextCooldown` caps it).
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (trimmed.length > 64) return undefined;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * The endpoint's state, read before every wave:
 *  - `{ until }`: a window is open; make no call before `until`;
 *  - `{ closedAt }`: the window closed at `closedAt` but its streak is live,
 *    so the first successful answer to a call asked from now on should call
 *    `recordSuccess`;
 *  - null: no window and no streak (the healthy path; nothing to record).
 */
export const get = internalQuery({
  args: { platform: platformValidator, endpoint: endpointValidator },
  returns: v.union(
    v.object({ until: v.number() }),
    v.object({ closedAt: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("marketplaceCooldowns")
      .withIndex("by_platform_endpoint", (q) =>
        q.eq("platform", args.platform).eq("endpoint", args.endpoint),
      )
      .unique();
    if (!row) return null;
    if (row.until > now) return { until: row.until };
    if (streakIsLive(row, now)) return { closedAt: row.until };
    return null;
  },
});

/**
 * NEO-482 — a successful answer after a window: resets the streak to 0, so
 * the next 429 opens the base window again. Callers invoke it only when `get`
 * answered `{ closedAt }`, so the healthy path never runs it; here it writes
 * only when `successResetsStreak` holds (a live streak, the window closed,
 * and the call asked after it closed). Idempotent: a second success, or one
 * racing a new 429, writes nothing.
 */
export const recordSuccess = internalMutation({
  args: {
    platform: platformValidator,
    endpoint: endpointValidator,
    /** When the successful call was asked (epoch ms). */
    askedAt: v.number(),
  },
  returns: v.object({ reset: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("marketplaceCooldowns")
      .withIndex("by_platform_endpoint", (q) =>
        q.eq("platform", args.platform).eq("endpoint", args.endpoint),
      )
      .unique();
    if (!row || !successResetsStreak(row, now, args.askedAt)) return { reset: false };
    await ctx.db.patch(row._id, { streak: 0, updatedAt: now });
    // Platform, endpoint and timing only.
    console.log(
      JSON.stringify({
        msg: "marketplace_cooldown_streak_reset",
        platform: args.platform,
        operation: args.endpoint,
        streak: row.streak,
        msSinceClose: now - row.until,
      }),
    );
    return { reset: true };
  },
});

/**
 * Records a 429 and returns the window's end. See `nextCooldown`.
 * `retryAfterMs` is BSC's Retry-After, already parsed.
 */
export const record429 = internalMutation({
  args: {
    platform: platformValidator,
    endpoint: endpointValidator,
    retryAfterMs: v.optional(v.number()),
  },
  returns: v.object({ until: v.number(), streak: v.number(), escalated: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("marketplaceCooldowns")
      .withIndex("by_platform_endpoint", (q) =>
        q.eq("platform", args.platform).eq("endpoint", args.endpoint),
      )
      .unique();
    const next = nextCooldown(row, now, args.retryAfterMs);
    if (!next.escalated) return next;
    if (row) {
      await ctx.db.patch(row._id, {
        until: next.until,
        last429At: now,
        streak: next.streak,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("marketplaceCooldowns", {
        platform: args.platform,
        endpoint: args.endpoint,
        until: next.until,
        last429At: now,
        streak: next.streak,
        updatedAt: now,
      });
    }
    // Platform, endpoint and timing only.
    console.warn(
      JSON.stringify({
        msg: "marketplace_cooldown_opened",
        platform: args.platform,
        operation: args.endpoint,
        streak: next.streak,
        ms: next.until - now,
      }),
    );
    return next;
  },
});
