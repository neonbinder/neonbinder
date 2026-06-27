import { action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";

// Test BSC set parameters
export const testBscSetParameters = action({
  args: {
    partialParams: v.object({
      sport: v.optional(v.string()),
      year: v.optional(v.number()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      variantType: v.optional(v.union(
        v.literal("base"),
        v.literal("parallel"),
        v.literal("insert"),
        v.literal("parallel_of_insert")
      )),
    }),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    result: v.optional(v.any()),
  }),
  handler: async (ctx, args) => {
    try {
      console.log(`[testBscSetParameters] Testing with params:`, args.partialParams);
      
      // Test the BSC adapter
      const result: any = await ctx.runAction(api.adapters.buysportscards.getAvailableSetParameters, {
        partialParams: args.partialParams,
      });

      return {
        success: true,
        message: "Successfully tested BSC set parameters",
        result,
      };
    } catch (error) {
      console.error(`[testBscSetParameters] Error:`, error);
      return {
        success: false,
        message: `Failed to test BSC set parameters: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
}); 