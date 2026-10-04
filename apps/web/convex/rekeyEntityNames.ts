/**
 * NEO-322 — re-key every stored copy of the shared entity-name key.
 *
 * `lib/entities/normalize-name.ts` is the ONE normaliser for player, team,
 * league and franchise names, and every lookup goes through an index on its
 * output. NEO-322 changed its chain (a run of two or more single-letter tokens
 * is joined, so "C. J. Kayfus" keys as "cj kayfus" where it used to key as
 * "c j kayfus"). A key stored by the OLD chain is unreachable through the
 * index with the NEW one, so a fresh lookup creates a sibling instead of
 * finding the row. Production now holds players and teams that stay, so the
 * stored keys are recomputed here rather than thrown away with the data.
 *
 * This module never normalises anything itself. It imports the shared
 * functions and the row-field helpers that wrap them (`teamRowFields`), so it
 * can never disagree with the writers about what the key is. Re-run it after
 * ANY future change to that chain.
 *
 * ## Operator commands
 *
 *   # 1. dry run (the default) — reports exactly what an armed run would do
 *   npx convex run rekeyEntityNames:run '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_REKEY_ENTITY_NAMES true
 *   npx convex run rekeyEntityNames:run '{"confirm":"REKEY ENTITY NAMES"}'
 *   npx convex env remove ALLOW_REKEY_ENTITY_NAMES
 *
 *   # 3. dry run again — every table must report toRekey: 0
 *   npx convex run rekeyEntityNames:run '{}'
 *
 *   # production: the same steps with --prod, in the same sitting as the
 *   # deploy that shipped the new chain.
 *
 * Full runbook: `docs/operations/neo322-rekey-entity-names.md`.
 *
 * DO NOT ADD `--identity`: `convex run --identity` resolves public functions
 * only, so every function here would come back "Could not find function".
 * Reaching an internal function at all takes the deployment's admin
 * credential, and reaching `--prod` takes prod deploy credentials; that is the
 * real boundary. The two arms below are the "arm before you fire" friction on
 * top of it (the `backfillBrandUnknownRole` shape, NEO-272):
 *
 *   `confirm: "REKEY ENTITY NAMES"` is the per-INVOCATION statement of intent.
 *   Omit it, or misspell it, and the run is a dry run whatever the
 *   environment says.
 *
 *   `ALLOW_REKEY_ENTITY_NAMES=true` is the per-DEPLOYMENT arm. It is what
 *   protects the deployment you did not mean to point at: a `--prod` typed out
 *   of habit carries the same confirm phrase as a dev run. It is asserted in
 *   EVERY write mutation (`applyPage`), not only in the entry point, so no
 *   future internal caller can reach the writes around it.
 *
 *   `applyPage` also REQUIRES `confirm` as the literal phrase in its own
 *   validator, so a direct `npx convex run rekeyEntityNames:applyPage` cannot
 *   skip the per-invocation statement of intent either; `run` passes it
 *   through only on an apply pass it has already decided to make.
 *
 * An armed call on an UNARMED deployment is refused with a `ConvexError`
 * whose data names the flag AND carries the dry-run report, so the operator
 * sees what the run would have done and what to do about it in one step.
 *
 * ## What it walks
 *
 * Every stored copy of the key, found by grepping `convex/schema.ts` for
 * `nameNormalized` / `aliasNormalized`:
 *
 *   players            nameNormalized    normalizeEntityName(name)
 *   playerSports       nameNormalized    denormalised players key
 *   playerAliases      aliasNormalized   normalizeEntityName(alias)
 *   teams              nameNormalized    teamRowFields({name, location})
 *   teamAliases        aliasNormalized   normalizeEntityName(alias)
 *   leagues            nameNormalized    normalizeOrderedEntityName(name)
 *   franchises         nameNormalized    normalizeEntityName(name)
 *   entityReviewSkips  nameNormalized    normalizeEntityName(name)
 *   entityReviewQueue  nameNormalized    by kind, mirroring `keyFor` in
 *                                        entityReviewQueue.startBatch
 *
 * (`leagues.aliases` and `players.aliases`/`teams.aliases` store RAW spellings
 * and are matched normalised at read time; nothing stored there to re-key.)
 *
 * "Changed" means the stored key is not what the current chain makes of the
 * row's own name, for ANY reason: the NEO-322 rule, a pre-NEO-253 diacritic
 * key, a hand-written key. The run never touches a name, an alias list or a
 * marketplace field; it only rewrites derived keys.
 *
 * The three side tables are never written here. `playerSports`,
 * `playerAliases` and `teamAliases` each have ONE writer (`syncPlayerSports`,
 * `syncPlayerAliases`, `syncTeamAliases`), guarded by pin tests, and the
 * re-key rebuilds a parent's rows by calling that writer. Even the READS go
 * through paging helpers in the owning modules, because the pins flag any
 * other module that queries those tables.
 *
 * ## Collisions
 *
 * A re-key can land two rows on one key. Per (scope, new key) group with at
 * least one CHANGED member — two unchanged rows that already shared a key are
 * none of this run's business and are not reported:
 *
 *   players, teams          write the new key on every changed row AND report
 *                           the group. Their readers take a LIST and branch on
 *                           its size (exactly-one links, several asks), so a
 *                           shared key becomes an operator question, never a
 *                           silent wrong link. Two team eras under one name is
 *                           legitimate (NEO-254).
 *   playerSports            the same policy, in the SAME group: a player's
 *                           extra-sport row collides as that player, in that
 *                           sport (`collisionTableOf`). A player's holders in a
 *                           sport are both legs `sameNamePlayers` reads there —
 *                           home rows and other players' `playerSports` rows —
 *                           so a re-keyed home row meeting another player's
 *                           membership, and a re-keyed membership meeting
 *                           another player's home row, are both reported.
 *   leagues, franchises     SKIP the colliding changed rows (they keep the old
 *                           key) and report them. Their readers take `.first()`
 *                           and their saves refuse NAME_TAKEN, so a shared key
 *                           would silently hide one row.
 *   skips, queue, aliases   write, and report the duplicates informationally.
 *                           (The alias tables stay informational: an alias
 *                           shared with another player's name is the wizard's
 *                           question at lookup time, not a key collision.)
 *
 * Nothing is ever merged or deleted. Resolving a reported group is an
 * operator decision on the admin screens.
 *
 * ## Budget
 *
 * The plan pass is one `scanPage` query per page (one `.paginate` per
 * execution), 500 rows except `players` and `playerSports`, whose changed rows
 * each read two holder legs and so plan 250 at a time; the apply pass is one `applyPage` mutation per page, 100 rows for
 * the tables whose writes fan out through the side-table writers and 500 for
 * the single-patch tables. Both walk in creation order with no index, so a
 * patch never moves a row under the cursor. `maxPages` (default 1000) bounds
 * each table's walk; hitting it reports `isComplete: false` rather than
 * throwing, and an armed run whose PLAN did not complete writes nothing, since
 * its collision picture is partial.
 *
 * ## Idempotent
 *
 * A second run finds every stored key equal to its recompute and reports
 * `toRekey: 0` everywhere. That dry run is the confirmation step.
 */

import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  normalizeEntityName,
  normalizeOrderedEntityName,
} from "../lib/entities/normalize-name";
import { teamFullName } from "../lib/teams/team-name";
import { findTeamsByExactName, teamRowFields } from "./lib/teamRow";
import {
  additionalSportIds,
  pagePlayerAliasRows,
  pagePlayerSportRows,
  playerSportRowsByName,
  syncPlayerAliases,
  syncPlayerSports,
} from "./players";
import { normalizeTeamAliasList, pageTeamAliasRows, syncTeamAliases } from "./teams";

// ─── Arming ────────────────────────────────────────────────────────────────

/** The exact string an armed run must carry in `confirm`. */
export const CONFIRM_PHRASE = "REKEY ENTITY NAMES";

/** The per-deployment arm. Only the literal `"true"` arms it. */
export const ENV_FLAG = "ALLOW_REKEY_ENTITY_NAMES";

function deploymentIsArmed(): boolean {
  return process.env[ENV_FLAG] === "true";
}

/**
 * FIXED text naming the flag. `ConvexError`, never a plain `Error`: production
 * Convex redacts a plain error's message, and the point of this refusal is to
 * say what to set.
 */
const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the entity-name re-key. Set ` +
  `${ENV_FLAG}=true on it (npx convex env set ${ENV_FLAG} true), re-run, and ` +
  `remove the flag afterwards. Nothing was written; "report" is what an armed ` +
  `run would have done.`;

/**
 * The first statement of every write mutation. The entry point checks the
 * flag too, but there is no identity anywhere under it (a CLI run carries
 * none), so the flag must sit next to the writes: a future internal caller
 * going straight to `applyPage` meets it there.
 */
function assertRekeyArmed(): void {
  if (!deploymentIsArmed()) {
    throw new ConvexError({ code: "REKEY_NOT_ARMED", message: NOT_ARMED_MESSAGE });
  }
}

const DRY_RUN_MESSAGE =
  `Dry run: nothing written. Arm with ${ENV_FLAG}=true on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_PHRASE}"} to apply.`;

const CONFIRM_MISMATCH_MESSAGE =
  `Dry run: nothing written. "confirm" was given but is not exactly ` +
  `"${CONFIRM_PHRASE}".`;

const PLAN_INCOMPLETE_MESSAGE =
  `Refused to write: the plan pass stopped at maxPages before walking every ` +
  `table, so the collision report is partial. Nothing was written. Re-run ` +
  `with a larger maxPages.`;

const APPLIED_MESSAGE =
  "Applied. Re-run without confirm to confirm every table reports toRekey: 0.";

const APPLY_INCOMPLETE_MESSAGE =
  "Partially applied: the apply pass stopped at maxPages. Re-run with confirm " +
  "and a larger maxPages; rows already re-keyed are skipped as unchanged.";

// ─── Budget ────────────────────────────────────────────────────────────────

/** Hard ceiling on any page, plan or apply. */
export const MAX_PAGE_SIZE = 500;

/** Plan pages: one indexed holder read per CHANGED row, nothing per unchanged one. */
export const DEFAULT_PLAN_PAGE_SIZE = 500;

/**
 * Plan pages for `players` and `playerSports`, whose changed rows read TWO
 * holder legs (`playerHoldersInSport`: the players identity index and the
 * `playerSports` index), plus a player get per membership found — and, for a
 * side row, its own player. A page of 250 changed rows is ~500-750 reads,
 * inside the ~900-op comfortable band; 500 would not be.
 */
export const DEFAULT_PLAYER_PLAN_PAGE_SIZE = 250;

function planPageSizeFor(table: RekeyTable): number {
  return table === "players" || table === "playerSports"
    ? DEFAULT_PLAYER_PLAN_PAGE_SIZE
    : DEFAULT_PLAN_PAGE_SIZE;
}

/**
 * Apply pages for tables whose writes fan out: a player patch is followed by
 * `syncPlayerSports` and `syncPlayerAliases` (a get and two or three indexed
 * reads plus their writes), a team patch by `syncTeamAliases`, and a side-table
 * row by its parent's writer. ~6-8 ops a row keeps 100 rows inside the ~900-op
 * comfortable band.
 */
export const DEFAULT_HEAVY_APPLY_PAGE_SIZE = 100;

/** Apply pages for single-patch tables (and one holder read for leagues/franchises). */
export const DEFAULT_LIGHT_APPLY_PAGE_SIZE = 500;

/** Pages per table per pass. Hitting it is `isComplete: false`, never a throw. */
export const DEFAULT_MAX_PAGES = 1000;

/** Every list in the report is capped here; the counts stay exact. */
export const REPORT_LIST_CAP = 200;

/** Old → new examples kept per table, so one big table cannot crowd out the rest. */
export const SAMPLES_PER_TABLE = 20;

/** Rows read per holder lookup. A group is reported, not resolved; 16 is plenty. */
const HOLDER_SCAN_LIMIT = 16;

function clampPageSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), MAX_PAGE_SIZE);
}

function clampMaxPages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_PAGES;
  return Math.max(Math.floor(value), 1);
}

// ─── Tables and policy ─────────────────────────────────────────────────────

/**
 * Walk order, which is also apply order: a parent before its side table, so a
 * re-keyed player has already rebuilt its own side rows by the time the side
 * table is walked (and the side walk only finds what the parent pass missed).
 */
export const REKEY_TABLES = [
  "players",
  "playerSports",
  "playerAliases",
  "teams",
  "teamAliases",
  "leagues",
  "franchises",
  "entityReviewSkips",
  "entityReviewQueue",
] as const;

export type RekeyTable = (typeof REKEY_TABLES)[number];

export const rekeyTableValidator = v.union(
  v.literal("players"),
  v.literal("playerSports"),
  v.literal("playerAliases"),
  v.literal("teams"),
  v.literal("teamAliases"),
  v.literal("leagues"),
  v.literal("franchises"),
  v.literal("entityReviewSkips"),
  v.literal("entityReviewQueue"),
);

type CollisionPolicy = "written" | "skipped" | "informational";

/** See "Collisions" in the module note. */
const COLLISION_POLICY: Record<RekeyTable, CollisionPolicy> = {
  players: "written",
  teams: "written",
  leagues: "skipped",
  franchises: "skipped",
  playerSports: "written",
  playerAliases: "informational",
  teamAliases: "informational",
  entityReviewSkips: "informational",
  entityReviewQueue: "informational",
};

const HEAVY_TABLES: ReadonlySet<RekeyTable> = new Set([
  "players",
  "playerSports",
  "playerAliases",
  "teams",
  "teamAliases",
]);

// ─── Validators ────────────────────────────────────────────────────────────

const holderValidator = v.object({
  /** The holder's entity id (player / team / league / ...). */
  id: v.string(),
  name: v.string(),
  /** Its stored key, which equals the group's new key. */
  oldKey: v.string(),
  /** Whether the holder is itself moving to another key. */
  changed: v.boolean(),
});

const changedRowValidator = v.object({
  /** The row this run would patch (or, for a side table, the stale index row). */
  rowId: v.string(),
  /** The entity reported: the row itself, or a side row's player/team. */
  entityId: v.string(),
  name: v.string(),
  oldKey: v.string(),
  /**
   * The recomputed key. `null` only for a stale ALIAS row whose replacement
   * cannot be told apart (it is rebuilt from the parent's alias list either
   * way).
   */
  newKey: v.union(v.string(), v.null()),
  /** Grouping scope: a sport id, or set/batch/kind for skips and the queue. */
  scopeKey: v.string(),
  /** The same scope for a human: sport label, or set label with ids. */
  scopeLabel: v.string(),
  /**
   * Other rows already stored under `newKey` in this scope, each flagged with
   * whether it is itself moving away (and so not really a clash).
   */
  holders: v.array(holderValidator),
});

const refusedRowValidator = v.object({
  table: rekeyTableValidator,
  rowId: v.string(),
  entityId: v.string(),
  name: v.string(),
  /**
   * `empty_key` — the name normalises to nothing; writing "" would make the
   *   row invisible to every lookup, so it keeps its old key.
   * `empty_name` — a team row with no name; `teamRowFields` refuses it.
   * `writer_refused` — the side-table writer threw (an alias list or a sport
   *   list past its cap, written around the editors). Fix the row by hand.
   */
  reason: v.union(
    v.literal("empty_key"),
    v.literal("empty_name"),
    v.literal("writer_refused"),
  ),
});

export const scanPageReturnValidator = v.object({
  scanned: v.number(),
  unchanged: v.number(),
  changed: v.array(changedRowValidator),
  refused: v.array(refusedRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

export const applyPageReturnValidator = v.object({
  scanned: v.number(),
  /** Rows re-keyed (main tables) or stale side rows rebuilt through the writer. */
  applied: v.number(),
  /** Leagues/franchises left on their old key because of a collision. */
  skippedCollision: v.number(),
  refused: v.array(refusedRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

const tableReportValidator = v.object({
  table: rekeyTableValidator,
  scanned: v.number(),
  unchanged: v.number(),
  /** Changed rows the apply pass will write (leagues/franchises: minus collisions). */
  toRekey: v.number(),
  /** Changed leagues/franchises left on their old key. Always 0 elsewhere. */
  skippedCollision: v.number(),
  /** Changed rows that cannot be written; listed in `refused`. */
  refused: v.number(),
  /** What the apply pass actually wrote. 0 on a dry run. */
  applied: v.number(),
  /** This table's walk(s) reached the end. */
  isComplete: v.boolean(),
});

const collisionValidator = v.object({
  table: rekeyTableValidator,
  /** Sport label, or the set (and batch) label for skips and the queue. */
  scope: v.string(),
  /** The shared new key. */
  key: v.string(),
  policy: v.union(v.literal("written"), v.literal("skipped"), v.literal("informational")),
  members: v.array(holderValidator),
});

const sampleValidator = v.object({
  table: rekeyTableValidator,
  id: v.string(),
  name: v.string(),
  oldKey: v.string(),
  newKey: v.union(v.string(), v.null()),
});

export const runReturnValidator = v.object({
  mode: v.union(v.literal("dry_run"), v.literal("applied")),
  /** True only when BOTH arms were present and the apply pass ran. */
  armed: v.boolean(),
  /** Every table's plan walk (and apply walk, if any) reached the end. */
  isComplete: v.boolean(),
  message: v.string(),
  tables: v.array(tableReportValidator),
  /** Exact number of collision groups; `collisions` is capped. */
  collisionCount: v.number(),
  collisions: v.array(collisionValidator),
  samples: v.array(sampleValidator),
  /**
   * Exact number of distinct (table, entity, reason) refusals across both
   * passes; `refused` is capped. Per-table `refused` counts ROWS instead.
   */
  refusedCount: v.number(),
  refused: v.array(refusedRowValidator),
});

type ChangedRow = Infer<typeof changedRowValidator>;
type RefusedRow = Infer<typeof refusedRowValidator>;
type Holder = Infer<typeof holderValidator>;
type ScanPageResult = Infer<typeof scanPageReturnValidator>;
type ApplyPageResult = Infer<typeof applyPageReturnValidator>;
type TableReport = Infer<typeof tableReportValidator>;
type Collision = Infer<typeof collisionValidator>;
type Sample = Infer<typeof sampleValidator>;
export type RekeyRunReport = Infer<typeof runReturnValidator>;

// ─── Per-row decisions (shared by plan and apply) ──────────────────────────

/**
 * What the current chain makes of one row. ONE decision per table, called by
 * both passes, so the apply pass can never write something the plan did not
 * describe (the `backfillBrandUnknownRole` planner rule).
 */
type Decision =
  | { status: "unchanged" }
  | { status: "refused"; reason: RefusedRow["reason"] }
  | { status: "changed"; newKey: string };

function decide(stored: string, newKey: string): Decision {
  if (stored === newKey) return { status: "unchanged" };
  if (newKey.length === 0) return { status: "refused", reason: "empty_key" };
  return { status: "changed", newKey };
}

/** `null` when `teamRowFields` refuses the row (an empty name). */
function teamKeyOf(row: Pick<Doc<"teams">, "name" | "location">): string | null {
  try {
    return teamRowFields({ name: row.name, location: row.location }).nameNormalized;
  } catch {
    return null;
  }
}

function decidePlayer(row: Doc<"players">): Decision {
  return decide(row.nameNormalized, normalizeEntityName(row.name));
}

function decideTeam(row: Doc<"teams">): Decision {
  const newKey = teamKeyOf(row);
  if (newKey === null) return { status: "refused", reason: "empty_name" };
  return decide(row.nameNormalized, newKey);
}

function decideLeague(row: Doc<"leagues">): Decision {
  return decide(row.nameNormalized, normalizeOrderedEntityName(row.name));
}

function decideFranchise(row: Doc<"franchises">): Decision {
  return decide(row.nameNormalized, normalizeEntityName(row.name));
}

function decideSkip(row: Doc<"entityReviewSkips">): Decision {
  return decide(row.nameNormalized, normalizeEntityName(row.name));
}

/**
 * Mirrors `keyFor` in `entityReviewQueue.startBatch`: players and teams take
 * the token-sorted key, leagues the ordered one. A row written before the
 * field existed has no key and is not this run's to invent.
 */
function queueKeyOf(row: Doc<"entityReviewQueue">): string {
  return row.kind === "league"
    ? normalizeOrderedEntityName(row.name)
    : normalizeEntityName(row.name);
}

function decideQueue(row: Doc<"entityReviewQueue">): Decision {
  if (row.nameNormalized === undefined) return { status: "unchanged" };
  return decide(row.nameNormalized, queueKeyOf(row));
}

/** A per-transaction memo, so a page with many rows per parent reads each parent once. */
function memo<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load(key);
      cache.set(key, hit);
    }
    return hit;
  };
}

type PlayerAliasContext = {
  player: Doc<"players">;
  /** `${sportId}|${aliasKey}` pairs `syncPlayerAliases` would keep. */
  wantedPairs: Set<string>;
  /** alias key → the raw alias that produces it. */
  wantedKeys: Map<string, string>;
};

/**
 * What `syncPlayerAliases` would keep for this player: every alias key, in the
 * home sport and every `playerSports` sport. Derived exactly the way the
 * writer derives it, so "stale" here is "the writer would delete it".
 */
async function loadPlayerAliasContext(
  ctx: QueryCtx | MutationCtx,
  playerId: Id<"players">,
): Promise<PlayerAliasContext | null> {
  const player = await ctx.db.get(playerId);
  if (!player) return null;
  const wantedKeys = new Map<string, string>();
  for (const alias of player.aliases ?? []) {
    const key = normalizeEntityName(alias);
    if (key && !wantedKeys.has(key)) wantedKeys.set(key, alias);
  }
  const sportIds = [player.sportId, ...(await additionalSportIds(ctx, playerId))];
  const wantedPairs = new Set<string>();
  for (const sportId of sportIds) {
    for (const key of wantedKeys.keys()) wantedPairs.add(`${sportId}|${key}`);
  }
  return { player, wantedPairs, wantedKeys };
}

type TeamAliasContext =
  | { team: Doc<"teams">; refused: false; wantedKeys: Map<string, string>; aliases: string[] }
  | { team: Doc<"teams">; refused: true };

/**
 * What `syncTeamAliases` would keep for this team when handed
 * `normalizeTeamAliasList(team.aliases, teamFullName(team))` — the list every
 * team writer passes it. An alias that now keys to the team's OWN name is
 * dropped by that list, and so is reported stale here.
 */
async function loadTeamAliasContext(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
): Promise<TeamAliasContext | null> {
  const team = await ctx.db.get(teamId);
  if (!team) return null;
  let aliases: string[];
  try {
    aliases = normalizeTeamAliasList(team.aliases ?? [], teamFullName(team));
  } catch {
    return { team, refused: true };
  }
  const wantedKeys = new Map<string, string>();
  for (const alias of aliases) {
    const key = normalizeEntityName(alias);
    if (key && !wantedKeys.has(key)) wantedKeys.set(key, alias);
  }
  return { team, refused: false, wantedKeys, aliases };
}

/**
 * For display only: which wanted key replaces a stale alias key. The join
 * changes spacing and order, never letters, so the replacement is the one
 * wanted key with the same multiset of characters. Ambiguous or absent is
 * `null` — the writer rebuilds the parent's rows from its list either way.
 */
function guessReplacementKey(oldKey: string, wanted: Iterable<string>): string | null {
  const signature = (key: string) => key.replace(/\s+/g, "").split("").sort().join("");
  const target = signature(oldKey);
  const matches = [...wanted].filter((key) => key !== oldKey && signature(key) === target);
  return matches.length === 1 ? matches[0] : null;
}

type PlayerSportDecision = Decision & { player?: Doc<"players"> };

async function decidePlayerSport(
  row: Doc<"playerSports">,
  getPlayer: (id: Id<"players">) => Promise<Doc<"players"> | null>,
): Promise<PlayerSportDecision> {
  const player = await getPlayer(row.playerId);
  // Orphan residue: readers already skip it, and nothing here deletes.
  if (!player) return { status: "unchanged" };
  return { ...decide(row.nameNormalized, normalizeEntityName(player.name)), player };
}

/**
 * Every OTHER player stored under `key` in `sportId`: home rows from the
 * players identity index, and players who also belong to the sport through a
 * `playerSports` row (NEO-313) — the two legs `sameNamePlayers` reads there,
 * minus its alias leg (an alias holder is a lookup-time question, not a key
 * collision). Deduped by player.
 *
 * `changed` says whether the holder is itself moving off `key`: a home row by
 * `decidePlayer`, a membership row by whether its stored copy is stale (the
 * apply pass rewrites it to the player's recomputed key).
 */
async function playerHoldersInSport(
  ctx: QueryCtx,
  key: string,
  sportId: Id<"selectorOptions">,
  self: Id<"players">,
  getPlayer: (id: Id<"players">) => Promise<Doc<"players"> | null>,
): Promise<Holder[]> {
  const holders = new Map<string, Holder>();
  const home = await ctx.db
    .query("players")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", key).eq("sportId", sportId),
    )
    .take(HOLDER_SCAN_LIMIT);
  for (const h of home) {
    if (h._id === self) continue;
    holders.set(h._id, {
      id: h._id,
      name: h.name,
      oldKey: h.nameNormalized,
      changed: decidePlayer(h).status !== "unchanged",
    });
  }
  // Through the owner module: `players.sportsIndexPin` flags any other module
  // that queries `playerSports`.
  for (const member of await playerSportRowsByName(ctx, key, sportId, HOLDER_SCAN_LIMIT)) {
    if (member.playerId === self || holders.has(member.playerId)) continue;
    const player = await getPlayer(member.playerId);
    // Orphan residue: readers already skip it.
    if (!player) continue;
    holders.set(member.playerId, {
      id: member.playerId,
      name: player.name,
      oldKey: member.nameNormalized,
      changed:
        decide(member.nameNormalized, normalizeEntityName(player.name)).status !== "unchanged",
    });
  }
  return [...holders.values()];
}

type AliasDecision =
  | { status: "unchanged" }
  | { status: "refused"; reason: RefusedRow["reason"]; entityName: string }
  | { status: "changed"; newKey: string | null; entityName: string; rawAlias: string | null };

async function decidePlayerAlias(
  row: Doc<"playerAliases">,
  getContext: (id: Id<"players">) => Promise<PlayerAliasContext | null>,
): Promise<AliasDecision> {
  const context = await getContext(row.playerId);
  if (!context) return { status: "unchanged" };
  if (context.wantedPairs.has(`${row.sportId}|${row.aliasNormalized}`)) {
    return { status: "unchanged" };
  }
  const newKey = guessReplacementKey(row.aliasNormalized, context.wantedKeys.keys());
  return {
    status: "changed",
    newKey,
    entityName: context.player.name,
    rawAlias: newKey === null ? null : (context.wantedKeys.get(newKey) ?? null),
  };
}

async function decideTeamAlias(
  row: Doc<"teamAliases">,
  getContext: (id: Id<"teams">) => Promise<TeamAliasContext | null>,
): Promise<AliasDecision> {
  const context = await getContext(row.teamId);
  if (!context) return { status: "unchanged" };
  const entityName = teamFullName(context.team);
  if (context.refused) {
    return { status: "refused", reason: "writer_refused", entityName };
  }
  // The writer keeps a row only for a wanted key AND the team's own sport.
  if (context.wantedKeys.has(row.aliasNormalized) && row.sportId === context.team.sportId) {
    return { status: "unchanged" };
  }
  const newKey = guessReplacementKey(row.aliasNormalized, context.wantedKeys.keys());
  return {
    status: "changed",
    newKey,
    entityName,
    rawAlias: newKey === null ? null : (context.wantedKeys.get(newKey) ?? null),
  };
}

// ─── Plan pass ─────────────────────────────────────────────────────────────

function sportLabeller(ctx: QueryCtx): (id: Id<"selectorOptions">) => Promise<string> {
  return memo(async (id: Id<"selectorOptions">) => {
    const row = await ctx.db.get(id);
    return row?.value ?? `(missing sport ${id})`;
  });
}

function setLabeller(ctx: QueryCtx): (id: Id<"selectorOptions">) => Promise<string> {
  return memo(async (id: Id<"selectorOptions">) => {
    const row = await ctx.db.get(id);
    return `${row?.value ?? "(missing set)"} (set ${id})`;
  });
}

/**
 * One page of one table, classified. Read-only and unarmed: a dry run must
 * work on any deployment. The holder lookups (rows that already carry a
 * changed row's new key) are one indexed read per CHANGED row, so a page of
 * unchanged rows costs the page and nothing else.
 */
export const scanPage = internalQuery({
  args: {
    table: rekeyTableValidator,
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  returns: scanPageReturnValidator,
  handler: async (ctx, args): Promise<ScanPageResult> => {
    const table = args.table;
    const numItems = clampPageSize(args.pageSize, planPageSizeFor(table));
    const cursor = args.cursor;
    const sportLabel = sportLabeller(ctx);
    const setLabel = setLabeller(ctx);

    const changed: ChangedRow[] = [];
    const refused: RefusedRow[] = [];
    let scanned = 0;
    let unchanged = 0;
    const refuse = (rowId: string, entityId: string, name: string, reason: RefusedRow["reason"]) =>
      refused.push({ table, rowId, entityId, name, reason });

    switch (table) {
      case "players": {
        const page = await ctx.db.query("players").paginate({ cursor, numItems });
        const getPlayer = memo((id: Id<"players">) => ctx.db.get(id));
        for (const row of page.page) {
          scanned += 1;
          const decision = decidePlayer(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: row.name,
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            // Home rows AND other players' memberships of the home sport.
            holders: await playerHoldersInSport(ctx, decision.newKey, row.sportId, row._id, getPlayer),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "teams": {
        const page = await ctx.db.query("teams").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideTeam(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, teamFullName(row), decision.reason); continue; }
          // Through the identity owner: this module must never read the team
          // identity index itself (teams.dedupPin). `findTeamsByExactName`
          // normalises the full name to exactly `decision.newKey`.
          const holders = await findTeamsByExactName(ctx, row.sportId, teamFullName(row));
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: teamFullName(row),
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: holders
              .filter((h) => h._id !== row._id)
              .map((h) => ({
                id: h._id,
                name: teamFullName(h),
                oldKey: h.nameNormalized,
                changed: decideTeam(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "leagues": {
        const page = await ctx.db.query("leagues").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideLeague(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          const holders = await ctx.db
            .query("leagues")
            .withIndex("by_name_normalized_and_sport_id", (q) =>
              q.eq("nameNormalized", decision.newKey).eq("sportId", row.sportId),
            )
            .take(HOLDER_SCAN_LIMIT);
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: row.name,
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: holders
              .filter((h) => h._id !== row._id)
              .map((h) => ({
                id: h._id,
                name: h.name,
                oldKey: h.nameNormalized,
                changed: decideLeague(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "franchises": {
        const page = await ctx.db.query("franchises").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideFranchise(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          const holders = await ctx.db
            .query("franchises")
            .withIndex("by_name_normalized_and_sport_id", (q) =>
              q.eq("nameNormalized", decision.newKey).eq("sportId", row.sportId),
            )
            .take(HOLDER_SCAN_LIMIT);
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: row.name,
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: holders
              .filter((h) => h._id !== row._id)
              .map((h) => ({
                id: h._id,
                name: h.name,
                oldKey: h.nameNormalized,
                changed: decideFranchise(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "entityReviewSkips": {
        const page = await ctx.db.query("entityReviewSkips").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideSkip(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          const holders = await ctx.db
            .query("entityReviewSkips")
            .withIndex("by_selector_option_and_kind_and_name", (q) =>
              q
                .eq("selectorOptionId", row.selectorOptionId)
                .eq("kind", row.kind)
                .eq("nameNormalized", decision.newKey),
            )
            .take(HOLDER_SCAN_LIMIT);
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: row.name,
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: `${row.selectorOptionId}|${row.kind}`,
            scopeLabel: `${await setLabel(row.selectorOptionId)}, ${row.kind}`,
            holders: holders
              .filter((h) => h._id !== row._id)
              .map((h) => ({
                id: h._id,
                name: h.name,
                oldKey: h.nameNormalized,
                changed: decideSkip(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "entityReviewQueue": {
        const page = await ctx.db.query("entityReviewQueue").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideQueue(row);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          const holders = await ctx.db
            .query("entityReviewQueue")
            .withIndex("by_batch_and_kind_and_name", (q) =>
              q
                .eq("selectorOptionId", row.selectorOptionId)
                .eq("batchId", row.batchId)
                .eq("kind", row.kind)
                .eq("nameNormalized", decision.newKey),
            )
            .take(HOLDER_SCAN_LIMIT);
          changed.push({
            rowId: row._id,
            entityId: row._id,
            name: row.name,
            // `decideQueue` returns "unchanged" for a row without a key.
            oldKey: row.nameNormalized ?? "",
            newKey: decision.newKey,
            scopeKey: `${row.selectorOptionId}|${row.batchId}|${row.kind}`,
            scopeLabel: `${await setLabel(row.selectorOptionId)}, batch ${row.batchId}, ${row.kind}`,
            holders: holders
              .filter((h) => h._id !== row._id)
              .map((h) => ({
                id: h._id,
                name: h.name,
                oldKey: h.nameNormalized ?? "",
                changed: decideQueue(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "playerSports": {
        const page = await pagePlayerSportRows(ctx, cursor, numItems);
        const getPlayer = memo((id: Id<"players">) => ctx.db.get(id));
        for (const row of page.page) {
          scanned += 1;
          const decision = await decidePlayerSport(row, getPlayer);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          const name = decision.player?.name ?? "";
          if (decision.status === "refused") { refuse(row._id, row.playerId, name, decision.reason); continue; }
          // The re-keyed player, in this EXTRA sport: who else answers to the
          // new key here. Grouped with the `players` rows of this sport
          // (`collisionTableOf`), so it meets a re-keyed home row too.
          changed.push({
            rowId: row._id,
            entityId: row.playerId,
            name,
            oldKey: row.nameNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: await playerHoldersInSport(ctx, decision.newKey, row.sportId, row.playerId, getPlayer),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "playerAliases": {
        const page = await pagePlayerAliasRows(ctx, cursor, numItems);
        const getContext = memo((id: Id<"players">) => loadPlayerAliasContext(ctx, id));
        for (const row of page.page) {
          scanned += 1;
          const decision = await decidePlayerAlias(row, getContext);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row.playerId, decision.entityName, decision.reason); continue; }
          // Informational: another player whose PRIMARY name is this alias in
          // this sport. (Alias-on-alias overlap is the wizard's question to
          // ask at lookup time, not this report's.)
          const newKey = decision.newKey;
          const holders =
            newKey === null
              ? []
              : await ctx.db
                  .query("players")
                  .withIndex("by_name_normalized_and_sport_id", (q) =>
                    q.eq("nameNormalized", newKey).eq("sportId", row.sportId),
                  )
                  .take(HOLDER_SCAN_LIMIT);
          changed.push({
            rowId: row._id,
            entityId: row.playerId,
            name: decision.entityName,
            oldKey: row.aliasNormalized,
            newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: holders
              .filter((h) => h._id !== row.playerId)
              .map((h) => ({
                id: h._id,
                name: h.name,
                oldKey: h.nameNormalized,
                changed: decidePlayer(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "teamAliases": {
        const page = await pageTeamAliasRows(ctx, cursor, numItems);
        const getContext = memo((id: Id<"teams">) => loadTeamAliasContext(ctx, id));
        for (const row of page.page) {
          scanned += 1;
          const decision = await decideTeamAlias(row, getContext);
          if (decision.status === "unchanged") { unchanged += 1; continue; }
          if (decision.status === "refused") { refuse(row._id, row.teamId, decision.entityName, decision.reason); continue; }
          // Informational: another team whose primary name is this alias.
          // Looked up by the RAW alias through the identity owner, never by
          // re-normalising a key (the key is not a name).
          const holders =
            decision.rawAlias === null
              ? []
              : await findTeamsByExactName(ctx, row.sportId, decision.rawAlias);
          changed.push({
            rowId: row._id,
            entityId: row.teamId,
            name: decision.entityName,
            oldKey: row.aliasNormalized,
            newKey: decision.newKey,
            scopeKey: row.sportId,
            scopeLabel: await sportLabel(row.sportId),
            holders: holders
              .filter((h) => h._id !== row.teamId)
              .map((h) => ({
                id: h._id,
                name: teamFullName(h),
                oldKey: h.nameNormalized,
                changed: decideTeam(h).status !== "unchanged",
              })),
          });
        }
        return { scanned, unchanged, changed, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }
    }
  },
});

// ─── Apply pass ────────────────────────────────────────────────────────────

/**
 * Is `newKey` already held, in this sport, by a league/franchise that is
 * staying on it? The apply-time twin of the plan's grouping, for the race
 * where an operator saved a row between the two passes. A holder that is
 * itself moving away does not count, exactly as in the plan.
 */
async function stableLeagueHolderExists(
  ctx: MutationCtx,
  row: Doc<"leagues">,
  newKey: string,
): Promise<boolean> {
  const holders = await ctx.db
    .query("leagues")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", newKey).eq("sportId", row.sportId),
    )
    .take(HOLDER_SCAN_LIMIT);
  return holders.some((h) => h._id !== row._id && decideLeague(h).status === "unchanged");
}

async function stableFranchiseHolderExists(
  ctx: MutationCtx,
  row: Doc<"franchises">,
  newKey: string,
): Promise<boolean> {
  const holders = await ctx.db
    .query("franchises")
    .withIndex("by_name_normalized_and_sport_id", (q) =>
      q.eq("nameNormalized", newKey).eq("sportId", row.sportId),
    )
    .take(HOLDER_SCAN_LIMIT);
  return holders.some((h) => h._id !== row._id && decideFranchise(h).status === "unchanged");
}

/**
 * One page of one table, re-decided live and written. Asserts the arm as its
 * first statement; `confirm` must be exactly `CONFIRM_PHRASE` or the validator
 * rejects the call before the handler runs. `skipIds` carries the plan's
 * colliding league/franchise rows; it is ignored for every other table (their
 * policy is to write).
 *
 * Only derived keys are written. A name, an alias list, a marketplace field or
 * `lastUpdated` is never touched: a re-key is not an edit.
 */
export const applyPage = internalMutation({
  args: {
    confirm: v.literal(CONFIRM_PHRASE),
    table: rekeyTableValidator,
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
    skipIds: v.optional(v.array(v.string())),
  },
  returns: applyPageReturnValidator,
  handler: async (ctx, args): Promise<ApplyPageResult> => {
    assertRekeyArmed();

    const table = args.table;
    const cursor = args.cursor;
    const numItems = clampPageSize(
      args.pageSize,
      HEAVY_TABLES.has(table) ? DEFAULT_HEAVY_APPLY_PAGE_SIZE : DEFAULT_LIGHT_APPLY_PAGE_SIZE,
    );
    const skip = new Set(args.skipIds ?? []);
    const refused: RefusedRow[] = [];
    let scanned = 0;
    let applied = 0;
    let skippedCollision = 0;
    const refuse = (rowId: string, entityId: string, name: string, reason: RefusedRow["reason"]) =>
      refused.push({ table, rowId, entityId, name, reason });

    /** Rebuild one player's side rows through their single writers. */
    const resyncPlayer = async (playerId: Id<"players">, name: string): Promise<boolean> => {
      try {
        await syncPlayerSports(ctx, playerId, await additionalSportIds(ctx, playerId));
      } catch {
        // Throws before writing (a missing player, or a sport list past its
        // cap written around the editor). Reported, never fatal to the page.
        refuse(playerId, playerId, name, "writer_refused");
        return false;
      }
      await syncPlayerAliases(ctx, { playerId });
      return true;
    };

    /** Rebuild one team's alias rows through `syncTeamAliases`. */
    const resyncTeam = async (team: Doc<"teams">): Promise<boolean> => {
      let aliases: string[];
      try {
        aliases = normalizeTeamAliasList(team.aliases ?? [], teamFullName(team));
      } catch {
        refuse(team._id, team._id, teamFullName(team), "writer_refused");
        return false;
      }
      await syncTeamAliases(ctx, { teamId: team._id, sportId: team.sportId, aliases });
      return true;
    };

    switch (table) {
      case "players": {
        const page = await ctx.db.query("players").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decidePlayer(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
          // After the patch, so `syncPlayerSports` copies the NEW key onto
          // every extra-sport row (it reads the row inside this transaction).
          await resyncPlayer(row._id, row.name);
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "teams": {
        const page = await ctx.db.query("teams").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideTeam(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, teamFullName(row), decision.reason); continue; }
          // Only the key: `teamRowFields` also trims the name, and a re-key
          // never renames a row.
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
          await resyncTeam(row);
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "leagues": {
        const page = await ctx.db.query("leagues").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideLeague(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          if (skip.has(row._id) || (await stableLeagueHolderExists(ctx, row, decision.newKey))) {
            skippedCollision += 1;
            continue;
          }
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "franchises": {
        const page = await ctx.db.query("franchises").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideFranchise(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          if (skip.has(row._id) || (await stableFranchiseHolderExists(ctx, row, decision.newKey))) {
            skippedCollision += 1;
            continue;
          }
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "entityReviewSkips": {
        const page = await ctx.db.query("entityReviewSkips").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideSkip(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "entityReviewQueue": {
        const page = await ctx.db.query("entityReviewQueue").paginate({ cursor, numItems });
        for (const row of page.page) {
          scanned += 1;
          const decision = decideQueue(row);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row._id, row.name, decision.reason); continue; }
          await ctx.db.patch(row._id, { nameNormalized: decision.newKey });
          applied += 1;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "playerSports": {
        const page = await pagePlayerSportRows(ctx, cursor, numItems);
        const getPlayer = memo((id: Id<"players">) => ctx.db.get(id));
        const stale = new Map<Id<"players">, { name: string; rows: number }>();
        for (const row of page.page) {
          scanned += 1;
          const decision = await decidePlayerSport(row, getPlayer);
          if (decision.status === "unchanged") continue;
          const name = decision.player?.name ?? "";
          if (decision.status === "refused") { refuse(row._id, row.playerId, name, decision.reason); continue; }
          const entry = stale.get(row.playerId) ?? { name, rows: 0 };
          entry.rows += 1;
          stale.set(row.playerId, entry);
        }
        // After the loop, never inside it: the writer rewrites every row of the
        // player, including rows later in this page.
        for (const [playerId, entry] of stale) {
          if (await resyncPlayer(playerId, entry.name)) applied += entry.rows;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "playerAliases": {
        const page = await pagePlayerAliasRows(ctx, cursor, numItems);
        const getContext = memo((id: Id<"players">) => loadPlayerAliasContext(ctx, id));
        const stale = new Map<Id<"players">, number>();
        for (const row of page.page) {
          scanned += 1;
          const decision = await decidePlayerAlias(row, getContext);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row.playerId, decision.entityName, decision.reason); continue; }
          stale.set(row.playerId, (stale.get(row.playerId) ?? 0) + 1);
        }
        for (const [playerId, rows] of stale) {
          await syncPlayerAliases(ctx, { playerId });
          applied += rows;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }

      case "teamAliases": {
        const page = await pageTeamAliasRows(ctx, cursor, numItems);
        const getContext = memo((id: Id<"teams">) => loadTeamAliasContext(ctx, id));
        const stale = new Map<Id<"teams">, { team: Doc<"teams">; rows: number }>();
        for (const row of page.page) {
          scanned += 1;
          const decision = await decideTeamAlias(row, getContext);
          if (decision.status === "unchanged") continue;
          if (decision.status === "refused") { refuse(row._id, row.teamId, decision.entityName, decision.reason); continue; }
          const context = await getContext(row.teamId);
          if (!context) continue;
          const entry = stale.get(row.teamId) ?? { team: context.team, rows: 0 };
          entry.rows += 1;
          stale.set(row.teamId, entry);
        }
        for (const entry of stale.values()) {
          if (await resyncTeam(entry.team)) applied += entry.rows;
        }
        return { scanned, applied, skippedCollision, refused, isDone: page.isDone, continueCursor: page.continueCursor };
      }
    }
  },
});

// ─── Report assembly (pure) ────────────────────────────────────────────────

type PlannedRow = ChangedRow & { table: RekeyTable };

/**
 * The table a planned row COLLIDES as. A `playerSports` row is its player's
 * key in another sport, so it groups with that sport's `players` rows: a
 * player re-keyed at home and another re-keyed through a membership, landing
 * on one key in one sport, are one group, reported as `players`.
 */
export function collisionTableOf(table: RekeyTable): RekeyTable {
  return table === "playerSports" ? "players" : table;
}

/**
 * Group every changed row by (collision table, scope, new key) and keep the groups with
 * two or more DISTINCT entities: the changed rows that land there, plus the
 * unchanged rows that already hold the key. A holder that is itself moving
 * away is left out — it shows up in its own group, under its own new key.
 *
 * Members are deduped by entity, so a player's two stale alias rows landing
 * on one key are one member, not a collision with itself.
 */
export function buildCollisionGroups(rows: readonly PlannedRow[]): Collision[] {
  const groups = new Map<string, { table: RekeyTable; scope: string; key: string; members: Map<string, Holder> }>();
  for (const row of rows) {
    if (row.newKey === null) continue;
    const table = collisionTableOf(row.table);
    const groupKey = `${table}\u0000${row.scopeKey}\u0000${row.newKey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { table, scope: row.scopeLabel, key: row.newKey, members: new Map() };
      groups.set(groupKey, group);
    }
    group.members.set(row.entityId, {
      id: row.entityId,
      name: row.name,
      oldKey: row.oldKey,
      changed: true,
    });
    for (const holder of row.holders) {
      if (holder.changed) continue;
      if (!group.members.has(holder.id)) group.members.set(holder.id, holder);
    }
  }
  const out: Collision[] = [];
  for (const group of groups.values()) {
    if (group.members.size < 2) continue;
    out.push({
      table: group.table,
      scope: group.scope,
      key: group.key,
      policy: COLLISION_POLICY[group.table],
      members: [...group.members.values()],
    });
  }
  return out;
}

/**
 * The changed league/franchise rows that sit in a collision group, by table.
 * For those tables a member's entity id IS its row id, and only the CHANGED
 * members are skipped: an unchanged holder is not being written anyway.
 */
function collisionSkipIds(collisions: readonly Collision[]): Map<RekeyTable, Set<string>> {
  const out = new Map<RekeyTable, Set<string>>();
  for (const collision of collisions) {
    if (collision.policy !== "skipped") continue;
    const ids = out.get(collision.table) ?? new Set<string>();
    for (const member of collision.members) {
      if (member.changed) ids.add(member.id);
    }
    out.set(collision.table, ids);
  }
  return out;
}

/**
 * Refused rows, deduped by (table, entity, reason) across both passes: the
 * apply pass re-decides every row and would otherwise list a plan-time refusal
 * twice, and a team with a refused alias list would otherwise appear once per
 * alias row. The count is exact; the list is capped.
 */
function refusedCollector(): {
  add: (rows: readonly RefusedRow[]) => void;
  count: () => number;
  list: () => RefusedRow[];
} {
  const seen = new Set<string>();
  const list: RefusedRow[] = [];
  return {
    add: (rows) => {
      for (const row of rows) {
        const key = `${row.table}\u0000${row.entityId}\u0000${row.reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (list.length < REPORT_LIST_CAP) list.push(row);
      }
    },
    count: () => seen.size,
    list: () => list,
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * The ONLY entry point. Plans every table (always), then — with the confirm
 * phrase AND the deployment flag — applies, table by table in walk order.
 *
 * Returns the report on a dry run and on an applied run. Throws a
 * `ConvexError` with data `{ code: "REKEY_NOT_ARMED", message, report }` when
 * the phrase is right but the deployment is not armed.
 */
export const run = internalAction({
  args: {
    /** Exactly "REKEY ENTITY NAMES" to write. Anything else is a dry run. */
    confirm: v.optional(v.string()),
    /**
     * Overrides EVERY page size, plan and apply (clamped to [1, 500]).
     * Omitted: 500 for plan pages (250 for players and playerSports) and
     * single-patch tables, 100 for players, teams and the side tables on
     * apply.
     */
    pageSize: v.optional(v.number()),
    /** Pages per table per pass (default 1000). */
    maxPages: v.optional(v.number()),
  },
  returns: runReturnValidator,
  handler: async (ctx, args): Promise<RekeyRunReport> => {
    const intendsToWrite = args.confirm === CONFIRM_PHRASE;
    const confirmMismatch = args.confirm !== undefined && !intendsToWrite;
    const maxPages = clampMaxPages(args.maxPages);

    // ── Plan ──
    const reports = new Map<RekeyTable, TableReport>();
    const planned: PlannedRow[] = [];
    const refused = refusedCollector();
    const samples: Sample[] = [];
    let planComplete = true;

    for (const table of REKEY_TABLES) {
      const report: TableReport = {
        table,
        scanned: 0,
        unchanged: 0,
        toRekey: 0,
        skippedCollision: 0,
        refused: 0,
        applied: 0,
        isComplete: false,
      };
      let tableSamples = 0;
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page: ScanPageResult = await ctx.runQuery(internal.rekeyEntityNames.scanPage, {
          table,
          cursor,
          pageSize: clampPageSize(args.pageSize, planPageSizeFor(table)),
        });
        report.scanned += page.scanned;
        report.unchanged += page.unchanged;
        report.refused += page.refused.length;
        refused.add(page.refused);
        for (const row of page.changed) {
          planned.push({ ...row, table });
          if (tableSamples < SAMPLES_PER_TABLE && samples.length < REPORT_LIST_CAP) {
            samples.push({ table, id: row.entityId, name: row.name, oldKey: row.oldKey, newKey: row.newKey });
            tableSamples += 1;
          }
        }
        if (page.isDone) {
          report.isComplete = true;
          break;
        }
        cursor = page.continueCursor;
      }
      if (!report.isComplete) planComplete = false;
      reports.set(table, report);
    }

    const collisions = buildCollisionGroups(planned);
    const skipIds = collisionSkipIds(collisions);
    for (const row of planned) {
      const report = reports.get(row.table)!;
      if (skipIds.get(row.table)?.has(row.rowId)) report.skippedCollision += 1;
      else report.toRekey += 1;
    }

    const assemble = (
      mode: RekeyRunReport["mode"],
      armed: boolean,
      isComplete: boolean,
      message: string,
    ): RekeyRunReport => ({
      mode,
      armed,
      isComplete,
      message,
      tables: REKEY_TABLES.map((t) => ({ ...reports.get(t)! })),
      collisionCount: collisions.length,
      collisions: collisions.slice(0, REPORT_LIST_CAP),
      samples,
      refusedCount: refused.count(),
      refused: [...refused.list()],
    });

    const log = (result: RekeyRunReport, refusedForFlag: boolean) =>
      // Counts only: no names, no keys. This runs against production and the
      // log is not the place for operator content.
      console.log(
        JSON.stringify({
          msg: "rekey_entity_names",
          mode: result.mode,
          armed: result.armed,
          refusedForFlag,
          isComplete: result.isComplete,
          collisionCount: result.collisionCount,
          refusedCount: result.refusedCount,
          tables: result.tables,
        }),
      );

    if (!intendsToWrite) {
      const result = assemble(
        "dry_run",
        false,
        planComplete,
        confirmMismatch ? CONFIRM_MISMATCH_MESSAGE : DRY_RUN_MESSAGE,
      );
      log(result, false);
      return result;
    }

    if (!deploymentIsArmed()) {
      const report = assemble("dry_run", false, planComplete, NOT_ARMED_MESSAGE);
      log(report, true);
      throw new ConvexError({ code: "REKEY_NOT_ARMED", message: NOT_ARMED_MESSAGE, report });
    }

    if (!planComplete) {
      const result = assemble("dry_run", false, false, PLAN_INCOMPLETE_MESSAGE);
      log(result, false);
      return result;
    }

    // ── Apply ──
    let applyComplete = true;
    for (const table of REKEY_TABLES) {
      const report = reports.get(table)!;
      const tableSkipIds = [...(skipIds.get(table) ?? [])];
      let cursor: string | null = null;
      let done = false;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page: ApplyPageResult = await ctx.runMutation(internal.rekeyEntityNames.applyPage, {
          confirm: CONFIRM_PHRASE,
          table,
          cursor,
          ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
          ...(tableSkipIds.length > 0 ? { skipIds: tableSkipIds } : {}),
        });
        report.applied += page.applied;
        // Only a writer refusing a side rebuild is new here; the collector
        // drops the plan-time refusals the apply pass re-decides.
        refused.add(page.refused);
        if (page.isDone) {
          done = true;
          break;
        }
        cursor = page.continueCursor;
      }
      if (!done) {
        report.isComplete = false;
        applyComplete = false;
      }
    }

    const result = assemble(
      "applied",
      true,
      applyComplete,
      applyComplete ? APPLIED_MESSAGE : APPLY_INCOMPLETE_MESSAGE,
    );
    log(result, false);
    return result;
  },
});
