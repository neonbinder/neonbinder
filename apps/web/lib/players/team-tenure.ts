/**
 * NEO-147 — picking which team's colors a player's spine label defaults to.
 *
 * A player with several stints has no single "their" team, so the designer
 * defaults to the one they spent longest with and lets the user override. This
 * is a pure function rather than inline page logic because the tie-breaking is
 * fiddly enough to be worth testing directly.
 *
 * ## Tenure is PER-STINT, and summing across stints is a deliberate non-goal
 *
 * `players.teamYears` used to be deduped BY `teamId` at commit time, so a
 * player who left a team and came back collapsed to a single entry spanning
 * only one of the stints. NEO-212 fixed that: the key is now `(teamId,
 * fromYear)`, so a returning player keeps every stint as its own row and the
 * career timeline is no longer lossy.
 *
 * That does NOT mean this file now adds the stints up. `tenureYears` measures
 * ONE stint, and `pickDefaultTeamYear` returns the single longest one — a
 * player with two three-year runs at a team loses to one six-year run
 * elsewhere. Deliberate: the function's whole job is to name a stint whose
 * years the label can print ("Angels 2011–2019"), and a summed total has no
 * years to print. It also only picks a DEFAULT — the user sees every stint in
 * the list and can choose another in one click. If a "most associated
 * franchise" ranking is ever wanted, it is a separate function over the same
 * rows, not a change to these two.
 */

export interface TeamYear {
  teamId: string;
  fromYear: number;
  toYear?: number;
}

/**
 * NEO-212 — the one ordering for a career timeline: earliest stint first,
 * and for two stints starting the same year, the one that ended first.
 *
 * ## Why it lives here rather than at either call site
 *
 * Career stints are written by two independent paths that must not disagree:
 * `commitCardChecklistPrelude` (convex/selectorOptions.ts — the review
 * wizard's "create" decision, merging Wikidata's careerTeams with the
 * operator's manual entries) and `enrichPlayer` (convex/adapters/wikidata.ts —
 * the post-creation enrichment action). Both store the result on
 * `players.teamYears`. If they ordered differently, the same player would read
 * back as a different timeline depending on which path happened to create
 * them, and the stored row's diff would be unreadable. Sorted at WRITE time,
 * not on render, so every consumer — the admin editor, card-detail chips,
 * `pickDefaultTeamYear` above — reads one already-canonical order.
 *
 * An open-ended stint (`toYear` absent) means "still there", so it sorts LAST
 * among stints sharing a `fromYear` — it is, by definition, the one that has
 * not ended.
 *
 * Explicitly NOT a dedupe. Two stints at one franchise (traded away, later
 * re-signed) are real and common, and collapsing them destroys the history
 * `teamYears` exists to record. Only an exact `(teamId, fromYear)` repeat is a
 * duplicate, and rejecting that is the caller's job — this only orders.
 *
 * Pure, and returns a new array; the input is never mutated.
 */
export function sortTeamYears<T extends { fromYear: number; toYear?: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.fromYear !== b.fromYear) return a.fromYear - b.fromYear;
    return (a.toYear ?? Infinity) - (b.toYear ?? Infinity);
  });
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
