import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Autocomplete } from "./primitives/Autocomplete";

/**
 * NEO-147: player typeahead backed by the `players.search_name` search index.
 *
 * The interaction, keyboard handling and ARIA all live in the generic
 * {@link Autocomplete} primitive. This component is the data half: debounce,
 * the Convex query, and the shape of a player row in the list.
 *
 * It exists as its own component rather than as options passed to
 * `Autocomplete` at each call site because "search every player we know" is a
 * single behaviour that several surfaces want (the spine-label designer today;
 * the four SetSelector typeaheads when they migrate), and it is the piece that
 * must not be re-implemented as a 500-row client-side filter again.
 */

export type PlayerSearchResult = Omit<Doc<"players">, "createdByUserId">;

/**
 * Debounce for the search query.
 *
 * Convex `useQuery` opens a reactive subscription per distinct argument set, so
 * an undebounced field would open one per keystroke — "Griffey" is seven
 * subscriptions for one intent. 200ms is below the ~250ms at which typing
 * starts to feel laggy while still collapsing a normal typing burst into one
 * or two queries.
 */
const SEARCH_DEBOUNCE_MS = 200;

export interface PlayerAutocompleteProps {
  /** Called when the user picks a player. */
  onSelect: (player: PlayerSearchResult) => void;
  /** Optional sport filter. Omit to search every sport (the collector case). */
  sportId?: Id<"selectorOptions">;
  label?: string;
  placeholder?: string;
  /** Text to seed the field with, e.g. re-editing an existing choice. */
  initialQuery?: string;
  disabled?: boolean;
  className?: string;
}

export function PlayerAutocomplete({
  onSelect,
  sportId,
  label = "Player name",
  placeholder = "Search players…",
  initialQuery = "",
  disabled = false,
  className,
}: PlayerAutocompleteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmed = debouncedQuery.trim();
  const results = useQuery(
    api.players.search,
    // "skip" rather than an empty-string query: an empty query is a no-op on
    // the server anyway, and skipping avoids opening a subscription at all
    // while the field is empty.
    trimmed ? { query: trimmed, sportId } : "skip",
  );

  // `useQuery` returns undefined while in flight. Distinguishing that from an
  // empty array is what lets the list say "Searching…" instead of flashing
  // "No matches" at every keystroke.
  const loading = trimmed.length > 0 && results === undefined;
  const items = useMemo(() => results ?? [], [results]);

  return (
    <Autocomplete<PlayerSearchResult>
      query={query}
      onQueryChange={setQuery}
      items={items}
      getKey={(p) => p._id}
      getLabel={(p) => p.name}
      onSelect={(player) => {
        // Leave the chosen name in the field. The user's next action is
        // usually to look at what they picked, not to type again, and a field
        // that empties itself on selection reads as having lost the choice.
        setQuery(player.name);
        setDebouncedQuery(player.name);
        onSelect(player);
      }}
      label={label}
      placeholder={placeholder}
      loading={loading}
      emptyMessage="No players found"
      disabled={disabled}
      className={className}
    />
  );
}
