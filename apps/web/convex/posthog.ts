"use node";
import { PostHog } from "posthog-node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/** Upper bound on one capture's flush. Telemetry is best-effort. */
const POSTHOG_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Send one event to PostHog. Fresh client per call with `flushAt: 1`, so the
 * `shutdown()` below is the flush.
 *
 * `recordAdapterCall` (since NEO-315) and the placeholder watchdog SCHEDULE this
 * (`ctx.scheduler.runAfter(0, …)`) rather than awaiting it, so its latency is
 * its own and never theirs. A scheduled run has no auth context, which is why
 * every caller resolves `distinctId` itself and passes it in.
 *
 * The flush is bounded. `shutdown()` with no argument waits as long as PostHog
 * takes; a scheduled capture that hangs would hold an action until the
 * platform's own timeout for an event nobody is waiting on.
 */
export const captureEvent = internalAction({
  args: {
    distinctId: v.string(),
    event: v.string(),
    properties: v.any(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const key = process.env.POSTHOG_API_KEY;
    if (!key) return null;
    const client = new PostHog(key, {
      host: "https://us.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
    client.capture({
      distinctId: args.distinctId,
      event: args.event,
      properties: args.properties,
    });
    await client.shutdown(POSTHOG_FLUSH_TIMEOUT_MS);
    return null;
  },
});
