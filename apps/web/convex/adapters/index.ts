"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import { CardListingsResponse } from "./base";

// Unified search function for all platforms that support card searches
export const searchAllCardPlatforms = action({
  args: {
    cardName: v.string(),
    year: v.optional(v.number()),
    sport: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    condition: v.optional(v.string()),
    maxPrice: v.optional(v.number()),
    minPrice: v.optional(v.number()),
    platforms: v.optional(v.array(v.union(
      v.literal("ebay"),
      v.literal("myslabs"),
      v.literal("mycardpost")
    ))),
    ebayAppId: v.optional(v.string()),
  },
  returns: v.object({
    results: v.array(v.object({
      platform: v.string(),
      listings: v.array(v.object({
        id: v.string(),
        title: v.string(),
        price: v.number(),
        condition: v.optional(v.string()),
        quantity: v.optional(v.number()),
        imageUrl: v.optional(v.string()),
        platform: v.string(),
        url: v.string(),
        seller: v.optional(v.string()),
        shipping: v.optional(v.number()),
      })),
      totalCount: v.number(),
    })),
    totalResults: v.number(),
  }),
  handler: async (ctx, args) => {
    const platforms = args.platforms || ["ebay", "myslabs", "mycardpost"];
    const results: Array<{ platform: string; listings: CardListingsResponse['listings']; totalCount: number }> = [];

    // Search each platform in parallel
    const searchPromises = platforms.map(async (platform) => {
      try {
        let result: CardListingsResponse;
        
        switch (platform) {
          case "ebay":
            if (!args.ebayAppId) {
              throw new Error("eBay App ID is required for eBay searches");
            }
            result = await ctx.runAction(api.adapters.ebay.searchEbay, {
              ...args,
              appId: args.ebayAppId,
            });
            break;
          case "myslabs":
            result = await ctx.runAction(api.adapters.myslabs.searchMySlabs, args);
            break;
          case "mycardpost":
            result = await ctx.runAction(api.adapters.mycardpost.searchMyCardPost, args);
            break;
          default:
            throw new Error(`Unsupported platform: ${platform}`);
        }

        return {
          platform,
          listings: result.listings,
          totalCount: result.totalCount,
        };
      } catch (error) {
        console.error(`Error searching ${platform}:`, error);
        return {
          platform,
          listings: [],
          totalCount: 0,
        };
      }
    });

    const platformResults = await Promise.all(searchPromises);
    results.push(...platformResults);

    const totalResults = results.reduce((sum, result) => sum + result.totalCount, 0);

    return {
      results,
      totalResults,
    };
  },
});

// Unified search function for all platforms that support set searches
// Note: searchSets functionality has been removed as we're focusing on available sets identification 

// Generic aggregator function for set parameters
export const getAvailableSetParameters = action({
  args: {
    partialParams: v.object({
      sport: v.optional(v.string()),
      year: v.optional(v.number()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      variantType: v.optional(v.union(
        v.literal("base"),
        v.literal("insert"),
        v.literal("parallel"),
        v.literal("parallel_of_insert")
      )),
      insertName: v.optional(v.string()),
      parallelName: v.optional(v.string()),
    }),
  },
  returns: v.object({
    availableOptions: v.object({
      sports: v.optional(v.array(v.object({
        site: v.string(),
        values: v.array(v.object({
          label: v.string(),
          value: v.string(),
        })),
      }))),
      years: v.optional(v.array(v.object({
        site: v.string(),
        values: v.array(v.object({
          label: v.string(),
          value: v.string(),
        })),
      }))),
      manufacturers: v.optional(v.array(v.object({
        site: v.string(),
        values: v.array(v.object({
          label: v.string(),
          value: v.string(),
        })),
      }))),
      setNames: v.optional(v.array(v.object({
        site: v.string(),
        values: v.array(v.object({
          label: v.string(),
          value: v.string(),
        })),
      }))),
      variantNames: v.optional(v.array(v.object({
        site: v.string(),
        values: v.array(v.object({
          label: v.string(),
          value: v.string(),
        })),
      }))),
    }),
    currentParams: v.object({
      sport: v.optional(v.string()),
      year: v.optional(v.number()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      variantType: v.optional(v.union(
        v.literal("base"),
        v.literal("insert"),
        v.literal("parallel"),
        v.literal("parallel_of_insert")
      )),
      insertName: v.optional(v.string()),
      parallelName: v.optional(v.string()),
    }),
  }),
  handler: async (ctx, args): Promise<{
    availableOptions: {
      sports?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      years?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      manufacturers?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      setNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      variantNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
    };
    currentParams: {
      sport?: string;
      year?: number;
      manufacturer?: string;
      setName?: string;
      variantType?: "base" | "insert" | "parallel" | "parallel_of_insert";
      insertName?: string;
      parallelName?: string;
    };
  }> => {
    try {
      // For now, just pass through to BSC
      // In the future, this will aggregate from multiple platforms
      const bscResult = await ctx.runAction(api.adapters.buysportscards.getAvailableSetParameters, {
        partialParams: args.partialParams,
      }) as {
        availableOptions: {
          sports?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          years?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          manufacturers?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          setNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
          variantNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
        };
        currentParams: {
          sport?: string;
          year?: number;
          manufacturer?: string;
          setName?: string;
          variantType?: "base" | "insert" | "parallel" | "parallel_of_insert";
          insertName?: string;
          parallelName?: string;
        };
      };

      return bscResult;
    } catch (error) {
      console.error("Error in generic aggregator:", error);
      throw new Error(`Failed to get available set parameters: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
}); 