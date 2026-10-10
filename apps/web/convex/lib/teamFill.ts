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
 *     variantType flagged `metadata.isBase` (an NB role, never the literal
 *     "Base"). Skipped when the node being synced IS the base.
 *
 * Exactly one distinct team set in a tier is the answer. Two or more means the
 * set disagrees with itself there (a traded player's base card and his update
 * card), and the search STOPS: the teams become unselected candidates for the
 * operator, never a pick. A later tier cannot outvote the set.
 *
 * Then the player row:
 *
 *  B. **oneTeamCareer.** Every stint names the same team. This answers the
 *     retired-player case: a 1960s Yankee on a 2026 insert has no stint
 *     covering 2026, but his career has one team.
 *  C. **oneStintInYear.** Exactly one stint spans the set's year
 *     (`fromYear <= year <= (toYear ?? currentYear)`, an open stint being a
 *     current team). No resolvable year skips C.
 *
 * With no answer, the candidates are what an operator would want to pick
 * from, in order: the teams of an ambiguous stored tier, then the stints
 * covering the year, then (only when both are empty) the whole career — the
 * same "let go of the year for a retired player" fallback
 * `suggestedTeamsForCard` makes. Capped, deduped, never pre-selected.
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
  | "oneTeamCareer"
  | "oneStintInYear";

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
   * When `answer` is null: teams the operator may pick from, in the order
   * described in the module note. Empty when `answer` is set — an answer is
   * not also a list of alternatives.
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
 * One player's team through tiers 1 → 2 → 3 → B → C.
 *
 * `cards` is whatever of the player's stored cards the caller read — any
 * node; the tiers pick out the ones under the nodes they name. `player`
 * undefined (a dangling id) skips B and C.
 */
export function suggestTeamsForPlayer(input: {
  playerId: Id<"players">;
  player: SuggestionPlayer | undefined;
  cards: ReadonlyArray<SuggestionCard>;
  /** The node the incoming cards will be saved under. */
  nodeId: Id<"selectorOptions">;
  /** The node `nodeId` copies, when `nodeId` is a parallel; else null. */
  parallelOfNodeId: Id<"selectorOptions"> | null;
  /** The set's base checklist node, or null when the set has none flagged. */
  baseNodeId: Id<"selectorOptions"> | null;
  year: number | undefined;
  currentYear: number;
  maxCandidates: number;
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

  const career = distinct((player.teamYears ?? []).map((entry) => entry.teamId));
  if (career.length === 1) {
    return { answer: { tier: "oneTeamCareer", teamIds: career }, candidates: [] };
  }

  const inYear =
    year === undefined
      ? []
      : distinct(
          (player.teamYears ?? [])
            .filter((entry) => entry.fromYear <= year && year <= (entry.toYear ?? currentYear))
            .map((entry) => entry.teamId),
        );
  if (inYear.length === 1) {
    return { answer: { tier: "oneStintInYear", teamIds: inYear }, candidates: [] };
  }

  return { answer: null, candidates: cap(inYear.length > 0 ? inYear : career) };
}
