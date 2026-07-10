// Unit tests for the per-(user, site) credential-operation OCC lease lock.
//
// Functions under test (internalMutations — not client-reachable):
//   acquireCredentialLock({ userId, site, op, token }) → { acquired, heldBy? }
//   releaseCredentialLock({ userId, site, token }) → null
//
// The lock serializes credential ops (store / test / delete) so concurrent
// actions (e.g. a Clear racing an in-flight marketplace login) cannot corrupt
// the stored token. Acquisition is race-free because Convex mutations are
// serializable — no compare-and-swap needed. A lease older than
// CRED_LOCK_LEASE_MS is stale and reclaimable (crash-recovery path).
//
// Security requirement: getUserProfile MUST strip lockToken before returning
// it to the client; only lockedAt/lockedOp may be exposed.
//
// Isolation requirement: locks are scoped to (userId, site) — a lock on
// (userA, bsc) must not affect (userB, bsc) or (userA, sportlots).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { CRED_LOCK_LEASE_MS } from "./userProfile";

// ---------------------------------------------------------------------------
// NEO-89: updateUserProfile can no longer touch siteCredentials/hasCredentials
// ---------------------------------------------------------------------------
// Previously `updateUserProfile` accepted an arbitrary `siteCredentials` array
// as one of its args, letting a client directly claim `hasCredentials: true`
// for a site outside the actual save/delete flow (never exploited — grepped
// zero real callers — but a real spoofing vector on a general-purpose
// mutation). Credential status is now exclusively written by
// `credentials.saveCredentials` via the internal-only mutations below.

// convex-test v0.0.53 requires import.meta.glob to discover all modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

// ---------------------------------------------------------------------------
// Shared test identities and constants
// ---------------------------------------------------------------------------

const USER_A = "user_lock_aaaa1111";
const USER_B = "user_lock_bbbb2222";
const SITE_BSC = "buysportscards";
const SITE_SL = "sportlots";

// ---------------------------------------------------------------------------
// Helper: read the raw siteCredentials entry for (userId, site) directly from
// the DB, bypassing the getUserProfile projection. This lets us assert on
// lockToken, which getUserProfile intentionally strips.
// ---------------------------------------------------------------------------
async function getRawEntry(
  t: ReturnType<typeof convexTest>,
  userId: string,
  site: string,
) {
  return t.run(async (ctx) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return profile?.siteCredentials?.find((c) => c.site === site) ?? null;
  });
}

// ---------------------------------------------------------------------------
// Helper: seed a userProfiles row with a single siteCredentials entry.
// Pass lockedAt/lockToken/lockedOp to pre-set a lock state.
// ---------------------------------------------------------------------------
async function seedProfile(
  t: ReturnType<typeof convexTest>,
  userId: string,
  site: string,
  opts: {
    hasCredentials?: boolean;
    lockedAt?: number;
    lockedOp?: "store" | "test" | "delete";
    lockToken?: string;
  } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId,
      siteCredentials: [
        {
          site,
          hasCredentials: opts.hasCredentials ?? false,
          ...(opts.lockedAt !== undefined ? { lockedAt: opts.lockedAt } : {}),
          ...(opts.lockedOp !== undefined ? { lockedOp: opts.lockedOp } : {}),
          ...(opts.lockToken !== undefined ? { lockToken: opts.lockToken } : {}),
        },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// acquireCredentialLock
// ---------------------------------------------------------------------------

describe("acquireCredentialLock", () => {
  test("should return acquired:true on a free key and persist lock fields", async () => {
    // No prior profile — the mutation must create the profile row and add an
    // entry with lockedAt / lockedOp / lockToken set.
    const t = convexTest(schema, modules);
    const TOKEN = "tok-acquire-free";

    const result = await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "test",
      token: TOKEN,
    });

    expect(result).toEqual({ acquired: true });

    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    expect(entry).not.toBeNull();
    expect(entry!.lockedAt).toBeTypeOf("number");
    expect(entry!.lockedOp).toBe("test");
    expect(entry!.lockToken).toBe(TOKEN);
  });

  test("should return acquired:false when a live lock (different token) is held", async () => {
    // Seed a live lock (lockedAt just set, well within the lease window).
    const t = convexTest(schema, modules);
    const HELD_TOKEN = "tok-held-live";
    const liveLockedAt = Date.now(); // definitely within CRED_LOCK_LEASE_MS

    await seedProfile(t, USER_A, SITE_BSC, {
      lockedAt: liveLockedAt,
      lockedOp: "store",
      lockToken: HELD_TOKEN,
    });

    const result = await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "test",
      token: "tok-challenger",
    });

    expect(result).toEqual({ acquired: false, heldBy: "store" });

    // The original lock must be untouched.
    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    expect(entry!.lockToken).toBe(HELD_TOKEN);
    expect(entry!.lockedAt).toBe(liveLockedAt);
  });

  test("should reclaim a stale lock (lockedAt > CRED_LOCK_LEASE_MS ago) and return acquired:true", async () => {
    // Set lockedAt just past the lease expiry so the lock is stale.
    const t = convexTest(schema, modules);
    const OLD_TOKEN = "tok-stale-old";
    const staleLockedAt = Date.now() - CRED_LOCK_LEASE_MS - 1000;

    await seedProfile(t, USER_A, SITE_BSC, {
      hasCredentials: true,
      lockedAt: staleLockedAt,
      lockedOp: "store",
      lockToken: OLD_TOKEN,
    });

    const NEW_TOKEN = "tok-reclaimed";
    const result = await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "delete",
      token: NEW_TOKEN,
    });

    expect(result).toEqual({ acquired: true });

    // The new token must now hold the lock; old token is gone.
    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    expect(entry!.lockToken).toBe(NEW_TOKEN);
    expect(entry!.lockedOp).toBe("delete");
    expect(entry!.lockToken).not.toBe(OLD_TOKEN);
    // hasCredentials must be preserved through the reclaim.
    expect(entry!.hasCredentials).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// releaseCredentialLock
// ---------------------------------------------------------------------------

describe("releaseCredentialLock", () => {
  test("should clear lock fields when the token matches, preserving site and hasCredentials", async () => {
    const t = convexTest(schema, modules);
    const TOKEN = "tok-release-match";

    await seedProfile(t, USER_A, SITE_BSC, {
      hasCredentials: true,
      lockedAt: Date.now(),
      lockedOp: "test",
      lockToken: TOKEN,
    });

    await t.mutation(internal.userProfile.releaseCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      token: TOKEN,
    });

    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    // Lock fields must be gone.
    expect(entry!.lockedAt).toBeUndefined();
    expect(entry!.lockedOp).toBeUndefined();
    expect(entry!.lockToken).toBeUndefined();
    // Structural fields must be preserved.
    expect(entry!.site).toBe(SITE_BSC);
    expect(entry!.hasCredentials).toBe(true);
  });

  test("should be a no-op when the token does NOT match (lock stays intact)", async () => {
    const t = convexTest(schema, modules);
    const REAL_TOKEN = "tok-real-holder";
    const liveLockedAt = Date.now();

    await seedProfile(t, USER_A, SITE_BSC, {
      lockedAt: liveLockedAt,
      lockedOp: "store",
      lockToken: REAL_TOKEN,
    });

    // Attempt to release with a wrong token — must be a no-op.
    await t.mutation(internal.userProfile.releaseCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      token: "tok-wrong-token",
    });

    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    // Original lock must still be in place.
    expect(entry!.lockToken).toBe(REAL_TOKEN);
    expect(entry!.lockedAt).toBe(liveLockedAt);
    expect(entry!.lockedOp).toBe("store");
  });

  test("should be a no-op (no throw) when the siteCredentials entry has been removed", async () => {
    // Seed a profile with NO siteCredentials for BSC — simulates the case where
    // a delete op removed the entry before the lock could be released.
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [], // BSC entry absent
      });
    });

    // Must not throw even though the entry doesn't exist.
    await expect(
      t.mutation(internal.userProfile.releaseCredentialLock, {
        userId: USER_A,
        site: SITE_BSC,
        token: "tok-ghost",
      }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SECURITY: getUserProfile must strip lockToken
// ---------------------------------------------------------------------------

describe("getUserProfile — lockToken projection security", () => {
  test("should expose lockedAt and lockedOp but NOT lockToken after acquiring a lock", async () => {
    const t = convexTest(schema, modules);
    const TOKEN = "tok-secret-server-only";

    // Acquire a lock so the DB row has all three lock fields.
    await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "store",
      token: TOKEN,
    });

    // getUserProfile is a public query gated on the caller's auth identity.
    const profile = await t
      .withIdentity({ subject: USER_A })
      .query(api.userProfile.getUserProfile, {});

    expect(profile).not.toBeNull();
    const cred = profile!.siteCredentials?.find((c) => c.site === SITE_BSC);
    expect(cred).toBeDefined();

    // lockedAt and lockedOp drive the reactive UI — must be present.
    expect(cred!.lockedAt).toBeTypeOf("number");
    expect(cred!.lockedOp).toBe("store");

    // lockToken is server-only. The returned object must not include it as
    // any key — check both undefined value and key absence.
    expect("lockToken" in cred!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation: lock scoping across users and sites
// ---------------------------------------------------------------------------

describe("lock isolation across (userId, site) pairs", () => {
  test("a lock on (userA, bsc) should NOT block (userB, bsc)", async () => {
    const t = convexTest(schema, modules);

    // userA acquires BSC.
    await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "store",
      token: "tok-user-a-bsc",
    });

    // userB can independently acquire BSC without being blocked.
    const result = await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_B,
      site: SITE_BSC,
      op: "test",
      token: "tok-user-b-bsc",
    });

    expect(result).toEqual({ acquired: true });
  });

  test("a lock on (userA, bsc) should NOT block (userA, sportlots)", async () => {
    const t = convexTest(schema, modules);

    // userA acquires BSC.
    await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_BSC,
      op: "store",
      token: "tok-user-a-bsc",
    });

    // The same user can independently acquire a different site.
    const result = await t.mutation(internal.userProfile.acquireCredentialLock, {
      userId: USER_A,
      site: SITE_SL,
      op: "delete",
      token: "tok-user-a-sl",
    });

    expect(result).toEqual({ acquired: true });

    // Verify both locks coexist independently.
    const bscEntry = await getRawEntry(t, USER_A, SITE_BSC);
    const slEntry = await getRawEntry(t, USER_A, SITE_SL);
    expect(bscEntry!.lockedOp).toBe("store");
    expect(slEntry!.lockedOp).toBe("delete");
  });
});

describe("updateUserProfile — cannot spoof siteCredentials (NEO-89)", () => {
  test("passing siteCredentials is rejected by the args validator — the field no longer exists", async () => {
    const t = convexTest(schema, modules);

    // Bypass TypeScript (the whole point: the type system already forbids
    // this at compile time) to prove Convex's runtime arg validator also
    // rejects an attempt to smuggle siteCredentials through this mutation.
    const spoofedArgs = {
      siteCredentials: [
        { site: SITE_BSC, hasCredentials: true, lastUpdated: new Date().toISOString() },
      ],
    };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.withIdentity({ subject: USER_A }).mutation(api.userProfile.updateUserProfile, spoofedArgs as any),
    ).rejects.toThrow();

    // No row should have been created with a spoofed credential entry.
    const entry = await getRawEntry(t, USER_A, SITE_BSC);
    expect(entry).toBeNull();
  });

  test("preferences-only update still works normally", async () => {
    const t = convexTest(schema, modules);

    const result = await t
      .withIdentity({ subject: USER_A })
      .mutation(api.userProfile.updateUserProfile, {
        preferences: { theme: "dark" },
      });

    expect(result).toBe(true);
  });
});
