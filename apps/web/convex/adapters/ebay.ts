"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { BaseAdapter, CardAdapter, CardSearchParams, CardListingsResponse, CardListing } from "./base";
import { api } from "../_generated/api";

export class EbayAdapter extends BaseAdapter implements CardAdapter {
  private baseUrl = "https://api.ebay.com";
  private appId: string;

  constructor(appId: string) {
    super();
    this.appId = appId;
  }

  async searchCards(params: CardSearchParams): Promise<CardListingsResponse> {
    try {
      // Build search query for eBay
      const searchParams = {
        q: params.cardName,
        year: params.year,
        categoryId: this.getCategoryId(params.sport),
        brand: params.manufacturer,
        condition: params.condition,
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
        limit: 50, // eBay API limit
      };

      const queryString = this.buildQueryString(searchParams);
      const url = `${this.baseUrl}/buy/browse/v1/item_summary/search?${queryString}`;

      const response = await this.makeRequest(url, {
        headers: {
          'Authorization': `Bearer ${this.appId}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY-US',
        },
      });

      const data = await this.parseJsonResponse(response) as EbayResponse;

      // Transform the response to our standard format
      const listings: CardListing[] = data.itemSummaries.map(item => ({
        id: item.itemId,
        title: item.title,
        price: parseFloat(item.price.value),
        condition: item.condition,
        quantity: item.quantity,
        imageUrl: item.image?.imageUrl,
        platform: "ebay",
        url: item.itemWebUrl,
        seller: item.seller?.username,
        shipping: item.shippingOptions?.[0]?.shippingCost?.value ? 
          parseFloat(item.shippingOptions[0].shippingCost.value) : undefined,
      }));

      return {
        listings,
        totalCount: data.total,
        platform: "ebay",
      };
    } catch (error) {
      console.error("Error searching eBay:", error);
      throw new Error(`Failed to search eBay: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private getCategoryId(sport?: string): string {
    // eBay category IDs for sports cards
    const categories: Record<string, string> = {
      'baseball': '213',
      'basketball': '214',
      'football': '215',
      'hockey': '216',
      'soccer': '217',
      'other': '218',
    };
    return categories[sport?.toLowerCase() || 'other'] || '213';
  }
}

// eBay API response types
interface EbayResponse {
  itemSummaries: Array<{
    itemId: string;
    title: string;
    price: {
      value: string;
      currency: string;
    };
    condition?: string;
    quantity: number;
    image?: {
      imageUrl: string;
    };
    itemWebUrl: string;
    seller?: {
      username: string;
    };
    shippingOptions?: Array<{
      shippingCost: {
        value: string;
        currency: string;
      };
    }>;
  }>;
  total: number;
}

// Convex action to search eBay
export const searchEbay = action({
  args: {
    cardName: v.string(),
    year: v.optional(v.number()),
    sport: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    condition: v.optional(v.string()),
    maxPrice: v.optional(v.number()),
    minPrice: v.optional(v.number()),
    appId: v.string(), // eBay App ID for authentication
  },
  returns: v.object({
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
    platform: v.string(),
  }),
  handler: async (ctx, args) => {
    const adapter = new EbayAdapter(args.appId);
    const searchParams = {
      cardName: args.cardName,
      year: args.year,
      sport: args.sport,
      manufacturer: args.manufacturer,
      condition: args.condition,
      maxPrice: args.maxPrice,
      minPrice: args.minPrice,
    };
    return await adapter.searchCards(searchParams);
  },
});

// Convex action to test eBay credentials
export const testCredentials = action({
  args: {},
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (ctx): Promise<{ success: boolean; message: string; details?: string }> => {
    // Get credential metadata (no secrets)
    const credentials = await ctx.runAction(api.credentials.getSiteCredentials, {
      site: "ebay",
    });

    if (!credentials) {
      return {
        success: false,
        message: "No credentials found for eBay",
        details: "Please save your credentials for eBay before testing. Go to the credentials section and enter your username and password."
      };
    }

    // Placeholder - implement actual eBay API authentication test
    return {
      success: true,
      message: `eBay credentials found for ${credentials.username}. API testing not yet implemented.`,
      details: "This is a placeholder. Actual eBay API authentication testing will be implemented in a future update."
    };
  },
});
