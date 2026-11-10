/**
 * PR 451 (NEO-487) — the deployment-wide BSC cooldown after a 429.
 *
 * BSC's edge (an AWS load balancer) answers 429 with an empty body in a few
 * milliseconds and then blocks the calling IP for about two minutes. Convex
 * deployments egress from shared IPs, so a 429 seen by one caller is a block
 * on every caller: the fetch-time team lookup, the background team queue and
 * every other deployment's traffic on that IP. Asking again inside the block
 * only extends it.
 *
 * So the first 429 opens a window during which no caller asks that endpoint
 * at all. Callers read `get` before every wave and hand their remaining work
 * on (the fetch-time lookup marks those cards `failed`, which queues them for
 * the background lane; the background lane pushes the card back to `until`).
 *
 * The window: 60 s, doubling with each consecutive 429 window to at most
 * 10 min, or BSC's own Retry-After when that is longer (also capped at
 * 10 min). A 429 that arrives while a window is open does not escalate it
 * (the calls were already in flight when it opened). The streak resets when
 * 15 min pass with no 429.
 *
 * Writes happen only on a 429: the healthy path costs one indexed read per
 * wave and no writes.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_MAX_MS = 10 * 60_000;
export const COOLDOWN_STREAK_RESET_MS = 15 * 60_000;

const platformValidator = v.literal("bsc");
const endpointValidator = v.literal("cardListing");

type CooldownRow = Pick<Doc<"marketplaceCooldowns">, "until" | "last429At" | "streak">;

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
  const streak =
    row && now - row.last429At <= COOLDOWN_STREAK_RESET_MS ? row.streak + 1 : 1;
  const doubled = COOLDOWN_BASE_MS * 2 ** Math.min(streak - 1, 16);
  const base = Math.min(doubled, COOLDOWN_MAX_MS);
  const retryAfter =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, COOLDOWN_MAX_MS)
      : 0;
  return { until: now + Math.max(base, retryAfter), streak, escalated: true };
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

/** The open window, if any: `{ until }` while `until` is in the future, else null. */
export const get = internalQuery({
  args: { platform: platformValidator, endpoint: endpointValidator },
  returns: v.union(v.object({ until: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("marketplaceCooldowns")
      .withIndex("by_platform_endpoint", (q) =>
        q.eq("platform", args.platform).eq("endpoint", args.endpoint),
      )
      .unique();
    if (!row || row.until <= Date.now()) return null;
    return { until: row.until };
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
