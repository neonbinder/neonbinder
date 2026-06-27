"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { BaseAdapter, CardAdapter, CardSearchParams, CardListingsResponse, CardListing } from "./base";

export class MyCardPostAdapter extends BaseAdapter implements CardAdapter {
  private baseUrl = "https://www.mycardpost.com";

  async searchCards(params: CardSearchParams): Promise<CardListingsResponse> {
    try {
      // Build search query for MyCardPost
      const searchParams = {
        q: params.cardName,
        year: params.year,
        sport: params.sport,
        brand: params.manufacturer,
        condition: params.condition,
        min_price: params.minPrice,
        max_price: params.maxPrice,
      };

      const queryString = this.buildQueryString(searchParams);
      const url = `${this.baseUrl}/api/search?${queryString}`;

      const response = await this.makeRequest(url);
      const data = await this.parseJsonResponse(response) as MyCardPostResponse;

      // Transform the response to our standard format
      const listings: CardListing[] = data.listings.map(item => ({
        id: item.listing_id,
        title: item.title,
        price: item.price,
        condition: item.condition,
        quantity: item.quantity,
        imageUrl: item.image_url,
        platform: "mycardpost",
        url: `${this.baseUrl}/listing/${item.listing_id}`,
        seller: item.seller_name,
        shipping: item.shipping_cost,
      }));

      return {
        listings,
        totalCount: data.total_count,
        platform: "mycardpost",
      };
    } catch (error) {
      console.error("Error searching MyCardPost:", error);
      throw new Error(`Failed to search MyCardPost: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// MyCardPost API response types
interface MyCardPostResponse {
  listings: Array<{
    listing_id: string;
    title: string;
    price: number;
    condition?: string;
    quantity: number;
    image_url?: string;
    seller_name?: string;
    shipping_cost?: number;
  }>;
  total_count: number;
}

// Convex action to search MyCardPost
export const searchMyCardPost = action({
  args: {
    cardName: v.string(),
    year: v.optional(v.number()),
    sport: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
    condition: v.optional(v.string()),
    maxPrice: v.optional(v.number()),
    minPrice: v.optional(v.number()),
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
    const adapter = new MyCardPostAdapter();
    return await adapter.searchCards(args);
  },
}); 