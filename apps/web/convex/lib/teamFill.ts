/**
 * NEO-335 — one player's team, from evidence the set and the player row
 * already hold. Feeds `cardChecklist.teamSuggestionsForPreview`, which the
 * entity review wizard's final step reads to pre-fill "K cards have no team
 * yet" BEFORE the cards are saved.
 *
 * ## History
 *
 * This module used to be NEO-279's set-wide "Fill teams" planner: a PLAN over
 * every teamless card under a set, applied after an operator confirmed its
 * counts. NEO-335 retired that surface (the answer now comes in the wizard,
 * before save) and kept the tiers, trimmed to the one question the wizard
 * asks: "for THIS player, on a card in THIS node, is there exactly one team?"
 *
 * ## Suggestions, never writes
 *
 * Nothing here writes. The wizard shows the answer as a pre-filled choice on
 * the screen the operator saves from; the operator can change it or leave the
 * card for later. A card's printed team and a player's career are different
 * facts, so nothing here ever touches `players.teamYears` either.
 *
 * ## The tiers, first answer wins
 *
 * Stored-row tiers first — they are the set's own statement of who a player
 * is here — each read from the player's SINGLE-player cards only, so a combo
 * card's team list never leaks onto a solo card:
 *
 *  1. **sameNode.** The player's cards under the node being synced (the same
 *     insert, the same parallel) that already carry a team.
 *  2. **parallelOf.** Only when that node is a `parallel`: the player's cards
 *     under the node it copies. A parallel is the same card printed again.
 *  3. **baseSet.** The player's cards under the set's base checklist — the
 *     variantType titled "Base" (NEO-334: a variant type's title is its kind,
 *     `variantTypeKind`); a set with none, or two, skips this tier. Skipped
 *     when the node being synced IS the base.
 *
 * Exactly one distinct team set in a tier is the answer. Two or more means the
 * set disagrees with itself there (a traded player's base card and his update
 * card), and the search STOPS: the teams become unselected candidates for the
 * operator, never a pick. A later tier cannot outvote the set.
 *
 * Then the player row, through ONE window rule (NEO-335 Phase 2, C2):
 *
 *  **oneTeamInWindow.** Exactly one team has a stint covering any year of
 *  `[setYear - 1, setYear]`. The window is two years wide because a set's
 *  year is not its season: a 2026 Series 1 card shows the 2025 team, so a
 *  player traded that winter is a tie between two teams, never a pick of the
 *  new one. An open stint (no `toYear`) is a current team and covers every
 *  year from its start. A stint that starts AFTER the set year never covers
 *  it: a card can show a team's past, never its future.
 *
 *  **oneTeamCareerInLeague** (legends). With NOTHING in the window — a
 *  retired player on a modern insert, or no set year at all — a career of
 *  exactly one team pre-fills only when that team is in the set's own league
 *  (rank 0). The Phase 1 year-blind shortcut pre-filled any one-team career,
 *  and enrichment routinely lacks a college stint, so a draft-product card in
 *  a college uniform got the pro team; tying it to the set's league keeps the
 *  legends case (a Reds-only Johnny Bench on an MLB insert) without that
 *  trap. No set league, or a team at rank 1 or 2, is no pre-fill. A legend
 *  with several teams comes back unselected, longest stint first (C8). A
 *  window hit always comes first.
 *
 *  **preferredInWindow.** Two or more teams in the window, and the set's own
 *  league breaks the tie (C2b): exactly one of them ranks best, and best is
 *  better than "other". The rank comes from the caller (`rankOf`): 0 = the
 *  set's league, 1 = the set's level, 2 = anything else or unknown. That is
 *  how a prospect's card goes to his major-league org ahead of the affiliates
 *  he also played for that year. The rank only BREAKS a window tie and orders
 *  the list. It never hides a team (the rest of the window comes back as
 *  candidates) and never outvotes a one-team window: a college card in a pro
 *  set still pre-fills the college team when that is the only one in the
 *  window, because pro sets do carry college cards.
 *
 * With no answer, the candidates are what an operator would want to pick
 * from: the teams of an ambiguous stored tier, else the window's teams, else
 * (window empty, or no year at all) the whole career. Career teams are
 * ordered by preference rank, then by years with the team, longest first.
 * Capped, deduped, never pre-selected.
 *
 * ## A listing's team name holds the answer back (invariant 8)
 *
 * Nothing here sees a card, so nothing here can see what a listing printed
 * on one. The per-card gate is the browser's: `teams-on-cards.ts` drops any
 * pre-fill on a card whose listing named a team NB could not resolve (or whose
 * lookup never answered), and shows these answers as unselected choices
 * there instead. A rule written here is a suggestion about a PLAYER; whether
 * it may pre-fill a CARD is decided per card, where the listing is in view.
 *
 * ## What is deliberately NOT evidence
 *
 * Another insert's cards. "Brett Favre could be a Jet in one insert and a
 * Packer in another" — a team borrowed across inserts is a guess dressed as a
 * fact. The base set is the one cross-node source.
 *
 * Never a marketplace value or name: every input here is an NB id.
 *
 * ## Pure by contract
 *
 * Ids in, answer out. No ctx, no generated code beyond the `Id` type, so a lib
 * test can drive every rule from literal rows. The Convex query reads the
 * player's cards and row; this module decides.
 */

import type { Id } from "../_generated/dataModel";
import { sameTeamSet } from "./selectorTeams";

/** Which tier answered (or, for candidates, which tier offered the team). */
export type TeamSuggestionTier =
  | "sameNode"
  | "parallelOf"
  | "baseSet"
  | "oneTeamInWindow"
  | "preferredInWindow"
  | "oneTeamCareerInLeague";

/**
 * How well a career team fits the set being saved: 0 = the set's own league,
 * 1 = another league at the set's level, 2 = anything else, or unknown.
 * Lower is better. See `teamPreferenceRank`.
 */
export type TeamPreferenceRank = 0 | 1 | 2;

/** The rank of a team nothing is known about. */
export const UNRANKED: TeamPreferenceRank = 2;

/**
 * C2b — a team's fit to the set, from NB rows only: the set's
 * `features.league` resolved to a `leagues` row, and the team's `leagueId`.
 *
 * Never a marketplace value or a display name: both sides are NB ids, and the
 * level is the league row's own NB field. An unclassified league (no level)
 * can only ever match by id.
 */
export function teamPreferenceRank(
  team: { leagueId?: string | null; leagueLevel?: string | null },
  set: { leagueId: string; level?: string | null } | null,
): TeamPreferenceRank {
  if (!set || !team.leagueId) return UNRANKED;
  if (team.leagueId === set.leagueId) return 0;
  if (set.level && team.leagueLevel && team.leagueLevel === set.level) return 1;
  return UNRANKED;
}

/** One stint, keyed by whatever identifies its team to the caller. */
export type KeyedStint<K extends string> = { key: K; fromYear: number; toYear?: number };

/**
 * Does this stint cover any year of the set's window `[year - 1, year]`?
 *
 * An open stint is a current team: it covers every year from its start. A
 * stint that starts after the set year never covers it.
 */
export function stintCoversWindow(
  stint: { fromYear: number; toYear?: number },
  year: number,
): boolean {
  return stint.fromYear <= year && (stint.toYear ?? Number.POSITIVE_INFINITY) >= year - 1;
}

/** What one player's career says, keyed like its stints. */
export type CareerVerdict<K extends string> = {
  answer: { tier: "oneTeamInWindow" | "preferredInWindow" | "oneTeamCareerInLeague"; key: K } | null;
  /**
   * With an answer: the OTHER teams in the window, so a tie-break never
   * hides the teams it ranked below (empty for a one-team window). Without:
   * the window's teams, else the whole career. Preference rank first, then
   * years with the team, longest first, then first seen.
   */
  candidates: K[];
};

/**
 * The career half of the suggestion, shared by the server (stints keyed by
 * team id) and the browser (a player created in the wizard, stints keyed by
 * the chip they will become). See the module note for the rules.
 */
export function careerTeamVerdict<K extends string>(input: {
  stints: ReadonlyArray<KeyedStint<K>>;
  year: number | undefined;
  currentYear: number;
  rankOf?: (key: K) => TeamPreferenceRank;
}): CareerVerdict<K> {
  const { stints, year, currentYear } = input;
  const rankOf = input.rankOf ?? (() => UNRANKED);

  const order: K[] = [];
  const years = new Map<K, number>();
  for (const stint of stints) {
    if (!years.has(stint.key)) order.push(stint.key);
    const end = stint.toYear ?? Math.max(currentYear, stint.fromYear);
    years.set(stint.key, (years.get(stint.key) ?? 0) + Math.max(1, end - stint.fromYear + 1));
  }
  const ranks = new Map<K, TeamPreferenceRank>(order.map((key) => [key, rankOf(key)]));
  const ordered = (keys: K[]): K[] =>
    keys
      .map((key, i) => ({ key, i }))
      .sort(
        (a, b) =>
          ranks.get(a.key)! - ranks.get(b.key)! ||
          years.get(b.key)! - years.get(a.key)! ||
          a.i - b.i,
      )
      .map(({ key }) => key);

  const inWindow: K[] =
    year === undefined
      ? []
      : order.filter((key) =>
          stints.some((stint) => stint.key === key && stintCoversWindow(stint, year)),
        );

  if (inWindow.length === 1) {
    return { answer: { tier: "oneTeamInWindow", key: inWindow[0] }, candidates: [] };
  }
  if (inWindow.length > 1) {
    const sorted = ordered(inWindow);
    const best = ranks.get(sorted[0])!;
    const atBest = sorted.filter((key) => ranks.get(key) === best);
    if (best < UNRANKED && atBest.length === 1) {
      return {
        answer: { tier: "preferredInWindow", key: sorted[0] },
        candidates: sorted.slice(1),
      };
    }
    return { answer: null, candidates: sorted };
  }
  // Nothing in the window (a legend on a modern insert, or no set year): a
  // ONE-team career pre-fills only when that team is in the set's own league
  // (Jason, NEO-335 Phase 2). A Yankees-only legend on an MLB insert is a
  // Yankee; the same name on a college or minor-league set is not evidence.
  if (order.length === 1 && ranks.get(order[0]) === 0) {
    return { answer: { tier: "oneTeamCareerInLeague", key: order[0] }, candidates: [] };
  }
  return { answer: null, candidates: ordered(order) };
}

/** The card fields a stored tier reads. Satisfied by a full `Doc<"cardChecklist">`. */
export type SuggestionCard = {
  selectorOptionId: Id<"selectorOptions">;
  playerIds?: ReadonlyArray<Id<"players">>;
  teamOnCardIds?: ReadonlyArray<Id<"teams">>;
};

/** The player fields the career tiers read. Satisfied by a full `Doc<"players">`. */
export type SuggestionPlayer = {
  teamYears?: ReadonlyArray<{ teamId: Id<"teams">; fromYear: number; toYear?: number }>;
};

export type PlayerTeamSuggestion = {
  /** Exactly one answer, from the first tier that gave one; null when none did. */
  answer: { tier: TeamSuggestionTier; teamIds: Array<Id<"teams">> } | null;
  /**
   * Teams the operator may pick from, in the order described in the module
   * note. With an answer this is only ever the rest of a tie-broken window
   * (`preferredInWindow`); every other answer comes alone.
   */
  candidates: Array<Id<"teams">>;
};

/**
 * Order-insensitive, duplicate-insensitive identity for a list of ids — a
 * dual-auto of one player twice and a card listing them once are the same
 * evidence.
 */
export function idSetKey(ids: ReadonlyArray<string>): string {
  return [...new Set<string>(ids)].sort().join("|");
}

type TeamSets = Array<Array<Id<"teams">>>;

/** Distinct team sets on the player's single-player cards under one node. */
function teamSetsUnder(
  cards: ReadonlyArray<SuggestionCard>,
  playerId: Id<"players">,
  nodeId: Id<"selectorOptions">,
): TeamSets {
  const sets: TeamSets = [];
  for (const card of cards) {
    if (card.selectorOptionId !== nodeId) continue;
    const players = new Set<string>(card.playerIds ?? []);
    if (players.size !== 1 || !players.has(playerId)) continue;
    const teams = card.teamOnCardIds ?? [];
    if (teams.length === 0) continue;
    if (!sets.some((seen) => sameTeamSet(seen, teams))) {
      sets.push([...new Set<Id<"teams">>(teams)]);
    }
  }
  return sets;
}

function distinct(ids: Iterable<Id<"teams">>): Array<Id<"teams">> {
  return [...new Set<Id<"teams">>(ids)];
}

/**
 * One player's team through tiers 1 → 2 → 3 → the career window.
 *
 * `cards` is whatever of the player's stored cards the caller read — any
 * node; the tiers pick out the ones under the nodes they name. `player`
 * undefined (a dangling id) skips the career. The caller drops stints it
 * KNOWS cannot be offered (another sport's team, a deleted one) before
 * calling: a team that cannot be picked must not make a window a tie.
 */
export function suggestTeamsForPlayer(input: {
  playerId: Id<"players">;
  player: SuggestionPlayer | undefined;
  cards: ReadonlyArray<SuggestionCard>;
  /** The node the incoming cards will be saved under. */
  nodeId: Id<"selectorOptions">;
  /** The node `nodeId` copies, when `nodeId` is a parallel; else null. */
  parallelOfNodeId: Id<"selectorOptions"> | null;
  /** The variantType node titled "Base", or null when the set has none (or two). */
  baseNodeId: Id<"selectorOptions"> | null;
  year: number | undefined;
  currentYear: number;
  maxCandidates: number;
  /** C2b — each career team's fit to the set; absent ranks everything alike. */
  rankOf?: (teamId: Id<"teams">) => TeamPreferenceRank;
}): PlayerTeamSuggestion {
  const { playerId, player, cards, nodeId, parallelOfNodeId, baseNodeId, year, currentYear } =
    input;
  const cap = (ids: Array<Id<"teams">>) => ids.slice(0, Math.max(0, input.maxCandidates));

  const storedTiers: Array<[TeamSuggestionTier, Id<"selectorOptions"> | null]> = [
    ["sameNode", nodeId],
    ["parallelOf", parallelOfNodeId],
    ["baseSet", baseNodeId !== nodeId ? baseNodeId : null],
  ];
  for (const [tier, node] of storedTiers) {
    if (node === null) continue;
    const sets = teamSetsUnder(cards, playerId, node);
    if (sets.length === 1) return { answer: { tier, teamIds: [...sets[0]] }, candidates: [] };
    if (sets.length > 1) {
      // The set disagrees with itself here. Stop: a career tier must not
      // outvote two printed cards. Their teams are the operator's choices.
      return { answer: null, candidates: cap(distinct(sets.flat())) };
    }
  }

  if (!player) return { answer: null, candidates: [] };

  const verdict = careerTeamVerdict<Id<"teams">>({
    stints: (player.teamYears ?? []).map((entry) => ({
      key: entry.teamId,
      fromYear: entry.fromYear,
      ...(entry.toYear !== undefined ? { toYear: entry.toYear } : {}),
    })),
    year,
    currentYear,
    rankOf: input.rankOf,
  });
  return {
    answer: verdict.answer
      ? { tier: verdict.answer.tier, teamIds: [verdict.answer.key] }
      : null,
    candidates: cap(verdict.candidates),
  };
}
