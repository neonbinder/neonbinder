"use node";
import { PostHog } from "posthog-node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

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
    await client.shutdown();
    return null;
  },
});
