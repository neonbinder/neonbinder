// Per-user state reset for E2E test isolation.
//
// Problem: NEW_PROFILE_TEST_EMAIL_<worker> and TEST_EMAIL_<worker> resolve to
// fixed Clerk users that are reused across CI runs. After a flow successfully
// saves profile data, the next run's `assertVisible "→ paypal.me/<expected>"`
// step sees the *previous* run's handle and Maestro `inputText` (which appends
// rather than replaces) produces concatenated garbage.
//
// Fix: a test flow signs the user in, then calls this mutation to wipe that
// user's own per-user state before the assertions run.
//
// Security posture — why this is safe as a *public* mutation:
// - It is scoped to the CALLER: it deletes only rows owned by
//   getCurrentUserId(ctx). A signed-in user can only wipe their own data, never
//   anyone else's. There is no clerkUserId argument to spoof.
// - It is gated by the presence of the TESTING_RESET_SECRET env var on the
//   Convex deployment. That var is set on dev + preview deployments only;
//   production has no value, so the mutation throws there and real users'
//   profiles can never be deleted. (We check presence, not the value — it's
//   purely an on/off flag here. The value is never sent to the client, so it
//   can't leak through the bundle the way a Maestro `-e` secret would.)
// - Deletes are strictly scoped to the three per-user tables via the by_user
//   index. No bulk-wipe paths, no cross-user reach.

import { mutation, action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";

export const resetMyTestState = mutation({
  args: {},
  returns: v.object({
    publicProfiles: v.number(),
    userProfiles: v.number(),
    prizePool: v.number(),
  }),
  handler: async (ctx) => {
    // Fail closed in production: the enabling flag is unset there.
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test reset is not enabled on this deployment");
    }

    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const publicProfiles = await ctx.db
      .query("publicProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of publicProfiles) {
      await ctx.db.delete(row._id);
    }

    const userProfiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of userProfiles) {
      await ctx.db.delete(row._id);
    }

    const prizePool = await ctx.db
      .query("prizePool")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of prizePool) {
      await ctx.db.delete(row._id);
    }

    return {
      publicProfiles: publicProfiles.length,
      userProfiles: userProfiles.length,
      prizePool: prizePool.length,
    };
  },
});

// Server-side marketplace-credential seeding for E2E test isolation (NEO-29).
//
// Problem: Maestro flows used to receive real BSC/SportLots passwords via `-e`
// env, which Maestro serializes into its public CI debug artifacts. Instead,
// the dev test user's credentials are now seeded server-side from Convex env
// vars and never touch Maestro at all.
//
// Same security posture as resetMyTestState: scoped to the CALLER (seeds only
// getCurrentUserId's own credentials), gated by presence of TESTING_RESET_SECRET
// (set on dev + preview only — fails closed in production), and reads the secret
// values exclusively from server env (DEV_*), never from client arguments. The
// returned summary is booleans only — no username/password/token is echoed.
const SEED_SITE_ENV: Record<string, { username: string; password: string }> = {
  buysportscards: { username: "DEV_BSC_USERNAME", password: "DEV_BSC_PASSWORD" },
  sportlots: { username: "DEV_SPORTLOTS_USERNAME", password: "DEV_SPORTLOTS_PASSWORD" },
};

export const seedMyTestCredentials = action({
  args: { sites: v.optional(v.array(v.string())) },
  returns: v.object({
    seeded: v.array(
      v.object({
        site: v.string(),
        stored: v.boolean(),
        skipped: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    // Fail closed in production: the enabling flag is unset there.
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test credential seeding is not enabled on this deployment");
    }

    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const sites = args.sites ?? ["buysportscards", "sportlots"];
    const seeded: Array<{
      site: string;
      stored: boolean;
      skipped?: boolean;
    }> = [];

    for (const site of sites) {
      const envKeys = SEED_SITE_ENV[site];
      const username = envKeys ? process.env[envKeys.username] : undefined;
      const password = envKeys ? process.env[envKeys.password] : undefined;
      if (!username || !password) {
        // No dev creds configured for this site on this deployment — skip
        // rather than failing the whole seed call.
        seeded.push({ site, stored: false, skipped: true });
        continue;
      }

      // IDEMPOTENT, BUT SELF-HEALING: skip the re-store ONLY when the secret
      // already holds the correct (canonical env) username. Re-storing matters
      // because the browser service's PUT /credentials
      // (secrets-manager.updateCredentials) writes a username/password-only
      // secret version that WIPES the cached marketplace token. Since every
      // flow routes its sign-in through /testing/seed-credentials, re-storing
      // on each flow wiped the token every time and forced a fresh Puppeteer
      // login per flow — a login storm that intermittently 500s/400s under the
      // browser service's rate limiter (NEO-29 CI run 26577449109). Skipping
      // when the stored creds are correct keeps the warmed token intact so
      // subsequent flows reuse it.
      //
      // The original "skip whenever ANY secret exists" was too coarse: a worker
      // whose secret held a STALE username from a prior run was never refreshed,
      // so its warm logged in with the bad username and SportLots returned
      // "Not a valid Email Address" (NEO-29 run 26618163560, worker
      // user_3DPlQMAl…). Comparing the stored username to the env value lets us
      // overwrite a stale secret (which correctly wipes its dead token and
      // forces a fresh, correct login) while still skipping — and preserving the
      // token — on the common, already-correct path.
      //
      // We never authenticate here either: a real login takes 30-65s and this
      // action is awaited by the seed page before it redirects, so warming here
      // would blow past the flows' post-redirect wait budget. Token warming is
      // done where a flow can afford it, by tapping "Test Credentials"
      // (util-login-to-bsc / util-login-to-sportlots); adapters also mint a
      // token lazily via getSiteToken on first fetch.
      const existing = await ctx.runAction(api.credentials.getSiteCredentials, {
        site,
      });
      // Marketplace usernames are emails (case-insensitive, no surrounding
      // whitespace). Compare normalized so benign casing/whitespace drift does
      // NOT trigger a needless re-store (which would wipe the warmed token and
      // reopen the storm). A genuine mismatch — or no secret at all — re-stores.
      const norm = (value: string) => value.trim().toLowerCase();
      const credsMatch = !!existing && norm(existing.username) === norm(username);
      if (credsMatch) {
        // Correct secret already present — ensure the flag (a prior
        // /testing/reset may have cleared the userProfile row while Secret
        // Manager kept the creds) and leave the stored token untouched.
        await ctx.runMutation(api.userProfile.updateSiteCredentialStatus, {
          site,
          hasCredentials: true,
        });
        seeded.push({ site, stored: true });
        continue;
      }

      const storeResult = await ctx.runAction(api.credentials.storeSiteCredentials, {
        site,
        username,
        password,
      });
      if (storeResult.success) {
        await ctx.runMutation(api.userProfile.updateSiteCredentialStatus, {
          site,
          hasCredentials: true,
        });
      }

      seeded.push({ site, stored: storeResult.success });
    }

    return { seeded };
  },
});
