import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { teamFullName } from "../../lib/teams/team-name";
import { Input } from "../primitives/Input";

/**
 * NEO-92: single-select existing-player/team search for the review wizard's
 * "Link to Existing…" action. Single-select and chip-free — the wizard only
 * ever needs to pick exactly one existing row to link this reviewed name to.
 *
 * Unlike PlayerPicker/TeamPicker, there is no "+ Create" escape hatch here —
 * the wizard's own "Add as New" action already covers that case.
 *
 * NEO-212: this used to be `players.list`/`teams.list` with `limit: 500` and a
 * client-side substring filter, the same 500-row pattern
 * `PlayerAutocomplete` (NEO-147) exists to stop re-implementing. Two things
 * were wrong with it, and only the second is about speed:
 *
 *  1. **It could not find what it claimed to search.** 500 is a cap, not a
 *     total. On a sport with more players than that, the row you needed was
 *     simply absent from the list, the search said "no match", and the operator
 *     created a duplicate of a player we already had — the exact failure this
 *     whole ticket is about. The search index has no such horizon.
 *  2. It shipped 500 documents to the browser to render at most 8 of them.
 *
 * The debounce is the same 200ms and for the same reason as
 * `PlayerAutocomplete`: Convex opens one reactive subscription per distinct
 * argument set, so an undebounced field opens one per keystroke.
 *
 * Ranking stays client-side over the returned page. The search index orders by
 * relevance, but "starts with what I typed" is what a typeahead user expects to
 * see first, and re-sorting 25 rows in the browser is free.
 */

/** See `PlayerAutocomplete`'s SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const SEARCH_DEBOUNCE_MS = 200;

/** How many ranked results the list shows. Unchanged from the pre-NEO-212 cap. */
const MAX_RESULTS = 8;

export default function EntityLinkSearch({
  kind,
  sportId,
  onSelect,
  onCancel,
}: {
  kind: "player" | "team";
  /** NEO-96: the sport-level selectorOptions row id, not its display name. */
  sportId: Id<"selectorOptions">;
  onSelect: (id: Id<"players"> | Id<"teams">, name: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmed = debouncedQuery.trim();

  // Both hooks are always called (React's rules), with the irrelevant one
  // "skip"ped — the same shape EntityReviewWizard uses for its near-match
  // queries. A blank query also skips: `players.search`/`teams.search` return
  // [] for one anyway, so there is no reason to open a subscription at all.
  const players = useQuery(
    api.players.search,
    kind === "player" && trimmed ? { query: trimmed, sportId } : "skip",
  );
  const teams = useQuery(
    api.teams.search,
    kind === "team" && trimmed ? { query: trimmed, sportId } : "skip",
  );
  /**
   * One `{ _id, name }` shape for both kinds, with a TEAM's name composed from
   * its location and nickname (NEO-236).
   *
   * Composed here, once, rather than at each of the four places below that
   * read `.name`: the sort key, the visible text, the `Link to {name}`
   * accessible name and the Enter-to-select handler must all agree, and
   * "Padres" in a list that also holds "Padres" from another franchise is not
   * a name an operator can choose between.
   */
  const candidates: Array<{ _id: Id<"players"> | Id<"teams">; name: string }> | undefined =
    kind === "player"
      ? players
      : teams?.map((t) => ({ _id: t._id, name: teamFullName(t) }));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    if (!candidates) return [];
    const q = trimmed.toLowerCase();
    return [...candidates]
      .sort((a, b) => {
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS);
  }, [candidates, trimmed]);

  const label = kind === "player" ? "player" : "team";

  // Three distinct empty states, and conflating any two of them is how a
  // typeahead lies: nothing typed yet, a search in flight, and a search that
  // genuinely found nothing. Only the third is "No matches".
  const idle = trimmed === "";
  const searching = !idle && candidates === undefined;
  const empty = !idle && !searching && matches.length === 0;

  return (
    <div
      className="border border-gray-700 rounded-md bg-gray-900/60 p-2 space-y-1"
      role="listbox"
      aria-label={`Search existing ${label}s`}
    >
      <Input
        bare
        ref={inputRef}
        type="text"
        value={query}
        placeholder={`Search existing ${label}s…`}
        aria-label={`Search existing ${label}s`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            /*
             * NEO-220 — one level at a time, and never past this panel.
             *
             * Escape used to close the whole search on the first press, and it
             * only failed to cancel the entire review batch because the wizard
             * root happened to skip Escape while `linkingOpen`. That is a
             * guarantee living in the wrong component: anything that changed
             * the root's condition would have turned "clear my search" into
             * "throw the session away", silently.
             *
             * So this handler owns both levels itself — clear the query if
             * there is one, otherwise close the panel — and `stopPropagation`
             * unconditionally, so the guarantee holds whatever the root does.
             */
            e.preventDefault();
            e.stopPropagation();
            if (query !== "") {
              setQuery("");
              setDebouncedQuery("");
              return;
            }
            onCancel();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = matches[highlightIdx];
            if (pick) onSelect(pick._id, pick.name);
          }
        }}
        className="w-full p-1.5 text-sm"
      />

      {idle && (
        <div className="text-xs text-gray-500 px-2 py-1">Type to search</div>
      )}
      {searching && <div className="text-xs text-gray-500 px-2 py-1">Loading…</div>}
      {empty && <div className="text-xs text-gray-500 px-2 py-1">No matches</div>}
      {matches.map((m, idx) => (
        <button
          key={m._id}
          type="button"
          onClick={() => onSelect(m._id, m.name)}
          onMouseEnter={() => setHighlightIdx(idx)}
          aria-label={`Link to ${m.name}`}
          role="option"
          aria-selected={idx === highlightIdx}
          className={`w-full text-left px-2 py-1 text-sm rounded ${
            idx === highlightIdx
              ? "bg-[#00D558]/20 text-[#00D558]"
              : "hover:bg-gray-800 text-gray-200"
          }`}
        >
          {m.name}
        </button>
      ))}

      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel linking"
        className="w-full text-left px-2 py-1 text-xs text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
      >
        Cancel (Esc)
      </button>
    </div>
  );
}
