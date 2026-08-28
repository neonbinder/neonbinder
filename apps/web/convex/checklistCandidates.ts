import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireAdmin, getCurrentUserId } from "./auth";
import { cardPlatformWireDataValidator } from "./schema";
import { cardNumberStem } from "../lib/cards/variations";

/**
 * NEO-195 — the streaming half of a checklist fetch.
 *
 * `fetchCardChecklist` takes ~6 seconds to fetch both marketplaces and
 * reconcile, then ~74 more resolving one team per card against BSC. Blocking
 * the review modal on the whole thing meant 80 seconds of "Fetching…".
 *
 * These functions let the action publish its work as it goes: candidates are
 * written as soon as reconciliation produces them, and released to the modal
 * only once they are genuinely reviewable.
 *
 * ## What the gate actually guards — corrected 2026-08-28
 *
 * The first version withheld a card from the modal until its team resolved.
 * That was too strict, and it blocked the very work the streaming was for:
 *
 *   "this is why I want to start seeing the cards stream in so that as a user
 *    I can work through this while the teams stuff is still being sorted out"
 *
 * Both of the product owner's statements are right, because they are about
 * different decisions:
 *
 *   PAIRING   — "BSC #1b is SportLots #1 [ Sliding ]" — needs card numbers and
 *               descriptions. It does not need a team, and no pairing decision
 *               changes when one arrives.
 *   APPROVING — committing the checklist. Must not happen on incomplete data.
 *
 * Teams are consumed AFTER Confirm, by the entity-review wizard. So the honest
 * gate is on CONFIRM, not on visibility — and that gate already exists in
 * CardPairingModal (`isStreaming` disables the button). Withholding rows on top
 * of it bought nothing and cost the operator the head start.
 *
 * Candidates are therefore released as soon as they are reconciled. `status`
 * still tracks whether a row's team has resolved, so the UI can show enrichment
 * in progress — it just no longer decides what may be seen.
 *
 * ## Stems still travel together
 *
 * A variation and the card it varies are written in the same batch and released
 * together, so a parent never appears without its variations. That matters for
 * pairing: you cannot sensibly link #1b while #1c is missing.
 */

const bucketValidator = v.union(
  v.literal("matched"),
  v.literal("bscOnly"),
  v.literal("slOnly"),
);

/** One candidate as the action hands it over. */
const candidateInputValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  teams: v.optional(v.array(v.string())),
  players: v.optional(v.array(v.string())),
  attributes: v.optional(v.array(v.string())),
  isRookie: v.optional(v.boolean()),
  isRelic: v.optional(v.boolean()),
  printRun: v.optional(v.number()),
  autographType: v.optional(v.string()),
  cardVariation: v.optional(v.string()),
  isVariation: v.optional(v.boolean()),
  platformData: cardPlatformWireDataValidator,
  bucket: bucketValidator,
  confidence: v.optional(v.number()),
});

/**
 * Open a batch: drop anything left from a previous run on this row, then write
 * every candidate as `pending`.
 *
 * Clearing first is deliberate. A re-sync before the operator cancelled would
 * otherwise leave two runs' candidates interleaved in the modal, and the older
 * ones would reference marketplace state that no longer exists.
 */
export const startCandidateBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
    userId: v.string(),
    candidates: v.array(candidateInputValidator),
    // Whether every card's team is already known. When false the rows are still
    // shown — see the note above — and simply carry `pending` until enrichment
    // reaches them.
    readyImmediately: v.boolean(),
  },
  returns: v.object({ written: v.number(), cleared: v.number() }),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    for (const row of stale) await ctx.db.delete(row._id);

    for (const c of args.candidates) {
      await ctx.db.insert("checklistCandidates", {
        ...c,
        selectorOptionId: args.selectorOptionId,
        batchId: args.batchId,
        createdByUserId: args.userId,
        stem: cardNumberStem(c.cardNumber),
        status: args.readyImmediately ? "ready" : "pending",
        lastUpdated: Date.now(),
      });
    }
    return { written: args.candidates.length, cleared: stale.length };
  },
});

/**
 * Attach resolved team names to the cards a lookup chunk covered, then release
 * every stem group that is now complete.
 *
 * Called once per chunk, so the modal fills in progressively rather than all at
 * once at the end.
 *
 * A card whose lookup came back EMPTY is still resolved — BSC genuinely has no
 * team for it (an insert, a checklist card). Marking it ready is correct;
 * leaving it pending would strand the row and, with group gating, its whole
 * stem.
 */
export const resolveCandidateTeams = internalMutation({
  args: {
    batchId: v.string(),
    // bsc ref → team name. A ref present with no name resolved to "no team".
    resolved: v.array(
      v.object({ bscRef: v.string(), teamName: v.optional(v.string()) }),
    ),
  },
  returns: v.object({ patched: v.number(), released: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_batch", (q) => q.eq("batchId", args.batchId))
      .collect();

    const byBscRef = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const ref = r.platformData.bsc?.ref;
      if (ref) byBscRef.set(ref, r);
    }

    const touchedStems = new Set<string>();
    let patched = 0;
    for (const { bscRef, teamName } of args.resolved) {
      const row = byBscRef.get(bscRef);
      if (!row) continue;
      await ctx.db.patch(row._id, {
        // An empty result is an answer, not a failure — see the note above.
        ...(teamName ? { teams: [teamName] } : {}),
        status: "ready",
        lastUpdated: Date.now(),
      });
      touchedStems.add(row.stem);
      patched++;
    }

    // Release whole stems only. A stem is complete when nothing in it is still
    // pending — which includes rows this chunk never touched.
    const fresh = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_batch", (q) => q.eq("batchId", args.batchId))
      .collect();
    const pendingByStem = new Set(
      fresh.filter((r) => r.status === "pending").map((r) => r.stem),
    );
    let released = 0;
    for (const stem of touchedStems) {
      if (!pendingByStem.has(stem)) released++;
    }
    return { patched, released };
  },
});

/**
 * The modal's live view.
 *
 * Returns EVERY candidate in the batch, pending teams included — pairing does
 * not need a team, and Confirm is separately blocked until the fetch finishes.
 * `ready` counts how many have their team so the UI can show enrichment
 * progress.
 */
export const getReadyCandidates = query({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({
    batchId: v.optional(v.string()),
    total: v.number(),
    ready: v.number(),
    cards: v.array(
      v.object({
        _id: v.id("checklistCandidates"),
        cardNumber: v.string(),
        cardName: v.string(),
        teams: v.optional(v.array(v.string())),
        players: v.optional(v.array(v.string())),
        attributes: v.optional(v.array(v.string())),
        isRookie: v.optional(v.boolean()),
        isRelic: v.optional(v.boolean()),
        printRun: v.optional(v.number()),
        autographType: v.optional(v.string()),
        cardVariation: v.optional(v.string()),
        isVariation: v.optional(v.boolean()),
        platformData: cardPlatformWireDataValidator,
        bucket: bucketValidator,
        confidence: v.optional(v.number()),
        stem: v.string(),
        teamResolved: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    if (rows.length === 0) {
      return { batchId: undefined, total: 0, ready: 0, cards: [] };
    }

    const cards = rows
      .map((r) => ({
        _id: r._id,
        cardNumber: r.cardNumber,
        cardName: r.cardName,
        teams: r.teams,
        players: r.players,
        attributes: r.attributes,
        isRookie: r.isRookie,
        isRelic: r.isRelic,
        printRun: r.printRun,
        autographType: r.autographType,
        cardVariation: r.cardVariation,
        isVariation: r.isVariation,
        platformData: r.platformData,
        bucket: r.bucket,
        confidence: r.confidence,
        stem: r.stem,
        // Lets the row show "resolving team…" rather than an empty cell that
        // looks like "this card has no team".
        teamResolved: r.status === "ready",
      }));

    return {
      batchId: rows[0].batchId,
      total: rows.length,
      ready: rows.filter((r) => r.status === "ready").length,
      cards,
    };
  },
});

/**
 * NEO-195 — reap candidates from a fetch that never finished.
 *
 * The normal exits both clean up: confirm promotes then discards, cancel
 * discards. What neither covers is a fetch that DIED — the browser closed
 * mid-sync, the action threw somewhere unhandled, the tab was killed. Those
 * rows have no owner and no one to delete them.
 *
 * Left alone they are not merely litter: `getReadyCandidates` reads by
 * selectorOption, so a half-finished run would surface stale cards next to a
 * fresh one, and its still-pending stems would withhold groups that have
 * nothing to do with the current fetch.
 *
 * `startCandidateBatch` already clears the row it is about to write, so this is
 * the backstop for rows nobody comes back to. An hour is far longer than any
 * real fetch (~80s at the worst measured) while staying well short of a
 * session an operator might resume.
 */
const CANDIDATE_STALE_MS = 60 * 60 * 1000;

export const sweepStaleCandidates = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - CANDIDATE_STALE_MS;
    // Bounded: a sweep that tried to delete an unbounded backlog in one
    // transaction would be the thing that breaks, not the litter it is
    // clearing. Whatever is left is picked up on the next run.
    const rows = await ctx.db.query("checklistCandidates").take(2000);
    let deleted = 0;
    for (const row of rows) {
      if (row.lastUpdated >= cutoff) continue;
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted };
  },
});

/**
 * Drop a batch. Called on cancel, and after a confirm has promoted the rows.
 *
 * Candidates are worthless once the operator has decided — keeping them would
 * make the next fetch's "clear stale rows" step do the work instead, one sync
 * later and less obviously.
 */
export const discardCandidates = mutation({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});
