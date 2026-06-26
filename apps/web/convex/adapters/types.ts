import { v } from "convex/values";

// Common types for card listings across platforms
export const CardListingSchema = v.object({
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
});

export const SetListingSchema = v.object({
  id: v.string(),
  setName: v.string(),
  year: v.number(),
  sport: v.string(),
  manufacturer: v.string(),
  totalCards: v.optional(v.number()),
  price: v.number(),
  condition: v.optional(v.string()),
  platform: v.string(),
  url: v.string(),
  seller: v.optional(v.string()),
});

// Platform types
export const PlatformType = v.union(
  v.literal("buysportscards"),
  v.literal("ebay"),
  v.literal("sportlots"),
  v.literal("myslabs"),
  v.literal("mycardpost")
);

// Search parameters for ListByCard adapters
export const CardSearchParamsSchema = v.object({
  cardName: v.string(),
  year: v.optional(v.number()),
  sport: v.optional(v.string()),
  manufacturer: v.optional(v.string()),
  condition: v.optional(v.string()),
  maxPrice: v.optional(v.number()),
  minPrice: v.optional(v.number()),
});

// Search parameters for ListBySet adapters
export const SetSearchParamsSchema = v.object({
  setName: v.string(),
  year: v.optional(v.number()),
  sport: v.optional(v.string()),
  manufacturer: v.optional(v.string()),
  maxPrice: v.optional(v.number()),
  minPrice: v.optional(v.number()),
});

// Response schemas
export const CardListingsResponseSchema = v.object({
  listings: v.array(CardListingSchema),
  totalCount: v.number(),
  platform: v.string(),
});

export const SetListingsResponseSchema = v.object({
  listings: v.array(SetListingSchema),
  totalCount: v.number(),
  platform: v.string(),
}); 