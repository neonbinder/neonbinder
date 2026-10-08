import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
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
 * ## Headed "Link to existing team", on every team step
 * NEO-326 (Jason, 2026-10-04): the section says what it is FOR, not what the
 * ranking found. "Possible matches" over a box with nothing in it read as a
 * claim; "Link to existing team" is true with or without near matches, so the
 * heading and the box are always there and never come and go with the
 * near-match query. Whatever the caller passes as `children` sits directly
 * under the field, inside the box — the wizard's "Remember … as a name"
 * checkbox, which is a fact about linking and so belongs with the link control.
 *
 * ## Starts empty, and the near matches are its first answer
 * NEO-326: the field opens EMPTY. Pre-filling the row's own name made it look
 * as if a team by exactly that name already existed. While it is empty its
 * options ARE the near matches (the caller's list, with the lone exact match
 * already promoted to the footer's primary and left out), each with its
 * league and years under it, so focusing the box still offers a real close
 * match without a keystroke. With no near matches the list stays shut until
 * the operator types (`hideWhenEmpty`): "No teams by that name" under a query
 * nobody typed would answer a question nobody asked.
 *
 * Typing anything hands the finding to `teams.search`, the server-backed,
 * sport-scoped, alias-aware index `CareerTeamEntry`, `TeamPicker` and
 * `EntityLinkSearch` already type against. Never a fetch-all-and-filter: a
 * sport can hold thousands of teams. Clearing the field goes back to the near
 * matches.
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
 * decides nothing itself. The caller keys it by row, so each step starts
 * empty again.
 */

/** See `PlayerAutocomplete`'s SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const SEARCH_DEBOUNCE_MS = 200;

/** `teams.search`'s own ceiling. Five Dodgers and their neighbours fit. */
const SEARCH_LIMIT = 25;

/** The combobox's accessible name. An E2E contract: flows tap it by this. */
export const TEAM_MATCH_SEARCH_LABEL = "Search all teams";

/** NEO-326 — the section's visible heading, and the group's accessible name. */
export const TEAM_MATCH_SECTION_HEADING = "Link to existing team";

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
  /**
   * The near matches to offer while the field is empty. `undefined` while the
   * query is in flight, which renders exactly as "none" does.
   */
  defaultMatches: NearMatch[] | undefined;
  onPick: (id: Id<"teams">, name: string) => void;
  /** Rendered directly under the field, inside the section. */
  children?: ReactNode;
}

export function TeamMatchSearch({
  sportId,
  defaultMatches,
  onPick,
  children,
}: TeamMatchSearchProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // On the heading <p>, never on the input: maestro-web reads an input's
  // resource-id as `id || aria-label`, and "Search all teams" is the flows'
  // handle on it.
  const headingId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * Nothing typed — the near matches answer, no search. Read off the LIVE
   * query, not the debounced one, so the first keystroke shows "Searching…"
   * at once rather than 200ms of near matches that no longer describe what is
   * typed.
   */
  const showingDefaults = query.trim() === "";
  const term = debouncedQuery.trim();
  const searchArgs =
    !showingDefaults && term ? { query: term, sportId, limit: SEARCH_LIMIT } : "skip";
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
  const loading = !showingDefaults && searched === undefined;

  return (
    // One box, always, named by its heading: "Link to existing team" is true
    // with or without near matches, so nothing here comes and goes when the
    // near-match query lands (NEO-326). A group rather than a <section>: a
    // region landmark inside a dialog step is noise to a landmark list.
    <div
      role="group"
      aria-labelledby={headingId}
      className="rounded-md border border-neon-blue/40 bg-neon-blue/5 p-3 space-y-2"
    >
      {/* Mounted from the first render and never removed, as the old panel's
          was: a live region inserted at the instant its text appears is
          announced unreliably. */}
      <span aria-live="polite" className="sr-only">
        {matchCount === 0
          ? ""
          : `${matchCount} possible match${matchCount === 1 ? "" : "es"}`}
      </span>
      <p id={headingId} className="text-sm font-medium text-neon-blue">
        {TEAM_MATCH_SECTION_HEADING}
      </p>
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
          // Empty and focused: open on the near matches (NEO-326). With none,
          // `hideWhenEmpty` keeps the list shut until the operator types.
          openOnEmpty
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
      {children}
    </div>
  );
}

export default TeamMatchSearch;
