/**
 * NEO-147 — picking which team's colors a player's spine label defaults to.
 *
 * A player with several stints has no single "their" team, so the designer
 * defaults to the one they spent longest with and lets the user override. This
 * is a pure function rather than inline page logic because the tie-breaking is
 * fiddly enough to be worth testing directly.
 *
 * ## The known inaccuracy, and why it is acceptable
 *
 * `players.teamYears` is deduped BY `teamId` at commit time, so a player who
 * left a team and came back collapses to a single entry spanning only one of
 * the stints. Tenure is therefore approximate for returning players. That is
 * tolerable precisely because this only picks a DEFAULT — the user sees every
 * team in the list and can choose another in one click. Fixing the underlying
 * dedup would change how career data is stored and belongs with that data, not
 * with a label designer.
 */

export interface TeamYear {
  teamId: string;
  fromYear: number;
  toYear?: number;
}

/**
 * Years spent with a team. An open-ended stint (`toYear` absent) means the
 * player is still there, so it counts through the current year.
 *
 * A single-season stint is `toYear === fromYear`, i.e. a span of 0. Returning 0
 * rather than 1 keeps the comparison honest between "one season" and "two
 * seasons"; it never needs to read as a duration in the UI.
 */
export function tenureYears(entry: TeamYear, currentYear: number): number {
  const end = entry.toYear ?? currentYear;
  return Math.max(0, end - entry.fromYear);
}

/**
 * The team a player is most associated with: longest tenure, ties broken by
 * whichever is more recent.
 *
 * Recency is the right tie-break because a collector labelling a binder is
 * usually thinking of the player as they are now (or as they retired), not as
 * they were in an equally-long earlier stint.
 *
 * Returns null for a player with no career data at all, which the designer
 * treats as "fall through to manual color entry" rather than as an error —
 * 27 of the first 100 prod players have no `teamYears`.
 */
export function pickDefaultTeamYear(
  teamYears: TeamYear[] | undefined,
  currentYear: number,
): TeamYear | null {
  if (!teamYears || teamYears.length === 0) return null;

  return teamYears.reduce((best, candidate) => {
    const bestTenure = tenureYears(best, currentYear);
    const candidateTenure = tenureYears(candidate, currentYear);
    if (candidateTenure !== bestTenure) {
      return candidateTenure > bestTenure ? candidate : best;
    }

    // Equal tenure — prefer the stint that ended later, then the one that
    // started later. An ongoing stint (no toYear) counts as ending now, so it
    // wins over any completed one of the same length.
    const bestEnd = best.toYear ?? currentYear;
    const candidateEnd = candidate.toYear ?? currentYear;
    if (candidateEnd !== bestEnd) return candidateEnd > bestEnd ? candidate : best;

    return candidate.fromYear > best.fromYear ? candidate : best;
  });
}
