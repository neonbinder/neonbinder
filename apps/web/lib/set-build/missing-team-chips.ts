/**
 * NEO-339 — the "which team is on this card?" question's chips, folded once.
 *
 * `MissingTeamFixer` (the attention walker's missing-team step) and the
 * set-building tool's attention listing ask the same question of the same
 * data, and must offer the same chips and preselect the same teams. They used
 * to carry two copies of this fold; this is the one both call.
 *
 * The rules (NEO-102, NEO-330):
 *
 *  - **One chip per TEAM**, not per suggestion. Two players on a League
 *    Leaders card can share a team; two identical chips would read as a bug
 *    and double-count against the cap. A shared chip names both players.
 *  - **The listing's rows first.** When the listing named a team, every NB row
 *    under that name is a chip (era-labelled), and a row that is also in a
 *    player's career carries that provenance and is not repeated in the
 *    career list. The listing's string only FINDS rows; the chip is a row id.
 *  - **Only set-year teams are preselected**, and none when the listing
 *    disagrees: a set-year stint at a team that is not among the listing's
 *    rows is two sources saying two things — surface it, never settle it
 *    (product invariants 7 and 8). A listing name that could not be looked up
 *    vouches for nothing, so it counts as disagreeing. A career fallback (no
 *    stint covers the set year) is a list to choose from, never an answer.
 *  - **At most `MAX_CARD_TEAMS`** preselected — the cap the server holds
 *    `teamOnCardIds` to.
 *
 * Pure and env-free, relative imports only, so the browser and a Node script
 * both load it.
 */

import { MAX_CARD_TEAMS } from "../../convex/features/cardAttention";

/** One `cardChecklist.suggestedTeamsForCard` row, as both callers receive it. */
export type TeamSuggestion<TId extends string> = {
  teamId: TId;
  /** The team's full name. */
  name: string;
  /** The full name, era-labelled when the sport holds the name more than once. */
  label: string;
  playerName: string;
  /** A stint covering the set year produced it. */
  inSetYear: boolean;
  /** The set year a whole-career fallback looked for, when no stint covered it. */
  uncoveredSetYear?: number;
};

/** A career chip: a team a player on the card played for. */
export type CareerTeamChip<TId extends string> = {
  teamId: TId;
  name: string;
  label: string;
  /** Players on this card whose career names the team. */
  playerNames: string[];
  inSetYear: boolean;
};

/** A listing chip: one NB row under the name the listing gave, with its era row. */
export type ListingTeamChip<TId extends string, TEra> = {
  teamId: TId;
  label: string;
  /** Players on this card whose career names this row; empty when none does. */
  playerNames: string[];
  inSetYear: boolean;
  era: TEra;
};

export type MissingTeamChips<TId extends string, TEra> = {
  listingChips: ListingTeamChip<TId, TEra>[];
  /** Career teams that are not already a listing chip. */
  careerChips: CareerTeamChip<TId>[];
  /** Every career team a set-year stint produced, listing chips included. */
  setYearTeamIds: TId[];
  /** The listing named a team and a set-year team is not among its rows. */
  listingDisagrees: boolean;
  /** What the step preselects. */
  preselect: TId[];
  uncoveredSetYear?: number;
};

/**
 * Fold the suggestions and the listing's rows into the step's chips.
 *
 * `listingName` is the listing's team name, trimmed ("" when it named none).
 * `listingRows` are the NB rows under that name (`teams.erasByNameAndSport`),
 * or null/undefined when they could not be looked up (no sport), which offers
 * no listing chips and vouches for nothing.
 */
export function foldMissingTeamChips<TId extends string, TEra extends { _id: TId; label: string }>(input: {
  suggestions: ReadonlyArray<TeamSuggestion<TId>>;
  listingName: string;
  listingRows: ReadonlyArray<TEra> | null | undefined;
}): MissingTeamChips<TId, TEra> {
  const careerByTeam = new Map<string, CareerTeamChip<TId>>();
  for (const s of input.suggestions) {
    const existing = careerByTeam.get(s.teamId);
    if (existing) {
      if (!existing.playerNames.includes(s.playerName)) existing.playerNames.push(s.playerName);
      existing.inSetYear = existing.inSetYear || s.inSetYear;
    } else {
      careerByTeam.set(s.teamId, {
        teamId: s.teamId,
        name: s.name,
        label: s.label,
        playerNames: [s.playerName],
        inSetYear: s.inSetYear,
      });
    }
  }
  const uncoveredSetYear = input.suggestions.find((s) => s.uncoveredSetYear !== undefined)?.uncoveredSetYear;

  const listingName = input.listingName.trim();
  const rows = listingName !== "" ? (input.listingRows ?? []) : [];
  const listingIds = new Set<string>(rows.map((e) => e._id));
  const listingChips: ListingTeamChip<TId, TEra>[] = rows.map((era) => {
    const career = careerByTeam.get(era._id);
    return {
      teamId: era._id,
      label: era.label,
      playerNames: career ? [...career.playerNames] : [],
      inSetYear: career?.inSetYear ?? false,
      era,
    };
  });
  const careerChips = [...careerByTeam.values()]
    .filter((chip) => !listingIds.has(chip.teamId))
    .map((chip) => ({ ...chip, playerNames: [...chip.playerNames] }));

  const setYearTeamIds = [...careerByTeam.values()].filter((c) => c.inSetYear).map((c) => c.teamId);
  const listingDisagrees = listingName !== "" && setYearTeamIds.some((id) => !listingIds.has(id));
  const preselect = listingDisagrees ? [] : setYearTeamIds.slice(0, MAX_CARD_TEAMS);

  return {
    listingChips,
    careerChips,
    setYearTeamIds,
    listingDisagrees,
    preselect,
    ...(uncoveredSetYear !== undefined ? { uncoveredSetYear } : {}),
  };
}
