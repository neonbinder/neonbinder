import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";

const USERNAME_REGEX = /^[a-z0-9-]+$/;

const publicProfileFields = {
  userId: v.string(),
  username: v.string(),
  displayName: v.optional(v.string()),
  photoUrl: v.optional(v.string()),
  tagline: v.optional(v.string()),
  brandColor1: v.optional(v.string()),
  brandColor2: v.optional(v.string()),
  ebayUrl: v.optional(v.string()),
  buySportsCardsUrl: v.optional(v.string()),
  sportlotsUrl: v.optional(v.string()),
  mySlabsUrl: v.optional(v.string()),
  myCardPostUrl: v.optional(v.string()),
  paypalUsername: v.optional(v.string()),
  paypalEmail: v.optional(v.string()),
  venmoUsername: v.optional(v.string()),
  cashAppUsername: v.optional(v.string()),
  twitterUrl: v.optional(v.string()),
  instagramUrl: v.optional(v.string()),
  tiktokUrl: v.optional(v.string()),
  youtubeUrl: v.optional(v.string()),
  facebookUrl: v.optional(v.string()),
  threadsUrl: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

/**
 * Get the current user's public profile (for the edit form)
 */
export const getMyPublicProfile = query({
  args: {},
  returns: v.union(
    v.object({
      ...publicProfileFields,
      _id: v.id("publicProfiles"),
      _creationTime: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return null;

    const profile = await ctx.db
      .query("publicProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    return profile ?? null;
  },
});

/**
 * Check if a username is available (no auth required — live uniqueness check)
 */
export const checkUsernameAvailable = query({
  args: { username: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!USERNAME_REGEX.test(args.username)) return false;

    const existing = await ctx.db
      .query("publicProfiles")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();

    return existing === null;
  },
});

/**
 * Create or update the current user's public profile
 */
export const upsertPublicProfile = mutation({
  args: {
    username: v.string(),
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    tagline: v.optional(v.string()),
    brandColor1: v.optional(v.string()),
    brandColor2: v.optional(v.string()),
    ebayUrl: v.optional(v.string()),
    buySportsCardsUrl: v.optional(v.string()),
    sportlotsUrl: v.optional(v.string()),
    mySlabsUrl: v.optional(v.string()),
    myCardPostUrl: v.optional(v.string()),
    paypalUsername: v.optional(v.string()),
    paypalEmail: v.optional(v.string()),
    venmoUsername: v.optional(v.string()),
    cashAppUsername: v.optional(v.string()),
    twitterUrl: v.optional(v.string()),
    instagramUrl: v.optional(v.string()),
    tiktokUrl: v.optional(v.string()),
    youtubeUrl: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    threadsUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (!USERNAME_REGEX.test(args.username)) {
      throw new Error("Username may only contain lowercase letters, numbers, and hyphens");
    }

    // Check uniqueness — allow the current user to keep their own username
    const existingByUsername = await ctx.db
      .query("publicProfiles")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();

    if (existingByUsername && existingByUsername.userId !== userId) {
      throw new Error("Username already taken");
    }

    const now = Date.now();

    const existingOwn = await ctx.db
      .query("publicProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existingOwn) {
      await ctx.db.patch(existingOwn._id, {
        ...args,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("publicProfiles", {
        userId,
        ...args,
        createdAt: now,
        updatedAt: now,
      });
    }

    return null;
  },
});

/**
 * Get the current user's profile completeness as a percentage.
 * Tracks which optional fields are filled out.
 */
export const getProfileCompleteness = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return 0;

    const profile = await ctx.db
      .query("publicProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (!profile) return 0;

    // Fields that count toward profile completeness
    const trackedFields = [
      "displayName",
      "photoUrl",
      "tagline",
      "brandColor1",
      "brandColor2",
      "ebayUrl",
      "buySportsCardsUrl",
      "sportlotsUrl",
      "mySlabsUrl",
      "myCardPostUrl",
      "paypalUsername",
      "paypalEmail",
      "venmoUsername",
      "cashAppUsername",
      "twitterUrl",
      "instagramUrl",
      "tiktokUrl",
      "youtubeUrl",
      "facebookUrl",
      "threadsUrl",
    ] as const;

    const filled = trackedFields.filter(
      (field) => profile[field] !== undefined && profile[field] !== ""
    ).length;

    // username is required and always set, so count it as +1 filled / +1 total
    return Math.round(((filled + 1) / (trackedFields.length + 1)) * 100);
  },
});

/**
 * Fetch a public profile by username — no auth required, omits userId
 */
export const getPublicProfileByUsername = query({
  args: { username: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("publicProfiles"),
      _creationTime: v.number(),
      username: v.string(),
      displayName: v.optional(v.string()),
      photoUrl: v.optional(v.string()),
      tagline: v.optional(v.string()),
      brandColor1: v.optional(v.string()),
      brandColor2: v.optional(v.string()),
      ebayUrl: v.optional(v.string()),
      buySportsCardsUrl: v.optional(v.string()),
      sportlotsUrl: v.optional(v.string()),
      mySlabsUrl: v.optional(v.string()),
      myCardPostUrl: v.optional(v.string()),
      paypalUsername: v.optional(v.string()),
      paypalEmail: v.optional(v.string()),
      venmoUsername: v.optional(v.string()),
      cashAppUsername: v.optional(v.string()),
      twitterUrl: v.optional(v.string()),
      instagramUrl: v.optional(v.string()),
      tiktokUrl: v.optional(v.string()),
      youtubeUrl: v.optional(v.string()),
      facebookUrl: v.optional(v.string()),
      threadsUrl: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("publicProfiles")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();

    if (!profile) return null;

    // Omit userId from public response
    const { userId: _userId, ...publicData } = profile;
    return publicData;
  },
});
