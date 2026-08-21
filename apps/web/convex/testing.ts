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
import { api, internal } from "./_generated/api";
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

/**
 * Flag the caller's own credential entry as needing re-authentication (NEO-141).
 *
 * Exists solely so E2E can reach the new sixth panel state. That state is the
 * headline UX of NEO-141 — the thing that turns NEO-140's silent wipe into
 * something a user can understand and recover from — and it is otherwise
 * untestable end-to-end: `needsReauth` is set in exactly one place, when the
 * browser service answers `reauth_required`, which requires a session that
 * genuinely exists but is dead. No UI action produces it, and the only organic
 * route is waiting out a 24h BSC refresh token. Faking the assertion in a flow
 * would be worse than having no flow, so the hook is real instead.
 *
 * Safety, in the same shape as the other helpers in this file:
 *   - fails closed in production (`TESTING_RESET_SECRET` is unset there);
 *   - only ever touches the CALLER's own row — no userId argument exists;
 *   - sets a boolean that can do nothing worse than prompt a sign-in. It grants
 *     no access, reads no secret, and cannot delete a credential.
 */
export const markSiteNeedsReauth = mutation({
  args: { site: v.string() },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test re-auth flagging is not enabled on this deployment");
    }

    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile?.siteCredentials) {
      return { updated: false };
    }

    const entry = profile.siteCredentials.find((c) => c.site === args.site);
    if (!entry) {
      return { updated: false };
    }

    await ctx.db.patch(profile._id, {
      siteCredentials: profile.siteCredentials.map((c) =>
        c.site === args.site
          ? { ...c, needsReauth: true, needsReauthSince: Date.now() }
          : c,
      ),
    });
    return { updated: true };
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
      // already holds the correct (canonical env) username. Skipping matters
      // even more since NEO-141: `saveCredentials` is now connect-and-store, so
      // a re-store performs a REAL marketplace login (30-65s) rather than the
      // old cheap PUT. Since every flow routes its sign-in through
      // /testing/seed-credentials, re-storing on each flow would mean a login
      // per flow — the storm that intermittently 500s/400s under the browser
      // service's rate limiter (NEO-29 CI run 26577449109). Skipping when the
      // stored creds are correct keeps the warmed session intact so subsequent
      // flows reuse it.
      //
      // The original "skip whenever ANY secret exists" was too coarse: a worker
      // whose secret held a STALE username from a prior run was never refreshed,
      // so its warm logged in with the bad username and SportLots returned
      // "Not a valid Email Address" (NEO-29 run 26618163560, worker
      // user_3DPlQMAl…). Comparing the stored username to the env value lets us
      // overwrite a stale secret (which now re-logs-in with the correct
      // username and mints a fresh session) while still skipping — and
      // preserving the token — on the common, already-correct path.
      //
      // On the COMMON (already-correct) path we still never authenticate here:
      // a real login takes 30-65s and this action is awaited by the seed page
      // before it redirects, so warming here would blow past the flows'
      // post-redirect wait budget. Token warming is done where a flow can
      // afford it, by tapping "Test Credentials" (util-login-to-bsc /
      // util-login-to-sportlots); adapters also mint a token lazily via
      // getSiteToken on first fetch.
      const existing = await ctx.runAction(api.credentials.getSiteCredentials, {
        site,
      });
      // Marketplace usernames are emails (case-insensitive, no surrounding
      // whitespace). Compare normalized so benign casing/whitespace drift does
      // NOT trigger a needless re-store (which would wipe the warmed token and
      // reopen the storm). A genuine mismatch — or no secret at all — re-stores.
      const norm = (value: string) => value.trim().toLowerCase();
      const credsMatch = !!existing && norm(existing.username) === norm(username);

      // NEO-141: a matching username is no longer sufficient to skip. Sessions
      // now EXPIRE — a BSC refresh token lives 24h — and the seed is the only
      // place that still holds a password, so it is the only place that can
      // mint a new one.
      //
      // The failure this prevents: a worker idle over 24h keeps a correct
      // username but a dead refresh token. The old check skipped the re-store,
      // no fresh session was minted, and the first fetch came back
      // `reauth_required`. The panel then renders the re-auth card, which
      // deliberately does NOT offer "Test Credentials" — so every shared util
      // flow (`util-login-to-bsc`, `util-login-to-sportlots`, …) would hang on
      // its extendedWaitUntil for that label instead of failing fast. Idle
      // workers would go red on a timeout with no obvious cause.
      //
      // `sessionRenewable` is deliberately conservative: a browser revision
      // predating NEO-141 omits the field, which coerces to false and costs
      // one redundant sign-in. Cheap, and it never skips wrongly.
      const REAUTH_LEEWAY_MS = 10 * 60 * 1000;
      const sessionRenewable =
        !!existing &&
        (existing.hasRefreshToken
          ? typeof existing.refreshExpiresAt !== "number" ||
            existing.refreshExpiresAt > Date.now() + REAUTH_LEEWAY_MS
          : // No refresh token: only a live cached token (SportLots' 30-day
            // cookie) still counts as renewable-without-us.
            existing.hasToken &&
            (typeof existing.expiresAt !== "number" ||
              existing.expiresAt > Date.now() + REAUTH_LEEWAY_MS));

      if (credsMatch && sessionRenewable) {
        // Correct secret already present — ensure the flag (a prior
        // /testing/reset may have cleared the userProfile row while Secret
        // Manager kept the creds) and leave the stored token untouched.
        //
        // `needsReauth: false` is load-bearing, not tidiness. We have just
        // verified the stored session is renewable, so a lingering flag is
        // stale by definition. Without it the flag is STICKY on this path:
        // `reauthPatch(undefined)` returns `{}`, so re-seeding preserves it —
        // meaning a worker left flagged by an interrupted run stays flagged
        // through every later seed, and the re-auth card (which renders no
        // "Test Credentials" button) would keep failing the util flows on that
        // runner with no way to self-heal. Seeding is the suite's repair
        // mechanism; it has to actually repair.
        await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
          userId,
          site,
          hasCredentials: true,
          needsReauth: false,
        });
        seeded.push({ site, stored: true });
        continue;
      }

      // NEO-89: saveCredentials already updates hasCredentials server-side on
      // a successful store, so no separate follow-up mutation is needed here
      // (unlike the credsMatch branch above, which skips the store call
      // entirely and so must set the flag itself).
      const storeResult = await ctx.runAction(api.credentials.saveCredentials, {
        site,
        username,
        password,
      });

      seeded.push({ site, stored: storeResult.success });
    }

    // NEO-120 — EasyPost postage key.
    //
    // Handled outside the loop because EasyPost is not a marketplace: no login,
    // no token to warm, and deliberately absent from SUPPORTED_SITES (which
    // would leak it into listUserSites, the Credentials tab and the login
    // flows). It stores through postage.saveEasypostKey instead.
    //
    // **Configure a TEST key here, never a production one.** A production key
    // would buy real postage on every CI run. A test key prices labels and
    // returns fake ones, charging nothing — exactly what the E2E needs.
    //
    // Adds NOTHING to `seeded` when unset — deliberately, rather than reporting
    // a "skipped" entry. Every caller of this action asserts on the exact array
    // it gets back, so an unconditional extra element would change the result
    // of seeding on every deployment that has no EasyPost key. Silence when
    // unconfigured keeps this additive.
    const easypostKey = process.env.DEV_EASYPOST_API_KEY;
    if (easypostKey) {
      const result = await ctx.runAction(api.postage.saveEasypostKey, {
        apiKey: easypostKey,
      });
      seeded.push({ site: "easypost", stored: result.success });
    }

    return { seeded };
  },
});
