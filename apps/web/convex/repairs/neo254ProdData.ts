/**
 * NEO-254 — the one-off repair of the rows the 2026-09-10 production bulk
 * load got wrong.
 *
 * ## Why this exists
 *
 * The Phase B loader put every league, franchise, team and player into prod
 * in one sitting, and a handful of rows came out wrong in ways no existing
 * write path can put right from a terminal:
 *
 *  - the admin mutations (`teams.saveTeamFields`, `franchises.save`,
 *    `leagues.saveLeagueFields`) all `requireAdmin`, and a CLI run carries no
 *    identity — `--identity` does not help, it makes internal functions
 *    unreachable (see `docs/operations/neo214-set-builder-admin-scripts.md`
 *    §2.1);
 *  - nothing anywhere moves a player's career stints from one team row to
 *    another, which is what a mis-dated era needs once players have been
 *    attached to it;
 *  - `splitTeamLocations` splits only where ESPN's team list agrees, so the
 *    reference rows the seed knows the split for (`SEED_TEAMS`) but ESPN does
 *    not carry are still whole — and a row the loader ADOPTED under its whole
 *    name is named by no seed entry at all, so nothing splits it.
 *
 * So: seven internal functions, each armed the NEO-214 way, each idempotent,
 * each reporting exactly what it changed. Nothing here is dataset-specific
 * — the incident's own invocations live in
 * `docs/operations/neo254-prod-data-repair.md`, not in this file.
 *
 * ## The gate, restated
 *
 * `confirm: "NEO254_REPAIR"` (the validator) AND
 * `ALLOW_NEO254_REPAIR === "true"` on the target deployment, asserted as the
 * first statement of EVERY mutation and query here rather than once at an
 * entry point — `bulkLoad.ts` and `seedTeamColors.ts` explain why: a future
 * internal caller that reached a batch directly would otherwise write
 * unarmed. No `requireAdmin` anywhere on this path, for the reason above.
 *
 * ## Exactly one, or nothing
 *
 * Every function that names a row refuses on zero matches and on more than
 * one. Teams are identified the NEO-254 way — `(full name, sport,
 * yearsActive.from)` — because a name alone may hold several eras. A
 * refusal is a `ConvexError` so production does not redact the message;
 * the message names counts and stored names, never free text echoed back.
 *
 * ## Idempotent
 *
 * A second identical run changes nothing and says so (`changed: false`, or
 * zero counts). `renameFranchise` converges even though its `from` row no
 * longer exists on the second run: finding `to` and not `from` is reported
 * as already done, not as a refusal.
 */

import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  findCollidingTeams,
  findTeamsByFullName,
  teamRowFields,
} from "../lib/teamRow";
import { normalizeEntityName } from "../lib/entityNearMatch";
import { findFranchiseByName, franchiseRowFields } from "../franchises";
import { normalizeAliasList, normalizeLeagueName } from "../leagues";
import { teamFullName } from "../../lib/teams/team-name";
import { eraLabel } from "../../lib/teams/team-era";
import { sortTeamYears } from "../../lib/players/team-tenure";
import {
  RENAMED_FRANCHISES,
  SEED_LEAGUES,
  SEED_TEAMS,
} from "../../lib/teams/seed-team-colors";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export const CONFIRM_LITERAL = "NEO254_REPAIR";
const ARM_FLAG = "ALLOW_NEO254_REPAIR";

/**
 * Asserted first in every function in this file. `ConvexError`, not `Error`,
 * so production names the flag instead of redacting it.
 */
function assertRepairArmed(confirm: string): void {
  if (confirm !== CONFIRM_LITERAL) {
    throw new ConvexError(`NEO-254 repair requires confirm: "${CONFIRM_LITERAL}".`);
  }
  if (process.env[ARM_FLAG] !== "true") {
    throw new ConvexError(
      `NEO-254 repair is not armed on this deployment. Set ${ARM_FLAG}=true on ` +
        `it first (\`npx convex env set ${ARM_FLAG} true\`), and unset it ` +
        `again afterwards (\`npx convex env remove ${ARM_FLAG}\`).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared validators and bounds
// ---------------------------------------------------------------------------

const confirmValidator = v.literal(CONFIRM_LITERAL);

const eraValidator = v.object({ from: v.number(), to: v.optional(v.number()) });

/** A team named the NEO-254 way: composed name plus the era it started. */
const teamRefValidator = v.object({
  location: v.optional(v.string()),
  name: v.string(),
  fromYear: v.number(),
});

/** Players per `moveStintsBatch` call — one indexed page, well inside the
 *  read budget even when every row is patched. */
const MAX_MOVE_BATCH = 500;
const DEFAULT_MOVE_BATCH = MAX_MOVE_BATCH;
/** Cursor-never-advances guard; `players` would need millions of rows. */
const MAX_MOVE_BATCHES = 10_000;

/** Same floor as `bulkLoad.MIN_YEAR`. */
const MIN_YEAR = 1800;

type Era = { from: number; to?: number };

function requireValidEra(era: Era): void {
  if (!Number.isInteger(era.from) || era.from < MIN_YEAR) {
    throw new ConvexError(`yearsActive.from must be a whole year >= ${MIN_YEAR}.`);
  }
  if (era.to !== undefined) {
    if (!Number.isInteger(era.to) || era.to < MIN_YEAR) {
      throw new ConvexError(`yearsActive.to must be a whole year >= ${MIN_YEAR}.`);
    }
    if (era.to < era.from) {
      throw new ConvexError("yearsActive cannot end before it starts.");
    }
  }
}

function sameEra(a: Era | undefined, b: Era | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.from === b.from && a.to === b.to;
}

// ---------------------------------------------------------------------------
// Shared lookups — exactly one, or a named refusal
// ---------------------------------------------------------------------------

/**
 * The sport row whose display value is `sport`, case-insensitively. Sports
 * are created by the marketplace sync; a missing one is a refusal, never an
 * insert (`seedTeamColors` and `bulkLoad` make the same call).
 */
async function requireSport(
  ctx: QueryCtx | MutationCtx,
  sport: string,
): Promise<Doc<"selectorOptions">> {
  const wanted = sport.trim().toLowerCase();
  const rows = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level", (q) => q.eq("level", "sport"))
    .collect();
  const matches = rows.filter((r) => r.value.trim().toLowerCase() === wanted);
  if (matches.length !== 1) {
    throw new ConvexError(
      `Expected exactly one sport named "${sport}", found ${matches.length}.`,
    );
  }
  return matches[0];
}

/**
 * The ONE team in `sportId` composed as `location name` whose era starts in
 * `fromYear`. The name finds the candidates, the year picks the era — the
 * NEO-254 identity, applied to a write.
 */
async function requireTeamByEra(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  ref: { location?: string; name: string; fromYear: number },
): Promise<Doc<"teams">> {
  const fullName = teamFullName(ref);
  const candidates = await findTeamsByFullName(ctx, sportId, fullName);
  const matches = candidates.filter(
    (t) => t.yearsActive?.from === ref.fromYear,
  );
  if (matches.length !== 1) {
    const eras = candidates.map((t) => eraLabel(t.yearsActive) || "undated");
    throw new ConvexError(
      `Expected exactly one team "${fullName}" starting ${ref.fromYear} in ` +
        `this sport, found ${matches.length} (rows under that name: ` +
        `${candidates.length}${eras.length ? `; eras ${eras.join(", ")}` : ""}).`,
    );
  }
  return matches[0];
}

/** Does this league answer to `nameNormalized` by name or alias? Mirrors
 *  `leagues.leagueAnswersTo`, which is not exported. */
function leagueAnswersTo(row: Doc<"leagues">, nameNormalized: string): boolean {
  if (!nameNormalized) return false;
  if (row.nameNormalized === nameNormalized) return true;
  return (row.aliases ?? []).some(
    (alias) => normalizeLeagueName(alias) === nameNormalized,
  );
}

// ---------------------------------------------------------------------------
// 1. setTeamEra
// ---------------------------------------------------------------------------

/**
 * Re-date one team row. `yearsActive: null` clears it.
 *
 * The era is half the row's identity, so the new one is checked against the
 * sport's same-name rows exactly as `teams.saveTeamFields` checks it: an
 * overlap (an undated side counts as overlapping) is a refusal.
 */
export const setTeamEra = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    location: v.optional(v.string()),
    name: v.string(),
    fromYear: v.number(),
    yearsActive: v.union(eraValidator, v.null()),
  },
  returns: v.object({
    teamId: v.id("teams"),
    before: v.union(eraValidator, v.null()),
    after: v.union(eraValidator, v.null()),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);
    const team = await requireTeamByEra(ctx, sport._id, args);

    const next = args.yearsActive ?? undefined;
    if (next) requireValidEra(next);

    const before = team.yearsActive ?? null;
    if (sameEra(team.yearsActive, next)) {
      return { teamId: team._id, before, after: before, changed: false };
    }

    const clash = await findCollidingTeams(
      ctx,
      sport._id,
      teamFullName(team),
      next,
      team._id,
    );
    if (clash.length > 0) {
      throw new ConvexError(
        `Refusing: ${eraLabel(next) || "an undated era"} would overlap ` +
          `${clash.length} other row(s) named "${teamFullName(team)}" ` +
          `(${clash.map((t) => eraLabel(t.yearsActive) || "undated").join(", ")}).`,
      );
    }

    await ctx.db.patch(team._id, {
      yearsActive: next,
      lastUpdated: Date.now(),
    });
    return { teamId: team._id, before, after: next ?? null, changed: true };
  },
});

// ---------------------------------------------------------------------------
// 2. renameFranchise
// ---------------------------------------------------------------------------

/**
 * Rename the one franchise in the sport called `from` to `to`, through the
 * same `franchiseRowFields` derivation `franchises.save` uses so the dedup
 * key cannot disagree with the name.
 *
 * Converges: when `from` is gone and `to` is present, that is the state this
 * call produces, so it is reported as done rather than refused.
 */
export const renameFranchise = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    from: v.string(),
    to: v.string(),
  },
  returns: v.object({
    franchiseId: v.id("franchises"),
    before: v.string(),
    after: v.string(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);
    const fields = franchiseRowFields(args.to);

    const fromKey = normalizeEntityName(args.from);
    const fromRows = fromKey
      ? await ctx.db
          .query("franchises")
          .withIndex("by_name_normalized_and_sport_id", (q) =>
            q.eq("nameNormalized", fromKey).eq("sportId", sport._id),
          )
          .take(2)
      : [];
    const toRow = await findFranchiseByName(ctx, sport._id, fields.name);

    if (fromRows.length === 0) {
      if (toRow) {
        // Already renamed — the second run of this exact call.
        return {
          franchiseId: toRow._id,
          before: toRow.name,
          after: toRow.name,
          changed: false,
        };
      }
      throw new ConvexError(
        `No franchise named "${args.from}" in this sport, and none named ` +
          `"${fields.name}" either.`,
      );
    }
    if (fromRows.length > 1) {
      throw new ConvexError(
        `Expected exactly one franchise named "${args.from}" in this sport, found several.`,
      );
    }
    const existing = fromRows[0];

    if (existing.name === fields.name && existing.nameNormalized === fields.nameNormalized) {
      return {
        franchiseId: existing._id,
        before: existing.name,
        after: existing.name,
        changed: false,
      };
    }
    if (toRow && toRow._id !== existing._id) {
      throw new ConvexError(
        `Another franchise in this sport is already called ${toRow.name}.`,
      );
    }

    await ctx.db.patch(existing._id, { ...fields, lastUpdated: Date.now() });
    return {
      franchiseId: existing._id,
      before: existing.name,
      after: fields.name,
      changed: true,
    };
  },
});

// ---------------------------------------------------------------------------
// 3. moveStints — an action looping a paginated mutation
// ---------------------------------------------------------------------------

/**
 * Resolve both ends of a move before any batch runs, so an unarmed or
 * ambiguous call costs one read and touches nothing.
 */
export const resolveMoveStintsTeams = internalQuery({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    fromTeam: teamRefValidator,
    toTeam: teamRefValidator,
  },
  returns: v.object({
    sportId: v.id("selectorOptions"),
    fromTeamId: v.id("teams"),
    toTeamId: v.id("teams"),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);
    const from = await requireTeamByEra(ctx, sport._id, args.fromTeam);
    const to = await requireTeamByEra(ctx, sport._id, args.toTeam);
    if (from._id === to._id) {
      throw new ConvexError("fromTeam and toTeam resolve to the same row.");
    }
    return { sportId: sport._id, fromTeamId: from._id, toTeamId: to._id };
  },
});

type Stint = { teamId: Id<"teams">; fromYear: number; toYear?: number };

/**
 * Rewrite the stints of one player. Pure, so the merge rule is testable on
 * its own and the mutation below is only the loop around it.
 *
 * A stint at `fromTeamId` starting in or after `seasonFrom` is re-pointed at
 * `toTeamId`. If the player already holds a stint at `toTeamId` with the SAME
 * `fromYear`, the two become one — `(teamId, fromYear)` is the key
 * `players.savePlayerFields` refuses duplicates on — and the merged stint
 * ends at the later of the two ends, an open end winning. Everything else,
 * including stints that started before `seasonFrom`, is left exactly as it
 * was; the result is re-sorted through `sortTeamYears` so the stored array
 * stays canonical.
 */
export function moveStintsInCareer(
  stints: readonly Stint[],
  fromTeamId: Id<"teams">,
  toTeamId: Id<"teams">,
  seasonFrom: number,
): { stints: Stint[]; moved: number } {
  let moved = 0;
  const out: Stint[] = [];
  const byKey = new Map<string, number>();
  const push = (stint: Stint): void => {
    const key = `${stint.teamId}:${stint.fromYear}`;
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(stint);
      return;
    }
    const held = out[at];
    const end =
      held.toYear === undefined || stint.toYear === undefined
        ? undefined
        : Math.max(held.toYear, stint.toYear);
    out[at] = end === undefined
      ? { teamId: held.teamId, fromYear: held.fromYear }
      : { teamId: held.teamId, fromYear: held.fromYear, toYear: end };
  };

  for (const stint of stints) {
    if (stint.teamId === fromTeamId && stint.fromYear >= seasonFrom) {
      moved += 1;
      push({ ...stint, teamId: toTeamId });
    } else {
      push(stint);
    }
  }
  return { stints: sortTeamYears(out), moved };
}

function sameStints(a: readonly Stint[], b: readonly Stint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (s, i) =>
      s.teamId === b[i].teamId &&
      s.fromYear === b[i].fromYear &&
      s.toYear === b[i].toYear,
  );
}

/** One page of the sport's players. Armed independently of the action. */
export const moveStintsBatch = internalMutation({
  args: {
    confirm: confirmValidator,
    sportId: v.id("selectorOptions"),
    fromTeamId: v.id("teams"),
    toTeamId: v.id("teams"),
    seasonFrom: v.number(),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    playersScanned: v.number(),
    playersChanged: v.number(),
    stintsMoved: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const batchSize = Math.min(
      MAX_MOVE_BATCH,
      Math.max(1, Math.floor(args.batchSize ?? DEFAULT_MOVE_BATCH)),
    );
    // Both rows must still exist and belong to this sport — the action
    // resolved them, but a batch is callable on its own.
    for (const id of [args.fromTeamId, args.toTeamId]) {
      const team = await ctx.db.get(id);
      if (!team || team.sportId !== args.sportId) {
        throw new ConvexError("A team in this move is missing or in another sport.");
      }
    }

    const page = await ctx.db
      .query("players")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .paginate({ cursor: args.cursor, numItems: batchSize });

    let playersChanged = 0;
    let stintsMoved = 0;
    for (const player of page.page) {
      const current = player.teamYears ?? [];
      if (!current.some((s) => s.teamId === args.fromTeamId)) continue;
      const next = moveStintsInCareer(
        current,
        args.fromTeamId,
        args.toTeamId,
        args.seasonFrom,
      );
      if (next.moved === 0 || sameStints(current, next.stints)) continue;
      await ctx.db.patch(player._id, {
        teamYears: next.stints,
        lastUpdated: Date.now(),
      });
      playersChanged += 1;
      stintsMoved += next.moved;
    }

    return {
      playersScanned: page.page.length,
      playersChanged,
      stintsMoved,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

type MoveStintsResult = {
  fromTeamId: Id<"teams">;
  toTeamId: Id<"teams">;
  playersScanned: number;
  playersChanged: number;
  stintsMoved: number;
  isComplete: boolean;
};

type MoveStintsBatchResult = {
  playersScanned: number;
  playersChanged: number;
  stintsMoved: number;
  isDone: boolean;
  continueCursor: string;
};

/**
 * Move every stint at `fromTeam` that starts in or after `seasonFrom` onto
 * `toTeam`, for every player in the sport. Pages the `by_sport_id` index in
 * batches of at most 500 the way `runSetBuilderReset` does.
 *
 * The handler and the two `internal.*` calls are annotated explicitly: an
 * action that calls functions in its own module is otherwise a circular type
 * inference through `_generated/api`, and tsc reports it as `any`.
 */
export const moveStints = internalAction({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    fromTeam: teamRefValidator,
    toTeam: teamRefValidator,
    seasonFrom: v.number(),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    fromTeamId: v.id("teams"),
    toTeamId: v.id("teams"),
    playersScanned: v.number(),
    playersChanged: v.number(),
    stintsMoved: v.number(),
    isComplete: v.boolean(),
  }),
  handler: async (ctx, args): Promise<MoveStintsResult> => {
    // Fail before the loop so an unarmed run costs one read; every batch
    // re-asserts on its own.
    assertRepairArmed(args.confirm);
    if (!Number.isInteger(args.seasonFrom) || args.seasonFrom < MIN_YEAR) {
      throw new ConvexError(`seasonFrom must be a whole year >= ${MIN_YEAR}.`);
    }
    const ends: {
      sportId: Id<"selectorOptions">;
      fromTeamId: Id<"teams">;
      toTeamId: Id<"teams">;
    } = await ctx.runQuery(
      internal.repairs.neo254ProdData.resolveMoveStintsTeams,
      {
        confirm: args.confirm,
        sport: args.sport,
        fromTeam: args.fromTeam,
        toTeam: args.toTeam,
      },
    );

    let playersScanned = 0;
    let playersChanged = 0;
    let stintsMoved = 0;
    let isComplete = false;
    let cursor: string | null = null;
    for (let batch = 0; batch < MAX_MOVE_BATCHES; batch += 1) {
      const result: MoveStintsBatchResult = await ctx.runMutation(
        internal.repairs.neo254ProdData.moveStintsBatch,
        {
          confirm: args.confirm,
          sportId: ends.sportId,
          fromTeamId: ends.fromTeamId,
          toTeamId: ends.toTeamId,
          seasonFrom: args.seasonFrom,
          cursor,
          ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
        },
      );
      playersScanned += result.playersScanned;
      playersChanged += result.playersChanged;
      stintsMoved += result.stintsMoved;
      if (result.isDone) {
        isComplete = true;
        break;
      }
      cursor = result.continueCursor;
    }

    console.log(
      JSON.stringify({
        msg: "neo254_move_stints_done",
        isComplete,
        playersScanned,
        playersChanged,
        stintsMoved,
      }),
    );
    return {
      fromTeamId: ends.fromTeamId,
      toTeamId: ends.toTeamId,
      playersScanned,
      playersChanged,
      stintsMoved,
      isComplete,
    };
  },
});

// ---------------------------------------------------------------------------
// 4. setLeagueAliases
// ---------------------------------------------------------------------------

/**
 * Add aliases to the one league in the sport that answers to `name`. A
 * union — nothing is ever removed — through `normalizeAliasList`, the same
 * bounds and dedup the admin editor applies. An alias another league in the
 * sport already answers to is refused, as `saveLeagueFields` refuses it: two
 * rows answering to one key is the ambiguity aliases exist to prevent.
 */
export const setLeagueAliases = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    name: v.string(),
    aliases: v.array(v.string()),
  },
  returns: v.object({
    leagueId: v.id("leagues"),
    before: v.array(v.string()),
    after: v.array(v.string()),
    added: v.array(v.string()),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);
    const wanted = normalizeLeagueName(args.name.trim());
    const siblings = await ctx.db
      .query("leagues")
      .withIndex("by_sport_id", (q) => q.eq("sportId", sport._id))
      .collect();
    const matches = siblings.filter((row) => leagueAnswersTo(row, wanted));
    if (matches.length !== 1) {
      throw new ConvexError(
        `Expected exactly one league answering to "${args.name}" in this sport, found ${matches.length}.`,
      );
    }
    const league = matches[0];
    const before = league.aliases ?? [];
    const after = normalizeAliasList([...before, ...args.aliases], league.name);
    const beforeKeys = new Set(before.map((a) => normalizeLeagueName(a)));
    const added = after.filter((a) => !beforeKeys.has(normalizeLeagueName(a)));

    if (added.length === 0) {
      return { leagueId: league._id, before, after: before, added, changed: false };
    }

    const addedKeys = new Set(added.map((a) => normalizeLeagueName(a)));
    for (const sibling of siblings) {
      if (sibling._id === league._id) continue;
      const siblingKeys = [
        sibling.nameNormalized,
        ...(sibling.aliases ?? []).map((a) => normalizeLeagueName(a)),
      ];
      if (siblingKeys.some((key) => addedKeys.has(key))) {
        throw new ConvexError(
          `Refusing: another league in this sport (${sibling.name}) already answers to one of those aliases.`,
        );
      }
    }

    await ctx.db.patch(league._id, { aliases: after, lastUpdated: Date.now() });
    return { leagueId: league._id, before, after, added, changed: true };
  },
});

// ---------------------------------------------------------------------------
// 5. resplitSeedTeams
// ---------------------------------------------------------------------------

const resplitSkipReason = v.union(
  v.literal("ambiguous"),
  v.literal("colliding"),
  v.literal("key_mismatch"),
);

type ResplitSkip = {
  name: string;
  sport: string;
  reason: "ambiguous" | "colliding" | "key_mismatch";
};

/**
 * Apply the split `SEED_TEAMS` already knows to rows still holding the whole
 * name — the pre-NEO-236 shape a bulk-loaded row can arrive in.
 *
 * For each seed entry that has a `location` (and, for a renamed franchise,
 * for its current name too): the sport's rows under that full name whose
 * `location` is empty and whose own `name` still normalises to the full key
 * are the candidates. Exactly one candidate, no same-name row with an
 * overlapping era (`findCollidingTeams`), and a dedup key that survives the
 * split unchanged — otherwise the entry is skipped and reported. Entries
 * without a location ("Arsenal", "AFC Bournemouth") have nothing to split.
 *
 * `SEED_TEAMS` is 165 rows and each costs two indexed reads, so this is one
 * mutation rather than a chunked loop.
 */
export const resplitSeedTeams = internalMutation({
  args: { confirm: confirmValidator },
  returns: v.object({
    resplit: v.array(v.string()),
    skipped: v.array(
      v.object({ name: v.string(), sport: v.string(), reason: resplitSkipReason }),
    ),
    /** Seed entries with a location whose sport holds no unsplit row. */
    nothingToDo: v.number(),
    /** Seed entries whose sport has never been synced here. */
    noSport: v.number(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);

    const sportRows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();
    const sportByValue = new Map(
      sportRows.map((r) => [r.value.toLowerCase().trim(), r]),
    );

    const resplit: string[] = [];
    const skipped: ResplitSkip[] = [];
    let nothingToDo = 0;
    let noSport = 0;
    // A renamed franchise's current parts can coincide with another seed's
    // own parts; each (sport, full name) is visited once.
    const visited = new Set<string>();

    for (const seed of SEED_TEAMS) {
      const targets: Array<{ location?: string; name: string }> = [];
      if (seed.location) targets.push({ location: seed.location, name: seed.name });
      const renamed = RENAMED_FRANCHISES[teamFullName(seed)];
      if (renamed?.location) {
        targets.push({ location: renamed.location, name: renamed.name });
      }
      if (targets.length === 0) continue;

      const sportValue = SEED_LEAGUES[seed.league].sportValue;
      const sport = sportByValue.get(sportValue.toLowerCase());
      if (!sport) {
        noSport += 1;
        continue;
      }

      for (const target of targets) {
        const fullName = teamFullName(target);
        const visitKey = `${sport._id}:${normalizeEntityName(fullName)}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        const key = normalizeEntityName(fullName);
        const rows = await findTeamsByFullName(ctx, sport._id, fullName);
        const unsplit = rows.filter(
          (row) =>
            (row.location === undefined || row.location.trim() === "") &&
            normalizeEntityName(row.name) === key,
        );
        if (unsplit.length === 0) {
          nothingToDo += 1;
          continue;
        }
        if (unsplit.length > 1) {
          skipped.push({ name: fullName, sport: sport.value, reason: "ambiguous" });
          continue;
        }
        const row = unsplit[0];

        const clash = await findCollidingTeams(
          ctx,
          sport._id,
          fullName,
          row.yearsActive,
          row._id,
        );
        if (clash.length > 0) {
          skipped.push({ name: fullName, sport: sport.value, reason: "colliding" });
          continue;
        }

        const fields = teamRowFields(target);
        // Splitting cannot change the dedup key (`normalizeEntityName`
        // token-sorts). A row whose stored key already disagrees with its own
        // name was written by something else; re-deriving it here would
        // repoint every card that resolves through it.
        if (fields.nameNormalized !== row.nameNormalized) {
          skipped.push({ name: fullName, sport: sport.value, reason: "key_mismatch" });
          continue;
        }

        await ctx.db.patch(row._id, {
          name: fields.name,
          location: fields.location,
          nameNormalized: fields.nameNormalized,
          lastUpdated: Date.now(),
        });
        resplit.push(fullName);
      }
    }

    return { resplit, skipped, nothingToDo, noSport };
  },
});

// ---------------------------------------------------------------------------
// 6. splitTeam
// ---------------------------------------------------------------------------

const splitPartsValidator = v.object({
  location: v.union(v.string(), v.null()),
  name: v.string(),
});

/**
 * Split ONE named row the seed does not know the parts of.
 *
 * `resplitSeedTeams` handles everything `SEED_TEAMS` carries a location for.
 * What it cannot reach is a row the loader ADOPTED — a pre-NEO-236 row that
 * already existed under its whole name, that the load then attached real
 * stints and an era to, and that no seed entry names in its current shape
 * (prod, 2026-09-10: the Clippers, the Oakland Raiders, the Arizona Coyotes,
 * the Oakland Athletics). The loader never rewrites an adopted row, so those
 * four are still whole. This is that split, one row at a time, with the parts
 * supplied by the operator instead of by the seed.
 *
 * The refusals are `resplitSeedTeams`' refusals, promoted from "skip and
 * report" to "throw", because a single-row call has an operator watching:
 *
 *  - the parts must compose back to the SAME dedup key, or it is a rename
 *    wearing a split's clothes and every card resolving through the key moves;
 *  - exactly one unsplit row must answer to `currentName`;
 *  - no other row of that name may hold an overlapping era
 *    (`findCollidingTeams`, undated counting as overlapping).
 *
 * Idempotent by convergence rather than by refusal: once the row is split,
 * there is no unsplit row left to find, and the split row that IS there is
 * the state this call produces — so a second run reports `changed: false`.
 */
export const splitTeam = internalMutation({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    currentName: v.string(),
    location: v.string(),
    name: v.string(),
  },
  returns: v.object({
    teamId: v.id("teams"),
    before: splitPartsValidator,
    after: splitPartsValidator,
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);

    const fields = teamRowFields({ location: args.location, name: args.name });
    if (!fields.location) {
      throw new ConvexError(
        "location cannot be empty — splitTeam turns a whole name into Location + Name.",
      );
    }
    const currentKey = normalizeEntityName(args.currentName);
    if (currentKey.length === 0) {
      throw new ConvexError("currentName cannot be empty.");
    }
    if (fields.nameNormalized !== currentKey) {
      throw new ConvexError(
        `Refusing: "${fields.location}" + "${fields.name}" does not compose back ` +
          `to "${args.currentName}". A split may not change the dedup key — ` +
          `every card that resolves through it would be repointed.`,
      );
    }

    const rows = await findTeamsByFullName(ctx, sport._id, args.currentName);
    const unsplit = rows.filter(
      (row) =>
        (row.location === undefined || row.location.trim() === "") &&
        normalizeEntityName(row.name) === currentKey,
    );

    if (unsplit.length === 0) {
      const already = rows.filter(
        (row) =>
          row.location?.trim() === fields.location && row.name.trim() === fields.name,
      );
      if (already.length === 1) {
        const row = already[0];
        const parts = { location: row.location ?? null, name: row.name };
        return { teamId: row._id, before: parts, after: parts, changed: false };
      }
      throw new ConvexError(
        `Expected exactly one unsplit team named "${args.currentName}" in this ` +
          `sport, found 0 (rows under that name: ${rows.length}; already split ` +
          `as "${fields.location} / ${fields.name}": ${already.length}).`,
      );
    }
    if (unsplit.length > 1) {
      throw new ConvexError(
        `Expected exactly one unsplit team named "${args.currentName}" in this ` +
          `sport, found ${unsplit.length} (eras ` +
          `${unsplit.map((t) => eraLabel(t.yearsActive) || "undated").join(", ")}).`,
      );
    }
    const row = unsplit[0];

    const clash = await findCollidingTeams(
      ctx,
      sport._id,
      teamFullName(fields),
      row.yearsActive,
      row._id,
    );
    if (clash.length > 0) {
      throw new ConvexError(
        `Refusing: ${clash.length} other row(s) named "${teamFullName(fields)}" ` +
          `already hold an overlapping era ` +
          `(${clash.map((t) => eraLabel(t.yearsActive) || "undated").join(", ")}).`,
      );
    }

    await ctx.db.patch(row._id, {
      name: fields.name,
      location: fields.location,
      nameNormalized: fields.nameNormalized,
      lastUpdated: Date.now(),
    });
    return {
      teamId: row._id,
      before: { location: null, name: row.name },
      after: { location: fields.location, name: fields.name },
      changed: true,
    };
  },
});

// ---------------------------------------------------------------------------
// 7. deleteTeam
// ---------------------------------------------------------------------------

/**
 * Delete ONE team row — and why a delete exists here when the app has none.
 *
 * The app has no delete-team path on purpose, and this does not change that.
 * What this reaches is a narrower thing: a pre-NEO-236 legacy row whose name
 * does not compose to the same normalised key as the row that superseded it.
 * `"Hawks"` normalises to `hawks`; the proper row is `"Atlanta" / "Hawks"`,
 * `atlanta hawks`. Different keys, so the two are invisible to each other —
 * no lookup will ever find the legacy row, no rename can reach it (a rename
 * that changes the key is exactly what `splitTeam` refuses), and
 * `resplitSeedTeams` cannot touch it either. It is an unreachable duplicate,
 * not data, and the only way it stops shadowing anything is to go.
 *
 * That is the whole licence. This is NOT a general delete-team tool, and the
 * refusals below are what keep it from becoming one.
 *
 * ## Nothing card-facing may be orphaned, armed or not
 *
 * A team id is referenced in exactly three places (`grep 'id("teams")'
 * convex/schema.ts`): `cardChecklist.teamOnCardIds`, `players.teamYears[]`
 * and `entityReviewQueue`'s `link` decision (`linkedTeamId`). The first and
 * third are ALWAYS a refusal — a card that prints a team, or a review a human
 * is part-way through, must not lose its referent because a script was armed.
 * Only the second has a policy, because a stint is something this file
 * already knows how to move:
 *
 *  - `refuse` (the default) — any stint at all stops the delete, naming up to
 *    ten of the players. The safe default: the caller must SAY what happens.
 *  - `drop` — the entries are removed, for a row whose stints are wrong in a
 *    way no other row can absorb (a cross-sport Wikidata row).
 *  - `move` — the entries go to another row, every year of them, through the
 *    same `moveStintsInCareer` merge rule `moveStints` uses.
 *
 * The two scans and the player walk are paginated and point-in-time: a
 * snapshot, not a lock. Run this when nothing else is writing, like every
 * other task in `docs/operations/`.
 *
 * ## Idempotent
 *
 * The row already being gone is the state this call produces, so a second run
 * reports `outcome: "already_absent"`, `changed: false` — it does not throw.
 * A misspelled name reads identically, which is why the result echoes the row
 * it found and the operator checks the FIRST run's output, not the second's.
 */

/** A team named for a delete: parts, optionally narrowed by era start. */
const teamTargetValidator = v.object({
  location: v.optional(v.string()),
  name: v.string(),
  fromYear: v.optional(v.number()),
});

const stintsPolicyValidator = v.union(
  v.object({ kind: v.literal("refuse") }),
  v.object({ kind: v.literal("drop") }),
  v.object({ kind: v.literal("move"), to: teamTargetValidator }),
);

/** `moveStintsInCareer` with no year floor — a delete moves a whole career. */
const ALL_SEASONS = Number.NEGATIVE_INFINITY;

/** Rows scanned per blocker page. Read-only, so this can be generous. */
const BLOCKER_BATCH = 500;
const MAX_BLOCKER_BATCHES = 10_000;
/** How many referencing rows a refusal names before it stops collecting. */
const BLOCKER_SAMPLE = 10;

/** How a row reads in a refusal: the parts, plus the era that tells eras apart. */
function teamLabel(team: Doc<"teams">): string {
  const era = eraLabel(team.yearsActive);
  const parts = team.location ? `${team.location} / ${team.name}` : team.name;
  return `${parts} (${era || "undated"})`;
}

/**
 * Every row in the sport matching these parts. An OMITTED (or empty)
 * `location` means the row's own location is empty — the pre-NEO-236 shape —
 * rather than "any location"; that is what lets `{name: "Hawks"}` name the
 * legacy row and never the proper `Atlanta / Hawks`. `fromYear`, when given,
 * narrows to that era the way `requireTeamByEra` does.
 */
async function findTeamsByParts(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  ref: { location?: string; name: string; fromYear?: number },
): Promise<Doc<"teams">[]> {
  const wantLocation = normalizeEntityName(ref.location ?? "");
  const rows = await findTeamsByFullName(ctx, sportId, teamFullName(ref));
  return rows.filter((row) => {
    if (normalizeEntityName(row.location ?? "") !== wantLocation) return false;
    if (ref.fromYear !== undefined && row.yearsActive?.from !== ref.fromYear) {
      return false;
    }
    return true;
  });
}

/** Exactly one, or a refusal that names every candidate it did find. */
async function requireTeamByParts(
  ctx: QueryCtx | MutationCtx,
  sportId: Id<"selectorOptions">,
  ref: { location?: string; name: string; fromYear?: number },
  role: string,
): Promise<Doc<"teams">> {
  const matches = await findTeamsByParts(ctx, sportId, ref);
  if (matches.length !== 1) {
    throw new ConvexError(
      `Expected exactly one ${role} team "${teamFullName(ref)}"` +
        `${ref.fromYear === undefined ? "" : ` starting ${ref.fromYear}`} in ` +
        `this sport, found ${matches.length}` +
        `${matches.length ? ` (${matches.map(teamLabel).join("; ")})` : ""}.`,
    );
  }
  return matches[0];
}

/**
 * Resolve both ends before anything is scanned or written. A missing DELETE
 * target is `teamId: null` rather than a throw — that is the idempotent case,
 * and the only one. A missing MOVE destination is still a refusal.
 */
export const resolveDeleteTeam = internalQuery({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    location: v.optional(v.string()),
    name: v.string(),
    fromYear: v.optional(v.number()),
    stints: v.optional(stintsPolicyValidator),
  },
  returns: v.object({
    sportId: v.id("selectorOptions"),
    teamId: v.union(v.id("teams"), v.null()),
    teamLabel: v.union(v.string(), v.null()),
    toTeamId: v.union(v.id("teams"), v.null()),
    toTeamLabel: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sport = await requireSport(ctx, args.sport);
    const matches = await findTeamsByParts(ctx, sport._id, args);
    if (matches.length > 1) {
      throw new ConvexError(
        `Expected exactly one team "${teamFullName(args)}" in this sport, ` +
          `found ${matches.length} (${matches.map(teamLabel).join("; ")}). ` +
          `Narrow it with fromYear.`,
      );
    }
    if (matches.length === 0) {
      return {
        sportId: sport._id,
        teamId: null,
        teamLabel: null,
        toTeamId: null,
        toTeamLabel: null,
      };
    }
    const team = matches[0];

    const policy = args.stints ?? { kind: "refuse" as const };
    if (policy.kind !== "move") {
      return {
        sportId: sport._id,
        teamId: team._id,
        teamLabel: teamLabel(team),
        toTeamId: null,
        toTeamLabel: null,
      };
    }
    const to = await requireTeamByParts(ctx, sport._id, policy.to, "destination");
    if (to._id === team._id) {
      throw new ConvexError(
        "The delete target and the stint destination resolve to the same row.",
      );
    }
    return {
      sportId: sport._id,
      teamId: team._id,
      teamLabel: teamLabel(team),
      toTeamId: to._id,
      toTeamLabel: teamLabel(to),
    };
  },
});

/**
 * One page of the two tables that ALWAYS block. Separate from the player walk
 * because nothing here has a policy — these are refusals, never rewrites.
 */
export const scanTeamBlockers = internalQuery({
  args: {
    confirm: confirmValidator,
    teamId: v.id("teams"),
    table: v.union(v.literal("cardChecklist"), v.literal("entityReviewQueue")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    found: v.number(),
    sample: v.array(v.string()),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const sample: string[] = [];
    let found = 0;

    if (args.table === "cardChecklist") {
      const page = await ctx.db
        .query("cardChecklist")
        .paginate({ cursor: args.cursor, numItems: BLOCKER_BATCH });
      for (const card of page.page) {
        if (!(card.teamOnCardIds ?? []).includes(args.teamId)) continue;
        found += 1;
        if (sample.length < BLOCKER_SAMPLE) {
          sample.push(`card #${card.cardNumber} ${card.cardName}`);
        }
      }
      return {
        found,
        sample,
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }

    const page = await ctx.db
      .query("entityReviewQueue")
      .paginate({ cursor: args.cursor, numItems: BLOCKER_BATCH });
    for (const row of page.page) {
      const decision = row.decision;
      // `linkedTeamId` lives on the `link` variant only; `in` is the narrowing
      // the union needs, and it also catches a future variant that grows one.
      if (!decision || !("linkedTeamId" in decision)) continue;
      if (decision.linkedTeamId !== args.teamId) continue;
      found += 1;
      if (sample.length < BLOCKER_SAMPLE) {
        sample.push(`${row.kind} review "${row.name}"`);
      }
    }
    return {
      found,
      sample,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Drop every stint at `teamId`, keeping the rest canonical. */
export function dropStintsFromCareer(
  stints: readonly Stint[],
  teamId: Id<"teams">,
): { stints: Stint[]; dropped: number } {
  const kept = stints.filter((s) => s.teamId !== teamId);
  return { stints: sortTeamYears(kept), dropped: stints.length - kept.length };
}

/**
 * One page of the sport's players, under the chosen stint policy. Armed
 * independently of the action, like `moveStintsBatch`. Under `refuse` it
 * writes nothing and only counts, so a refused delete leaves no partial work.
 */
export const deleteTeamStintsBatch = internalMutation({
  args: {
    confirm: confirmValidator,
    sportId: v.id("selectorOptions"),
    teamId: v.id("teams"),
    toTeamId: v.union(v.id("teams"), v.null()),
    policy: v.union(v.literal("refuse"), v.literal("drop"), v.literal("move")),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    playersScanned: v.number(),
    playersChanged: v.number(),
    stintsMoved: v.number(),
    stintsDropped: v.number(),
    blocked: v.number(),
    sample: v.array(v.string()),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const toTeamId = args.toTeamId;
    if (args.policy === "move" && toTeamId === null) {
      throw new ConvexError("A move needs a destination team.");
    }
    const batchSize = Math.min(
      MAX_MOVE_BATCH,
      Math.max(1, Math.floor(args.batchSize ?? DEFAULT_MOVE_BATCH)),
    );
    const page = await ctx.db
      .query("players")
      .withIndex("by_sport_id", (q) => q.eq("sportId", args.sportId))
      .paginate({ cursor: args.cursor, numItems: batchSize });

    let playersChanged = 0;
    let stintsMoved = 0;
    let stintsDropped = 0;
    let blocked = 0;
    const sample: string[] = [];

    for (const player of page.page) {
      const current = player.teamYears ?? [];
      if (!current.some((s) => s.teamId === args.teamId)) continue;

      if (args.policy === "refuse") {
        blocked += 1;
        if (sample.length < BLOCKER_SAMPLE) sample.push(player.name);
        continue;
      }
      if (args.policy === "drop") {
        const next = dropStintsFromCareer(current, args.teamId);
        if (next.dropped === 0) continue;
        await ctx.db.patch(player._id, {
          teamYears: next.stints,
          lastUpdated: Date.now(),
        });
        playersChanged += 1;
        stintsDropped += next.dropped;
        continue;
      }
      if (toTeamId === null) continue; // unreachable — guarded above
      const next = moveStintsInCareer(current, args.teamId, toTeamId, ALL_SEASONS);
      if (next.moved === 0) continue;
      await ctx.db.patch(player._id, {
        teamYears: next.stints,
        lastUpdated: Date.now(),
      });
      playersChanged += 1;
      stintsMoved += next.moved;
    }

    return {
      playersScanned: page.page.length,
      playersChanged,
      stintsMoved,
      stintsDropped,
      blocked,
      sample,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * The delete itself, after the scans are clean. Re-reads the row so a second
 * run — or a racing one — cannot delete twice or delete across a sport.
 */
export const finalizeDeleteTeam = internalMutation({
  args: {
    confirm: confirmValidator,
    sportId: v.id("selectorOptions"),
    teamId: v.id("teams"),
  },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    assertRepairArmed(args.confirm);
    const team = await ctx.db.get(args.teamId);
    if (!team) return { deleted: false };
    if (team.sportId !== args.sportId) {
      throw new ConvexError("That team is in another sport.");
    }
    await ctx.db.delete(args.teamId);
    return { deleted: true };
  },
});

type DeleteTeamResult = {
  teamId: Id<"teams"> | null;
  teamLabel: string | null;
  outcome: "deleted" | "already_absent";
  playersScanned: number;
  playersChanged: number;
  stintsMoved: number;
  stintsDropped: number;
  isComplete: boolean;
  changed: boolean;
};

type BlockerScanResult = {
  found: number;
  sample: string[];
  isDone: boolean;
  continueCursor: string;
};

type DeleteBatchResult = {
  playersScanned: number;
  playersChanged: number;
  stintsMoved: number;
  stintsDropped: number;
  blocked: number;
  sample: string[];
  isDone: boolean;
  continueCursor: string;
};

export const deleteTeam = internalAction({
  args: {
    confirm: confirmValidator,
    sport: v.string(),
    location: v.optional(v.string()),
    name: v.string(),
    fromYear: v.optional(v.number()),
    stints: v.optional(stintsPolicyValidator),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    teamId: v.union(v.id("teams"), v.null()),
    teamLabel: v.union(v.string(), v.null()),
    outcome: v.union(v.literal("deleted"), v.literal("already_absent")),
    playersScanned: v.number(),
    playersChanged: v.number(),
    stintsMoved: v.number(),
    stintsDropped: v.number(),
    isComplete: v.boolean(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args): Promise<DeleteTeamResult> => {
    assertRepairArmed(args.confirm);
    const policy = args.stints ?? { kind: "refuse" as const };

    const ends: {
      sportId: Id<"selectorOptions">;
      teamId: Id<"teams"> | null;
      teamLabel: string | null;
      toTeamId: Id<"teams"> | null;
      toTeamLabel: string | null;
    } = await ctx.runQuery(internal.repairs.neo254ProdData.resolveDeleteTeam, {
      confirm: args.confirm,
      sport: args.sport,
      ...(args.location !== undefined ? { location: args.location } : {}),
      name: args.name,
      ...(args.fromYear !== undefined ? { fromYear: args.fromYear } : {}),
      stints: policy,
    });

    const teamId = ends.teamId;
    if (teamId === null) {
      return {
        teamId: null,
        teamLabel: null,
        outcome: "already_absent",
        playersScanned: 0,
        playersChanged: 0,
        stintsMoved: 0,
        stintsDropped: 0,
        isComplete: true,
        changed: false,
      };
    }

    // The two references that are never negotiable, whatever `stints` says.
    for (const table of ["cardChecklist", "entityReviewQueue"] as const) {
      let scanCursor: string | null = null;
      let found = 0;
      const sample: string[] = [];
      for (let batch = 0; batch < MAX_BLOCKER_BATCHES; batch += 1) {
        const result: BlockerScanResult = await ctx.runQuery(
          internal.repairs.neo254ProdData.scanTeamBlockers,
          { confirm: args.confirm, teamId, table, cursor: scanCursor },
        );
        found += result.found;
        for (const entry of result.sample) {
          if (sample.length < BLOCKER_SAMPLE) sample.push(entry);
        }
        if (result.isDone) break;
        scanCursor = result.continueCursor;
      }
      if (found > 0) {
        throw new ConvexError(
          `Refusing to delete ${ends.teamLabel}: ${found} ${table} row(s) ` +
            `still reference it (${sample.join("; ")}` +
            `${found > sample.length ? "; …" : ""}). Repoint them first — a ` +
            `delete may not orphan card-facing data.`,
        );
      }
    }

    // The stints, under the policy.
    let playersScanned = 0;
    let playersChanged = 0;
    let stintsMoved = 0;
    let stintsDropped = 0;
    let blocked = 0;
    const blockedSample: string[] = [];
    let isComplete = false;
    let cursor: string | null = null;
    for (let batch = 0; batch < MAX_MOVE_BATCHES; batch += 1) {
      const result: DeleteBatchResult = await ctx.runMutation(
        internal.repairs.neo254ProdData.deleteTeamStintsBatch,
        {
          confirm: args.confirm,
          sportId: ends.sportId,
          teamId,
          toTeamId: ends.toTeamId,
          policy: policy.kind,
          cursor,
          ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
        },
      );
      playersScanned += result.playersScanned;
      playersChanged += result.playersChanged;
      stintsMoved += result.stintsMoved;
      stintsDropped += result.stintsDropped;
      blocked += result.blocked;
      for (const entry of result.sample) {
        if (blockedSample.length < BLOCKER_SAMPLE) blockedSample.push(entry);
      }
      if (result.isDone) {
        isComplete = true;
        break;
      }
      cursor = result.continueCursor;
    }
    if (blocked > 0) {
      throw new ConvexError(
        `Refusing to delete ${ends.teamLabel}: ${blocked} player(s) still ` +
          `have a stint there (${blockedSample.join("; ")}` +
          `${blocked > blockedSample.length ? "; …" : ""}). Pass ` +
          `stints: {"kind":"move","to":{…}} or {"kind":"drop"} to say what ` +
          `happens to them.`,
      );
    }
    if (!isComplete) {
      throw new ConvexError(
        "Refusing to delete: the player walk did not finish, so a stint may " +
          "still point at this row. Re-run.",
      );
    }

    const { deleted }: { deleted: boolean } = await ctx.runMutation(
      internal.repairs.neo254ProdData.finalizeDeleteTeam,
      { confirm: args.confirm, sportId: ends.sportId, teamId },
    );

    console.log(
      JSON.stringify({
        msg: "neo254_delete_team_done",
        team: ends.teamLabel,
        policy: policy.kind,
        deleted,
        playersChanged,
        stintsMoved,
        stintsDropped,
      }),
    );
    return {
      teamId,
      teamLabel: ends.teamLabel,
      outcome: deleted ? "deleted" : "already_absent",
      playersScanned,
      playersChanged,
      stintsMoved,
      stintsDropped,
      isComplete,
      changed: deleted || playersChanged > 0,
    };
  },
});
