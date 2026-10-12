/**
 * NEO-339 — the entity-review decisions, as plain functions.
 *
 * Moved out of `EntityReviewWizard` (and the team draft out of `NewTeamForm`)
 * with no change in behaviour, so the wizard and the set-building tool
 * (`tools/setbuild/`) record the SAME `recordDecision` arguments and stage the
 * same rows. The wizard keeps the walk, the focus handling and the forms; what
 * it sends lives here.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";
import type { LeagueLevel } from "../../convex/leagues";
import { splitTeamName, teamFullName } from "../teams/team-name";

type ReviewRowId = Id<"entityReviewQueue">;

// ===== THE NEW TEAM DRAFT (moved from NewTeamForm) =====

/** The answer this form collects. Empty strings, not undefined — these are
 *  controlled inputs, and a blank Location is a real answer. */
export type NewTeamDraft = {
  location: string;
  name: string;
  /**
   * The league the operator picked, as one of three states that the server
   * treats differently:
   *   - a league id — this existing league;
   *   - `null` — no league, said deliberately;
   *   - `undefined` — not answered: the wizard's commit falls back to the
   *     lookup's suggested league (the one this field shows as its answer),
   *     and with no suggestion the team gets no league. The sport default is
   *     never applied (NEO-331).
   * The form only ever produces the first two once it has rendered; `undefined`
   * is the initial value a host may seed it with.
   */
  leagueId: Id<"leagues"> | null | undefined;
  /**
   * A league to CREATE, by name — the "we don't hold this one yet" answer. Set
   * by picking the suggestion's "Create <name>", a league this batch staged, or
   * a typed name the wizard staged; mutually exclusive with `leagueId`, which
   * `pick` enforces by clearing it.
   */
  leagueName: string | undefined;
  /**
   * NEO-254 — the years this team played, when the operator knows them.
   *
   * Load-bearing for identity, not decoration. A sport can hold two teams under
   * one name — the 1972-1996 Winnipeg Jets and the 2011- Jets — and the era is
   * the only thing that tells them apart, so it is what decides whether
   * creating finds the row we hold or makes a second one beside it.
   *
   * Optional, and stays optional: most teams are created without anybody
   * knowing or caring, and an undated row is a normal row. It matters exactly
   * when the name is already taken, which is when the form asks for it.
   */
  yearsActive?: { from: number; to?: number };
  /**
   * NEO-284 — other names this team answers to, comma-separated exactly as
   * the League forms take theirs (`parseAliases` in `NewLeagueForm` turns it
   * into the list). A string rather than a list because it is a box the
   * operator is typing into; the host parses it once, at create.
   *
   * Empty string, not undefined: a controlled input, and "no aliases" is a
   * real answer.
   */
  aliases: string;
};

/**
 * What the form shows before the operator touches anything.
 *
 * `location` splits off the front of `name` only when the enrichment supplied
 * one AND it is a whole-word prefix: "San Diego" off "San Diego Padres" splits,
 * "Anaheim" off "Los Angeles Angels" does not, and neither does "Sa".
 *
 * The league is left for {@link resolveLeagueSuggestion} to settle against the
 * sport's real rows, because "the lookup said Australian Baseball League" and
 * "we hold a row called that" are different facts and only the second one can
 * be pre-selected.
 */
export function newTeamPrefill(input: {
  name: string;
  location?: string;
}): NewTeamDraft {
  const split = input.location
    ? splitTeamName(input.name, input.location)
    : null;
  return {
    location: split ? split.location : "",
    name: split ? split.name : input.name.trim(),
    leagueId: undefined,
    leagueName: undefined,
    aliases: "",
  };
}

/**
 * NEO-236 — what the Location + Name pair shows for a team row before the
 * operator touches it.
 *
 * Location is pre-filled ONLY from an ESPN location the lookup actually
 * returned, and only when `splitTeamName` finds it as a whole-word prefix of
 * the reviewed name: "San Diego" off "San Diego Padres" splits, "Anaheim" off
 * "Los Angeles Angels" does not, and neither does "Sa". Everything else starts
 * with a blank Location and the whole reviewed name in Name — byte-for-byte
 * how these rows were created before the split existed, and the operator's cue
 * to split it themselves. A blank Location is the FINAL answer only for a name
 * that carries no place at all ("Athletics", "Orix Buffaloes"); a college
 * side's location is its school ("San Diego State" / "Aztecs").
 *
 * There is no first-token heuristic here and there must never be one: NB has
 * no code path that guesses a location without a source. The operator is the
 * fallback.
 *
 * Mirrored server-side by `prefilledTeamCreate` in convex/entityReviewQueue.ts,
 * which is what "Add All Remaining as New" writes for a team row — so
 * confirming one row and confirming the batch mean the same thing.
 */
export function teamCreatePrefill(row: {
  name: string;
  enrichment?: { location?: string } | null;
}): NewTeamDraft {
  return newTeamPrefill({
    name: row.name,
    ...(row.enrichment?.location ? { location: row.enrichment.location } : {}),
  });
}

// ===== DECISIONS =====

/** One hand-typed career team, as `CareerTeamEntry` collects it. */
export type ManualCareerTeam = {
  name: string;
  fromYear: number;
  toYear?: number;
};

/**
 * What "Add as New" carries for a row, by kind. See `buildCreateDecision`.
 */
export type CreateDecisionPayload = {
  manualCareerTeams?: ManualCareerTeam[];
  excludedCareerTeamNames?: string[];
  create?: {
    location?: string;
    name: string;
    leagueId?: Id<"leagues"> | null;
    leagueName?: string;
    // NEO-254 — see `teamCreateValidator`.
    yearsActive?: { from: number; to?: number };
    // NEO-284 — the other names, already parsed. See `NewTeamDraft`.
    aliases?: string[];
  };
  // NEO-254 — league-kind only. See `NewLeagueForm`.
  createLeague?: {
    name: string;
    abbreviation?: string;
    // NEO-331 — required, as on every league create.
    level: LeagueLevel;
    yearsActive?: { from: number; to?: number };
    aliases?: string[];
    wikidataId?: string;
  };
  // NEO-313 — player rows only. See `addSetSportByRow`.
  addSetSport?: boolean;
};

/** `entityReviewQueue.recordDecision`'s arguments, as the wizard sends them. */
export type RecordDecisionArgs = {
  reviewRowId: ReviewRowId;
  action: "create" | "link" | "skip";
  linkedPlayerId?: Id<"players">;
  linkedTeamId?: Id<"teams">;
  linkedLeagueId?: Id<"leagues">;
  manualCareerTeams?: Array<{ name: string; fromYear: number; toYear?: number }>;
  excludedCareerTeamNames?: string[];
  create?: CreateDecisionPayload["create"];
  createLeague?: CreateDecisionPayload["createLeague"];
  saveAsAlias?: boolean;
  addSetSport?: boolean;
};

/**
 * NEO-236 — one create decision, built from whatever the current row's kind
 * actually needs.
 *
 * A TEAM row carries `create`: the Location, Name and League the commit
 * prelude builds the row from, and the ONLY thing it will build one from.
 *
 * A PLAYER row carries only its stints and its exclusions. The `createTeams`
 * list it used to carry is gone — every career team that needs creating has
 * a review row of its own now, and recording the answer in two places is how
 * the two end up disagreeing.
 *
 * `manualCareerTeams` carries FULL names, because that is what the prelude
 * looks up against `teams`.
 *
 * Moved verbatim from the wizard's `handleCreate`, which now sends this.
 */
export function buildCreateDecision(
  reviewRowId: ReviewRowId,
  payload: CreateDecisionPayload = {},
): RecordDecisionArgs {
  return {
    reviewRowId,
    action: "create",
    manualCareerTeams: payload.manualCareerTeams?.length
      ? payload.manualCareerTeams.map((ct) => ({
          name: teamFullName(ct),
          fromYear: ct.fromYear,
          ...(ct.toYear !== undefined ? { toYear: ct.toYear } : {}),
        }))
      : undefined,
    excludedCareerTeamNames: payload.excludedCareerTeamNames?.length
      ? payload.excludedCareerTeamNames
      : undefined,
    create: payload.create,
    createLeague: payload.createLeague,
    ...(payload.addSetSport ? { addSetSport: true } : {}),
  };
}

/**
 * One link decision. Moved verbatim from the wizard's `handleLink`, which now
 * sends this.
 *
 * `options.saveAsAlias` is NEO-284, team rows only: whether commit should keep
 * this row's raw name as an alias of the linked team. Read off the checkbox by
 * every team link path (footer primary, near-match row, link search) so the
 * three cannot disagree. Omitted entirely for players and leagues — the server
 * refuses it on any other kind.
 */
export function buildLinkDecision(
  reviewRowId: ReviewRowId,
  kind: "player" | "team" | "league",
  linkedId: Id<"players"> | Id<"teams"> | Id<"leagues">,
  options: { saveAsAlias?: boolean; addSetSport?: boolean } = {},
): RecordDecisionArgs {
  return {
    reviewRowId,
    action: "link",
    linkedPlayerId: kind === "player" ? (linkedId as Id<"players">) : undefined,
    linkedTeamId: kind === "team" ? (linkedId as Id<"teams">) : undefined,
    // NEO-254 — every team in the batch that named this league then uses
    // the linked row rather than creating anything.
    linkedLeagueId: kind === "league" ? (linkedId as Id<"leagues">) : undefined,
    ...(kind === "team" && options.saveAsAlias !== undefined
      ? { saveAsAlias: options.saveAsAlias }
      : {}),
    // NEO-313 — only ever `true`, and only for a player.
    ...(kind === "player" && options.addSetSport ? { addSetSport: true } : {}),
  };
}

// ===== STAGING =====

/** One staging call the wizard makes, with the arguments it sends. */
export type StagingCall =
  | {
      mutation: "stageCareerTeamRows";
      args: { reviewRowId: ReviewRowId };
    }
  | {
      mutation: "stageLeagueRows";
      args: { reviewRowId: ReviewRowId; leagueName: string };
    };

/**
 * NEO-236 / NEO-254 — the staging the wizard does on its own, for one row.
 *
 * Two rules, both moved from the wizard:
 *
 *  - CAREER TEAMS (the belt-and-braces pass). An undecided PLAYER row whose
 *    enrichment carries career teams, not yet staged this session
 *    (`opts.alreadyStaged`, keyed on the row id), stages them with
 *    `stageCareerTeamRows({ reviewRowId })`. `applyLookupResult` normally
 *    stages them the moment the enrichment lands; this covers a batch whose
 *    lookups landed before that shipped, and a row whose enrichment arrived by
 *    another route. On an ordinary row it is one idempotent call that inserts
 *    nothing.
 *  - LEAGUE. A TEAM row whose New Team form names a league to create
 *    (`opts.leagueName`, non-blank) stages that league with
 *    `stageLeagueRows({ reviewRowId, leagueName })` — a typed league is a
 *    commitment, so it raises its step the moment it is made.
 *
 * Both server calls are idempotent; the result is what to send, in order.
 */
export function planStaging(
  row: {
    _id: ReviewRowId;
    kind: string;
    decision?: unknown;
    enrichment?: { careerTeams?: readonly unknown[] } | null;
  },
  opts: { alreadyStaged?: ReadonlySet<string>; leagueName?: string } = {},
): StagingCall[] {
  const calls: StagingCall[] = [];
  if (
    row.kind === "player" &&
    !row.decision &&
    (row.enrichment?.careerTeams?.length ?? 0) > 0 &&
    !opts.alreadyStaged?.has(row._id)
  ) {
    calls.push({
      mutation: "stageCareerTeamRows",
      args: { reviewRowId: row._id },
    });
  }
  if (row.kind === "team" && opts.leagueName?.trim()) {
    calls.push({
      mutation: "stageLeagueRows",
      args: { reviewRowId: row._id, leagueName: opts.leagueName },
    });
  }
  return calls;
}
