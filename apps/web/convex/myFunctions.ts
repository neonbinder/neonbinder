import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { getCurrentUserId } from "./auth";

// Write your Convex functions in any file inside this directory (`convex`).
// See https://docs.convex.dev/functions for more.

// You can read data from the database via a query:
export const listNumbers = query({
  // Validators for arguments.
  args: {
    count: v.number(),
  },

  // Query implementation.
  handler: async (ctx, args) => {
    //// Read the database as many times as you need here.
    //// See https://docs.convex.dev/database/reading-data.
    const numbers = await ctx.db
      .query("numbers")
      // Ordered by _creationTime, return most recent
      .order("desc")
      .take(args.count);
    const userId = await getCurrentUserId(ctx);
    // For Clerk, we don't need to fetch a user from the database
    // The userId is the Clerk user ID (string)
    return {
      viewer: userId, // Just return the Clerk user ID
      numbers: numbers.reverse().map((number) => number.value),
    };
  },
});

// Test authentication endpoint
export const testAuth = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    console.log("Auth identity:", identity);
    return {
      authenticated: !!identity,
      userId: identity?.subject || "not authenticated",
      email: identity?.email || "no email",
      name: identity?.name || "no name",
    };
  },
});

// You can write data to the database via a mutation:
export const addNumber = mutation({
  // Validators for arguments.
  args: {
    value: v.number(),
  },

  // Mutation implementation.
  handler: async (ctx, args) => {
    //// Insert or modify documents in the database here.
    //// Mutations can also read from the database like queries.
    //// See https://docs.convex.dev/database/writing-data.

    const id = await ctx.db.insert("numbers", { value: args.value });

    console.log("Added new document with id:", id);
    // Optionally, return a value from your mutation.
    // return id;
  },
});

// You can fetch data from and send data to third-party APIs via an action:
export const myAction = action({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },
  returns: v.null(),
  // Action implementation.
  handler: async (ctx, args) => {
    //// Use the browser-like `fetch` API to send HTTP requests.
    //// See https://docs.convex.dev/functions/actions#calling-third-party-apis-and-using-npm-packages.
    // const response = await ctx.fetch("https://api.thirdpartyservice.com");
    // const data = await response.json();

    //// Query data by running Convex queries.
    const data = await ctx.runQuery(api.myFunctions.listNumbers, {
      count: 10,
    });
    console.log(data);

    //// Write data by running Convex mutations.
    await ctx.runMutation(api.myFunctions.addNumber, {
      value: args.first,
    });
  },
});

// ===== SET SELECTIONS MANAGEMENT =====

export const createSetSelection = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    sport: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    year: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    manufacturer: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    setName: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    variantType: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    insert: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    parallel: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
  },
  returns: v.id("setSelections"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("setSelections", {
      name: args.name,
      description: args.description,
      sport: args.sport,
      year: args.year,
      manufacturer: args.manufacturer,
      setName: args.setName,
      variantType: args.variantType,
      insert: args.insert,
      parallel: args.parallel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return id;
  },
});

export const updateSetSelection = mutation({
  args: {
    id: v.id("setSelections"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    sport: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    year: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    manufacturer: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    setName: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    variantType: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    insert: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
    parallel: v.optional(
      v.array(v.object({ site: v.string(), value: v.string() })),
    ),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, {
      ...updates,
      updatedAt: Date.now(),
    });
  },
});

export const getSetSelection = query({
  args: { id: v.id("setSelections") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("setSelections"),
      _creationTime: v.number(),
      name: v.string(),
      description: v.string(),
      sport: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      year: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      manufacturer: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      setName: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      variantType: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      insert: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      parallel: v.optional(
        v.array(v.object({ site: v.string(), value: v.string() })),
      ),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listSetSelections = query({
  handler: async (ctx) => {
    return await ctx.db.query("setSelections").order("desc").collect();
  },
});

// ===== SELECTOR OPTIONS =====
// Selector logic has been extracted to convex/selectorOptions.ts
// Re-export getSelectorOptions for backward compatibility with existing frontend components
export { getSelectorOptions } from "./selectorOptions";
