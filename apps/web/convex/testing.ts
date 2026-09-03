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

import { mutation, action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { CLERK_USER_ID_RE, placeholderJobPrefix } from "./lib/placeholderObjects";
import type { Id } from "./_generated/dataModel";

/**
 * What {@link seedMyTestLabelScans} hands back.
 *
 * Written out as a named type, and used to annotate both the handler and the
 * `ctx.runMutation` call in {@link seedMyTestCredentials}, purely to break a
 * TypeScript inference cycle: an action in this file calls an internal
 * mutation in this file, so `internal.testing.*` cannot be resolved while the
 * module's own exports are still being inferred. Explicit annotations cut the
 * cycle; without them tsc reports TS7022/TS7023 on both functions.
 */
type ScanFixtureResult = {
  purchaseId: Id<"labelPurchases">;
  scans: number;
  applied: boolean;
};

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

/**
 * Materialise a "collecting" placeholder run owned by the CALLER, so an E2E flow
 * has something real to abort (NEO-170 admin operability).
 *
 * Exists for the same reason `markSiteNeedsReauth` does: the state the flow needs
 * to assert against is otherwise unreachable from the UI in test time. Reaching a
 * genuine collecting run means opening a scanner session and uploading an image
 * to GCS through a signed policy — a real object, a real `/process-entry`, and
 * minutes of Cloud Run work — none of which the abort flow is testing. What it
 * IS testing is that an admin can see another user's run and stop it, and that
 * needs precisely one row.
 *
 * Deliberately **not** a call to `startPlaceholderStream`, for two reasons. That
 * mutation enforces the per-user active-job cap, so a suite that left a run
 * behind would start failing its own fixture; and it belongs to the product
 * surface, which should not grow a test-only bypass. This writes the row it
 * needs directly, in the same shape `startPlaceholderStream` writes — including
 * the job prefix as `objectPath`, built with the shared helper rather than
 * hand-formatted, so the fixture cannot drift from the real thing.
 *
 * No images and no GCS: the row references a prefix under which nothing was ever
 * uploaded, which is exactly what an abandoned session looks like anyway.
 *
 * Safety, in the same shape as the other helpers in this file:
 *   - fails closed in production (`TESTING_RESET_SECRET` is unset there);
 *   - only ever creates a row owned by the CALLER — there is no userId argument
 *     to spoof, so it cannot be used to plant a job on someone else;
 *   - creates an EMPTY run. It enqueues nothing, so it spends no Vision or model
 *     budget, and the idle sweep closes it within the hour even if the flow that
 *     made it never aborts it.
 */
export const seedMyTestPlaceholderStream = mutation({
  args: {},
  returns: v.object({ jobId: v.string() }),
  handler: async (ctx) => {
    // Fail closed in production: the enabling flag is unset there.
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test placeholder seeding is not enabled on this deployment");
    }

    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    if (!CLERK_USER_ID_RE.test(userId)) {
      // Same check the real mint makes: this value becomes a literal object-path
      // segment, so refuse to build one from an unexpected shape even here.
      throw new Error("Unexpected user id shape");
    }

    const jobId = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: placeholderJobPrefix(userId, jobId),
      createdAt: now,
      mode: "stream",
      status: "collecting",
      startedAt: now,
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      rejectedEntries: 0,
      nextEntryIndex: 0,
      lastActivityAt: now,
    });

    return { jobId };
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

    // NEO-121 — `sites` is the seed SELECTOR, and one of the things a flow can
    // ask to be seeded is not a marketplace at all: the scan-visibility fixture
    // (see SCAN_FIXTURE_SELECTOR below). Pulled out before the loop so it never
    // falls through to the "no dev creds for this site" skip branch, and so a
    // flow that asks only for it pays for no marketplace logins.
    const requested = args.sites ?? ["buysportscards", "sportlots"];
    const wantsScanFixture = requested.includes(SCAN_FIXTURE_SELECTOR);
    const sites = requested.filter((site) => site !== SCAN_FIXTURE_SELECTOR);
    const seeded: Array<{
      site: string;
      stored: boolean;
      skipped?: boolean;
    }> = [];

    if (wantsScanFixture) {
      const fixture: ScanFixtureResult = await ctx.runMutation(
        internal.testing.seedMyTestLabelScans,
        { userId },
      );
      seeded.push({ site: SCAN_FIXTURE_SELECTOR, stored: fixture.scans > 0 });
    }

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
    //
    // NEO-121 — stores through the INTERNAL helper, not the public
    // `saveEasypostKey`, precisely because the public one now schedules webhook
    // registration (decision 8). Every preview seeds this same shared test key
    // for 8 worker users, so registering here would pile a webhook per preview
    // per worker onto one EasyPost test account — and `preview-cleanup.yml`
    // deletes the preview deployment, so nothing would ever unregister them.
    // The seed stores the key; only a real seller's save registers a hook.
    const easypostKey = process.env.DEV_EASYPOST_API_KEY;
    if (easypostKey) {
      const result = await ctx.runAction(internal.postage.storeEasypostKeyForUser, {
        userId,
        apiKey: easypostKey,
      });
      seeded.push({ site: "easypost", stored: result.success });
    }

    return { seeded };
  },
});

// ─── NEO-121 — the scan-visibility fixture ───────────────────────────────────
//
// WHY A FIXTURE AT ALL
// A purchase row with USPS scans on it cannot be reached from the UI in test
// time. Getting one for real means tapping "Buy & print" — which spends real
// money on a production key and ends in window.print(), whose native dialog
// wedges the runner — and then waiting three days for USPS to scan the letter.
// Neither is a thing an E2E run can do, so the row is written directly, in the
// exact shape the two real writers produce.
//
// WHY IT RIDES ON /testing/seed-credentials
// That page is the suite's one generic "seed something for the caller, then
// land on the destination" hop, and its `sites` query param is already the
// selector for WHAT to seed. Adding a fixture name to that selector costs no
// new route, no new page and no new entry in the router — one fewer moving
// part than a second seeding page that would do the same three things.
//
// WHY IT WRITES THROUGH THE REAL WRITERS
// It calls `internal.shipping.recordLabelPurchase` and then
// `internal.shipmentTracking.applyTrackerSnapshot` — the same two mutations a
// real purchase and a real `tracker.updated` webhook go through. So the stored
// row is sanitised, truncated, capped and monotonic-guarded exactly as
// production data is, and the E2E asserts against what the product would
// actually render rather than against a hand-built document that could drift.
//
// THE DATA IS A REAL LETTER. Every message, city and status below is copied
// from the production tracker Jason supplied on 2026-09-03 (Madison WI →
// Olympia WA, four scans over three days, terminal status `out_for_delivery`).
// The tracking code is a 31-digit IMb of the right SHAPE but a synthetic
// value, and the shipment/tracker ids are synthetic: nothing here names a real
// EasyPost object, so no flow can accidentally act on one.

/**
 * The name a flow passes in `sites` to ask for the scan fixture.
 *
 * Deliberately hyphenated and not a marketplace name, so it can never collide
 * with a real entry in {@link SEED_SITE_ENV}.
 */
const SCAN_FIXTURE_SELECTOR = "label-scans";

/**
 * Synthetic EasyPost identifiers. `by_shipment` on this id is what makes the
 * seed idempotent — a re-run finds the row it wrote last time instead of
 * filing a second one, so a worker account never accumulates fixture rows.
 */
const SCAN_FIXTURE_SHIPMENT_ID = "shp_e2escanfixture0000000000000001";
const SCAN_FIXTURE_TRACKER_ID = "trk_e2escanfixture0000000000000001";

/** 31 digits — an IMb, the shape a real First-Class letter carries. */
const SCAN_FIXTURE_TRACKING_CODE = "0004012345678901234567890123456";

/** EasyPost's public tracking page for the tracker. Rendered as a link. */
const SCAN_FIXTURE_PUBLIC_URL =
  "https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx";

/**
 * The recipient the fixture row is addressed to.
 *
 * Distinct from every other name the suite types ("Jane Buyer", "Dana Reyes")
 * so a flow asserting on this row's heading cannot be satisfied by a row some
 * other flow left behind.
 */
const SCAN_FIXTURE_RECIPIENT = "Scan Fixture Buyer";

const HOUR_MS = 60 * 60 * 1000;

/**
 * File one label purchase for `userId` and apply a four-scan tracker snapshot
 * to it, so `/print/labels` has a row with a real scan history to render.
 *
 * Safety, in the same shape as the other helpers in this file:
 *   - `internalMutation` — unreachable from any client. The only caller is
 *     {@link seedMyTestCredentials}, which has already checked the enabling
 *     flag and derived `userId` from the verified Clerk subject. It is
 *     re-checked here anyway: this writes rows, and a write helper that trusts
 *     its caller's gate is one refactor away from being ungated.
 *   - fails closed in production (`TESTING_RESET_SECRET` is unset there);
 *   - writes ONLY through the two internal writers the feature itself uses, so
 *     it can create nothing the product could not create;
 *   - idempotent, and never deletes: a re-run re-applies the snapshot to the
 *     row it already wrote. Nothing existing is removed, so no other flow's
 *     state can be degraded by seeding this one.
 *
 * The scan times are relative to now (three days of history ending six hours
 * ago) rather than fixed instants, so the row always reads as a letter in the
 * mail this week and `updatedAt` is always strictly newer than what a previous
 * run stored — which is what lets the monotonic guard in
 * `applyTrackerSnapshot` accept the re-application instead of no-op'ing.
 */
export const seedMyTestLabelScans = internalMutation({
  args: { userId: v.string() },
  returns: v.object({
    purchaseId: v.id("labelPurchases"),
    scans: v.number(),
    applied: v.boolean(),
  }),
  handler: async (ctx, args): Promise<ScanFixtureResult> => {
    // Fail closed in production: the enabling flag is unset there.
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test scan seeding is not enabled on this deployment");
    }

    const now = Date.now();

    const findRow = async () =>
      await ctx.db
        .query("labelPurchases")
        .withIndex("by_shipment", (q) =>
          q.eq("easypostShipmentId", SCAN_FIXTURE_SHIPMENT_ID),
        )
        .filter((q) => q.eq(q.field("userId"), args.userId))
        .first();

    let row = await findRow();
    if (!row) {
      // The real purchase writer. No `tracker` argument: the snapshot is
      // applied below through the webhook's own mutation, which is the path
      // that actually has to work for this feature.
      await ctx.runMutation(internal.shipping.recordLabelPurchase, {
        userId: args.userId,
        easypostShipmentId: SCAN_FIXTURE_SHIPMENT_ID,
        trackingCode: SCAN_FIXTURE_TRACKING_CODE,
        // A real First-Class letter: 78¢, one ounce.
        costCents: 78,
        weightOz: 1,
        toAddress: {
          name: SCAN_FIXTURE_RECIPIENT,
          line1: "1 Capitol Way N",
          city: "Olympia",
          state: "WA",
          postalCode: "98501",
          country: "US",
        },
        // Never fetched: reprint calls `refreshLabelUrl` rather than opening
        // the stored URL, and no flow taps reprint. Stored because the field
        // is required and a row is never allowed to be empty.
        labelUrl: "https://easypost-files.invalid/e2e-scan-fixture-label.png",
      });
      row = await findRow();
      if (!row) {
        throw new Error("Scan fixture: purchase row was not written");
      }
    }

    const scans = [
      {
        // The postmark. USPS's own wording, and the single most alarming
        // string in the timeline — the page glosses it, and the E2E asserts
        // the gloss.
        at: now - 72 * HOUR_MS,
        status: "pre_transit",
        message: "Origin Processing Cancellation of Postage",
        city: "MADISON",
        state: "WI",
        zip: "53703",
        country: "US",
      },
      {
        at: now - 61 * HOUR_MS,
        status: "in_transit",
        message: "Origin Primary Processing",
        city: "MILWAUKEE",
        state: "WI",
        zip: "53203",
        country: "US",
      },
      {
        at: now - 30 * HOUR_MS,
        status: "in_transit",
        message: "Destination MMP Processing",
        city: "TACOMA",
        state: "WA",
        zip: "98409",
        country: "US",
      },
      {
        // The finish line for a letter: the destination post office's
        // "Delivery" scan. Nothing ever confirms the mailbox.
        at: now - 6 * HOUR_MS,
        status: "out_for_delivery",
        message: "Delivery",
        city: "OLYMPIA",
        state: "WA",
        zip: "98501",
        country: "US",
      },
    ];

    const result: { applied: boolean; newScans: number } = await ctx.runMutation(
      internal.shipmentTracking.applyTrackerSnapshot,
      {
        purchaseId: row._id,
        userId: args.userId,
        snapshot: {
          trackerId: SCAN_FIXTURE_TRACKER_ID,
          status: "out_for_delivery",
          statusDetail: "out_for_delivery",
          updatedAt: now,
          lastScanAt: scans[scans.length - 1].at,
          estDeliveryAt: now - 6 * HOUR_MS,
          publicTrackingUrl: SCAN_FIXTURE_PUBLIC_URL,
          scans,
        },
      },
    );

    return {
      purchaseId: row._id,
      scans: scans.length,
      applied: result.applied,
    };
  },
});
