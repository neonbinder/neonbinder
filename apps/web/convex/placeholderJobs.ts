import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert the ownership record for a freshly minted placeholder-upload job
 * (NEO-148). Internal-only — the only caller is
 * `createPlaceholderUploadUrl` (convex/adapters/placeholderUploads.ts),
 * immediately after it successfully generates the signed POST policy.
 *
 * See the `placeholderJobs` table comment in schema.ts for why this row
 * exists at all: it's what lets every downstream (NEO-151/152) function
 * re-derive `objectPath` from a server-verified `jobId` + ownership check
 * instead of ever accepting `objectPath` as a client argument.
 */
export const insertPlaceholderJob = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    objectPath: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: args.jobId,
      userId: args.userId,
      objectPath: args.objectPath,
      createdAt: Date.now(),
      status: "pending",
    });
    return null;
  },
});
