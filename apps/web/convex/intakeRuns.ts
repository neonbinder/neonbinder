/**
 * NEO-379 — card intake runs and the matcher, server side, no UI.
 *
 * A run files one placeholder job's photos into one home (a binder or a box).
 * The placeholder pipeline already uploads, crops, reads and pairs the photos;
 * this module adds the step after pairing: match each pair to a card in the
 * run's variant (`lib/intakeMatch.ts` holds the rules) and keep the answer
 * where the intake screen can subscribe to it.
 *
 * Matching runs on the server as pairs change. Every placeholder writer that
 * adds, revises or removes a pair calls `noteIntakePairsChanged`, which queues
 * one `syncIntakeMatches` for the job's run (one index read and nothing else
 * when the job has no run, which is every non-intake job).
 *
 * Not here yet: saving a pair as a copy (it attaches the photos, NEO-377), the
 * common-price prompt (NEO-378), the catalog-wide set finder for a run with no
 * variant, and the screen itself (NEO-376 step 4).
 */

import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireSignedIn, getCurrentUserId } from "./auth";
import {
  intakeBandValidator,
  intakeDefaultsValidator,
  intakeReasonValidator,
  collectionContainerKindValidator,
} from "./schema";
import {
  intakeNamesFor,
  matchIntakePair,
  type IntakeCandidate,
} from "./lib/intakeMatch";

/** Pairs matched per sync before it re-queues itself for the rest. */
export const INTAKE_MATCH_CHUNK = 200;
/** Recent runs listed at most. */
const MAX_RECENT_RUNS = 20;
/** Characters kept of a free-text default. */
const MAX_DEFAULT_TEXT = 500;

/** Variant ancestry walked for a `cardNumberPrefix` (variant → set). */
const MAX_PREFIX_HOPS = 4;

async function ownedRun(
  ctx: QueryCtx,
  runId: Id<"intakeRuns">,
  userId: string,
): Promise<Doc<"intakeRuns"> | null> {
  const run = await ctx.db.get(runId);
  if (!run || run.userId !== userId) return null;
  return run;
}

async function requireOwnedRun(
  ctx: QueryCtx,
  runId: Id<"intakeRuns">,
): Promise<Doc<"intakeRuns">> {
  const userId = await requireSignedIn(ctx);
  const run = await ownedRun(ctx, runId, userId);
  if (!run) throw new Error("Intake run not found");
  return run;
}

/** A variant to match in must exist and hold cards directly. */
async function requireVariant(
  ctx: QueryCtx,
  variantId: Id<"selectorOptions">,
): Promise<void> {
  const row = await ctx.db.get(variantId);
  if (!row) throw new Error("Variant not found");
  const card = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
    .first();
  if (!card) throw new Error("That variant has no cards to match against");
}

function cleanDefaults(
  defaults: Doc<"intakeRuns">["defaults"],
): Doc<"intakeRuns">["defaults"] {
  if (!defaults) return undefined;
  const text = (s: string | undefined) => {
    const t = s?.trim();
    return t ? t.slice(0, MAX_DEFAULT_TEXT) : undefined;
  };
  const cents = (n: number | undefined, label: string) => {
    if (n === undefined) return undefined;
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number of cents, 0 or more`);
    return n;
  };
  return {
    condition: defaults.condition,
    grading: defaults.grading,
    costCents: cents(defaults.costCents, "Cost"),
    acquiredOn: text(defaults.acquiredOn),
    location: text(defaults.location),
    notes: text(defaults.notes),
    minPriceCents: cents(defaults.minPriceCents, "Minimum price"),
  };
}

/**
 * Queue a match sync for the job's intake run, if it has one. Called by every
 * placeholder writer that adds, revises or removes a pair. Cheap on purpose:
 * a job with no run costs one index read.
 */
export async function noteIntakePairsChanged(
  ctx: MutationCtx,
  jobId: string,
): Promise<void> {
  const run = await ctx.db
    .query("intakeRuns")
    .withIndex("by_job", (q) => q.eq("jobId", jobId))
    .first();
  if (!run) return;
  await queueSync(ctx, run);
}

async function queueSync(ctx: MutationCtx, run: Doc<"intakeRuns">): Promise<void> {
  if (run.matchScheduled) return;
  await ctx.db.patch(run._id, { matchScheduled: true });
  await ctx.scheduler.runAfter(0, internal.intakeRuns.syncIntakeMatches, { runId: run._id });
}

// ---------------------------------------------------------------------------
// Public: runs
// ---------------------------------------------------------------------------

/**
 * Start a run over a placeholder job the caller owns, filing into a home the
 * caller owns. One run per job: asking again returns the existing run.
 */
export const createIntakeRun = mutation({
  args: {
    jobId: v.string(),
    homeId: v.id("collectionContainers"),
    variantId: v.optional(v.id("selectorOptions")),
    defaults: v.optional(intakeDefaultsValidator),
  },
  returns: v.id("intakeRuns"),
  handler: async (ctx, args) => {
    const userId = await requireSignedIn(ctx);
    const job = await ctx.db
      .query("placeholderJobs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!job || job.userId !== userId) throw new Error("Job not found");
    const home = await ctx.db.get(args.homeId);
    if (!home || home.ownerId !== userId) throw new Error("Binder or box not found");
    if (args.variantId) await requireVariant(ctx, args.variantId);

    const existing = await ctx.db
      .query("intakeRuns")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    const runId = await ctx.db.insert("intakeRuns", {
      userId,
      jobId: args.jobId,
      homeId: args.homeId,
      variantId: args.variantId,
      defaults: cleanDefaults(args.defaults),
      createdAt: now,
      lastActivityAt: now,
    });
    const run = await ctx.db.get(runId);
    if (run) await queueSync(ctx, run);
    return runId;
  },
});

const runSummaryValidator = v.object({
  _id: v.id("intakeRuns"),
  jobId: v.string(),
  homeId: v.id("collectionContainers"),
  homeName: v.string(),
  homeKind: collectionContainerKindValidator,
  variantId: v.optional(v.id("selectorOptions")),
  variantName: v.optional(v.string()),
  variantPinned: v.optional(v.boolean()),
  defaults: v.optional(intakeDefaultsValidator),
  createdAt: v.number(),
  lastActivityAt: v.number(),
});

async function summarize(ctx: QueryCtx, run: Doc<"intakeRuns">) {
  const home = await ctx.db.get(run.homeId);
  const variant = run.variantId ? await ctx.db.get(run.variantId) : null;
  if (!home) return null;
  return {
    _id: run._id,
    jobId: run.jobId,
    homeId: run.homeId,
    homeName: home.name,
    homeKind: home.kind,
    variantId: run.variantId,
    variantName: variant?.value,
    variantPinned: run.variantPinned,
    defaults: run.defaults,
    createdAt: run.createdAt,
    lastActivityAt: run.lastActivityAt,
  };
}

/** One run, for `?run=`. Null when it is not the caller's (or is gone). */
export const getIntakeRun = query({
  args: { runId: v.id("intakeRuns") },
  returns: v.union(runSummaryValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return null;
    const run = await ownedRun(ctx, args.runId, userId);
    return run ? await summarize(ctx, run) : null;
  },
});

/** The caller's recent runs, newest activity first. */
export const listMyIntakeRuns = query({
  args: {},
  returns: v.array(runSummaryValidator),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];
    const runs = await ctx.db
      .query("intakeRuns")
      .withIndex("by_user_and_activity", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_RECENT_RUNS);
    const out = [];
    for (const run of runs) {
      const s = await summarize(ctx, run);
      if (s) out.push(s);
    }
    return out;
  },
});

/**
 * Pick or pin the run's variant. Every pair the collector has not picked by
 * hand is matched again in it.
 */
export const setIntakeRunVariant = mutation({
  args: {
    runId: v.id("intakeRuns"),
    variantId: v.id("selectorOptions"),
    /** True for "these are all from <set>", chosen mid-run. */
    pinned: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await requireOwnedRun(ctx, args.runId);
    await requireVariant(ctx, args.variantId);
    await ctx.db.patch(run._id, {
      variantId: args.variantId,
      variantPinned: args.pinned ? true : undefined,
      lastActivityAt: Date.now(),
    });
    // The variant is part of every row's readKey, so the sync re-matches them.
    await queueSync(ctx, { ...run, variantId: args.variantId });
    return null;
  },
});

/** Replace the run's batch defaults. */
export const setIntakeRunDefaults = mutation({
  args: { runId: v.id("intakeRuns"), defaults: intakeDefaultsValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await requireOwnedRun(ctx, args.runId);
    await ctx.db.patch(run._id, {
      defaults: cleanDefaults(args.defaults),
      lastActivityAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public: matches
// ---------------------------------------------------------------------------

const cardSummaryValidator = v.object({
  _id: v.id("cardChecklist"),
  cardNumber: v.string(),
  cardName: v.string(),
  variation: v.optional(v.string()),
});

const matchRowValidator = v.object({
  _id: v.id("intakeMatches"),
  pairId: v.id("placeholderPairs"),
  frontIndex: v.number(),
  backIndex: v.number(),
  cardId: v.optional(v.id("cardChecklist")),
  confidence: v.number(),
  band: intakeBandValidator,
  reason: intakeReasonValidator,
  candidates: v.array(cardSummaryValidator),
  variations: v.array(cardSummaryValidator),
  byUser: v.optional(v.boolean()),
  repeatOfPairId: v.optional(v.id("placeholderPairs")),
  /** Copies of the proposed card already in the run's home ("You have N here"). */
  haveHere: v.number(),
});

/**
 * The run's matches, in scan order, with the cards they name. Empty when the
 * run is not the caller's.
 */
export const listIntakeMatches = query({
  args: { runId: v.id("intakeRuns") },
  returns: v.array(matchRowValidator),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return [];
    const run = await ownedRun(ctx, args.runId, userId);
    if (!run) return [];
    const rows = await ctx.db
      .query("intakeMatches")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();
    rows.sort((a, b) => a.frontIndex - b.frontIndex);

    const cardCache = new Map<string, Doc<"cardChecklist"> | null>();
    const card = async (id: Id<"cardChecklist">) => {
      if (!cardCache.has(id)) cardCache.set(id, await ctx.db.get(id));
      const c = cardCache.get(id);
      return c
        ? { _id: c._id, cardNumber: c.cardNumber, cardName: c.cardName, variation: c.cardVariation }
        : null;
    };
    const many = async (ids: Id<"cardChecklist">[]) => {
      const out = [];
      for (const id of ids) {
        const c = await card(id);
        if (c) out.push(c);
      }
      return out;
    };
    const haveCache = new Map<string, number>();
    const haveHere = async (cardId: Id<"cardChecklist">) => {
      const hit = haveCache.get(cardId);
      if (hit !== undefined) return hit;
      const copies = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", userId).eq("cardId", cardId))
        .collect();
      const n = copies
        .filter((c) => c.homeId === run.homeId)
        .reduce((sum, c) => sum + c.quantity, 0);
      haveCache.set(cardId, n);
      return n;
    };

    const out = [];
    for (const row of rows) {
      out.push({
        _id: row._id,
        pairId: row.pairId,
        frontIndex: row.frontIndex,
        backIndex: row.backIndex,
        cardId: row.cardId,
        confidence: row.confidence,
        band: row.band,
        reason: row.reason,
        candidates: await many(row.candidates),
        variations: await many(row.variations),
        byUser: row.byUser,
        repeatOfPairId: row.repeatOfPairId,
        haveHere: row.cardId ? await haveHere(row.cardId) : 0,
      });
    }
    return out;
  },
});

/**
 * The collector picks the card for a pair (a candidate, a variation, or one
 * found by search), or clears the pick with `cardId: null` so the matcher
 * answers again. A pick is never overwritten by a later sync.
 */
export const pickIntakeCard = mutation({
  args: {
    runId: v.id("intakeRuns"),
    pairId: v.id("placeholderPairs"),
    cardId: v.union(v.id("cardChecklist"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await requireOwnedRun(ctx, args.runId);
    const row = await ctx.db
      .query("intakeMatches")
      .withIndex("by_pair", (q) => q.eq("pairId", args.pairId))
      .first();
    if (!row || row.runId !== run._id) throw new Error("Card not found in this run");

    if (args.cardId === null) {
      // Clearing the readKey makes the next sync match it afresh.
      await ctx.db.patch(row._id, { byUser: undefined, readKey: "" });
      await queueSync(ctx, run);
    } else {
      const card = await ctx.db.get(args.cardId);
      if (!card) throw new Error("Card not found");
      const variations = await ctx.db
        .query("cardChecklist")
        .withIndex("by_variation_parent", (q) => q.eq("variationOfCardId", card._id))
        .take(50);
      await ctx.db.patch(row._id, {
        cardId: card._id,
        confidence: 100,
        band: "matched",
        reason: "byUser",
        byUser: true,
        variations: variations.map((c) => c._id),
      });
      await queueSync(ctx, run); // re-flags repeats
    }
    await ctx.db.patch(run._id, { lastActivityAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal: the sync
// ---------------------------------------------------------------------------

async function variantPrefix(
  ctx: QueryCtx,
  variantId: Id<"selectorOptions">,
): Promise<string | null> {
  let id: Id<"selectorOptions"> | undefined = variantId;
  for (let hop = 0; id && hop < MAX_PREFIX_HOPS; hop++) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(id);
    if (!row) return null;
    const prefix = row.metadata?.cardNumberPrefix;
    if (prefix) return prefix;
    if (row.level === "setName") return null;
    id = row.parentId;
  }
  return null;
}

async function imagePlayers(
  ctx: QueryCtx,
  jobId: string,
  entryIndex: number,
): Promise<{ players: string[]; team?: string; cardNumber?: string }> {
  const image = await ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) => q.eq("jobId", jobId).eq("entryIndex", entryIndex))
    .first();
  return {
    players: image?.players ?? [],
    team: image?.team,
    cardNumber: image?.cardNumber,
  };
}

/**
 * Bring the run's match rows in line with the job's pairs: drop rows whose
 * pair is gone, match new pairs and pairs that read differently (never one
 * the collector picked), then flag repeats. At most `INTAKE_MATCH_CHUNK`
 * pairs are matched per call; the rest re-queue.
 */
export const syncIntakeMatches = internalMutation({
  args: { runId: v.id("intakeRuns") },
  returns: v.object({ matched: v.number(), removed: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return { matched: 0, removed: 0, more: false };
    await ctx.db.patch(run._id, { matchScheduled: undefined });

    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", run.jobId))
      .collect();
    const rows = await ctx.db
      .query("intakeMatches")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();

    const pairIds = new Set(pairs.map((p) => p._id));
    let removed = 0;
    for (const row of rows) {
      if (!pairIds.has(row.pairId)) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    const byPair = new Map(
      rows.filter((r) => pairIds.has(r.pairId)).map((r) => [r.pairId, r]),
    );

    let cards: IntakeCandidate[] | null = null;
    let prefix: string | null = null;
    const loadCards = async () => {
      if (cards || !run.variantId) return cards ?? [];
      const variantId = run.variantId;
      const rowsInVariant = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
        .collect();
      cards = rowsInVariant.map((c) => ({
        id: c._id,
        cardNumber: c.cardNumber,
        names: intakeNamesFor(c.cardName, c.playerLinks),
        team: c.team ?? null,
        variationOf: c.variationOfCardId ?? null,
      }));
      prefix = await variantPrefix(ctx, variantId);
      return cards;
    };

    let matched = 0;
    let more = false;
    const ordered = [...pairs].sort((a, b) => a.frontIndex - b.frontIndex);
    for (const pair of ordered) {
      const existing = byPair.get(pair._id);
      if (existing?.byUser) continue;
      const front = await imagePlayers(ctx, run.jobId, pair.frontIndex);
      const back = await imagePlayers(ctx, run.jobId, pair.backIndex);
      const players = [
        ...(pair.player ? [pair.player] : []),
        ...front.players,
        ...back.players,
      ].filter((p, i, all) => all.indexOf(p) === i);
      const read = {
        cardNumber: pair.cardNumber ?? back.cardNumber ?? front.cardNumber ?? null,
        players,
        team: pair.team ?? front.team ?? back.team ?? null,
      };
      const readKey = JSON.stringify([
        pair.frontIndex,
        pair.backIndex,
        read.cardNumber,
        read.players,
        read.team,
        run.variantId ?? null,
      ]);
      if (existing && existing.readKey === readKey) continue;
      if (matched >= INTAKE_MATCH_CHUNK) {
        more = true;
        break;
      }

      const answer = run.variantId
        ? matchIntakePair(read, await loadCards(), prefix)
        : null;
      const fields = {
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
        readKey,
        cardId: (answer?.cardId ?? undefined) as Id<"cardChecklist"> | undefined,
        confidence: answer?.confidence ?? 0,
        band: answer?.band ?? ("none" as const),
        reason: answer?.reason ?? ("noVariant" as const),
        candidates: (answer?.candidates ?? []) as Id<"cardChecklist">[],
        variations: (answer?.variations ?? []) as Id<"cardChecklist">[],
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        byPair.set(pair._id, { ...existing, ...fields });
      } else {
        const id = await ctx.db.insert("intakeMatches", {
          runId: run._id,
          userId: run.userId,
          pairId: pair._id,
          ...fields,
        });
        const inserted = await ctx.db.get(id);
        if (inserted) byPair.set(pair._id, inserted);
      }
      matched += 1;
    }

    // Repeats: the earliest-scanned pair matched to a card owns it; any later
    // pair matched to the same card points at it.
    const firstFor = new Map<string, Id<"placeholderPairs">>();
    const current = [...byPair.values()].sort((a, b) => a.frontIndex - b.frontIndex);
    for (const row of current) {
      let repeatOf: Id<"placeholderPairs"> | undefined;
      if (row.cardId) {
        repeatOf = firstFor.get(row.cardId);
        if (!repeatOf) firstFor.set(row.cardId, row.pairId);
      }
      if (row.repeatOfPairId !== repeatOf) {
        await ctx.db.patch(row._id, { repeatOfPairId: repeatOf });
      }
    }

    if (matched > 0 || removed > 0) {
      await ctx.db.patch(run._id, { lastActivityAt: Date.now() });
    }
    if (more) {
      const fresh = await ctx.db.get(run._id);
      if (fresh) await queueSync(ctx, fresh);
    }
    return { matched, removed, more };
  },
});
