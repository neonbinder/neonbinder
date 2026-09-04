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
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";

/**
 * NEO-92: backs the step-through "new players & teams" review wizard that
 * replaced the old single-screen UnknownEntitiesDialog checkbox list. See
 * the `entityReviewQueue` table doc comment in schema.ts for the full model.
 *
 * Lifecycle: fetchCardChecklist (an action — transitively admin-gated via
 * its own call to getAncestorChain, which requires admin) calls `startBatch`
 * for any unknown names it surfaces. The wizard subscribes to `getBatch` and
 * calls `recordDecision` once per row as the user reviews. `commitCardChecklist`
 * (admin-gated) reads the finished batch to resolve its decisions, then
 * schedules `cleanupBatch`. A decision is create, link, or — NEO-212 — skip
 * ("not a person / not a team"): a skipped row creates and links nothing, the
 * card keeps the raw name as free text, and commit records the name in
 * `entityReviewSkips` so it stays out of this set's wizard on later fetches.
 * `cancelBatch` is the wizard's Cancel action — it only ever touches these
 * throwaway rows, never `players`/`teams`/`cardChecklist`. Every public
 * function here is admin-gated (requireAdmin), matching every other function
 * in selectorOptions.ts — even though the blast radius of this table alone is
 * small, there's no reason a non-admin should be able to read/mutate it at all.
 */

const enrichmentValidator = v.object({
  wikidataId: v.optional(v.string()),
  careerTeams: v.optional(v.array(v.object({
    name: v.string(),
    fromYear: v.number(),
    toYear: v.optional(v.number()),
  }))),
  // NEO-235, player-only: Wikidata teams with no usable start year. Names
  // only — they cannot become `teamYears` entries (which require `fromYear`)
  // and are surfaced so the operator can see what was found. See schema.ts.
  undatedCareerTeams: v.optional(v.array(v.string())),
  isHallOfFame: v.optional(v.boolean()),
  // NEO-212: player-only disambiguation context from Wikidata. See the
  // entityReviewQueue.enrichment comment in schema.ts.
  description: v.optional(v.string()),
  birthYear: v.optional(v.number()),
  enwikiTitle: v.optional(v.string()),
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
    // NEO-212: Wikidata career-team labels the admin unchecked in the wizard.
    // Commit must not create team rows for these. See schema.ts.
    excludedCareerTeamNames: v.optional(v.array(v.string())),
  }),
  v.object({
    action: v.literal("link"),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
  }),
  // NEO-212: "not a person / not a team" — the card keeps the raw name, and
  // nothing is created or linked. See schema.ts.
  v.object({ action: v.literal("skip") }),
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

// NEO-212: same guard rail, same reasoning, for the unchecked-Wikidata-team
// exclusion list. Bounded independently of MAX_MANUAL_CAREER_TEAMS because the
// two lists are populated from different places (hand-typed vs. Wikidata's
// careerTeams), even though the number happens to match.
const MAX_EXCLUDED_CAREER_TEAM_NAMES = 64;

/**
 * NEO-212: validate and normalize the Wikidata career-team labels an admin
 * unchecked for a "create" decision.
 *
 * Trims each entry and rejects a blank one — a blank label can never match an
 * `enrichment.careerTeams[].name`, so it is always operator/UI error rather
 * than a harmless no-op worth swallowing. Caps the array for the same reason
 * the manual entries are capped. Dedupes case-insensitively (keeping first
 * appearance, and the original casing) so commit compares against a clean set
 * and the stored decision stays readable as an audit record.
 */
function normalizeExcludedCareerTeamNames(
  names: ReadonlyArray<string>,
): string[] {
  if (names.length > MAX_EXCLUDED_CAREER_TEAM_NAMES) {
    throw new Error(
      `Too many excluded career-team names (${names.length}); the maximum is ${MAX_EXCLUDED_CAREER_TEAM_NAMES}`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) {
      throw new Error("Excluded career-team name cannot be empty");
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized;
}

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
  // NEO-221 — see schema.ts. Read only by `sweepAbandonedBatches`.
  lastTouchedAt: v.optional(v.number()),
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
  // NEO-221. Projected rather than stripped: it is a timestamp of the
  // operator's own activity, not an identity, so there is nothing to withhold
  // — and `toPublicRow` only removes `createdByUserId`, so omitting it here
  // would make `getBatch`'s return validator reject its own rows.
  lastTouchedAt: v.optional(v.number()),
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

/**
 * NEO-221 — defence in depth: an admin may only act on their OWN review batch.
 *
 * `requireAdmin` is the real gate and every function here already runs it; the
 * blast radius of this table is a handful of throwaway rows. This is the
 * second layer, and it exists because batches are deliberately scoped per user
 * (see `startBatch` and the schema note): two admin sessions — or, in Maestro
 * CI, two workers each authenticated as a distinct admin test account — hold
 * separate batches over the SAME set at the same time. A row id or a batchId
 * from the wrong session is far likelier to be a stale client than an attack,
 * and either way the right answer is to refuse rather than to silently
 * overwrite or delete a colleague's in-progress review.
 *
 * `createdByUserId` is written from `getCurrentUserId` at the fetch that
 * started the batch (selectorOptions.ts), and `requireAdmin` returns the same
 * `identity.subject` — the two are the same identity form, which is what makes
 * comparing them meaningful rather than accidentally always-false.
 */
function assertOwnsRow(
  row: { createdByUserId: string },
  callerId: string,
): void {
  if (row.createdByUserId !== callerId) {
    throw new Error("This review row belongs to a different review session");
  }
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
 *
 * ## NEO-221 — resume RECONCILES rather than returning the batch untouched
 *
 * "Touch nothing" was right while the only way back into a resumed batch was
 * an identical re-fetch. It stopped being right once the wizard could hand the
 * operator back to card matching and return (NEO-220's "Back to matching"):
 * the second Confirm can legitimately carry a DIFFERENT name set — a pairing
 * the operator linked no longer contributes its unmatched name, a rename
 * introduces one — and a batch frozen at the first Confirm's names would ask
 * about names no card carries any more while never asking about the new ones.
 * Commit would then find no decision for a real name and leave the card
 * unlinked, which is precisely the failure this ticket exists to remove.
 *
 * So a resume reconciles the batch against the incoming names, keyed by
 * `kind` + the SAME normalizer the players/teams tables dedupe on
 * (`normalizePlayerName`/`normalizeTeamName`), so a re-spelling of one name is
 * a match rather than an add plus a drop:
 *
 *   - a key present on both sides keeps its row, and therefore its decision,
 *     its enrichment and its status — reconciliation never re-asks something
 *     the operator has already answered;
 *   - a key only in the incoming set gets a fresh `pending` row (same shape as
 *     a first-time insert) and a lookup scheduled for it — and ONLY for it, so
 *     resuming does not re-run the whole batch's Wikidata work;
 *   - a key only on the existing side is dropped ONLY IF the operator never
 *     ruled on it. An UNDECIDED row for a name no card carries any more is a
 *     question about nothing, and leaving it would block the wizard's
 *     "all reviewed" on it forever. A DECIDED row is kept, whatever the
 *     incoming set says.
 *
 * ## Why a decided row is never deleted here
 *
 * Reconciliation is ADDITIVE about the operator's work, in exactly the sense
 * the sync boundary is additive about NB's data. The incoming name list is
 * derived — from a marketplace payload, through a pairing session an operator
 * can still change their mind about — so "this name is not in the list any
 * more" is a statement about that derivation, not evidence that the human's
 * ruling was wrong. Deleting on it would let a re-pair silently discard a
 * decision, and the operator's only clue would be a name they have to rule on
 * twice. A kept-but-unused decision costs one throwaway row; the batch is
 * deleted wholesale at commit, cancel, or by the abandoned-batch sweep.
 *
 * Every surviving row is stamped `lastTouchedAt`: coming back to a batch is
 * proof of life, and a session an operator has just re-entered must not look
 * abandoned to the sweep.
 *
 * The `batchId` is preserved throughout, because the client is already holding
 * it and a new one would strand the open wizard.
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
    // Keyed the same way on both sides of the reconciliation below, and by
    // the same normalizers `players`/`teams` dedupe on, so "J.T. Realmuto"
    // and "JT Realmuto" are one name here exactly as they are one row there.
    const keyFor = (kind: "player" | "team", name: string) =>
      kind === "player"
        ? `player:${normalizePlayerName(name)}`
        : `team:${normalizeTeamName(name)}`;

    const existing = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_user", (q) =>
        q
          .eq("selectorOptionId", args.selectorOptionId)
          .eq("createdByUserId", args.createdByUserId),
      )
      .first();

    if (existing) {
      const batchId = existing.batchId;
      // Scoped to the resumed batch itself, not to every row this user has for
      // this selectorOption: one user only ever holds one batch at a time (a
      // commit or a cancel deletes it), and reading through the batch index
      // keeps that assumption from silently deleting a stray row from another.
      const existingRows = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", batchId),
        )
        .collect();

      // Incoming names, deduped by key so two spellings of one name cannot
      // insert two rows. First spelling wins, matching how
      // `resolveUnknownsAndStartBatch` picks the label it surfaces.
      const incoming = new Map<string, { kind: "player" | "team"; name: string }>();
      for (const name of args.playerNames) {
        const key = keyFor("player", name);
        if (!incoming.has(key)) incoming.set(key, { kind: "player", name });
      }
      for (const name of args.teamNames) {
        const key = keyFor("team", name);
        if (!incoming.has(key)) incoming.set(key, { kind: "team", name });
      }

      const now = Date.now();
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        const key = keyFor(row.kind, row.name);
        // Recorded BEFORE the drop test, so a decided row that is no longer
        // incoming still suppresses a re-insert of its own name.
        existingKeys.add(key);
        if (!incoming.has(key) && row.decision === undefined) {
          // Gone from the incoming set and never ruled on — a question about
          // a name no card carries. A DECIDED row is kept; see the doc above.
          await ctx.db.delete(row._id);
          continue;
        }
        // Re-entering the batch is operator activity. See the sweep.
        await ctx.db.patch(row._id, { lastTouchedAt: now });
      }

      const addedIds: Array<Id<"entityReviewQueue">> = [];
      for (const [key, { kind, name }] of incoming) {
        if (existingKeys.has(key)) continue;
        addedIds.push(
          await ctx.db.insert("entityReviewQueue", {
            selectorOptionId: args.selectorOptionId,
            batchId,
            createdByUserId: args.createdByUserId,
            kind,
            name,
            sportId: args.sportId,
            status: "pending",
          }),
        );
      }
      if (addedIds.length > 0) {
        // Only the ADDED rows. A resume must never re-enqueue a lookup that
        // already ran (or is running) — see the enqueue note on the fresh path
        // below, and NEO-99's creation-only enrichment contract.
        await ctx.scheduler.runAfter(
          0,
          internal.wikidataPool.enqueueEntityReviewLookups,
          { rowIds: addedIds },
        );
      }
      return batchId;
    }

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
 * Three actions:
 *   - "create" — mint a new player/team at commit time, optionally carrying
 *     hand-typed `manualCareerTeams` and (NEO-212) `excludedCareerTeamNames`,
 *     the Wikidata career teams the admin unchecked.
 *   - "link" — point the card at an existing player/team.
 *   - "skip" (NEO-212) — the name is not a person / not a team. Commit leaves
 *     the card's raw name alone and creates/links nothing.
 *
 * A "link" decision is validated against the row before being trusted —
 * commitCardChecklist later uses `linkedPlayerId`/`linkedTeamId` verbatim to
 * populate a real card's playerIds/teamOnCardIds, so this is the boundary
 * that must reject a mismatched or missing id rather than silently
 * dropping the name later at commit time.
 *
 * A "skip" decision carries no payload, so nothing else on the args is
 * meaningful — a `linkedPlayerId`/`linkedTeamId`/`manualCareerTeams` sent
 * alongside it is IGNORED rather than rejected. The wizard drives all three
 * actions through one call site, so those fields are leftovers from a
 * previously-selected action, not a caller mistake; throwing would turn a
 * harmless UI artifact into a dead end for the operator, and there is nothing
 * to protect — the skip decision never stores them, so they cannot reach
 * commit.
 *
 * Re-deciding a row that already carries a decision OVERWRITES it, for every
 * action — the wizard lets an operator go back and change a call.
 */
export const recordDecision = mutation({
  args: {
    reviewRowId: v.id("entityReviewQueue"),
    action: v.union(
      v.literal("create"),
      v.literal("link"),
      // NEO-212: "not a person / not a team".
      v.literal("skip"),
    ),
    linkedPlayerId: v.optional(v.id("players")),
    linkedTeamId: v.optional(v.id("teams")),
    // Only meaningful for a player-row "create" decision — extra career-team
    // history the admin typed by hand in the wizard (Wikidata found nothing,
    // or missed a team). Validated below before it's trusted.
    manualCareerTeams: v.optional(v.array(manualCareerTeamValidator)),
    // NEO-212, also "create"-only: the Wikidata career-team labels the admin
    // UNCHECKED in the wizard, so commit doesn't create team rows for them.
    // Validated/normalized below before it's trusted.
    excludedCareerTeamNames: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerId = await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);

    // NEO-212: "not a person / not a team". Nothing else on the args applies —
    // see the doc comment for why leftovers are ignored rather than rejected.
    if (args.action === "skip") {
      await ctx.db.patch(args.reviewRowId, {
        decision: { action: "skip" },
        // NEO-221: proof of life for the abandoned-batch sweep.
        lastTouchedAt: Date.now(),
      });
      return null;
    }

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
      // NEO-212: the Wikidata career teams the admin unchecked. Validated on
      // the same boundary and for the same reason as the manual entries above
      // — commit consumes this list verbatim.
      const excludedCareerTeamNames = normalizeExcludedCareerTeamNames(
        args.excludedCareerTeamNames ?? [],
      );
      await ctx.db.patch(args.reviewRowId, {
        decision: {
          action: "create",
          // Omit the key entirely when empty, matching how `enrichment` is
          // treated optionally elsewhere in this file.
          ...(manualCareerTeams.length ? { manualCareerTeams } : {}),
          ...(excludedCareerTeamNames.length ? { excludedCareerTeamNames } : {}),
        },
        lastTouchedAt: Date.now(),
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
        lastTouchedAt: Date.now(),
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
        lastTouchedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * NEO-221 — un-decide one row, so the operator can go back and change a call.
 *
 * `recordDecision` already OVERWRITES a decision, which covers "I meant link,
 * not create". This covers the other half: putting a row back into the queue
 * as an open question, which is what the wizard's Back / decided-list "Change
 * decision" needs — the review UI presents an undecided row, so a row has to
 * be able to become undecided again before it can be re-presented.
 *
 * Patching `decision: undefined` is how Convex removes a field, so the row is
 * left byte-identical to one that was never decided. `enrichment` and `status`
 * are deliberately untouched: a settled lookup stays settled, and re-deciding
 * a row must not cost a second Wikidata round-trip.
 *
 * ## Why a still-`pending` row re-schedules a lookup
 *
 * `applyLookupResult` and `backstopEntityReviewRowImpl` both SKIP a decided row
 * (NEO-189 — writing to a row the commit prelude is reading is what made a
 * seed job lose an optimistic-concurrency race on every retry). So a row that
 * was decided while its lookup was still in flight has had its result dropped
 * on the floor: it is `pending`, it will never leave `pending` on its own, and
 * un-deciding it would hand the operator a row stuck on "Looking up…" forever.
 * Re-scheduling the pool enqueue is what makes the row answerable again.
 *
 * This is a LOOKUP, not entity enrichment. The creation-only rule
 * (`enqueueEnrichment`, and the note on `resolveTeamIdByName` in
 * selectorOptions.ts) is about re-enriching a `players`/`teams` row that
 * already exists; nothing here touches those tables. An `entityReviewQueue`
 * row is a throwaway question awaiting an answer, and this is the same enqueue
 * `startBatch` performs when the question is first asked.
 *
 * Bounded by operator clicks — one enqueue per "Change decision" tap on a row
 * that never resolved, which is a rare shape to begin with.
 *
 * Admin-gated exactly as `recordDecision` is: same table, same blast radius,
 * and the two are two halves of one operator gesture.
 */
export const clearDecision = mutation({
  args: { reviewRowId: v.id("entityReviewQueue") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerId = await requireAdmin(ctx);

    const row = await ctx.db.get(args.reviewRowId);
    if (!row) throw new Error("Review row not found");
    assertOwnsRow(row, callerId);

    await ctx.db.patch(args.reviewRowId, {
      decision: undefined,
      // NEO-221: un-deciding is operator activity like any other — a session
      // spent walking back through decisions must not look abandoned.
      lastTouchedAt: Date.now(),
    });

    if (row.status === "pending") {
      await ctx.scheduler.runAfter(
        0,
        internal.wikidataPool.enqueueEntityReviewLookups,
        { rowIds: [args.reviewRowId] },
      );
    }
    return null;
  },
});

/**
 * Shared body of the two bulk fast-paths below: walk one batch and decide
 * every row that carries NO decision yet, leaving already-decided rows exactly
 * as the operator left them, and return how many this call decided.
 *
 * Factored out so `recordAllRemainingAsCreate` and `recordAllRemainingAsSkip`
 * cannot drift on batch scoping, on the already-decided rule, or on what the
 * returned count means — the only difference between them is the decision they
 * write, and (NEO-221) whether a row whose lookup is still in flight is in
 * scope. Private, and assumes its caller has already run `requireAdmin`.
 *
 * ## NEO-221 — `includePending` is not a preference, it is the difference
 * between the two fast paths
 *
 * A `pending` row is one whose Wikidata lookup has not come back. What that
 * means depends entirely on what is about to be written to it:
 *
 *   - CREATE consumes the lookup. `enrichment` is what seeds the new
 *     player/team's Wikidata id, career teams, league, city and colours, so
 *     deciding a pending row "create" mints a permanently bare row for a
 *     player Wikidata knows perfectly well — silently, and with no later path
 *     back to the enrichment (`enqueueEnrichment` is creation-only). The
 *     operator asked for "everything else is new", not "everything else is new
 *     and unenriched". So create passes `false` and the caller re-arms as
 *     lookups land.
 *   - SKIP consumes nothing. Nothing is created, nothing is linked, and no
 *     enrichment is ever read — so waiting on the lookup buys the operator
 *     precisely nothing, and making them wait to say "none of this is an
 *     entity" would be a worse wizard, not a safer one. Skip passes `true`.
 */
async function decideAllRemaining(
  ctx: MutationCtx,
  args: { selectorOptionId: Id<"selectorOptions">; batchId: string },
  decision: { action: "create" } | { action: "skip" },
  includePending: boolean,
): Promise<number> {
  const rows = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option_and_batch", (q) =>
      q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
    )
    .collect();
  const now = Date.now();
  let count = 0;
  for (const row of rows) {
    if (row.decision) continue;
    if (!includePending && row.status === "pending") continue;
    // Spread rather than passing `decision` through: each row stores its own
    // object rather than sharing one reference across the whole batch.
    await ctx.db.patch(row._id, {
      decision: { ...decision },
      // NEO-221: one timestamp for the whole call — this IS one operator
      // action, and stamping each row a millisecond apart would only make the
      // sweep's arithmetic harder to read.
      lastTouchedAt: now,
    });
    count++;
  }
  return count;
}

/**
 * Bulk fast-path: mark every not-yet-decided row in this batch as
 * "create", in one mutation. A first-time real-set sync can surface
 * hundreds of genuinely-new names (the common case, not the exception —
 * e.g. every rookie in a brand-new set) where reviewing one at a time has
 * real value ONLY when something looks wrong; when everything's fine, the
 * user needs a fast path instead of hundreds of individual taps.
 *
 * NEO-221: rows still "pending" — their Wikidata lookup has not come back —
 * are now EXCLUDED, where they used to be swept up with the rest. Deciding one
 * "create" mints a permanently bare player/team for a name Wikidata could have
 * enriched, with no later path back (enrichment is creation-only); see
 * `decideAllRemaining` for the full argument. The wizard re-calls this as
 * lookups land, so the operator still taps once — the count just fills in
 * over a few seconds instead of all at once.
 *
 * The return value is what makes that loop safe to drive from the client: it
 * is how many rows THIS call decided, so a re-call that finds nothing settled
 * yet returns 0 rather than looking like a failure.
 */
export const recordAllRemainingAsCreate = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    await requireAdmin(ctx);
    return await decideAllRemaining(ctx, args, { action: "create" }, false);
  },
});

/**
 * NEO-212 counterpart to `recordAllRemainingAsCreate`: mark every
 * not-yet-decided row in this batch as "skip". The case it exists for is the
 * mirror image — a set whose surfaced "new names" are mostly not entities at
 * all (subset/parallel labels, checklist headers, a team name that landed in a
 * player column), where the operator wants the whole remainder left alone
 * rather than minting a row for each.
 *
 * Same admin gate, same batch scoping, same already-decided rule and same
 * return (how many rows THIS call decided) as the create variant; both run
 * through `decideAllRemaining` so the two cannot drift.
 *
 * NEO-221 answered the question this comment used to leave open, and answered
 * it DIFFERENTLY for the two paths: skip still includes rows whose lookup is
 * in flight, while create no longer does. That is not an inconsistency — a
 * skip creates nothing and therefore never reads `enrichment`, so waiting on
 * the lookup would cost the operator time and buy them nothing, whereas a
 * create consumes the enrichment and deciding early throws it away. Skip is
 * also the operator's explicit "none of this is an entity", which is exactly
 * the case where blocking on a lookup would be perverse.
 */
export const recordAllRemainingAsSkip = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    batchId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    await requireAdmin(ctx);
    return await decideAllRemaining(ctx, args, { action: "skip" }, true);
  },
});

/**
 * NEO-221 — delete every row of one batch, and return how many were deleted.
 *
 * The single deletion body behind `cancelBatch` (the operator said no),
 * `cleanupBatch` (an operator tool for a batch nobody will finish) and
 * `sweepAbandonedBatches` (the cron that finds those on its own). Three
 * callers with three different reasons and exactly one definition of what
 * "delete a batch" means — before this, two of them carried their own copy of
 * the same loop, which is one drift away from a sweep that half-cleans.
 *
 * Deliberately reads through `by_selector_option_and_batch` rather than taking
 * the rows a caller already has: the sweep decides on a sampled window, and
 * deleting from a stale list would leave a batch partly alive.
 *
 * Private, and assumes its caller has already gated itself.
 */
async function deleteBatchRows(
  ctx: MutationCtx,
  selectorOptionId: Id<"selectorOptions">,
  batchId: string,
): Promise<number> {
  const rows = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option_and_batch", (q) =>
      q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchId),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

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
    const callerId = await requireAdmin(ctx);
    // NEO-221 — refuse to cancel someone else's session. Checked BEFORE the
    // delete, on the batch's own rows: cancelling is the one irreversible
    // thing an operator can do to a review, so a stale batchId from another
    // tab must not be able to throw away a colleague's work. An empty batch
    // (already committed or cancelled) has no owner to disagree with and is a
    // no-op, exactly as it was.
    const rows = await ctx.db
      .query("entityReviewQueue")
      .withIndex("by_selector_option_and_batch", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId).eq("batchId", args.batchId),
      )
      .collect();
    for (const row of rows) assertOwnsRow(row, callerId);
    await deleteBatchRows(ctx, args.selectorOptionId, args.batchId);
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
    await deleteBatchRows(ctx, args.selectorOptionId, args.batchId);
    return null;
  },
});

/**
 * NEO-221 — how long a review batch may sit with NO operator activity before
 * the hourly cron deletes it.
 *
 * Distinct from ENTITY_REVIEW_STALE_MS above, which is about a single row's
 * LOOKUP hanging (30 minutes, ages `pending` → `error`, deletes nothing). This
 * one is about the SESSION: a wizard the operator closed the tab on, whose
 * rows are perfectly healthy and will simply sit there forever, quietly
 * resuming themselves into the next fetch of that set (see `startBatch`).
 *
 * A day, because deleting a batch throws away real operator work — every
 * decision recorded in it — and the only cost of erring long is some rows in a
 * throwaway table. An operator who reviews 200 names across a working day,
 * leaves it overnight and comes back is doing something entirely reasonable;
 * `lastTouchedAt` keeps their session alive for as long as they keep touching
 * it, and 24 hours of complete silence is the honest read of "nobody is coming
 * back".
 */
export const ENTITY_REVIEW_ABANDONED_MS = 24 * 60 * 60 * 1000;

/**
 * Rows examined per sweep invocation. Bounds the transaction the way
 * ENTITY_REVIEW_SWEEP_CHUNK does — a table PAGE, not an index range, because
 * abandonment is a property of a whole (selectorOptionId, batchId) group and
 * no index groups by that.
 */
export const ENTITY_REVIEW_ABANDONED_SCAN = 500;

/**
 * Cron target (crons.ts): delete review batches nobody is coming back to.
 *
 * ## What it is for
 *
 * `commitCardChecklist` and `cancelBatch` each clean up after themselves, so
 * the only batches that survive are the ones whose session simply ENDED —
 * closed tab, crashed browser, an operator who walked away. Those are not
 * inert: `startBatch` resumes any batch it finds for the same
 * (selectorOptionId, user), so an abandoned one silently becomes the next
 * fetch's starting point, complete with decisions made against a card list
 * that may be weeks old. Deleting it is what makes the next fetch a fresh
 * question.
 *
 * ## The abandonment test
 *
 * A batch is abandoned when EVERY row in it has been silent past the cutoff,
 * where a row's last sign of life is `max(_creationTime, lastTouchedAt ?? 0)`.
 * Every row, not any row and not the newest: a batch is one session, and one
 * decision recorded ten minutes ago is proof the whole session is alive even
 * if two hundred of its rows were inserted yesterday and never touched again.
 * `lastTouchedAt` absent means "never touched", which is exactly what a row
 * written before this field existed is.
 *
 * ## Why the page only NOMINATES, and the batch is then re-read in full
 *
 * The page is a window over the table ordered by `_creationTime`, and a batch
 * is routinely bigger than it — a first-time sync of a real set surfaces
 * hundreds of names. Judging a batch on the rows that happened to fall inside
 * the window would delete a live session whose recent activity sat just
 * outside it, which is the operator-work-destroying failure this whole ticket
 * is about. So a page can only nominate a (selectorOptionId, batchId) as a
 * candidate; the decision is taken over the batch's FULL row set, re-read
 * through `by_selector_option_and_batch` in this same transaction.
 *
 * ## Why it paginates with a cursor rather than restarting
 *
 * `sweepStalePendingRows` can restart from the top each run because the rows
 * it fixes LEAVE the index it reads (`status` stops being `pending`). This one
 * reads the whole table, and the rows it does not delete — every live batch —
 * stay exactly where they are. Without a cursor, a deployment whose oldest 500
 * rows are one long-running review would re-examine that same review forever
 * and never reach the abandoned batch behind it. So the cursor is carried
 * forward and the sweep self-schedules until the table is exhausted, the same
 * bounded-work-then-continue shape as `sweepWedgedBatches`.
 */
export const sweepAbandonedBatches = internalMutation({
  args: {
    // Continuation of THIS sweep's walk over the table. Absent on the cron's
    // own invocation, which always starts from the beginning.
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    batches: v.number(),
    rows: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - ENTITY_REVIEW_ABANDONED_MS;
    const lastTouched = (row: Doc<"entityReviewQueue">) =>
      Math.max(row._creationTime, row.lastTouchedAt ?? 0);

    const page = await ctx.db
      .query("entityReviewQueue")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: ENTITY_REVIEW_ABANDONED_SCAN,
      });

    // Group by (selectorOptionId, batchId). `\u0000` cannot appear in either
    // component, so the composite key is unambiguous. A batch straddling the
    // page boundary is nominated by whichever page holds a stale row of it and
    // then re-read in full below, so the split costs correctness nothing.
    const candidates = new Map<
      string,
      { selectorOptionId: Id<"selectorOptions">; batchId: string }
    >();
    for (const row of page.page) {
      if (lastTouched(row) >= cutoff) continue;
      const key = `${row.selectorOptionId}\u0000${row.batchId}`;
      if (!candidates.has(key)) {
        candidates.set(key, {
          selectorOptionId: row.selectorOptionId,
          batchId: row.batchId,
        });
      }
    }

    let batches = 0;
    let rows = 0;
    for (const { selectorOptionId, batchId } of candidates.values()) {
      // The decision, taken over the WHOLE batch. One live row anywhere in it
      // means the session is not over — see the note above.
      const all = await ctx.db
        .query("entityReviewQueue")
        .withIndex("by_selector_option_and_batch", (q) =>
          q.eq("selectorOptionId", selectorOptionId).eq("batchId", batchId),
        )
        .collect();
      if (all.length === 0) continue;
      if (all.some((row) => lastTouched(row) >= cutoff)) continue;
      rows += await deleteBatchRows(ctx, selectorOptionId, batchId);
      batches += 1;
    }

    if (batches > 0) {
      // Ids and counts only — never a name. See the no-PII rule in
      // observability.ts.
      console.warn(
        JSON.stringify({ msg: "entity_review_batches_reaped", batches, rows }),
      );
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.entityReviewQueue.sweepAbandonedBatches,
        { cursor: page.continueCursor },
      );
    }
    return { batches, rows, done: page.isDone };
  },
});
