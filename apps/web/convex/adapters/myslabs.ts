"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { BaseAdapter, CardAdapter, CardSearchParams, CardListingsResponse, CardListing } from "./base";

export class MySlabsAdapter extends BaseAdapter implements CardAdapter {
  private baseUrl = "https://www.myslabs.com";

  async searchCards(params: CardSearchParams): Promise<CardListingsResponse> {
    try {
      // Build search query for MySlabs
      const searchParams = {
        search: params.cardName,
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
      const data = await this.parseJsonResponse(response) as MySlabsResponse;

      // Transform the response to our standard format
      const listings: CardListing[] = data.cards.map(item => ({
        id: item.card_id,
        title: item.card_name,
        price: item.price,
        condition: item.grade,
        quantity: item.quantity,
        imageUrl: item.image_url,
        platform: "myslabs",
        url: `${this.baseUrl}/card/${item.card_id}`,
        seller: item.seller,
        shipping: item.shipping_cost,
      }));

      return {
        listings,
        totalCount: data.total_cards,
        platform: "myslabs",
      };
    } catch (error) {
      console.error("Error searching MySlabs:", error);
      throw new Error(`Failed to search MySlabs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// MySlabs API response types
interface MySlabsResponse {
  cards: Array<{
    card_id: string;
    card_name: string;
    price: number;
    grade?: string;
    quantity: number;
    image_url?: string;
    seller?: string;
    shipping_cost?: number;
  }>;
  total_cards: number;
}

// Convex action to search MySlabs
export const searchMySlabs = action({
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
    const adapter = new MySlabsAdapter();
    return await adapter.searchCards(args);
  },
}); 