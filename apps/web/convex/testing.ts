// Per-user state reset for E2E test isolation.
//
// Problem: NEW_PROFILE_TEST_EMAIL_<worker> and TEST_EMAIL_<worker> resolve to
// fixed Clerk users that are reused across CI runs. After a test successfully
// saves profile data, the next run starts from the *previous* run's values
// (under the retired Maestro suite, whose `inputText` appended rather than
// replaced, that produced concatenated garbage).
//
// Fix: a test signs the user in, then calls this mutation to wipe that
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
//   can't leak through the bundle or the test runner's artifacts.)
// - Deletes are strictly scoped to the three per-user tables via the by_user
//   index. No bulk-wipe paths, no cross-user reach.

import { mutation, action, internalAction, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { CLERK_USER_ID_RE, placeholderJobPrefix } from "./lib/placeholderObjects";
// NEO-287 — the operator switch. A paused marketplace is seeded as `skipped`,
// before any read of its stored credentials.
import { isPlatformPaused } from "./marketplacePause";
import { ebayConfig, ebayConfigured } from "./lib/ebayEnv";
import type { Doc, Id } from "./_generated/dataModel";
import { dropOwnerPhotos } from "./copyPhotos";
import { addOne, applyCopyChanges, defaultConditionOf, getOrCreateMain } from "./collection";
import { ListingGate } from "./listingGate";
import { intakePhotoFailureValidator, listingPlatformValidator } from "./schema";
import { DRAIN_LEASE_MS } from "./listingDrain";
import { listsAnywhere, newToken } from "./listingOutbox";
import type { ActionCtx } from "./_generated/server";
import {
  applySaleLinesCore,
  eraOfVariant,
  projectEbayOrderForRecord,
  recordOrderCore,
  SALE_ITEMS_PER_APPLY,
  type ProjectedOrder,
} from "./listingSales";
import { ebayLineTitle, projectEbayOrder } from "./lib/ebayListing";
import { TEST_SALE_ORDER_PREFIX } from "./lib/testSeedMarks";
import { bscConditionFor, type BscEra } from "./lib/bscConditions";
import { buildListingSku } from "./lib/listingSku";
import { BSC_LISTED_BOUNDS, bscListedText } from "./lib/bscOrders";
import { CatalogReader } from "./lib/catalogView";
import { slotIds } from "./platformSlots";

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
    // NEO-358: the caller's collection (copies before the containers they
    // live in). NEO-359: wants before the containers they may be scoped to.
    collectionCopies: v.number(),
    collectionWants: v.number(),
    // NEO-361: the caller's requests, with their private cards and sets.
    cardRequests: v.number(),
    collectionContainers: v.number(),
    collectionBuildingSets: v.number(),
    // NEO-378: the caller's common prices per variant.
    variantCommonPrices: v.number(),
    // NEO-370: the caller's marketplace listing rows, all four tables
    // (outbox, per-variant syncs, per-platform states, sales) summed.
    marketplaceListing: v.number(),
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

    // NEO-358 — the caller's collection. Copies first: every copy names a
    // container as its home, so the containers go after them.
    const collectionCopies = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of collectionCopies) {
      await ctx.db.delete(row._id);
    }
    // NEO-377 — their photos and files, live or waiting on an Undo.
    await dropOwnerPhotos(ctx, userId);

    // NEO-359 — wants may name a container as their binder, so they go
    // before the containers too.
    const collectionWants = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of collectionWants) {
      await ctx.db.delete(row._id);
    }

    // NEO-361 — the caller's private cards (photos with them), private sets
    // and requests. Their copies went with the copies above.
    const privateCards = await ctx.db
      .query("privateCards")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of privateCards) {
      for (const id of [row.frontImageId, row.backImageId]) {
        if (id && (await ctx.db.system.get(id))) await ctx.storage.delete(id);
      }
      await ctx.db.delete(row._id);
    }
    const privateSets = await ctx.db
      .query("privateSets")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of privateSets) {
      await ctx.db.delete(row._id);
    }
    const cardRequests = await ctx.db
      .query("cardRequests")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of cardRequests) {
      await ctx.db.delete(row._id);
    }

    const collectionContainers = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of collectionContainers) {
      // NEO-401 — a smart binder's stored fits go with it.
      const fits = await ctx.db
        .query("collectionBinderFits")
        .withIndex("by_binder_order", (q) => q.eq("binderId", row._id))
        .collect();
      for (const fit of fits) await ctx.db.delete(fit._id);
      const state = await ctx.db
        .query("collectionBinderFitsState")
        .withIndex("by_binder", (q) => q.eq("binderId", row._id))
        .unique();
      if (state) await ctx.db.delete(state._id);
      await ctx.db.delete(row._id);
    }

    const collectionBuildingSets = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of collectionBuildingSets) {
      await ctx.db.delete(row._id);
    }

    const variantCommonPrices = await ctx.db
      .query("variantCommonPrices")
      .withIndex("by_owner_and_variant", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of variantCommonPrices) {
      await ctx.db.delete(row._id);
    }

    // NEO-370 — the caller's listing outbox, per-variant sync records,
    // per-platform states and sales. Every one is keyed on ownerId first, so
    // each is a prefix read of its own index.
    const listingOutbox = await ctx.db
      .query("listingOutbox")
      .withIndex("by_owner_platform_variant", (q) => q.eq("ownerId", userId))
      .collect();
    const listingSyncs = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_variant_platform", (q) => q.eq("ownerId", userId))
      .collect();
    const listingStates = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", userId))
      .collect();
    const sales = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_date", (q) => q.eq("ownerId", userId))
      .collect();
    // NEO-415 — the caller's eBay link rows and eBay settings.
    const listingLinks = await ctx.db
      .query("marketplaceListingLinks")
      .withIndex("by_owner_platform_card_condition", (q) => q.eq("ownerId", userId))
      .collect();
    const ebaySettings = await ctx.db
      .query("ebaySellerSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    for (const row of [...listingOutbox, ...listingSyncs, ...listingStates, ...sales, ...listingLinks, ...ebaySettings]) {
      await ctx.db.delete(row._id);
    }

    return {
      publicProfiles: publicProfiles.length,
      userProfiles: userProfiles.length,
      prizePool: prizePool.length,
      collectionCopies: collectionCopies.length,
      collectionWants: collectionWants.length,
      cardRequests: cardRequests.length,
      collectionContainers: collectionContainers.length,
      collectionBuildingSets: collectionBuildingSets.length,
      variantCommonPrices: variantCommonPrices.length,
      marketplaceListing:
        listingOutbox.length +
        listingSyncs.length +
        listingStates.length +
        sales.length +
        listingLinks.length +
        ebaySettings.length,
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

/** NEO-433: stands in for a drain run the platform killed: a real scheduled function that really fails. */
export const failLikeAKilledDrain = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("E2E fixture: a drain run the platform killed");
  },
});

/** NEO-433: how long the killed run below reads as running, so an open status page sees it flip. */
const KILLED_DRAIN_TICK_MS = 3000;

/**
 * NEO-433 — the state a drain run the platform killed leaves behind, on the
 * CALLER's own row: the lease held and their newest sync record running, both
 * under one token and linked to a function that fails, with the real watcher
 * on it. A kill can't be produced on demand, and the real 100 s grace is far
 * past any spec's budget, so the watcher runs with no grace.
 *
 * Why this is safe as a public mutation: it throws where TESTING_RESET_SECRET
 * is unset (production), it takes no owner (only the caller's rows), and it
 * refuses while a real run holds the lease, so it never takes one from a run.
 * It touches no outbox row and sends nothing itself. A kick landing on the held
 * lease is honoured when the lease clears: a real drain, on the caller's row only.
 */
export const seedMyTestKilledDrain = mutation({
  args: { platform: listingPlatformValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("The killed-drain fixture is not enabled on this deployment");
    }
    const ownerId = await getCurrentUserId(ctx);
    if (!ownerId) throw new Error("Not authenticated");
    const state = await ctx.db
      .query("marketplaceListingStates")
      .withIndex("by_owner_platform", (q) => q.eq("ownerId", ownerId).eq("platform", args.platform))
      .unique();
    if (!state) throw new Error("The killed-drain fixture needs a listing platform");
    const now = Date.now();
    if (state.drainLeaseToken !== undefined && (state.drainLeaseExpiresAt ?? 0) > now) {
      throw new Error("A drain is running; the killed-drain fixture never takes its lease");
    }
    const record = await ctx.db
      .query("marketplaceListingSyncs")
      .withIndex("by_owner_platform_run", (q) => q.eq("ownerId", ownerId).eq("platform", args.platform))
      .order("desc")
      .first();
    if (!record) throw new Error("The killed-drain fixture needs a set that has synced");
    const leaseToken = newToken();
    const fnId = await ctx.scheduler.runAfter(0, internal.testing.failLikeAKilledDrain, {});
    await ctx.db.patch(state._id, {
      drainLeaseToken: leaseToken,
      drainLeaseExpiresAt: now + DRAIN_LEASE_MS,
      lastUpdated: now,
    });
    await ctx.db.patch(record._id, {
      status: "running",
      leaseToken,
      leaseExpiresAt: now + DRAIN_LEASE_MS,
      lastRunAt: now,
      progress: { runStartedAt: now, steps: [{ kind: args.platform === "ebay" ? "items" : "send", status: "working" }] },
      lastUpdated: now,
    });
    await ctx.scheduler.runAfter(KILLED_DRAIN_TICK_MS, internal.listingDrain.watchDrainRun, {
      ownerId,
      platform: args.platform,
      leaseToken,
      fnId,
      graceMs: 0,
      tickMs: KILLED_DRAIN_TICK_MS,
    });
    return null;
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

/**
 * NEO-411 — a run holding one photo that never got read, for the spec that
 * proves a failed photo ends on screen and can be sent again.
 *
 * A photo the heavy service never answers is minutes of real spend and cannot
 * be made to happen on cue, so this writes the end state directly: an open
 * scanner run (the same row `seedMyTestPlaceholderStream` writes), one photo
 * marked failed with PHOTO_TIMED_OUT, and the intake run that shows it, homed
 * in the caller's Main. Nothing was uploaded under the photo's key, so Try
 * again sends it to the fast service, which answers "no such photo" at once
 * and the photo ends failed again: the real retry path, end to end, at no
 * model cost.
 *
 * Same safety as the seed above: fails closed in production, writes only rows
 * owned by the CALLER, and leaves an open run the idle sweep closes. Callers
 * cancel their active runs first (the page does), for the 2-active cap.
 */
export const seedMyTestFailedPhotoRun = mutation({
  args: {},
  returns: v.object({ runId: v.id("intakeRuns"), jobId: v.string(), originalName: v.string() }),
  handler: async (ctx) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test placeholder seeding is not enabled on this deployment");
    }
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!CLERK_USER_ID_RE.test(userId)) throw new Error("Unexpected user id shape");

    const jobId = crypto.randomUUID();
    const now = Date.now();
    const originalName = `never-read-${jobId.slice(0, 8)}.jpg`;
    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: placeholderJobPrefix(userId, jobId),
      createdAt: now,
      mode: "stream",
      status: "collecting",
      startedAt: now,
      totalImages: 1,
      processedImages: 0,
      failedImages: 1,
      rejectedEntries: 0,
      nextEntryIndex: 1,
      lastActivityAt: now,
    });
    await ctx.db.insert("placeholderImages", {
      jobId,
      userId,
      entryIndex: 0,
      originalName,
      status: "failed",
      escalated: true,
      errorCode: "PHOTO_TIMED_OUT",
      errorDetail: "seeded for E2E: no answer from the heavy preprocess service",
      queuedAt: now,
      escalatedAt: now,
      heavyStartedAt: now,
      settledAt: now,
    });
    const homeId = await getOrCreateMain(ctx, userId);
    const runId = await ctx.db.insert("intakeRuns", {
      userId,
      jobId,
      homeId,
      createdAt: now,
      lastActivityAt: now,
    });
    return { runId, jobId, originalName };
  },
});

/**
 * NEO-441 — a run holding four read photos that no pair claims, for the spec
 * that drives the Pairing column's pair-by-hand button. Real photos pair
 * themselves, so a spec cannot keep two of them loose; this writes the state
 * after reading directly: an open scanner run, four photos `done` with nothing
 * read off them (no side, no number, no player) and no pair row. Nothing here
 * schedules `runPairing`, so nothing pairs them before the collector does.
 *
 * Same safety as the seeds above: fails closed in production, writes only rows
 * owned by the CALLER, spends no model budget, and leaves an open run the idle
 * sweep closes. Callers cancel their active runs first (the page does).
 */
const LOOSE_PHOTO_NAMES = ["loose-1.jpg", "loose-2.jpg", "loose-3.jpg", "loose-4.jpg"] as const;

export const seedMyTestLoosePhotosRun = mutation({
  args: {},
  returns: v.object({ runId: v.id("intakeRuns") }),
  handler: async (ctx) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test placeholder seeding is not enabled on this deployment");
    }
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!CLERK_USER_ID_RE.test(userId)) throw new Error("Unexpected user id shape");

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
      totalImages: LOOSE_PHOTO_NAMES.length,
      processedImages: LOOSE_PHOTO_NAMES.length,
      failedImages: 0,
      rejectedEntries: 0,
      nextEntryIndex: LOOSE_PHOTO_NAMES.length,
      lastActivityAt: now,
    });
    for (const [entryIndex, originalName] of LOOSE_PHOTO_NAMES.entries()) {
      await ctx.db.insert("placeholderImages", {
        jobId,
        userId,
        entryIndex,
        originalName,
        status: "done",
        queuedAt: now,
        settledAt: now,
      });
    }
    const homeId = await getOrCreateMain(ctx, userId);
    const runId = await ctx.db.insert("intakeRuns", {
      userId,
      jobId,
      homeId,
      createdAt: now,
      lastActivityAt: now,
    });
    return { runId };
  },
});

/**
 * NEO-427 — a run with one saved card whose scans failed to reach its copy, for
 * the spec that drives a Saved tile's failed states. A real attach can't be made
 * to fail on cue, so this writes the end state over a real copy.
 *
 * The card sits in its own `PhotoFixture-<id>` set under the real Baseball >
 * 2024 > Topps, and the copy in its own unlisted box, so nothing else on the
 * account sees it and nothing lists. No file was uploaded under the job, so Try
 * again on "error" runs the real path and comes back with the scans gone.
 *
 * Same safety as the seeds above: fails closed in production, writes only rows
 * owned by the CALLER (the set is per seed), and leaves an open run the idle
 * sweep closes. Callers cancel their active runs first (the page does).
 */
export const seedMyTestSavedPhotoFailureRun = mutation({
  args: { photoFailure: intakePhotoFailureValidator },
  returns: v.object({ runId: v.id("intakeRuns"), copyId: v.id("collectionCopies") }),
  handler: async (ctx, args): Promise<{ runId: Id<"intakeRuns">; copyId: Id<"collectionCopies"> }> => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("Test placeholder seeding is not enabled on this deployment");
    }
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!CLERK_USER_ID_RE.test(userId)) throw new Error("Unexpected user id shape");

    const childNamed = async (level: "sport" | "year" | "manufacturer", value: string, parentId?: Id<"selectorOptions">) => {
      const rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", level).eq("parentId", parentId))
        .take(200);
      const row = rows.find((r) => r.value === value);
      if (!row) throw new Error(`This seed needs Baseball > 2024 > Topps on the deployment: no ${value}`);
      return row._id;
    };
    const sportId = await childNamed("sport", "Baseball");
    const yearId = await childNamed("year", "2024", sportId);
    const brandId = await childNamed("manufacturer", "Topps", yearId);

    const jobId = crypto.randomUUID();
    const now = Date.now();
    const minted = `PhotoFixture-${jobId.slice(0, 8)}`;
    // The Set Builder's own writers, so the set and card are born as the app
    // makes them. They are admin-gated, as every E2E account is.
    const setId = await ctx.runMutation(api.selectorOptions.addCustomSelectorOption, {
      level: "setName",
      value: minted,
      parentId: brandId,
    });
    const baseId = await ctx.runMutation(api.selectorOptions.addCustomSelectorOption, {
      level: "variantType",
      value: "Base",
      parentId: setId,
    });
    const cardId = await ctx.runMutation(api.selectorOptions.addCustomCard, {
      selectorOptionId: baseId,
      cardNumber: "1",
      cardName: "Testcard",
    });
    const homeId = await ctx.db.insert("collectionContainers", {
      ownerId: userId,
      kind: "box",
      name: minted,
      listedOnMarketplaces: false,
      lastUpdated: now,
    });
    const { result, change } = await addOne(
      ctx,
      userId,
      cardId,
      { quantity: 1, homeId },
      await defaultConditionOf(ctx, userId),
      new ListingGate(ctx, userId),
      { keepsOwnLine: true },
    );
    await applyCopyChanges(ctx, userId, [change]);

    await ctx.db.insert("placeholderJobs", {
      jobId,
      userId,
      objectPath: placeholderJobPrefix(userId, jobId),
      createdAt: now,
      mode: "stream",
      status: "collecting",
      startedAt: now,
      totalImages: 2,
      processedImages: 2,
      failedImages: 0,
      rejectedEntries: 0,
      nextEntryIndex: 2,
      lastActivityAt: now,
    });
    for (const entryIndex of [0, 1]) {
      await ctx.db.insert("placeholderImages", {
        jobId,
        userId,
        entryIndex,
        originalName: `${minted}-${entryIndex}.jpg`,
        status: "done",
        queuedAt: now,
        settledAt: now,
      });
    }
    const pairId = await ctx.db.insert("placeholderPairs", {
      jobId,
      userId,
      frontIndex: 0,
      backIndex: 1,
      confidence: "side-only",
      mechanism: "manual",
      score: 0,
    });
    const runId = await ctx.db.insert("intakeRuns", { userId, jobId, homeId, createdAt: now, lastActivityAt: now });
    await ctx.db.insert("intakeMatches", {
      runId,
      userId,
      pairId,
      frontIndex: 0,
      backIndex: 1,
      readKey: "1",
      cardId,
      confidence: 97,
      band: "matched",
      reason: "numberAndPlayer",
      candidates: [cardId],
      variations: [],
      savedCopyId: result.copyId,
      savedQuantity: 1,
      savedAt: now,
      photos: "failed",
      photoFailure: args.photoFailure,
      photoAttempt: 1,
    });
    return { runId, copyId: result.copyId };
  },
});

// Server-side marketplace-credential seeding for E2E test isolation (NEO-29).
//
// Problem: the retired Maestro flows received real BSC/SportLots passwords via
// `-e` env, which Maestro serialized into its public CI debug artifacts. The
// rule that came out of it still holds for Playwright, whose traces, reports
// and logs are public CI artifacts too: the test user's credentials are seeded
// server-side from Convex env vars and never pass through the test runner.
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

/** NEO-482: re-login cycles {@link seedBscWithSellerId} runs after its first sign-in, at most. */
export const SEED_BSC_MAX_RELOGINS = 4;
/** NEO-482: {@link seedBscWithSellerId} starts no sign-in once this long has passed since it began. */
export const SEED_BSC_RELOGIN_WINDOW_MS = 58_000;
/**
 * NEO-482: the least time between the STARTS of two sign-ins in
 * {@link seedBscWithSellerId}. A BSC profile stall heals with time, so the
 * tries are spread across the window (starts near 0, 12, 24, 36 and 48 s)
 * instead of firing back to back once a stall ends and sign-ins come back
 * fast and still without the id.
 */
export const SEED_BSC_RELOGIN_SPACING_MS = 12_000;
/**
 * NEO-482: the wait {@link seedBscWithSellerId} uses between sign-ins. An
 * object so a test can replace `sleep` (and move its spied clock instead of
 * waiting real seconds); nothing else reassigns it.
 */
export const seedBscReloginClock = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One entry of {@link seedMyTestCredentials}' `seeded` array. */
type SeededSite = { site: string; stored: boolean; skipped?: boolean; reason?: string };

/**
 * NEO-489: the reason a listing-on BSC seed reports when its listing save
 * left the row dormant on a seller conflict (another NB owner already lists
 * from the same BSC seller account). Carries no id.
 */
export const SEED_BSC_SELLER_CONFLICT_REASON =
  "BuySportsCards listing not started (sellerConflict): this seller account already lists from another NeonBinder account.";

/**
 * NEO-482 — a listing-on BuySportsCards seed must leave the caller's BSC
 * seller id saved, or report why not.
 *
 * The E2E reset deletes the userProfiles row, and `bscSellerId` with it. Left
 * unsaved, the first Sync's drain reads it inside "Send changes", which can
 * outrun that step's budget. The id exists only through BSC's API and may
 * change, so it is never taken from env or a constant: it comes from the live
 * profile read the browser service makes inside every password login, which
 * `credentials.runSiteLogin` saves when the login returns one. That read is
 * best-effort (a stalled read still returns a session, with no id), so:
 *
 * - id already saved: the old behaviour, unchanged. `alreadyPresent` (the
 *   secret is correct and renewable) writes the credential flag only; the
 *   store branch runs one normal store. No extra call.
 * - id missing: a fresh password login through `storeTestCredentials`, on
 *   both branches (the "already present" branch never signs in otherwise, so
 *   nothing would save the id). NEO-489: each of these sign-ins stores with
 *   listing OFF (the test marker), so no listing run can start before the id
 *   exists; once the id is saved, one `updateSiteCredentialStatus` with
 *   `listing: "save"` turns listing on, and a seed that stalls leaves it off.
 *   After each login, the profile is read for the id. Missing: sign in fresh
 *   again, no logout. A BSC profile stall
 *   heals with time, not with a new session, and our password login is
 *   already a new session each time, so the loop is what buys the time. At
 *   most {@link SEED_BSC_MAX_RELOGINS} re-logins after the first, each
 *   started at least {@link SEED_BSC_RELOGIN_SPACING_MS} after the previous
 *   one STARTED (a sign-in that already took that long gets no extra wait),
 *   so fast id-less sign-ins start near 0, 12, 24, 36 and 48 s rather than
 *   spending all five tries in the first half-minute. None starts at or after
 *   {@link SEED_BSC_RELOGIN_WINDOW_MS}: when the spacing wait would carry the
 *   next start there, the loop stops with the stalled reason instead. A
 *   stalled sign-in takes about 13 s, so the usual worst case is the last
 *   start just under 58 s plus one stall, about 71 s, inside the hop's 90 s
 *   `SEED_SIGN_IN`. The window bounds when a login starts, not when it ends:
 *   one started near 58 s can run to its own 60 s timeout (longer under
 *   browser-service 503 retries), and the hop then times out instead of
 *   printing the reason. Either way the run is red.
 * - a login that fails (`success: false` or a throw) stops at once, with that
 *   login's message as the reason.
 * - NEO-489: every listing save above runs with the id saved, so
 *   `listingSync.setUpListing` checks one NB owner per seller account and can
 *   leave the row dormant on `sellerConflict`. After each save the row is
 *   read (`listingSync.listingSettings`); a conflict reports stored false
 *   with {@link SEED_BSC_SELLER_CONFLICT_REASON}, so the seed hop names it
 *   instead of a later step missing its "Listing your boxes" line.
 *
 * Logs one line per sign-in: `{msg: "seed_bsc_relogin", attempt, idSaved,
 * elapsedMs, waitedMs}` (attempt 1 is the first sign-in; `waitedMs` is the
 * spacing wait spent just before that sign-in started, 0 for the first). Neither a log line nor a
 * reason ever carries the id, the password or a token: `storeTestCredentials`'
 * messages are fixed per-site product copy.
 */
async function seedBscWithSellerId(
  ctx: ActionCtx,
  args: {
    userId: string;
    username: string;
    password: string;
    /** The correct, renewable secret is already stored (the flag-only branch). */
    alreadyPresent: boolean;
  },
): Promise<SeededSite> {
  const site = "buysportscards";
  const startedAt = Date.now();
  const sellerIdSaved = async (): Promise<boolean> => {
    const profile = await ctx.runQuery(api.userProfile.getUserProfile, {});
    return !!profile?.marketplaceAccountIds?.bscSellerId;
  };
  const store = async (listing: boolean): Promise<{ success: boolean; message: string }> => {
    try {
      return await ctx.runAction(internal.credentials.storeTestCredentials, {
        userId: args.userId,
        site,
        username: args.username,
        password: args.password,
        listing,
      });
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  /** After a listing save: stored, unless the save left the row on a seller conflict. */
  const listingSaved = async (): Promise<SeededSite> => {
    const settings = await ctx.runQuery(api.listingSync.listingSettings, {});
    return settings.bsc.sellerConflict
      ? { site, stored: false, reason: SEED_BSC_SELLER_CONFLICT_REASON }
      : { site, stored: true };
  };

  if (await sellerIdSaved()) {
    if (args.alreadyPresent) {
      await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
        userId: args.userId,
        site,
        hasCredentials: true,
        needsReauth: false,
        listing: "save",
      });
      return await listingSaved();
    }
    const stored = await store(true);
    return stored.success ? await listingSaved() : { site, stored: false, reason: stored.message };
  }

  let attempt = 0;
  let waitedMs = 0;
  for (;;) {
    attempt += 1;
    const signInStartedAt = Date.now();
    // NEO-489: listing stays off (the test marker) while the id is missing.
    const stored = await store(false);
    if (!stored.success) return { site, stored: false, reason: stored.message };
    const idSaved = await sellerIdSaved();
    console.log(
      JSON.stringify({ msg: "seed_bsc_relogin", attempt, idSaved, elapsedMs: Date.now() - startedAt, waitedMs }),
    );
    if (idSaved) {
      // The id is saved: now, and only now, turn listing on (clears the marker).
      await ctx.runMutation(internal.userProfile.updateSiteCredentialStatus, {
        userId: args.userId,
        site,
        hasCredentials: true,
        needsReauth: false,
        listing: "save",
      });
      return await listingSaved();
    }
    const stalled = {
      site,
      stored: false,
      reason: `BuySportsCards seller id not saved: the profile read stalled on every sign-in (${attempt} tries).`,
    };
    if (attempt > SEED_BSC_MAX_RELOGINS) return stalled;
    // Space the next START from this one's; never start at or past the window.
    const now = Date.now();
    const wait = Math.max(0, signInStartedAt + SEED_BSC_RELOGIN_SPACING_MS - now);
    if (now + wait - startedAt >= SEED_BSC_RELOGIN_WINDOW_MS) return stalled;
    const waitStartedAt = Date.now();
    if (wait > 0) await seedBscReloginClock.sleep(wait);
    waitedMs = Date.now() - waitStartedAt;
    // A real timer can overshoot; the window still bounds the start.
    if (Date.now() - startedAt >= SEED_BSC_RELOGIN_WINDOW_MS) return stalled;
  }
}

export const seedMyTestCredentials = action({
  args: {
    sites: v.optional(v.array(v.string())),
    // NEO-370 Revision 5: whether the seeded marketplace sign-ins LIST (a
    // saved sign-in is listing: counts pushed, sales polled). Default false:
    // the suite's accounts carry the test marker
    // (`marketplaceListingStates.testListingOff`) so nothing reaches a real
    // marketplace unless a spec asks (`/testing/seed-credentials?listing=on`).
    // True clears the marker and starts listing as a collector's own save.
    listing: v.optional(v.boolean()),
  },
  returns: v.object({
    seeded: v.array(
      v.object({
        site: v.string(),
        stored: v.boolean(),
        skipped: v.optional(v.boolean()),
        // NEO-294: why a store failed, in the user-facing words
        // `saveCredentials` already chose (paused / site-side refusal /
        // no answer / refused credentials / lock contention). Present ONLY on
        // a failure, so the "callers assert the exact array" contract above
        // still holds for every passing path. /testing/seed-credentials
        // prints it, which puts the CLASS of failure on the CI screenshot
        // instead of a bare `=fail`.
        reason: v.optional(v.string()),
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
    const seeded: SeededSite[] = [];

    if (wantsScanFixture) {
      const fixture: ScanFixtureResult = await ctx.runMutation(
        internal.testing.seedMyTestLabelScans,
        { userId },
      );
      seeded.push({ site: SCAN_FIXTURE_SELECTOR, stored: fixture.scans > 0 });
    }

    for (const site of sites) {
      // NEO-287 — a PAUSED marketplace is skipped FIRST, before the
      // `getSiteCredentials` metadata read below and before any
      // `saveCredentials` (a real marketplace login). Same shape as the
      // no-dev-creds skip so the seed flow needs no new branch; the paused
      // E2E branch asserts the paused UI instead of a stored session.
      if (isPlatformPaused(site)) {
        console.log(JSON.stringify({ msg: "seed_credentials_paused", site }));
        seeded.push({ site, stored: false, skipped: true });
        continue;
      }
      // NEO-415 — eBay signs in by OAuth, so the seed holds no password: it
      // connects with a refresh token minted out of band for the sandbox
      // seller (`DEV_EBAY_REFRESH_TOKEN`), through the browser service's
      // refresh-token grant (`credentials.connectEbay`, refused off testing
      // deployments and off the eBay sandbox, as the service refuses it in
      // production). One token exchange, no browser login, so it simply
      // reconnects every time. Skipped like any site with no dev secret.
      if (site === "ebay") {
        const refreshToken = process.env.DEV_EBAY_REFRESH_TOKEN;
        if (!refreshToken || !ebayConfigured() || ebayConfig()?.environment !== "sandbox") {
          seeded.push({ site, stored: false, skipped: true });
          continue;
        }
        const connected = await ctx.runAction(internal.credentials.connectEbay, {
          userId,
          refreshToken,
          listing: args.listing === true ? "save" : "testOff",
        });
        seeded.push({ site, stored: connected.ok, ...(connected.ok ? {} : { reason: connected.error }) });
        continue;
      }
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

      // NEO-482: a listing-on BSC seed must end with the seller id saved,
      // read live by a sign-in (see seedBscWithSellerId). It takes both
      // branches below over: flag-only or one store when the id is already
      // saved, fresh sign-ins until it is when it is not.
      if (site === "buysportscards" && args.listing === true) {
        seeded.push(
          await seedBscWithSellerId(ctx, {
            userId,
            username,
            password,
            alreadyPresent: credsMatch && sessionRenewable,
          }),
        );
        continue;
      }

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
          listing: args.listing === true ? "save" : "testOff",
        });
        seeded.push({ site, stored: true });
        continue;
      }

      // NEO-89: the store already updates hasCredentials server-side on
      // a successful store, so no separate follow-up mutation is needed here
      // (unlike the credsMatch branch above, which skips the store call
      // entirely and so must set the flag itself).
      //
      // NEO-370 Revision 5: through the internal store
      // (`credentials.storeTestCredentials`, the same connect-and-store as
      // `saveCredentials`) so the seed, not a collector's save, decides
      // whether the sign-in lists: the marker is written in the same mutation
      // as the credential flag, so nothing can start listing in between.
      const storeResult: { success: boolean; message: string } = await ctx.runAction(
        internal.credentials.storeTestCredentials,
        { userId, site, username, password, listing: args.listing === true },
      );

      // NEO-294: carry `saveCredentials`' own message through on a failure.
      // It is already product copy shown to real users (a fixed per-site
      // string — no username, password or token is interpolated into it), and
      // it is the only place that knows WHICH class of failure this was. On
      // success nothing is added, so the result shape is byte-identical to
      // before on every green path.
      seeded.push({
        site,
        stored: storeResult.success,
        ...(storeResult.success ? {} : { reason: storeResult.message }),
      });
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

// ── NEO-500: a BuySportsCards order to pick, for the Pick List spec ────────

/** Lines one seeded order may name, and copies one line may sell. */
const PICK_SEED_MAX_CARDS = 20;
const PICK_SEED_MAX_QUANTITY = 10;
/** Boxes and box copies the seed looks through (a suite account holds a handful). */
const PICK_SEED_SCAN = 500;
/** Described unmatched lines (`listedLines`) one seeded order may carry. */
const PICK_SEED_MAX_LISTED = 3;
/** The spec-minted order number: one token, so it is also a safe id suffix. */
const PICK_SEED_ORDER_NO_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * NEO-500 — a BuySportsCards order on the CALLER's account, recorded and
 * applied exactly as the order poll would, for the Pick List spec. Sales
 * cannot be made on cue (the seller accounts are shared, and a real BSC order
 * is a real buyer), so this builds the projected order the poll would have
 * stored and runs the poll's own two steps (`recordOrderCore`,
 * `applySaleLinesCore`) in this one mutation, skipping only the poll gate
 * (whether the account's listing state polls sales).
 *
 * The order: status READY_TO_SHIP, `orderId` = `TEST_SALE_ORDER_PREFIX` +
 * `orderNo` (so the poll never re-reads it from BSC), one line per
 * `cards` entry over the caller's box named `boxName`: the card in that box
 * with that card number (exactly one, or it refuses), its BSC card id from the
 * card's own `platformData.bsc.ref`, the BSC condition the box copy's NB
 * condition lists as, and the SKU NB would have pushed for (card, condition,
 * box). `badLine` adds one line whose SKU is not NB's ("Can't find it").
 * `listedLines` (NEO-509, at most `PICK_SEED_MAX_LISTED`) adds one more line
 * per entry that NB cannot match, whose description (`listed`) names a card
 * in the set of the order's first card: the sport row's name and its BSC
 * sport id (its `platformData.bsc` slot, so the store resolves NB's sport by
 * id as it would for a real order), the year row's name, the set as the Pick
 * List labels it (`${season} ${name}`), the given players, the given card
 * number, and variant "Base". A blank or absent `cardNumber` writes no
 * `cardNo` at all: a description with too little to file the line under a
 * set (it stays under "Can't find it" and still shows what BSC said). Each
 * line carries its own BSC card id and SKU (`nb-test-listed-card-<n>`,
 * `nb-test-listed-not-an-nb-sku-<n>`, n from 1), so the store keys them
 * apart.
 * Seeding an `orderNo` that exists records the stored order again as it is
 * (a retried hop applies nothing twice and does not look at the box again);
 * `ship` re-records it as SHIPPED, which takes it off the Pick List.
 *
 * Safety, in the same shape as the other seeds here:
 *   - fails closed in production (`TESTING_RESET_SECRET` is unset there);
 *   - only the CALLER's rows: their box, their copies, their sale (no owner
 *     argument to spoof);
 *   - calls no marketplace, and refuses outright while the caller pushes
 *     counts to any platform (`listsAnywhere`): the suite's accounts carry the
 *     test marker, so the copies it lowers queue nothing for a drain.
 */
export const seedMyTestPickOrder = mutation({
  args: {
    orderNo: v.string(),
    boxName: v.optional(v.string()),
    cards: v.optional(v.array(v.object({ cardNumber: v.string(), quantity: v.number() }))),
    badLine: v.optional(v.boolean()),
    listedLines: v.optional(v.array(v.object({ cardNumber: v.optional(v.string()), players: v.string() }))),
    ship: v.optional(v.boolean()),
  },
  returns: v.object({ saleId: v.id("marketplaceSales"), lines: v.number(), applied: v.number() }),
  handler: async (ctx, args) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("The pick-order seed is not enabled on this deployment");
    }
    const ownerId = await getCurrentUserId(ctx);
    if (!ownerId) throw new Error("Not authenticated");
    if (!PICK_SEED_ORDER_NO_RE.test(args.orderNo)) throw new Error("orderNo must be one token (letters, digits, - or _)");
    if (await listsAnywhere(ctx, ownerId)) {
      throw new Error("The pick-order seed refuses an account that pushes to a marketplace");
    }
    const orderId = `${TEST_SALE_ORDER_PREFIX}${args.orderNo}`;
    const existing = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", ownerId).eq("platform", "bsc").eq("orderId", orderId))
      .unique();

    let order: ProjectedOrder;
    if (args.ship && !existing) throw new Error(`No seeded order ${args.orderNo} to ship`);
    if (existing) {
      // Seeded before: record the stored order again (a retried hop, or
      // `ship`), never re-resolved from the box, whose copies it took.
      order = {
        orderId,
        orderNo: existing.orderNo,
        orderDate: existing.orderDate,
        status: args.ship ? "SHIPPED" : existing.status,
        totals: existing.totals,
        items: existing.items.map((item) => ({
          platformCardId: item.platformCardId,
          condition: item.condition,
          quantity: item.quantity,
          priceCents: item.priceCents,
          ...(item.sellerSku !== undefined ? { sellerSku: item.sellerSku } : {}),
          graded: false,
        })),
      };
    } else {
      const cards = args.cards ?? [];
      if (cards.length === 0 || cards.length > PICK_SEED_MAX_CARDS) {
        throw new Error(`cards must name 1-${PICK_SEED_MAX_CARDS} cards`);
      }
      const wantListed = args.listedLines ?? [];
      if (wantListed.length > PICK_SEED_MAX_LISTED) {
        throw new Error(`listedLines may name at most ${PICK_SEED_MAX_LISTED} lines`);
      }
      // Checked before anything is read: players are required, a card number
      // is optional (blank = none), and each present value is display text
      // within the bound the store keeps.
      const listedLines = wantListed.map((line, i): { players: string; cardNo?: string } => {
        const players = bscListedText(line.players, BSC_LISTED_BOUNDS.players);
        const rawNo = (line.cardNumber ?? "").trim();
        const cardNo = rawNo === "" ? undefined : bscListedText(rawNo, BSC_LISTED_BOUNDS.cardNo);
        if (players === null || cardNo === null) {
          throw new Error(`listedLines[${i}] needs players, and a card number only if any, within bounds`);
        }
        return { players, ...(cardNo !== undefined ? { cardNo } : {}) };
      });
      const boxName = (args.boxName ?? "").trim();
      const boxes = (
        await ctx.db
          .query("collectionContainers")
          .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
          .take(PICK_SEED_SCAN)
      ).filter((c) => c.kind === "box" && c.name.trim() === boxName);
      if (boxes.length !== 1) throw new Error(`Expected exactly one box named "${boxName}", found ${boxes.length}`);
      const box = boxes[0];
      const copies = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", box._id))
        .take(PICK_SEED_SCAN);
      const eras = new Map<string, BscEra | null>();
      const items: ProjectedOrder["items"] = [];
      let firstCard: Doc<"cardChecklist"> | null = null;
      for (const want of cards) {
        if (!Number.isInteger(want.quantity) || want.quantity < 1 || want.quantity > PICK_SEED_MAX_QUANTITY) {
          throw new Error(`quantity must be 1-${PICK_SEED_MAX_QUANTITY}`);
        }
        // The box's catalog cards with this number: exactly one.
        const matches = new Map<string, Doc<"cardChecklist">>();
        for (const copy of copies) {
          const cardId = ctx.db.normalizeId("cardChecklist", copy.cardId);
          if (!cardId || matches.has(cardId)) continue;
          const card = await ctx.db.get(cardId);
          if (card && card.cardNumber === want.cardNumber) matches.set(cardId, card);
        }
        if (matches.size !== 1) {
          throw new Error(`Expected one card #${want.cardNumber} in "${boxName}", found ${matches.size}`);
        }
        const card = [...matches.values()][0];
        firstCard ??= card;
        const ref = card.platformData?.bsc?.ref;
        if (!ref) throw new Error(`Card #${want.cardNumber} has no BuySportsCards id`);
        const copy = copies.find((c) => c.cardId === card._id && c.grading === undefined && c.condition !== undefined);
        if (!copy?.condition) throw new Error(`Card #${want.cardNumber} has no raw copy with a condition in "${boxName}"`);
        const era = await eraOfVariant(ctx, card.selectorOptionId, eras);
        if (era === null) throw new Error(`Card #${want.cardNumber} has no year to read its BSC era from`);
        const bscCondition = bscConditionFor(copy.condition, era);
        items.push({
          platformCardId: ref,
          condition: bscCondition,
          quantity: want.quantity,
          priceCents: 100,
          sellerSku: buildListingSku({ cardId: card._id, bscCondition, boxId: box._id }),
          graded: false,
        });
      }
      if (args.badLine) {
        items.push({
          platformCardId: "nb-test-unknown-card",
          condition: "near_mint",
          quantity: 1,
          priceCents: 100,
          sellerSku: "nb-test-not-an-nb-sku",
          graded: false,
        });
      }
      if (listedLines.length > 0 && firstCard) {
        const set = await new CatalogReader(ctx).setRef(firstCard.selectorOptionId);
        if (!set?.sport || !set.year) throw new Error(`Card #${firstCard.cardNumber} has no sport, year or set above it`);
        const sportRow = await ctx.db.get(set.sport._id);
        const platformSportId = sportRow ? slotIds(sportRow, "bsc")[0] : undefined;
        for (const [i, line] of listedLines.entries()) {
          items.push({
            platformCardId: `nb-test-listed-card-${i + 1}`,
            condition: "near_mint",
            quantity: 1,
            priceCents: 100,
            sellerSku: `nb-test-listed-not-an-nb-sku-${i + 1}`,
            graded: false,
            listed: {
              sport: set.sport.name,
              ...(platformSportId !== undefined ? { platformSportId } : {}),
              year: set.year.name,
              setName: `${set.season} ${set.name}`,
              players: line.players,
              ...(line.cardNo !== undefined ? { cardNo: line.cardNo } : {}),
              variant: "Base",
            },
          });
        }
      }
      const subtotalCents = items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
      order = {
        orderId,
        orderNo: args.orderNo,
        orderDate: Date.now(),
        status: "READY_TO_SHIP",
        totals: { subtotalCents, totalCents: subtotalCents },
        items,
      };
    }

    const recorded = await recordOrderCore(ctx, { ownerId, platform: "bsc", order }, { skipPollGate: true });
    if (recorded.saleId === null) throw new Error("The order was not recorded");
    let applied = 0;
    for (let i = 0; i < recorded.toApply.length; i += SALE_ITEMS_PER_APPLY) {
      const r = await applySaleLinesCore(
        ctx,
        { ownerId, saleId: recorded.saleId, indexes: recorded.toApply.slice(i, i + SALE_ITEMS_PER_APPLY) },
        { skipPollGate: true },
      );
      applied += r.applied;
    }
    return { saleId: recorded.saleId, lines: order.items.length, applied };
  },
});

// ── NEO-520: an eBay order NB didn't list, for the unmatched-sale spec ─────

/** Lines one seeded eBay order may carry, and copies one line may sell. */
const EBAY_SEED_MAX_LINES = 3;
const EBAY_SEED_MAX_QUANTITY = 10;

/**
 * NEO-520 — an eBay order on the CALLER's account whose every line is one
 * NeonBinder didn't list (no NB SKU), recorded and applied exactly as the
 * order poll would, for the unmatched-sale spec. A real sandbox order can't
 * be made on cue, so this builds the raw Fulfillment `Order` the poll reads
 * and runs it through the poll's own path: `projectEbayOrder` (the real
 * projection, title bounds included) → `projectEbayOrderForRecord` (with no
 * date floor) → `recordOrderCore` → `applySaleLinesCore`, skipping only the
 * poll gate (whether the account's listing state polls sales).
 *
 * The order: PAID, NOT_STARTED, created now, `orderId` =
 * `TEST_SALE_ORDER_PREFIX` + `orderNo` (so the poll never re-reads it from
 * eBay; the order number shown is the spec's own token). One line per
 * `lines` entry (1-3): legacy item id `nb-test-item-<n>`, SKU
 * `nb-test-other-<n>` (not NB's, so the apply refuses it as unmatched and
 * touches no box), the given quantity at $1.00 each, and the given title (a
 * title the projection would drop is refused here instead, so the spec never
 * lands on the no-title words by accident; an absent title sends none). No
 * buyer, ship-to or any other buyer field is written.
 * Seeding an `orderNo` that exists records the stored order again as it is;
 * `ship` re-records it as FULFILLED, which takes it off the Pick List.
 *
 * Safety, in the same shape as `seedMyTestPickOrder`:
 *   - fails closed in production (`TESTING_RESET_SECRET` is unset there);
 *   - only the CALLER's rows (no owner argument to spoof);
 *   - calls no marketplace, and refuses outright while the caller pushes
 *     counts to any platform (`listsAnywhere`).
 */
export const seedMyTestEbayOrder = mutation({
  args: {
    orderNo: v.string(),
    lines: v.optional(v.array(v.object({ title: v.optional(v.string()), quantity: v.number() }))),
    ship: v.optional(v.boolean()),
  },
  returns: v.object({ saleId: v.id("marketplaceSales"), lines: v.number(), applied: v.number() }),
  handler: async (ctx, args) => {
    if (!process.env.TESTING_RESET_SECRET) {
      throw new Error("The eBay order seed is not enabled on this deployment");
    }
    const ownerId = await getCurrentUserId(ctx);
    if (!ownerId) throw new Error("Not authenticated");
    if (!PICK_SEED_ORDER_NO_RE.test(args.orderNo)) throw new Error("orderNo must be one token (letters, digits, - or _)");
    if (await listsAnywhere(ctx, ownerId)) {
      throw new Error("The eBay order seed refuses an account that pushes to a marketplace");
    }
    const orderId = `${TEST_SALE_ORDER_PREFIX}${args.orderNo}`;
    const existing = await ctx.db
      .query("marketplaceSales")
      .withIndex("by_owner_platform_order", (q) => q.eq("ownerId", ownerId).eq("platform", "ebay").eq("orderId", orderId))
      .unique();

    let order: ProjectedOrder;
    if (args.ship && !existing) throw new Error(`No seeded eBay order ${args.orderNo} to ship`);
    if (existing) {
      // Seeded before: record the stored order again (a retried hop, or `ship`).
      order = {
        orderId,
        orderNo: existing.orderNo,
        orderDate: existing.orderDate,
        status: args.ship ? "FULFILLED" : existing.status,
        totals: existing.totals,
        items: existing.items.map((item) => ({
          platformCardId: item.platformCardId,
          condition: item.condition,
          quantity: item.quantity,
          priceCents: item.priceCents,
          ...(item.sellerSku !== undefined ? { sellerSku: item.sellerSku } : {}),
          graded: false,
        })),
      };
    } else {
      const lines = args.lines ?? [];
      if (lines.length === 0 || lines.length > EBAY_SEED_MAX_LINES) {
        throw new Error(`lines must name 1-${EBAY_SEED_MAX_LINES} lines`);
      }
      const lineItems = lines.map((line, i) => {
        if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > EBAY_SEED_MAX_QUANTITY) {
          throw new Error(`quantity must be 1-${EBAY_SEED_MAX_QUANTITY}`);
        }
        if (line.title !== undefined && ebayLineTitle(line.title) === null) {
          throw new Error(`lines[${i}].title is not a title NB would keep`);
        }
        return {
          lineItemId: `nb-test-line-${i + 1}`,
          legacyItemId: `nb-test-item-${i + 1}`,
          sku: `nb-test-other-${i + 1}`,
          ...(line.title !== undefined ? { title: line.title } : {}),
          quantity: line.quantity,
          lineItemCost: { value: line.quantity.toFixed(2), currency: "USD" },
        };
      });
      const subtotal = lines.reduce((sum, line) => sum + line.quantity, 0).toFixed(2);
      const created = new Date().toISOString();
      const raw = {
        orderId,
        creationDate: created,
        lastModifiedDate: created,
        orderPaymentStatus: "PAID",
        orderFulfillmentStatus: "NOT_STARTED",
        pricingSummary: {
          priceSubtotal: { value: subtotal, currency: "USD" },
          total: { value: subtotal, currency: "USD" },
        },
        lineItems,
      };
      const projected = projectEbayOrder(raw);
      const recordable = projected ? projectEbayOrderForRecord(projected, { ordersFrom: null }) : null;
      if (!recordable) throw new Error("The seeded eBay order did not project");
      // eBay shows the order id as its number; the spec reads its own token.
      order = { ...recordable, orderNo: args.orderNo };
    }

    const recorded = await recordOrderCore(ctx, { ownerId, platform: "ebay", order }, { skipPollGate: true });
    if (recorded.saleId === null) throw new Error("The order was not recorded");
    let applied = 0;
    for (let i = 0; i < recorded.toApply.length; i += SALE_ITEMS_PER_APPLY) {
      const r = await applySaleLinesCore(
        ctx,
        { ownerId, saleId: recorded.saleId, indexes: recorded.toApply.slice(i, i + SALE_ITEMS_PER_APPLY) },
        { skipPollGate: true },
      );
      applied += r.applied;
    }
    return { saleId: recorded.saleId, lines: order.items.length, applied };
  },
});
