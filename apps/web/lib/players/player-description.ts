/**
 * NEO-462 — one line describing a player, for telling two players with the
 * same (or a similar) name apart: `b. 1990 · Dodgers 2014–19 · Brewers
 * 2020–21 +1 more`.
 *
 * Successor to NEO-254's `career-summary.ts`, which rendered stints in
 * chronological order. This module ranks TEAMS instead, so the line leads
 * with the franchise a collector most associates with the player.
 *
 * ## Why this is a shared pure module and not a template in a component
 *
 * Two surfaces show this line, and a player the operator links from one has
 * to read the same way in the other:
 *
 *  - The review wizard's same-name list is rendered from a string the SERVER
 *    built (`entityReviewQueue.enrichment.existingCandidates[].careerSummary`),
 *    because drawing it on the client would mean joining every candidate's
 *    `teamYears` to `teams`: N round trips to answer "which Bob Allen is
 *    this?", on a panel that exists to be read in a second.
 *  - `players.nearMatches` ("Possible matches") returns the structured
 *    `CareerLine` and the client formats it, so it can style the parts.
 *
 * Both rank with `rankCareerTeams` and format with the functions below, so
 * the order and the spelling cannot drift between them.
 *
 * Pure, and deliberately in `lib/` rather than `convex/`: a browser bundle
 * imports it, so it must not pull `_generated/server` in behind it.
 */

import { isDatedTeamYear, sortTeamYears } from "./team-tenure";

/**
 * How many teams a line names before it stops counting.
 *
 * Not a display cap so much as a recognition cap. The line answers one
 * question, "is this the man on the card?", and that is settled by the first
 * franchise or two; a twelve-team journeyman rendered in full stops being
 * scannable and starts being a paragraph. The remainder is reported as
 * `+N more` rather than dropped, so nobody reads a truncated career as a
 * complete one. Also the per-candidate team-read budget on the server: only
 * the teams that will be NAMED are ever read.
 */
export const PLAYER_DESCRIPTION_MAX_TEAMS = 2;

/** What a surface prints for a player with no birth year and no stints. */
export const NOTHING_ON_FILE = "Nothing on file yet";

/** One stint's years. `toYear` absent = still there ("–present"). */
export type YearSpan = { fromYear: number; toYear?: number };

/**
 * One team on the line, already resolved to a NAME. `spans` is every dated
 * stint at that team, chronological; `[]` means the team is known only from
 * undated stints (NEO-285: a college the source names without years), and it
 * prints as the bare name.
 */
export type CareerTeam = { name: string; spans: YearSpan[] };

/** The shown teams, in rank order, and how many more teams were not shown. */
export type CareerLine = { teams: CareerTeam[]; moreTeams: number };

/** One team, ranked, before its name is resolved. */
export type RankedCareerTeam<TId extends string = string> = {
  teamId: TId;
  /** Dated stints only, chronological. `[]` = undated only. */
  spans: YearSpan[];
  /** Seasons at the team: inclusive seasons summed over `spans`; 0 undated-only. */
  totalYears: number;
  /** Earliest `fromYear` across `spans`; absent for an undated-only team. */
  firstYear?: number;
};

/**
 * Teams ordered by how long the player spent there IN TOTAL.
 *
 * Stints at one team are summed (traded away and re-signed still counts as
 * one franchise), and each stint counts its INCLUSIVE seasons,
 * `(toYear ?? currentYear) - fromYear + 1`, never less than 1. Not
 * `tenureYears` (`to - from`, which scores a single season as 0): that is
 * fine for picking one stint, but summed it undercounts split stints. Three
 * one-season Mets stints would score 0 and lose to one 2005–06 Cubs stint
 * scoring 1, though the player spent three seasons with the Mets and two
 * with the Cubs. Ties go to the team the player reached first, then to
 * input order. Teams known only from undated stints
 * have no tenure to measure, so they come last, in input order. A team with
 * both dated and undated stints ranks by its dated spans alone; the undated
 * stint adds no years and no position.
 *
 * Repeat stints are NOT collapsed into one span: the gap between them is
 * exactly the kind of detail that settles which of two same-named men is on a
 * 1993 card, and merging them would state years that never happened. They are
 * kept as separate spans and printed in order ("Mariners 2009–12, 2016–19").
 *
 * Pure; the input is never mutated.
 */
export function rankCareerTeams<TId extends string>(
  teamYears:
    | ReadonlyArray<{ teamId: TId; fromYear?: number; toYear?: number }>
    | undefined,
  currentYear: number,
): RankedCareerTeam<TId>[] {
  const byTeam = new Map<TId, { order: number; spans: YearSpan[] }>();
  for (const stint of teamYears ?? []) {
    let entry = byTeam.get(stint.teamId);
    if (!entry) {
      entry = { order: byTeam.size, spans: [] };
      byTeam.set(stint.teamId, entry);
    }
    if (isDatedTeamYear(stint)) {
      entry.spans.push(
        stint.toYear !== undefined
          ? { fromYear: stint.fromYear, toYear: stint.toYear }
          : { fromYear: stint.fromYear },
      );
    }
  }

  const ranked = [...byTeam.entries()].map(([teamId, { order, spans }]) => {
    const sorted = sortTeamYears(spans);
    const totalYears = sorted.reduce(
      (sum, span) => sum + inclusiveSeasons(span, currentYear),
      0,
    );
    const team: RankedCareerTeam<TId> & { order: number } = {
      teamId,
      spans: sorted,
      totalYears,
      order,
    };
    if (sorted.length > 0) team.firstYear = sorted[0].fromYear;
    return team;
  });

  ranked.sort((a, b) => {
    const aDated = a.firstYear !== undefined;
    const bDated = b.firstYear !== undefined;
    if (aDated !== bDated) return aDated ? -1 : 1;
    if (aDated && bDated) {
      if (a.totalYears !== b.totalYears) return b.totalYears - a.totalYears;
      if (a.firstYear !== b.firstYear) return a.firstYear! - b.firstYear!;
    }
    return a.order - b.order;
  });

  return ranked.map(({ order: _order, ...team }) => team);
}

/**
 * Seasons a stint covers, counting both ends: 2005–06 is 2, a single season
 * is 1, an open stint runs through `currentYear`. Bad data (an end before the
 * start, or a start after `currentYear` on an open stint) counts as 1: the
 * stint happened, but its years say nothing about how long.
 */
function inclusiveSeasons(span: YearSpan, currentYear: number): number {
  const end = span.toYear ?? currentYear;
  return Math.max(1, end - span.fromYear + 1);
}

/**
 * The line's structured form: the first `maxTeams` ranked teams, named, plus
 * a count of the teams left over.
 *
 * `teamName` is called ONLY for the teams shown, so a server caller can read
 * just those team documents. `undefined` for a player with no stints at all,
 * which is a real and common state (a row created from a card and never
 * enriched); the caller says what that means in its own voice.
 */
export function careerLine<TId extends string>(
  ranked: ReadonlyArray<RankedCareerTeam<TId>>,
  teamName: (id: TId) => string,
  maxTeams: number = PLAYER_DESCRIPTION_MAX_TEAMS,
): CareerLine | undefined {
  if (ranked.length === 0) return undefined;
  // Floored at 1: a caller passing 0 or a negative means "as few as
  // possible", and rendering nothing but "+7 more" answers no question.
  const shown = Math.max(1, Math.floor(maxTeams));
  const teams = ranked.slice(0, shown).map((team) => ({
    name: teamName(team.teamId),
    spans: team.spans.map((span) => ({ ...span })),
  }));
  return { teams, moreTeams: ranked.length - teams.length };
}

/**
 * `2014–19`; `1998–2004` when the century changes; `2024–present` for an
 * open stint; `2019` for a single season. An end year before the start (bad
 * data) prints both years in full rather than a misleading short form.
 */
export function formatYearSpan(span: YearSpan): string {
  const { fromYear, toYear } = span;
  if (toYear === undefined) return `${fromYear}–present`;
  if (toYear === fromYear) return `${fromYear}`;
  if (toYear > fromYear && Math.floor(toYear / 100) === Math.floor(fromYear / 100)) {
    return `${fromYear}–${String(toYear % 100).padStart(2, "0")}`;
  }
  return `${fromYear}–${toYear}`;
}

/** `Dodgers 2014–19`, `Mariners 2009–12, 2016–19`, or a bare `Wisconsin`. */
export function formatCareerTeam(team: CareerTeam): string {
  if (team.spans.length === 0) return team.name;
  return `${team.name} ${team.spans.map(formatYearSpan).join(", ")}`;
}

/** `Dodgers 2014–19 · Brewers 2020–21 +1 more`, or `""` with no teams. */
export function formatCareerLine(line: CareerLine | undefined): string {
  if (!line || line.teams.length === 0) return "";
  const head = line.teams.map(formatCareerTeam).join(" · ");
  return line.moreTeams > 0 ? `${head} +${line.moreTeams} more` : head;
}

/**
 * `b. 1990 · Dodgers 2014–19 · Brewers 2020–21 +1 more`, or `""` when there
 * is nothing to say (the caller decides whether to print `NOTHING_ON_FILE`).
 *
 * `career` may be the structured line, or a string that is ALREADY a
 * formatted career line (the stored `careerSummary` on a review candidate).
 */
export function formatPlayerDescription(input: {
  birthYear?: number;
  career?: CareerLine | string;
}): string {
  const parts: string[] = [];
  if (input.birthYear !== undefined) parts.push(`b. ${input.birthYear}`);
  const career =
    typeof input.career === "string" ? input.career : formatCareerLine(input.career);
  if (career) parts.push(career);
  return parts.join(" · ");
}

/**
 * The same description for a screen reader: commas instead of middle dots,
 * `plus N more` instead of `+N more`, and `and` between repeat stints at one
 * team so the team boundaries stay audible
 * (`b. 1990, Mariners 2009–12 and 2016–19, Brewers 2020–21, plus 1 more`).
 */
export function speakPlayerDescription(input: {
  birthYear?: number;
  career?: CareerLine;
}): string {
  const parts: string[] = [];
  if (input.birthYear !== undefined) parts.push(`b. ${input.birthYear}`);
  for (const team of input.career?.teams ?? []) {
    parts.push(
      team.spans.length === 0
        ? team.name
        : `${team.name} ${team.spans.map(formatYearSpan).join(" and ")}`,
    );
  }
  const more = input.career?.moreTeams ?? 0;
  if (more > 0 && parts.length > 0) parts.push(`plus ${more} more`);
  return parts.join(", ");
}
