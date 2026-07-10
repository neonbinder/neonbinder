import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";

const marketplaceAccountIdsValidator = v.optional(v.object({
  bscSellerId: v.optional(v.string()),
}));

/**
 * Get the current user's profile
 */
export const getUserProfile = query({
  args: {},
  returns: v.union(
    v.object({
      userId: v.string(), // Clerk user ID as string
      siteCredentials: v.optional(v.array(v.object({
        site: v.string(),
        hasCredentials: v.boolean(),
        lastUpdated: v.optional(v.string()),
        // Lock state surfaced to the UI for the reactive in-flight disable.
        // lockToken is intentionally NOT exposed (server-only — see projection).
        lockedAt: v.optional(v.number()),
        lockedOp: v.optional(
          v.union(v.literal("store"), v.literal("test"), v.literal("delete")),
        ),
      }))),
      marketplaceAccountIds: marketplaceAccountIdsValidator,
      preferences: v.optional(v.object({
        defaultSport: v.optional(v.string()),
        defaultYear: v.optional(v.number()),
        theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
      })),
    }),
    v.null()
  ),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return null;
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (!profile) {
      return null;
    }

    return {
      userId: profile.userId,
      // Strip lockToken — it is server-only (required to release the lock and
      // never sent to the client). lockedAt/lockedOp drive the reactive UI.
      siteCredentials: (profile.siteCredentials || []).map((c) => ({
        site: c.site,
        hasCredentials: c.hasCredentials,
        lastUpdated: c.lastUpdated,
        lockedAt: c.lockedAt,
        lockedOp: c.lockedOp,
      })),
      marketplaceAccountIds: profile.marketplaceAccountIds,
      preferences: profile.preferences,
    };
  },
});

/**
 * Internal mutation to upsert a marketplace-specific account identifier
 * (e.g. BSC sellerId) onto the user's profile. Called from the BSC login
 * action after the browser service returns the sellerId; never invoked
 * directly from the client.
 *
 * Note: only known sites are accepted to keep the validator surface tight.
 * Adding a new marketplace means extending this switch alongside the schema.
 */
export const setMarketplaceAccountIdInternal = internalMutation({
  args: {
    userId: v.string(),
    site: v.union(v.literal("buysportscards")),
    accountId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Defensive validation: accountId comes from the marketplace's profile
    // response (e.g., BSC's sellerProfile.sellerId). If their response
    // shape ever drifts and we accidentally read a different field,
    // we'd persist an arbitrary string that then lands in our HTTP
    // request bodies + log lines. Cap length and whitelist characters
    // so a malformed upstream payload can't pollute downstream calls.
    if (args.accountId.length === 0 || args.accountId.length > 64) {
      throw new Error(
        `[setMarketplaceAccountIdInternal] accountId length out of range (1-64), got ${args.accountId.length}`,
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(args.accountId)) {
      throw new Error(
        `[setMarketplaceAccountIdInternal] accountId contains invalid characters (allow A-Z a-z 0-9 _ -)`,
      );
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    const nextAccounts = {
      ...(profile?.marketplaceAccountIds ?? {}),
      ...(args.site === "buysportscards" ? { bscSellerId: args.accountId } : {}),
    };

    if (profile) {
      await ctx.db.patch(profile._id, { marketplaceAccountIds: nextAccounts });
    } else {
      await ctx.db.insert("userProfiles", {
        userId: args.userId,
        marketplaceAccountIds: nextAccounts,
      });
    }
    return null;
  },
});

/**
 * Update user profile preferences.
 *
 * NEO-89: `siteCredentials` was previously an accepted arg here too, which let
 * any client directly set `hasCredentials` outside the save/delete flow —
 * dead code in practice (grepped: zero frontend callers ever passed it), but
 * a real spoofing vector on a general-purpose mutation. Credential status is
 * now exclusively written by `credentials.saveCredentials` via the internal
 * mutations below.
 */
export const updateUserProfile = mutation({
  args: {
    preferences: v.optional(v.object({
      defaultSport: v.optional(v.string()),
      defaultYear: v.optional(v.number()),
      theme: v.optional(v.union(v.literal("light"), v.literal("dark"))),
    })),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (args.preferences === undefined) {
      return true;
    }

    if (profile) {
      await ctx.db.patch(profile._id, { preferences: args.preferences });
    } else {
      await ctx.db.insert("userProfiles", {
        userId,
        preferences: args.preferences,
      });
    }

    return true;
  },
});

/**
 * Update a specific site's credential status.
 *
 * NEO-89: internal — was a public mutation the frontend called as a SECOND,
 * separate network call after the browser-service secret write succeeded.
 * If that second call never fired (client interrupted/killed/navigated away
 * between the two), Convex kept believing credentials existed after the
 * underlying secret was gone — a permanent "ghost credentials" state with no
 * self-healing. Now only reachable from `credentials.saveCredentials`,
 * called server-side in the same action as the secret write, so the two can
 * no longer drift apart. `userId` is passed explicitly (matching
 * `acquireCredentialLock` below) since this runs via `ctx.runMutation` from a
 * "use node" action file, not from a client request with its own auth ctx.
 */
export const updateSiteCredentialStatus = internalMutation({
  args: {
    userId: v.string(),
    site: v.string(),
    hasCredentials: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    const currentCredentials = profile?.siteCredentials || [];
    const existingIndex = currentCredentials.findIndex(cred => cred.site === args.site);

    const updatedCredentials = [...currentCredentials];

    if (existingIndex >= 0) {
      // Update existing entry
      updatedCredentials[existingIndex] = {
        ...updatedCredentials[existingIndex],
        hasCredentials: args.hasCredentials,
        lastUpdated: new Date().toISOString(),
      };
    } else {
      // Add new entry
      updatedCredentials.push({
        site: args.site,
        hasCredentials: args.hasCredentials,
        lastUpdated: new Date().toISOString(),
      });
    }

    if (profile) {
      await ctx.db.patch(profile._id, {
        siteCredentials: updatedCredentials,
      });
    } else {
      await ctx.db.insert("userProfiles", {
        userId: args.userId,
        siteCredentials: updatedCredentials,
      });
    }

    return null;
  },
});

/**
 * Remove a site's credential status.
 *
 * NEO-89: internal — same reasoning as `updateSiteCredentialStatus`. Also now
 * the self-healing target: `credentials.getSiteToken` calls this directly
 * when it discovers the underlying secret is missing during an automatic
 * re-auth attempt, so the UI stops showing stale "saved" state regardless of
 * how the drift happened.
 */
export const removeSiteCredentialStatus = internalMutation({
  args: {
    userId: v.string(),
    site: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    if (profile && profile.siteCredentials) {
      const updatedCredentials = profile.siteCredentials.filter(
        cred => cred.site !== args.site
      );

      await ctx.db.patch(profile._id, {
        siteCredentials: updatedCredentials,
      });
    }

    return null;
  },
});

// ─── Per-(user, site) credential-operation lock ──────────────────────────────
// Serializes store / test-login / delete so a Clear can't race an in-flight
// marketplace login and corrupt the stored token. A lock older than the lease
// is stale and reclaimable (covers a crashed login that never released). Sized
// above the worst-case login (loginWithRetry in credentials.ts: 60s/attempt ×
// up to 4 retries + backoff = 270s). The happy path releases immediately in a
// finally, so the lease only matters as a crash-recovery ceiling.
// ⚠️ MAINTENANCE (security): if loginWithRetry's maxAttempts or per-attempt
// timeout is raised, raise this lease in lockstep — otherwise a stale-lease
// reclaim could hijack a still-running login (security-auditor, 2026-06-19).
// The client mirror in app/profile/page.tsx must stay >= this value.
export const CRED_LOCK_LEASE_MS = 5 * 60 * 1000;

const lockedOpValidator = v.union(
  v.literal("store"),
  v.literal("test"),
  v.literal("delete"),
);

/**
 * NEO-89: read-only lock check for `credentials.getSiteToken`'s self-heal
 * path. When a token fetch discovers the secret is missing (404), it clears
 * the stale `hasCredentials` flag — but if a `saveCredentials` store is
 * ACTIVELY writing that same secret right now, the 404 is an expected
 * mid-write transient, not evidence of a truly-missing secret, and
 * self-healing would both (a) wipe the flag right out from under the
 * in-flight store's own imminent "set true", and (b) clobber the lock entry
 * the store is currently holding (`removeSiteCredentialStatus` filters the
 * whole siteCredentials entry, lock fields included). Skip the self-heal
 * whenever a live lock is held; a stale/expired lock is not a false positive
 * (defeats the exact purpose of a lease).
 */
export const hasLiveCredentialLock = internalQuery({
  args: {
    userId: v.string(),
    site: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const entry = profile?.siteCredentials?.find((c) => c.site === args.site);
    return !!(
      entry?.lockedAt != null && entry.lockedAt + CRED_LOCK_LEASE_MS > Date.now()
    );
  },
});

/**
 * Acquire the per-(user, site) credential lock. Called via ctx.runMutation from
 * the node actions in credentials.ts, so userId is passed explicitly
 * (internalMutation — not client-reachable). Convex mutations are serializable,
 * so this read-check-set is race-free (two concurrent acquires can't both win).
 * Returns { acquired: false, heldBy } when a live (non-lease-expired) lock
 * already exists; the caller treats that as "operation in progress".
 */
export const acquireCredentialLock = internalMutation({
  args: {
    userId: v.string(),
    site: v.string(),
    op: lockedOpValidator,
    token: v.string(),
  },
  returns: v.object({
    acquired: v.boolean(),
    heldBy: v.optional(lockedOpValidator),
  }),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    const current = profile?.siteCredentials || [];
    const idx = current.findIndex((c) => c.site === args.site);
    const existing = idx >= 0 ? current[idx] : undefined;

    // A live lock blocks acquisition; a stale (lease-expired) one is reclaimable.
    if (
      existing?.lockedAt != null &&
      existing.lockedAt + CRED_LOCK_LEASE_MS > Date.now()
    ) {
      return { acquired: false, heldBy: existing.lockedOp };
    }

    const lockedEntry = {
      site: args.site,
      hasCredentials: existing?.hasCredentials ?? false,
      lastUpdated: existing?.lastUpdated,
      lockedAt: Date.now(),
      lockedOp: args.op,
      lockToken: args.token,
    };

    const updated = [...current];
    if (idx >= 0) updated[idx] = lockedEntry;
    else updated.push(lockedEntry);

    if (profile) {
      await ctx.db.patch(profile._id, { siteCredentials: updated });
    } else {
      await ctx.db.insert("userProfiles", {
        userId: args.userId,
        siteCredentials: updated,
      });
    }

    return { acquired: true };
  },
});

/**
 * Release the per-(user, site) credential lock. Only clears the lock when the
 * token matches, so we never stomp a lock that was reclaimed after the lease
 * expired. Idempotent: a no-op if the entry is gone (e.g. a delete op removed
 * it) or the token doesn't match.
 */
export const releaseCredentialLock = internalMutation({
  args: {
    userId: v.string(),
    site: v.string(),
    token: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!profile?.siteCredentials) return null;

    const idx = profile.siteCredentials.findIndex((c) => c.site === args.site);
    if (idx < 0) return null;
    const entry = profile.siteCredentials[idx];
    if (entry.lockToken !== args.token) return null; // someone else holds it now

    const updated = [...profile.siteCredentials];
    updated[idx] = {
      site: entry.site,
      hasCredentials: entry.hasCredentials,
      lastUpdated: entry.lastUpdated,
      // lockedAt / lockedOp / lockToken dropped — lock released.
    };
    await ctx.db.patch(profile._id, { siteCredentials: updated });
    return null;
  },
});

/**
 * Create a new prize in the prize pool
 */
export const createPrize = mutation({
  args: {
    prizeName: v.string(),
    percentage: v.number(),
    pokemonImageUrl: v.optional(v.string()),
    sportsImageUrls: v.optional(v.array(v.string())),
  },
  returns: v.id("prizePool"),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const now = Date.now();
    const prizeId = await ctx.db.insert("prizePool", {
      userId,
      prizeName: args.prizeName,
      percentage: args.percentage,
      pokemonImageUrl: args.pokemonImageUrl,
      sportsImageUrls: args.sportsImageUrls,
      createdAt: now,
      updatedAt: now,
    });

    return prizeId;
  },
});

/**
 * Update an existing prize
 */
export const updatePrize = mutation({
  args: {
    prizeId: v.id("prizePool"),
    prizeName: v.string(),
    percentage: v.number(),
    pokemonImageUrl: v.optional(v.string()),
    sportsImageUrls: v.optional(v.array(v.string())),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const prize = await ctx.db.get(args.prizeId);
    if (!prize) {
      throw new Error("Prize not found");
    }

    if (prize.userId !== userId) {
      throw new Error("Unauthorized");
    }

    const updateData: {
      prizeName: string;
      percentage: number;
      updatedAt: number;
      pokemonImageUrl?: string;
      sportsImageUrls?: string[];
    } = {
      prizeName: args.prizeName,
      percentage: args.percentage,
      updatedAt: Date.now(),
    };

    if (args.pokemonImageUrl) {
      updateData.pokemonImageUrl = args.pokemonImageUrl;
    }

    if (args.sportsImageUrls) {
      updateData.sportsImageUrls = args.sportsImageUrls;
    }

    await ctx.db.patch(args.prizeId, updateData);

    return true;
  },
});

/**
 * Delete a prize from the pool
 */
export const deletePrize = mutation({
  args: {
    prizeId: v.id("prizePool"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const prize = await ctx.db.get(args.prizeId);
    if (!prize) {
      throw new Error("Prize not found");
    }

    if (prize.userId !== userId) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(args.prizeId);
    return true;
  },
});

/**
 * Get all prizes for the current user
 */
export const getPrizes = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("prizePool"),
    _creationTime: v.number(),
    userId: v.string(), // Clerk user ID as string
    prizeName: v.string(),
    percentage: v.number(),
    pokemonImageUrl: v.optional(v.string()),
    sportsImageUrls: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return [];
    }

    const prizes = await ctx.db
      .query("prizePool")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return prizes;
  },
});
