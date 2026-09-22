import { v, type Infer } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAdmin, getCurrentUserIdentity } from "./auth";
import { cardPlatformWireDataValidator } from "./schema";
import { cardNumberStem } from "../lib/cards/variations";
// NEO-251 security review: the same two bounds the write path enforces, applied
// at this boundary too — see `startCandidateBatch`'s handler.
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "./features/cardAttention";
import { MAX_PLAYER_NAME_LENGTH } from "../lib/players/name-limits";

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

/**
 * NEO-251 — both marketplaces' player lists for one card, plus an optional
 * hint.
 *
 * `preferred` is evidence, never a decision: it is set only when the NB row
 * this card matches already carries SportLots' roster, which means an operator
 * settled it that way on an earlier sync. The modal still defaults to BSC and
 * still makes the operator choose — NB owns the answer.
 */
const playersConflictValidator = v.object({
  bsc: v.array(v.string()),
  sportlots: v.array(v.string()),
  preferred: v.optional(v.union(v.literal("bsc"), v.literal("sportlots"))),
});

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
  // NEO-199 — set only when BSC and SportLots name this card differently, which
  // on a real set is a handful of rows out of ~900.
  nameConflict: v.optional(
    v.object({ bsc: v.string(), sportlots: v.string() }),
  ),
  // NEO-251 — the same, for the player LIST. `nameConflict` is about the card's
  // title; this is about who the card says is on it, which is a separate field
  // that fails separately (BSC sends a structured array, SportLots one subject
  // string that `parseSlSubjects` splits). Count- and length-bounded by
  // `startCandidateBatch`'s handler, not by this validator — see there.
  playersConflict: v.optional(playersConflictValidator),
  bucket: bucketValidator,
  confidence: v.optional(v.number()),
});


/**
 * NEO-294 — how many candidate rows ONE transaction may write or clear.
 *
 * ## The failure this exists to stop
 *
 * Convex counts one system operation per CALL — an index read, an insert, a
 * delete, a `scheduler.runAfter` — and `startCandidateBatch` made one per
 * CARD, twice: it deleted the operator's previous rows and then inserted the
 * new ones, in a single transaction. On a ~900-card set (2024 Topps Chrome,
 * the shape the seed job syncs) a re-sync is
 *
 *   1 index read + ~900 deletes + ~900 inserts ≈ 1,801 operations
 *
 * against the ceiling `CARDS_PER_COMMIT_CHUNK` (selectorOptions.ts) measured
 * from the same Convex error in NEO-189: ~900 is comfortable, ~1,800 strains,
 * ~4,000 fails outright. The whole candidate array arrives in ONE
 * `ctx.runMutation` from `fetchCardChecklist`, and that caller does not chunk,
 * so nothing was bounding it.
 *
 * ## The page, and the arithmetic
 *
 * 700 rows per transaction, plus the one index read that produced the page and
 * the one `scheduler.runAfter` that continues the chain, is ~702 — ~22%
 * headroom under the comfortable ceiling. The clear and the write are separate
 * phases with separate pages, which is most of the fix on its own: the
 * measured worst case stops being 1,801 operations and becomes two
 * transactions of ~901 even before either is paged.
 *
 * ## Why the chain is scheduled rather than driven by the caller
 *
 * `createSetsFromSlRoots`' chunking is the caller-driven precedent, and it
 * would be the better shape here too — but the caller lives in
 * `selectorOptions.ts` and the loop belongs with the data it walks. A
 * `runAfter(0)` chain gets the same bound with the same convergence: the CLEAR
 * runs to completion before the first row is written (so the modal never
 * interleaves two runs, which is what the clear is for), each page commits on
 * its own, and `from` names the next candidate so a replayed page re-writes
 * nothing.
 *
 * Nothing downstream observes the split. The auto-keep path already polls
 * `getReadyCandidates` until `total` equals the count the action reported
 * (`CardChecklist.awaitStreamedBatch`, 30s budget) before it commits anything,
 * and the pairing modal's Confirm is gated on the action's own promise. The
 * one ordering that had to be made explicit is the team lookup's — see
 * `resolveCandidateTeams`, which now retries a card whose row this chain had
 * not reached yet.
 */
export const CHECKLIST_CANDIDATE_PAGE = 700;

/**
 * NEO-294 — `startCandidateBatch`'s own arguments, so the page writer and the
 * continuation it schedules are typed from one place rather than from a
 * hand-copied shape that could drift from the validator.
 */
type StartCandidateBatchArgs = {
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  userId: string;
  candidates: Array<Infer<typeof candidateInputValidator>>;
  readyImmediately: boolean;
  from?: number;
};

/**
 * NEO-294 — delete one page of an operator's candidate rows on a row, and say
 * whether more remain.
 *
 * The single body behind `startCandidateBatch`'s clear, `discardCandidates`
 * and the scheduled tail of both, so the three cannot drift on what "this
 * operator's rows on this selectorOption" means — the scoping NEO-195's
 * follow-up added after an unscoped clear destroyed a second admin's in-flight
 * review.
 *
 * Reads one row PAST the page so `hasMore` comes from the same query rather
 * than a second one. Private, and assumes its caller has gated itself.
 */
async function clearCandidatePage(
  ctx: MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  userId: string,
): Promise<{ cleared: number; hasMore: boolean }> {
  const rows = await ctx.db
    .query("checklistCandidates")
    .withIndex("by_selector_option_and_user", (q) =>
      q.eq("selectorOptionId", selectorOptionId).eq("createdByUserId", userId),
    )
    .take(CHECKLIST_CANDIDATE_PAGE + 1);
  const page = rows.slice(0, CHECKLIST_CANDIDATE_PAGE);
  for (const row of page) await ctx.db.delete(row._id);
  return { cleared: page.length, hasMore: rows.length > page.length };
}

/**
 * NEO-294 — finish a clear that ran out of transaction. Chains until the
 * operator's rows on this selectorOption are gone.
 *
 * Internal and unscoped by identity on purpose: it is the tail of a decision an
 * admin already made and a gate already checked, and it can only ever delete
 * rows for the (selectorOption, operator) pair the caller named.
 */
export const clearCandidatesTail = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    userId: v.string(),
  },
  returns: v.object({ cleared: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const result = await clearCandidatePage(
      ctx,
      args.selectorOptionId,
      args.userId,
    );
    if (result.hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.checklistCandidates.clearCandidatesTail,
        { selectorOptionId: args.selectorOptionId, userId: args.userId },
      );
    }
    return result;
  },
});

/**
 * Open a batch: drop anything left from THIS OPERATOR's previous run on this
 * row, then write every candidate as `pending`.
 *
 * Clearing first is deliberate. A re-sync before the operator cancelled would
 * otherwise leave two runs' candidates interleaved in the modal, and the older
 * ones would reference marketplace state that no longer exists.
 *
 * ## Why the clear is scoped to the caller — NEO-195 follow-up
 *
 * "A run" belongs to an operator, not to a selectorOption. The first version
 * cleared every row for the selectorOption regardless of who wrote it, so two
 * admins syncing the same set concurrently destroyed each other's work: A's
 * fetch deleted B's in-flight rows, B's modal emptied mid-review, and B lost a
 * 900-card reconciliation with no error to explain it. `createdByUserId` was
 * already written on every row and never read — the scoping was intended and
 * missed.
 *
 * Scoping keeps the original intent intact (a second run by the SAME operator
 * still replaces their own previous batch) and drops only the collateral.
 *
 * ## NEO-294 — two bounded phases, and the clear still goes first
 *
 * See `CHECKLIST_CANDIDATE_PAGE` for the arithmetic. `from` is the index of
 * the next candidate to write and is absent on the caller's own invocation;
 * the CLEAR is finished before the first row is written, because a modal
 * showing two runs' candidates interleaved is the failure the clear exists to
 * prevent and a half-cleared table is exactly that. The bounds are per
 * TRANSACTION, not per batch: nothing is ever dropped, and `hasMore` says
 * whether a continuation is on its way.
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
    // NEO-294 — the index of the first candidate THIS call writes. Absent
    // starts at the head and clears the operator's previous run first.
    from: v.optional(v.number()),
  },
  returns: v.object({
    written: v.number(),
    cleared: v.number(),
    // NEO-294 — true when a scheduled continuation is carrying the rest.
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const from = args.from ?? 0;

    // NEO-251 (security review) — bound every name on a candidate before any of
    // it is stored.
    //
    // The same numbers the WRITE path enforces (`MAX_CARD_PLAYERS`,
    // `MAX_CARD_TEAMS`, `MAX_PLAYER_NAME_LENGTH`), applied here because this is
    // a DIFFERENT boundary from the commit's: a candidate row is written once
    // and then read back into an operator's browser on every tick of a reactive
    // subscription, so an adapter regression that turned one subject string
    // into hundreds of "names" would be paid for on every one of those reads,
    // on every row of a ~900-card batch — long before anything reached a
    // commit, and whether or not the operator ever pressed Confirm.
    //
    // `players` and `teams` are bounded as well as the conflict arrays. They
    // are the same shape from the same source (an adapter parsing a marketplace
    // page), they are stored in the same row, and they are read back on the
    // same subscription — bounding only the conflict would have left the larger
    // and far more common field open.
    //
    // The whole batch is REFUSED rather than trimmed. A truncated roster is a
    // wrong roster that looks right, and this is the field a listing's players
    // are generated from; a failed fetch is recoverable, silently listing the
    // wrong player is not. Reported by COUNT and by LENGTH, never by echoing a
    // name (the `players.ts` convention) — the card number is NB's own value.
    const assertNames = (
      cardNumber: string,
      names: string[],
      max: number,
      /** What is being counted: "players", "bsc players in its roster conflict". */
      subject: string,
      /** The noun in the limit phrase and the name message: "player" / "team". */
      unit: string,
    ) => {
      if (names.length > max) {
        throw new Error(
          `startCandidateBatch: card #${cardNumber} carries ${names.length} ${subject}, above the ${max}-${unit} limit`,
        );
      }
      for (const name of names) {
        if (name.length > MAX_PLAYER_NAME_LENGTH) {
          throw new Error(
            `startCandidateBatch: card #${cardNumber} carries a ${unit} name of ${name.length} characters; the limit is ${MAX_PLAYER_NAME_LENGTH}.`,
          );
        }
      }
    };

    for (const c of args.candidates) {
      assertNames(
        c.cardNumber,
        c.players ?? [],
        MAX_CARD_PLAYERS,
        "players",
        "player",
      );
      assertNames(c.cardNumber, c.teams ?? [], MAX_CARD_TEAMS, "teams", "team");
      const conflict = c.playersConflict;
      if (!conflict) continue;
      for (const side of ["bsc", "sportlots"] as const) {
        assertNames(
          c.cardNumber,
          conflict[side],
          MAX_CARD_PLAYERS,
          `${side} players in its roster conflict`,
          "player",
        );
      }
    }

    /*
     * NEO-294 — PHASE 1, and only on the first call: drop what THIS OPERATOR
     * left behind on this row.
     *
     * Scoped to the caller: another operator's in-flight batch on this same row
     * is not stale, it is someone else's live review.
     *
     * The clear finishes before ANY row of the new batch is written. That is
     * what keeps the page read below unambiguous — no row of `args.batchId`
     * exists yet, so everything the index returns is genuinely stale — and it
     * is what the clear is for in the first place: a modal showing two runs'
     * candidates interleaved, the older ones pointing at marketplace state
     * that no longer exists.
     */
    if (from === 0) {
      const { cleared, hasMore } = await clearCandidatePage(
        ctx,
        args.selectorOptionId,
        args.userId,
      );
      if (hasMore) {
        // Still clearing. Re-enter at `from: 0` rather than moving on, so the
        // write phase cannot start on a half-cleared table.
        await ctx.scheduler.runAfter(
          0,
          internal.checklistCandidates.startCandidateBatch,
          { ...args, from: 0 },
        );
        return { written: 0, cleared, hasMore: true };
      }
      return await writeCandidatePage(ctx, args, 0, cleared);
    }
    return await writeCandidatePage(ctx, args, from, 0);
  },
});

/**
 * NEO-294 — PHASE 2: write one page of candidates and hand the rest to the
 * scheduler.
 *
 * Split out so the two entry points into it (the first call, once its clear
 * has finished, and every continuation) cannot drift on what a page is or on
 * when the chain stops.
 *
 * `from` is an index into an array the caller re-passes unchanged rather than
 * a cursor into the table, so there is nothing to go stale between links. A
 * page is a Convex transaction: it committed or it wrote nothing, and the
 * scheduler runs each link once — so there is no half-written page to
 * reconcile. The recovery path for a chain that dies is the ENTRY point, which
 * clears this operator's rows before it writes anything; re-running the fetch
 * can never leave two copies of a card.
 */
async function writeCandidatePage(
  ctx: MutationCtx,
  args: StartCandidateBatchArgs,
  from: number,
  cleared: number,
): Promise<{ written: number; cleared: number; hasMore: boolean }> {
  /*
   * NEO-294 — a continuation whose batch is GONE writes nothing.
   *
   * Paging opened one window the single-transaction version could not have: a
   * link of an abandoned chain landing after the operator has cancelled, or
   * after their next sync cleared the table and started a new batch. Without
   * this, those rows would be inserted into a dead batch and surface in
   * `getReadyCandidates` beside the live one — the interleaving the clear
   * exists to prevent, arriving through the back door.
   *
   * One index read, on continuations only, so the ordinary single-page batch
   * pays nothing. `from > 0` is exactly "somebody wrote page zero", so an
   * empty batch here means it was cleared rather than never started.
   */
  if (from > 0) {
    const alive = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_batch", (q) => q.eq("batchId", args.batchId))
      .first();
    if (alive === null) {
      // Counts and a batch id only — never a card name. See observability.ts.
      console.warn(
        JSON.stringify({
          msg: "checklist_candidate_batch_abandoned",
          batchId: args.batchId,
          from,
        }),
      );
      return { written: 0, cleared, hasMore: false };
    }
  }

  const page = args.candidates.slice(from, from + CHECKLIST_CANDIDATE_PAGE);
  const now = Date.now();
  for (const c of page) {
    await ctx.db.insert("checklistCandidates", {
      ...c,
      selectorOptionId: args.selectorOptionId,
      batchId: args.batchId,
      createdByUserId: args.userId,
      stem: cardNumberStem(c.cardNumber),
      status: args.readyImmediately ? "ready" : "pending",
      lastUpdated: now,
    });
  }
  const next = from + page.length;
  const hasMore = next < args.candidates.length;
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.checklistCandidates.startCandidateBatch,
      { ...args, from: next },
    );
  }
  return { written: page.length, cleared, hasMore };
}

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
 *
 * ## NEO-294 — one retry for a row the write chain has not reached
 *
 * `startCandidateBatch` now writes a very large batch across more than one
 * transaction (see `CHECKLIST_CANDIDATE_PAGE`), so for the first few
 * milliseconds of a >700-card sync a `bscRef` this chunk resolved may belong
 * to a row that does not exist yet. Silently skipping it — which is what the
 * `if (!row) continue` below does, and rightly, for a row a Cancel deleted —
 * would lose that card's team with no trace, and nothing re-asks BSC.
 *
 * So a miss is retried ONCE, after a short delay, for exactly the refs that
 * missed. The gap it has to cover is tiny and the margin is large: the write
 * chain is `runAfter(0)` links of ~700 inserts, while the caller only reaches
 * this mutation after a real BSC round trip for 50 cards (~4s on the measured
 * ~74s/900-card enrichment). One retry, never a loop — if the row is still
 * absent it was deleted, not late, and the count is reported rather than
 * retried forever.
 */
export const resolveCandidateTeams = internalMutation({
  args: {
    batchId: v.string(),
    // bsc ref → team name. A ref present with no name resolved to "no team".
    resolved: v.array(
      v.object({ bscRef: v.string(), teamName: v.optional(v.string()) }),
    ),
    // NEO-294 — set on the one retry, so a miss cannot reschedule forever.
    retry: v.optional(v.boolean()),
  },
  returns: v.object({
    patched: v.number(),
    released: v.number(),
    // NEO-294 — refs this call found no row for. Retried once (see above) and
    // then reported.
    missing: v.number(),
  }),
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
    /** NEO-294 — refs with no row yet; see the retry note above. */
    const missed: Array<{ bscRef: string; teamName?: string }> = [];
    let patched = 0;
    for (const { bscRef, teamName } of args.resolved) {
      const row = byBscRef.get(bscRef);
      if (!row) {
        missed.push(teamName === undefined ? { bscRef } : { bscRef, teamName });
        continue;
      }
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

    /*
     * NEO-294 — the one retry. `args.retry` marks the retry itself, so this
     * can never chain: a ref still missing on the second pass belongs to a row
     * that was deleted, not to one that is late.
     *
     * The delay is what makes it worth doing at all — `runAfter(0)` would land
     * in the same millisecond the write chain is still in.
     */
    const RETRY_MS = 1_000;
    if (missed.length > 0 && args.retry !== true) {
      await ctx.scheduler.runAfter(
        RETRY_MS,
        internal.checklistCandidates.resolveCandidateTeams,
        { batchId: args.batchId, resolved: missed, retry: true },
      );
    } else if (missed.length > 0) {
      // Counts and a batch id only — never a card name. See observability.ts.
      console.warn(
        JSON.stringify({
          msg: "checklist_candidate_team_unmatched",
          batchId: args.batchId,
          missing: missed.length,
        }),
      );
    }
    return { patched, released, missing: missed.length };
  },
});

/**
 * The modal's live view, scoped to the signed-in operator.
 *
 * Scoping matters as much here as it does in `startCandidateBatch`: this query
 * is what the modal subscribes to, so an unscoped read let one operator's
 * fetch repopulate — or empty — another operator's open dialog. A caller with
 * no identity sees nothing rather than erroring; the query is reactive and the
 * modal mounts before auth necessarily resolves, so an empty batch is the
 * honest answer and a throw would only surface as a broken subscription.
 *
 * Returns EVERY candidate in the operator's batch, pending teams included — pairing does
 * not need a team, and Confirm is separately blocked until the fetch finishes.
 * `ready` counts how many have their team so the UI can show enrichment
 * progress.
 *
 * ## NEO-203 — admin-gated, but still non-throwing
 *
 * Every other function in the checklist pipeline is `requireAdmin`; this one
 * was only ever auth-SCOPED, which was a gap rather than a decision — the
 * cards it hands back are a privileged marketplace fetch, and set building is
 * an admin surface end to end.
 *
 * It checks the role WITHOUT throwing, because the not-yet-authenticated case
 * is real and normal here: this query is reactive and the modal mounts before
 * auth necessarily resolves, so a throw surfaces as a broken subscription
 * rather than as a permission error. An empty batch is the honest answer for
 * "nobody who may see this is asking" — and a non-admin cannot write candidate
 * rows in the first place (`startCandidateBatch` runs behind
 * `fetchCardChecklist`'s own `requireAdmin`), so the scope and the gate agree.
 */
export const getReadyCandidates = query({
  args: { selectorOptionId: v.id("selectorOptions") },
  // Deliberately public-by-shape but self-scoping AND admin-gated: the handler
  // reads the caller's identity and role, and can only ever return rows an
  // admin caller wrote themselves.
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
        nameConflict: v.optional(
          v.object({ bsc: v.string(), sportlots: v.string() }),
        ),
        playersConflict: v.optional(playersConflictValidator),
        bucket: bucketValidator,
        confidence: v.optional(v.number()),
        stem: v.string(),
        teamResolved: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await getCurrentUserIdentity(ctx);
    if (!identity || identity.role !== "admin") {
      return { batchId: undefined, total: 0, ready: 0, cards: [] };
    }
    const userId = identity.userId;
    const rows = await ctx.db
      .query("checklistCandidates")
      .withIndex("by_selector_option_and_user", (q) =>
        q
          .eq("selectorOptionId", args.selectorOptionId)
          .eq("createdByUserId", userId),
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
        // NEO-199: the wrong-player guard fires on the STREAMED view too. The
        // modal opens on this query seconds into a fetch and lives on it for
        // the ~70s of team enrichment that follows, so a conflict withheld here
        // is a conflict the operator reviews the row without.
        nameConflict: r.nameConflict,
        // NEO-251: same reasoning one field over — a roster disagreement
        // withheld from the streamed view is one the operator reviews the row
        // without.
        playersConflict: r.playersConflict,
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
 * selectorOption AND operator, so a half-finished run of that operator's own
 * would surface stale cards next to a fresh one, and its still-pending stems
 * would withhold groups that have nothing to do with the current fetch.
 *
 * This sweep stays GLOBAL on purpose — it is an hourly cron with no caller to
 * scope to, and abandoned rows belong to operators who are, by definition, not
 * coming back. It is the one function in this file that should not be
 * user-scoped.
 *
 * `startCandidateBatch` already clears the row it is about to write, so this is
 * the backstop for rows nobody comes back to. An hour is far longer than any
 * real fetch (~80s at the worst measured) while staying well short of a
 * session an operator might resume.
 */
const CANDIDATE_STALE_MS = 60 * 60 * 1000;

export const sweepStaleCandidates = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - CANDIDATE_STALE_MS;
    /*
     * NEO-294 — the SCAN was bounded; the DELETES were not.
     *
     * `take(2000)` costs one system operation however many rows it returns, so
     * the bound that mattered was never here — it was the delete per row
     * behind it. Two abandoned ~900-card fetches is ~1,800 operations in one
     * transaction, which `CARDS_PER_COMMIT_CHUNK` measured as straining, and a
     * sweep that throws leaves the litter it exists to clear exactly where it
     * was. So the deletes are bounded too, at the same page every other write
     * in this file uses.
     *
     * The scan stays wider than the page on purpose: the rows this sweep
     * leaves alone are the LIVE ones, and reading past them is what lets one
     * invocation reach stale rows sitting behind a busy operator's batch.
     * Restarting from the top next run converges, because the rows it deletes
     * leave the table.
     */
    const rows = await ctx.db.query("checklistCandidates").take(2000);
    let deleted = 0;
    let hasMore = false;
    for (const row of rows) {
      if (row.lastUpdated >= cutoff) continue;
      if (deleted >= CHECKLIST_CANDIDATE_PAGE) {
        hasMore = true;
        break;
      }
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted, hasMore };
  },
});

/**
 * Drop the CALLER's batch. Called on cancel, and after a confirm has promoted
 * the rows.
 *
 * Candidates are worthless once the operator has decided — keeping them would
 * make the next fetch's "clear stale rows" step do the work instead, one sync
 * later and less obviously.
 *
 * Scoped to the caller for the same reason `startCandidateBatch` is: cancelling
 * your own review must not delete a second operator's live candidates out from
 * under their open modal. `requireAdmin` hands back the caller's id, so the
 * scope costs no second identity lookup.
 *
 * ## NEO-294 — bounded, and what Cancel still guarantees
 *
 * This was a `.collect()` plus a delete per row: on the ~900-card set the seed
 * job syncs, ~901 system operations sitting behind a Cancel button, with
 * nothing but the set's size deciding whether it fit. It now deletes one
 * `CHECKLIST_CANDIDATE_PAGE` and hands the tail to `clearCandidatesTail`, so a
 * ~900-card discard is one transaction of 700 and one of ~200 rather than one
 * of 901, and a set twice that size costs a third rather than failing.
 *
 * `deleted` is what THIS call deleted, and `hasMore` says a continuation is
 * carrying the rest — the same honest per-call reporting the entity-review
 * bulk walk uses. The callers in `CardChecklist` await this before they say
 * anything to the operator, so nothing announces a discard that has not begun;
 * a set large enough to page finishes emptying a few milliseconds later, and
 * in every flow the modal is being torn down anyway.
 */
export const discardCandidates = mutation({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({
    deleted: v.number(),
    // NEO-294 — true when a scheduled continuation is carrying the rest.
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const { cleared, hasMore } = await clearCandidatePage(
      ctx,
      args.selectorOptionId,
      userId,
    );
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.checklistCandidates.clearCandidatesTail,
        { selectorOptionId: args.selectorOptionId, userId },
      );
    }
    return { deleted: cleared, hasMore };
  },
});
