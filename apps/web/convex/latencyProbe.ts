import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * NEO-407 — the latency probe's two targets.
 *
 * CI run 41212224696 saw a preview execute no functions for 10.7 s, and its
 * logs alone could not say whether Convex had stopped, the clients were idle,
 * or one of our functions was busy. `scripts/convex-probe.mjs` calls these on
 * a fixed clock beside every E2E shard (and can be pointed at any deployment),
 * so a stall shows up as a run of slow or missing probe answers with its own
 * timestamps, independent of what the specs were doing.
 *
 * Each reads ONE document (the first selector option, by creation order) and
 * returns nothing: no data leaves, nothing is written, and the cost is one
 * read. `nonce` differs on every call, so Convex's query cache never answers
 * for the function: every probe really runs.
 *
 * Public and anonymous by intent (pinned in publicFunctionAuth.test.ts), so
 * both fail closed where `TESTING_RESET_SECRET` is unset, which is production:
 * there they return before reading anything, and the probe measures only the
 * round trip. Pointing the probe at production with a real read is a separate
 * decision. A nonce longer than `MAX_NONCE` is refused.
 */
export const MAX_NONCE = 64;

function probeEnabled(nonce: string): boolean {
  if (nonce.length > MAX_NONCE) throw new Error("nonce too long");
  return Boolean(process.env.TESTING_RESET_SECRET);
}

export const ping = query({
  args: { nonce: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!probeEnabled(args.nonce)) return null;
    await ctx.db.query("selectorOptions").first();
    return null;
  },
});

/**
 * The same read on the mutation path, which runs and commits through a
 * different queue than queries (the 10.7 s stall caught a mutation queued for
 * 15.8 s). Writes nothing.
 */
export const pingMutation = mutation({
  args: { nonce: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!probeEnabled(args.nonce)) return null;
    await ctx.db.query("selectorOptions").first();
    return null;
  },
});
