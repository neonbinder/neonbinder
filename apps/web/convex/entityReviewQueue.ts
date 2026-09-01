import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { RunResult } from "@convex-dev/workpool";
import { getCurrentUserId, requireAdmin } from "./auth";

/**
 * NEO-92: backs the step-through "new players & teams" review wizard that
 * replaced the old single-screen UnknownEntitiesDialog checkbox list. See
 * the `entityReviewQueue` table doc comment in schema.ts for the full model.
 *
 * Lifecycle: fetchCardChecklist (an action — transitively admin-gated via
 * its own call to getAncestorChain, which requires admin) calls `startBatch`
 * for any unknown names it surfaces. The wizard subscribes to `getBatch` and
 * calls `recordDecision` once per row as the user reviews. `commitCardChecklist`
 * (admin-gated) reads the finished batch to resolve create/link decisions,
 * then schedules `cleanupBatch`. `cancelBatch` is the wizard's Cancel action —
 * it only ever touches these throwaway rows, never `players`/`teams`/
 * `cardChecklist`. Every public function here is admin-gated (requireAdmin),
 * matching every other function in selectorOptions.ts — even though the
 * blast radius of this table alone is small, there's no reason a non-admin
 * should be able to read/mutate it at all.
 */

const enrichmentValidator = v.object({
  wikidataId: v.optional(v.string()),
  careerTeams: v.optional(v.array(v.object({
    name: v.string(),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  isHallOfFame: v.optional(v.boolean()),
  league: v.optional(v.string()),
  city: v.optional(v.string()),
  yearsActive: v.optional(v.object({
    from: v.number(),
    to: v.optional(v.number()),
  })),
  colors: v.optional(v.object({
    primary: v.optional(v.string()),
    secondary: v.optional(v.string()),
  })),
  espnId: v.optional(v.string()),
});

// Manual career-team entries the admin can add for a player row in the
// wizard (see recordDecision). Kept as a standalone validator so both the
// stored `decision` shape and recordDecision's args validate identically.
const manualCareerTeamValidator = v.object({
  name: v.string(),
  fromYear: v.number(),
  toYear: v.optional(v.number()),
});

const decisionValidator = v.union(
  v.object({
    action: v.literal("create"),
    manualCareerTeams: v.optional(v.array(manualCareerTeamValidator)),
  }),
  v.object({
    action: v.literal("link"),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
  }),
);

// Earliest plausible year for a career-team entry — 1869 (first openly
// professional baseball club). A deliberately loose lower bound: the point is
// to reject nonsense (year 0, negative, a mistyped 5-digit year), not to
// encode sport-specific history.
const MIN_CAREER_YEAR = 1869;

// Upper bound on how many career-team entries an admin can attach to a single
// player row in the wizard. Not a security boundary (this path is admin-gated)
// — a guard rail against an unbounded write reaching players.teamYears in
// commitCardChecklist. A real player's career spans a handful of teams; 64 is
// generous headroom.
const MAX_MANUAL_CAREER_TEAMS = 64;

// `createdByUserId` is audit/scoping-only — see toPublicRow below. Mirrors
// the players.ts/teams.ts pattern: internalQuery reads the full row,
// public query strips this field before it reaches the client.
const rowValidator = v.object({
  _id: v.id("entityReviewQueue"),
  _creationTime: v.number(),
  selectorOptionId: v.id("selectorOptions"),
  batchId: v.string(),
  createdByUserId: v.string(),
  kind: v.union(v.literal("player"), v.literal("team")),
  name: v.string(),
  // NEO-96: reference to the sport-level selectorOptions row.
  sportId: v.id("selectorOptions"),
  status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
  enrichment: v.optional(enrichmentValidator),
  decision: v.optional(decisionValidator),
});

const publicRowValidator = v.object({
  _id: v.id("entityReviewQueue"),
  _creationTime: v.number(),
  selectorOptionId: v.id("selectorOptions"),
  batchId: v.string(),
  kind: v.union(v.literal("player"), v.literal("team")),
  name: v.string(),
  sportId: v.id("selectorOptions"),
  // NEO-96: the sport row's display value, resolved server-side so the wizard
  // can render "(Player \u00b7 Baseball)" without a client-side join.
  sportValue: v.string(),
  status: v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
  enrichment: v.optional(enrichmentValidator),
  decision: v.optional(decisionValidator),
});

/**
 * NEO-96: resolve a sport row id to its display value. Used for human-facing
 * error text and for the `sportValue` the wizard renders. Falls back to the raw
 * id rather than throwing — a dangling reference should surface as an odd label
 * in one message, not break the whole review flow.
 */
async function sportLabel(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<Doc<"selectorOptions"> | null> } },
  sportId: Id<"selectorOptions">,
): Promise<string> {
  const row = await ctx.db.get(sportId);
  return row?.value ?? sportId;
}

function toPublicRow<T extends { createdByUserId: string }>(
  row: T,
): Omit<T, "createdByUserId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdByUserId: _omit, ...rest } = row;
  return rest;
}

/**
 * Start (or resume) a review batch for a selectorOption, scoped to the
 * calling user. Called from fetchCardChecklist's action via ctx.runMutation
 * — internal, no public surface needed since only that action calls it.
 *
 * If a batch already exists for this (selectorOptionId, createdByUserId)
 * pair, resume it (return its id, touch nothing) rather than deleting +
 * restarting: a batch only exists while mid-review (commit and cancel both
 * delete their batch's rows on completion), so finding one means this SAME
 * user's previous tab/click is still reviewing it — silently discarding
 * that progress would be a real bug. This holds even once every row is
 * decided but not yet committed (the wizard's final "All reviewed — save?"
 * screen) — a page refresh in that state should resume the same
 * fully-decided batch, not lose it.
 *
 * Scoping by user (not just selectorOptionId) is what makes this safe under
 * concurrent access to the same set: two different users (or, in Maestro
 * E2E, two different CI workers each authenticated as a distinct test
 * account) fetching the SAME real marketplace variant each get their own
 * private batch instead of sharing/colliding on one. This isn't only a test
 * concern — two admin sessions (or the same admin in two tabs) reviewing
 * the same set concurrently should behave the same way.
 *
 * Safe to key resumption purely on "any row exists for this user" (not "any
 * UNDECIDED row") because commitCardChecklist deletes a batch's rows
 * SYNCHRONOUSLY, in the same transaction as the commit itself — there is no
 * async window where a fully-decided batch could be observed here after
 * it's already been committed. See the delete site in commitCardChecklist
 * for why that matters (an earlier scheduled-delete version of this had
 * exactly that race).
 */
export const startBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    createdByUserId: v.string(),
    sportId: v.id("selectorOptions"),
    playerNames: v.array(v.string()),
    teamNames: v.array(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const existing = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_user", (q) =>
        q
          .eq("selectorOptionId", args.selectorOptionId)
          .eq("createdByUserId", args.createdByUserId),
      )
      .first();
    if (existing) return existing.batchId;

    const batchId = crypto.randomUUID();
    const ids: Array<Id<"entityReviewQueue">> = [];
    for (const name of args.playerNames) {
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          createdByUserId: args.createdByUserId,
          kind: "player",
          name,
          sportId: args.sportId,
          status: "pending",
        }),
      );
    }
    for (const name of args.teamNames) {
      ids.push(
        await ctx.db.insert("entityReviewQueue", {
          selectorOptionId: args.selectorOptionId,
          batchId,
          createdByUserId: args.createdByUserId,
          kind: "team",
          name,
          sportId: args.sportId,
          status: "pending",
        }),
      );
    }
    if (ids.length > 0) {
      // NEO-99: hand the rows to the deployment-wide Wikidata pool
      // (convex/wikidataPool.ts) instead of a per-batch serial chain. Scheduled
      // rather than enqueued inline so THIS mutation — the one the user's fetch
      // is waiting on — stays a plain insert and never touches the pool
      // component; the scheduled `enqueueEntityReviewLookups` does the enqueuing
      // (chunked) in the background. Same start/enqueue split as
      // `startPlaceholderBatch` → `enqueueImageChunk`.
      await ctx.scheduler.runAfter(
        0,
        internal.wikidataPool.enqueueEntityReviewLookups,
        { rowIds: ids },
      );
    }
    return batchId;
  },
});

/**
 * What the wizard subscribes to. Fully reactive — a row's `status` flips
 * live as the Wikidata pool (convex/wikidataPool.ts) drains its work items 5
 * at a time, so the client sees each lookup complete and streams the rows in
 * without polling. Because the pool runs 5-wide rather than one serial chain,
 * completion order is no longer strictly insertion order; the wizard handles
 * that by presenting the earliest-inserted row that is no longer "pending"
 * (see EntityReviewWizard.tsx's `current`).
 */
export const getBatch = query({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.array(publicRowValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    // NEO-96: resolve the sport label server-side. Every row in a batch shares
    // one sportId, so this is a single extra read regardless of batch size —
    // worth doing here rather than making the wizard join per row.
    const labelCache = new Map<Id<"selectorOptions">, string>();
    const resolved = [];
    for (const row of rows) {
      let sportValue = labelCache.get(row.sportId);
      if (sportValue === undefined) {
        sportValue = await sportLabel(ctx, row.sportId);
        labelCache.set(row.sportId, sportValue);
      }
      resolved.push({ ...toPublicRow(row), sportValue });
    }
    return resolved;
  },
});

/**
 * Record the user's decision for one reviewed row. Patched immediately
 * (not batched client-side) so wizard progress survives a page refresh —
 * the whole point of persisting decisions server-side rather than only in
 * React state.
 *
 * A "link" decision is validated against the row before being trusted —
 * commitCardChecklist later uses `linkedPlayerId`/`linkedTeamId` verbatim to
 * populate a real card's playerIds/teamOnCardIds, so this is the boundary
 * that must reject a mismatched or missing id rather than silently
 * dropping the name later at commit time.
 */
export const recordDecision = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    action: v.union(v.literal("create"), v.literal("link")),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
    // Only meaningful for a player-row "create" decision — extra career-team
    // history the admin typed by hand in the wizard (Wikidata found nothing,
    // or missed a team). Validated below before it's trusted.
    manualCareerTeams: v.optional(v.array(manualCareerTeamValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");

    if (args.action === "create") {
      // Defense in depth: this is admin-gated, but still validate the shape
      // so a malformed year can never reach the players.teamYears write in
      // commitCardChecklist. Loose bounds — reject nonsense, not history.
      const maxYear = new Date().getFullYear() + 1;
      const manualCareerTeams = args.manualCareerTeams ?? [];
      // Cap the array length so an admin (or a compromised admin session)
      // can't attach an unbounded number of career-team rows to a single
      // player — a real player has a handful, 64 is generous headroom.
      if (manualCareerTeams.length > MAX_MANUAL_CAREER_TEAMS) {
        throw new Error(
          `Too many manual career-team entries (${manualCareerTeams.length}); the maximum is ${MAX_MANUAL_CAREER_TEAMS}`,
        );
      }
      for (const ct of manualCareerTeams) {
        // Reject an empty/whitespace-only team name before it can reach the
        // get-or-create team resolution in commitCardChecklist (which would
        // otherwise mint a blank-named team). Mirrors how card-name
        // collection elsewhere trims and filters empties.
        if (ct.name.trim().length === 0) {
          throw new Error("Career-team name cannot be empty");
        }
        if (
          !Number.isInteger(ct.fromYear) ||
          ct.fromYear < MIN_CAREER_YEAR ||
          ct.fromYear > maxYear
        ) {
          throw new Error(
            `Invalid career-team fromYear ${ct.fromYear} for "${ct.name}" (expected an integer in ${MIN_CAREER_YEAR}–${maxYear})`,
          );
        }
        if (ct.toYear !== undefined) {
          if (
            !Number.isInteger(ct.toYear) ||
            ct.toYear > maxYear ||
            ct.toYear < ct.fromYear
          ) {
            throw new Error(
              `Invalid career-team toYear ${ct.toYear} for "${ct.name}" (expected an integer between fromYear ${ct.fromYear} and ${maxYear})`,
            );
          }
        }
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: {
          action: "create",
          // Omit the key entirely when empty, matching how `enrichment` is
          // treated optionally elsewhere in this file.
          ...(manualCareerTeams.length ? { manualCareerTeams } : {}),
        },
      });
      return null;
    }

    if (row.kind === "player") {
      if (!args.linkedPlayerId) {
        throw new Error("linkedPlayerId is required to link a player");
      }
      const linked = await ctx.db.get(args.linkedPlayerId);
      if (!linked) throw new Error("Linked player not found");
      if (linked.sportId !== row.sportId) {
        // NEO-96: compare ids, but report DISPLAY names — an operator reading
        // "sport (abc123) doesn't match xyz789" learns nothing.
        throw new Error(
          `Linked player's sport (${await sportLabel(ctx, linked.sportId)}) ` +
            `doesn't match ${await sportLabel(ctx, row.sportId)}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedPlayerId: args.linkedPlayerId },
      });
    } else {
      if (!args.linkedTeamId) {
        throw new Error("linkedTeamId is required to link a team");
      }
      const linked = await ctx.db.get(args.linkedTeamId);
      if (!linked) throw new Error("Linked team not found");
      if (linked.sportId !== row.sportId) {
        throw new Error(
          `Linked team's sport (${await sportLabel(ctx, linked.sportId)}) ` +
            `doesn't match ${await sportLabel(ctx, row.sportId)}`,
        );
      }
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "link", linkedTeamId: args.linkedTeamId },
      });
    }
    return null;
  },
});

/**
 * Bulk fast-path: mark every not-yet-decided row in this batch as
 * "create", in one mutation. A first-time real-set sync can surface
 * hundreds of genuinely-new names (the common case, not the exception —
 * e.g. every rookie in a brand-new set) where reviewing one at a time has
 * real value ONLY when something looks wrong; when everything's fine, the
 * user needs a fast path instead of hundreds of individual taps. Rows
 * still "pending" (their Wikidata lookup hasn't finished yet) are
 * included too — commitCardChecklist's create branch already treats
 * `enrichment` as optional, so those just create a bare, unenriched row
 * (identical to how any player/team looked up with no Wikidata match
 * behaves) rather than blocking on the lookup queue draining.
 */
export const recordAllRemainingAsCreate = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    let count = 0;
    for (const row of rows) {
      if (row.decision) continue;
      await ctx.db.patch(row._id, { decision: { action: "create" } });
      count++;
    }
    return count;
  },
});

/**
 * Wizard Cancel. Only ever deletes these throwaway rows — players, teams,
 * and cardChecklist are never touched during review, so cancelling has
 * exactly the same all-or-nothing semantics as today's dialog.
 */
export const cancelBatch = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** Internal — read one row for the pool's lookup work item (runEntityReviewLookup). */
export const getInternal = internalQuery({
  args: { id: v.id("entityReviewQueue") },
  returns: v.union(rowValidator, v.null()),
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Internal — the pool's lookup work item patches status/enrichment as each
 * lookup completes.
 *
 * ## Why this reads before it writes (NEO-189)
 *
 * A row that already carries a `decision` is LEFT ALONE. This used to patch
 * unconditionally, and that is what turned a seed job red: the operator's
 * "mark everything as create" fast path (`recordAllRemainingAsCreate`)
 * deliberately decides rows whose lookup is still `pending`, the operator hits
 * Confirm, and `commitCardChecklist`'s prelude then reads the whole batch
 * through `by_selector_option_and_batch`. Every straggler lookup landing here
 * during that read invalidated the prelude's read set, and with a lookup storm
 * in flight (CI hit an ESPN 403 retry loop) it lost on Convex's every internal
 * retry too:
 *
 *   Documents read from or written to the "entityReviewQueue" table changed
 *   while this mutation was being run and on every subsequent retry. A call to
 *   "entityReviewQueue.js:applyLookupResult" changed the document…
 *
 * The write was pointless as well as harmful. `enrichment` has exactly two
 * consumers: the commit prelude, which reads it to seed a newly created
 * player/team, and the review wizard's detail panel — and the wizard only ever
 * renders a row that is NOT decided (`EntityReviewWizard`'s `current` filters
 * on `!r.decision`). So once a decision exists, nothing will ever read the
 * enrichment this patch would store: commit has either already read the row or
 * is about to, and either way it finishes by deleting the batch.
 *
 * This does NOT weaken the "a row is never stranded on pending" invariant —
 * see `backstopEntityReviewRowImpl`, which carries the same guard and the
 * argument for why.
 */
export const applyLookupResult = internalMutation({
  args: {
    id: v.id("entityReviewQueue"),
    status: v.union(v.literal("ready"), v.literal("error")),
    enrichment: v.optional(enrichmentValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    // Gone — a Cancel or a completed commit deleted the batch while this item
    // was still draining. Nothing to resolve.
    if (!row) return null;
    // Decided: the operator has ruled and commit is imminent or done. Writing
    // here would only contend with the commit's read of this same row.
    if (row.decision) return null;
    await ctx.db.patch(args.id, {
      status: args.status,
      enrichment: args.enrichment,
    });
    return null;
  },
});

/**
 * The workpool completion backstop (NEO-99), as a plain exported function so
 * the tests can drive it via `t.run` without mounting the workpool component —
 * the same reason `recordImageOutcomeImpl` is a function rather than a
 * registered mutation. `onEntityReviewLookupComplete` in wikidataPool.ts is the
 * one-line delegation the pool actually calls.
 *
 * The invariant it guarantees: a review row can never be stranded on `pending`.
 * `runEntityReviewLookup` resolves the row on its own happy and caught-error
 * paths, so this normally finds the row already "ready"/"error" and no-ops. It
 * exists for the residue that path cannot reach from within itself — an uncaught
 * throw, an action-level timeout, or a pool cancellation, in each of which the
 * action never ran its patch. In all of those the row is still `pending` when
 * the work item finally completes, and this ages it to "error" ("No Wikidata
 * match found"), which is the honest end state for a lookup that produced
 * nothing usable.
 *
 * `result.kind` is not branched on: whatever terminal shape the work item ended
 * in, a still-`pending` row means "no result landed", and "error" is the
 * resolution for every one of them. An already-resolved row is left exactly as
 * the action set it (a real "ready" with enrichment is never downgraded).
 * `decision` is never touched, so a row bulk-decided while its lookup was in
 * flight keeps its decision.
 *
 * ## NEO-189: a DECIDED row is skipped, and that does not weaken the invariant
 *
 * Same guard, same reason as `applyLookupResult` above — a write here on a row
 * the commit prelude is reading is what made the seed job's commit lose an
 * optimistic-concurrency race on every retry.
 *
 * The invariant this function exists for is about rows the operator has NOT
 * ruled on: those are the ones the wizard blocks on, and they still get aged
 * exactly as before. A DECIDED row left sitting on `pending` is inert — the
 * wizard's `current` skips decided rows entirely, its "N of M" counts
 * decisions rather than statuses, so nothing blocks on the status — and it does
 * not survive: `commitCardChecklist` deletes the whole batch when it finishes,
 * `cancelBatch` deletes it on Cancel, and `sweepStalePendingRows` ages whatever
 * an abandoned wizard leaves behind after ENTITY_REVIEW_STALE_MS.
 */
export async function backstopEntityReviewRowImpl(
  ctx: MutationCtx,
  rowId: Id<"entityReviewQueue">,
  result: RunResult,
): Promise<null> {
  const row = await ctx.db.get(rowId);
  // Gone (a Cancel deleted the batch while this item drained) — nothing to age.
  if (!row) return null;
  // Already resolved by the action itself — the common path. Leave it be.
  if (row.status !== "pending") return null;
  // NEO-189: decided by the operator — commit is imminent or done, and this
  // write would only contend with the commit's read of this row. See above.
  if (row.decision) return null;

  // rowId is an opaque document id, never PII (see the no-PII rule in
  // observability.ts). `result.kind` tells triage HOW the work item ended
  // without the row having been resolved — the fingerprint of the residue this
  // backstop exists for.
  console.warn(
    JSON.stringify({
      msg: "entity_review_row_backstopped",
      rowId,
      resultKind: result.kind,
    }),
  );
  await ctx.db.patch(rowId, { status: "error" });
  return null;
}

/**
 * How long a review row may sit `pending` before the cron sweep ages it to
 * "error" (crons.ts → sweepStalePendingRows).
 *
 * This is the LAST line of defense, behind both the pool's `onComplete` and the
 * fetch timeout — it only matters if a work item is lost so completely that its
 * completion callback never fires at all. 30 minutes is deliberately generous:
 * under the 5-wide pool a healthy row resolves within seconds, and even a
 * pathological all-timeout drain of a many-hundred-entity batch finishes well
 * inside this window, so a false positive (aging a row that was still going to
 * resolve) is nearly impossible — and if every lookup really is timing out for
 * half an hour, Wikidata is down and "error" is the correct outcome anyway.
 * Erring long mirrors the placeholder wedge watchdog's exact philosophy: a
 * safety net must never fire on healthy work.
 */
export const ENTITY_REVIEW_STALE_MS = 30 * 60 * 1000;

/** Rows aged per sweep invocation before self-scheduling the rest — bounds the
 *  transaction the way the placeholder watchdog's take does. */
export const ENTITY_REVIEW_SWEEP_CHUNK = 100;

/**
 * Cron target (crons.ts): age review rows that have been `pending` past
 * ENTITY_REVIEW_STALE_MS to "error", so a lookup whose work item died mid-flight
 * — in a way even the pool's completion backstop never observed — cannot leave
 * the wizard hung on "Looking up…" forever.
 *
 * Reads through `by_status`, which orders `pending` rows oldest-first (every
 * index ends in `_creationTime` ascending), so the oldest — and therefore the
 * only candidates that can be stale — come first. The scan STOPS at the first
 * row younger than the cutoff: everything after it is younger still. In steady
 * state that first row is a few seconds old, so the common run reads the oldest
 * handful, ages none, and returns — cheap enough to run often.
 *
 * Bounded per invocation and self-scheduling for the remainder, mirroring
 * sweepWedgedBatches: a mass strand after an incident drains across several
 * runs rather than one giant transaction.
 */
export const sweepStalePendingRows = internalMutation({
  args: {},
  returns: v.object({ aged: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - ENTITY_REVIEW_STALE_MS;
    const oldest = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(ENTITY_REVIEW_SWEEP_CHUNK);

    let aged = 0;
    for (const row of oldest) {
      // Ordered oldest-first: the first row at-or-after the cutoff means every
      // remaining row is younger too, so there is nothing left to age.
      if (row._creationTime >= cutoff) break;
      await ctx.db.patch(row._id, { status: "error" });
      aged += 1;
    }

    if (aged > 0) {
      console.warn(
        JSON.stringify({ msg: "entity_review_stale_rows_aged", aged }),
      );
    }

    // Self-schedule only if the whole chunk was stale — then more may remain
    // (the aged rows have left the `pending` index, so the next run resumes at
    // the next-oldest and the set strictly shrinks). A partial chunk means the
    // scan hit a fresh row and there is nothing further to do.
    const done = aged < oldest.length || oldest.length < ENTITY_REVIEW_SWEEP_CHUNK;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.entityReviewQueue.sweepStalePendingRows, {});
    }
    return { aged, done };
  },
});

/**
 * Internal — deletes a batch's rows. NOT called by commitCardChecklist
 * (which deletes its batch's rows synchronously, inline, using the rows it
 * already read to resolve decisions — see the delete site there for why a
 * scheduled/async cleanup was replaced: it left a race where a re-fetch of
 * the same selectorOptionId could observe and wrongly resume an
 * already-committed batch). Kept as a standalone utility for clearing a
 * genuinely abandoned batch (e.g. the user closed the tab mid-review,
 * never confirmed or cancelled) — nothing currently calls it in the
 * commit/cancel path, both of which clean up their own rows directly.
 */
export const cleanupBatch = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});
