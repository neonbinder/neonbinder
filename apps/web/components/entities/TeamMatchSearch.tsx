import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Autocomplete } from "../primitives/Autocomplete";
import { teamFullName } from "../../lib/teams/team-name";
import { eraLabel } from "../../lib/teams/team-era";
import type { NearMatch } from "./NearMatchPanel";

/**
 * NEO-307 — the review wizard's ONE way to link a team step to a team NB holds.
 *
 * Jason, 2026-09-25, on a New Team step for "Brooklyn Dodgers": "The 'Possible
 * Matches' needs a similar team picker." The panel was a fixed list of a few
 * ranked search hits with a separate "Link to Existing…" search behind a
 * footer link that swapped the whole step out. On a team step both are
 * replaced by this: one type-ahead, on every team step, in the body where the
 * Possible matches list used to be.
 *
 * ## Pre-filled, and the near matches are its first answer
 * The field opens holding the row's own name, and while it still does, its
 * options ARE the near matches (the caller's list, with the lone exact match
 * already promoted to the footer's primary and left out), each with its
 * league and years under it. With no near matches the list stays shut until
 * the operator types (`hideWhenEmpty`): "No teams by that name" under a name
 * they never typed would answer a question nobody asked.
 *
 * Typing anything else ("Dodgers") hands the finding to `teams.search`, the
 * server-backed, sport-scoped, alias-aware index `CareerTeamEntry`,
 * `TeamPicker` and `EntityLinkSearch` already type against. Never a
 * fetch-all-and-filter: a sport can hold thousands of teams.
 *
 * ## Why the second line is league and years
 * "Dodgers" is five teams. The full name tells Brooklyn from Los Angeles, and
 * the league and era tell two rows of the same name apart — the same two facts
 * Team Management's list prints under each row. A near match found on an
 * alias, or on the same name, says so first on that line, which is what the
 * old panel's badge and alias note said.
 *
 * ## What a pick does
 * Exactly what the old near-match row did: `onPick(id, name)`, which the
 * wizard hands to the one link path every team link goes through
 * (`handleLink`, with the "Remember … as a name" answer). This component
 * decides nothing itself.
 */

/** See `PlayerAutocomplete`'s SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const SEARCH_DEBOUNCE_MS = 200;

/** `teams.search`'s own ceiling. Five Dodgers and their neighbours fit. */
const SEARCH_LIMIT = 25;

/** The combobox's accessible name. An E2E contract: flows tap it by this. */
export const TEAM_MATCH_SEARCH_LABEL = "Search all teams";

/** One option. `_id` is a team row; everything else is display. */
type TeamOption = {
  _id: Id<"teams">;
  fullName: string;
  yearsActive?: { from: number; to?: number };
  league?: string;
  /** Near matches only: why the ranking offered it. */
  tag?: string;
};

export interface TeamMatchSearchProps {
  /** NEO-96: the sport-level selectorOptions row id. Scopes every search. */
  sportId: Id<"selectorOptions">;
  /** What the field opens holding — the row's name as the step proposes it. */
  initialQuery: string;
  /**
   * The near matches to open on, for as long as the field still holds
   * `initialQuery`. `undefined` while the query is in flight, which renders
   * exactly as "none" does.
   */
  defaultMatches: NearMatch[] | undefined;
  onPick: (id: Id<"teams">, name: string) => void;
}

export function TeamMatchSearch({
  sportId,
  initialQuery,
  defaultMatches,
  onPick,
}: TeamMatchSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Still holding the proposed name — the near matches answer, no search.
   * Read off the LIVE query, not the debounced one, so the first keystroke
   * away from it shows "Searching…" at once rather than 200ms of near matches
   * that no longer describe what is typed.
   */
  const showingDefaults = query.trim() === initialQuery.trim();
  const term = debouncedQuery.trim();
  const searchArgs =
    !showingDefaults && term && term !== initialQuery.trim()
      ? { query: term, sportId, limit: SEARCH_LIMIT }
      : "skip";
  const searched = useQuery(api.teams.search, searchArgs);

  /**
   * League names for the second line. A sport's leagues are a couple of dozen
   * rows at most (see `EntityLinkSearch`'s note), and this is the same
   * `leagues.list({ sportId })` subscription the New Team form beside this
   * already holds, so Convex serves both from one.
   */
  const leagues = useQuery(api.leagues.list, { sportId });
  const leagueLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const league of leagues ?? []) {
      map.set(league._id, league.abbreviation ?? league.name);
    }
    return map;
  }, [leagues]);

  // Exact first, otherwise in the order the server ranked them — the order
  // the old panel listed them in.
  const matches = useMemo(
    () =>
      [...(defaultMatches ?? [])].sort(
        (a, b) =>
          (a.confidence === "exact" ? 0 : 1) - (b.confidence === "exact" ? 0 : 1),
      ),
    [defaultMatches],
  );
  const matchCount = matches.length;

  /**
   * The near matches carry name and years but not the league, so their rows
   * are read by id to fill it in. Sorted, so a reorder of the same matches does
   * not re-subscribe (Convex keys a subscription on the serialised args).
   */
  const defaultIds = useMemo(
    () => [...new Set(matches.map((m) => m._id as Id<"teams">))].sort(),
    [matches],
  );
  const defaultRows = useQuery(
    api.teams.getManyByIds,
    defaultIds.length > 0 ? { ids: defaultIds } : "skip",
  );

  const items = useMemo<TeamOption[]>(() => {
    const leagueOf = (row: { leagueId?: Id<"leagues">; league?: string }) =>
      (row.leagueId ? leagueLabelById.get(row.leagueId) : undefined) ??
      // NEO-156's deprecated free-text league, for a row the backfill has not
      // reached. Display only.
      row.league;

    if (showingDefaults) {
      const rowById = new Map((defaultRows ?? []).map((r) => [r._id as string, r]));
      return matches.map((m) => {
        const row = rowById.get(m._id);
        return {
          _id: m._id as Id<"teams">,
          fullName: row ? teamFullName(row) : m.name,
          yearsActive: row?.yearsActive ?? m.yearsActive,
          league: row ? leagueOf(row) : undefined,
          // The old panel's badge and alias note, in the old panel's words.
          tag: m.matchedAlias
            ? `also known as “${m.matchedAlias}”`
            : m.confidence === "exact"
              ? "same name"
              : undefined,
        };
      });
    }
    return (searched ?? []).map((t) => ({
      _id: t._id,
      fullName: teamFullName(t),
      yearsActive: t.yearsActive,
      league: leagueOf(t),
    }));
  }, [showingDefaults, matches, defaultRows, searched, leagueLabelById]);

  // In flight: typed away from the defaults and the answer is not back yet —
  // including the debounce window, when the query has not even been sent.
  const loading = !showingDefaults && query.trim() !== "" && searched === undefined;

  return (
    // The Possible matches box only when there are matches to head. With none
    // it is the caption and one field, so on the commonest team step (a
    // genuinely new team) the New Team form below is not pushed down by
    // chrome with nothing in it.
    <div
      className={
        matchCount > 0
          ? "rounded-md border border-neon-blue/40 bg-neon-blue/5 p-3 space-y-2"
          : "space-y-1"
      }
    >
      {/* Mounted from the first render and never removed, as the old panel's
          was: a live region inserted at the instant its text appears is
          announced unreliably. */}
      <span aria-live="polite" className="sr-only">
        {matchCount === 0
          ? ""
          : `${matchCount} possible match${matchCount === 1 ? "" : "es"}`}
      </span>
      {matchCount > 0 && (
        <p className="text-sm font-medium text-neon-blue">Possible matches</p>
      )}
      <div className="space-y-1">
        {/* The visible name of the field, word for word its accessible name
            (WCAG 2.2 SC 2.5.3). aria-hidden so it is not read twice: the
            combobox already announces it. */}
        <p aria-hidden="true" className="text-xs text-slate-400">
          {TEAM_MATCH_SEARCH_LABEL}
        </p>
        <Autocomplete<TeamOption>
          query={query}
          onQueryChange={setQuery}
          items={items}
          getKey={(t) => t._id}
          getLabel={(t) => t.fullName}
          getDescription={(t) =>
            [t.tag, t.league, eraLabel(t.yearsActive)].filter(Boolean).join(" · ") ||
            undefined
          }
          descriptionBelow
          hideWhenEmpty={showingDefaults}
          onSelect={(t) => {
            // Leave the pick in the field, as `PlayerAutocomplete` does: if the
            // link is refused the operator can still see what they chose.
            setQuery(t.fullName);
            setDebouncedQuery(t.fullName);
            onPick(t._id, t.fullName);
          }}
          label={TEAM_MATCH_SEARCH_LABEL}
          placeholder="Type a team name"
          loading={loading}
          emptyMessage="No teams by that name"
          selectOnFocus
          listMaxHeightClassName="max-h-48"
          inputGeometryClassName="p-1.5 text-sm"
        />
      </div>
    </div>
  );
}

export default TeamMatchSearch;
