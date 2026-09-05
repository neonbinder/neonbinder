import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  normalizeEntityName,
  rankTeamCandidates,
} from "../../convex/lib/entityNearMatch";
import { teamFullName } from "../../lib/teams/team-name";
import { Input } from "../primitives/Input";

/**
 * NEO-92 follow-up: manual career-team entry for a player row in the
 * EntityReviewWizard. When the wizard's background Wikidata lookup finds no
 * career-team history (e.g. "Daulton Varsho" in our testing) — or missed a
 * team it should have — the admin can add `{ team, fromYear, toYear? }`
 * entries by hand, in ADDITION to whatever Wikidata found.
 *
 * The team field is a free-text combobox: it typeaheads against candidate
 * teams, but UNLIKE EntityLinkSearch it deliberately accepts a name that
 * matches nothing. So there's no "+ Create" escape hatch here; typing IS
 * creating.
 *
 * ## NEO-236 — creating takes Location + Name, never a full string
 *
 * Jason, 2026-09-05: "We simply shouldn't allow for full string creation.
 * Location & Team Name should be the input." So the entry is now two fields —
 * an optional Location ("San Diego") ahead of the nickname ("Padres") — and it
 * reports both upward rather than one string. The wizard composes them for
 * matching (`teamFullName`) and carries the split through to the decision, so
 * a career team the commit has to CREATE lands as a properly split row instead
 * of one whose whole name sits in `name`.
 *
 * Location stays optional and blank by default: a college side, a national
 * team or "Orix Buffaloes" has none, and a blank Location is a real answer
 * rather than an unfinished form. Picking a suggestion fills Name with the
 * whole existing name and clears Location — the composed string then matches
 * that row exactly, so commit LINKS to it and creates nothing.
 *
 * This component owns only its own mini-form state and emits each completed
 * entry via `onAdd`. The staged list of added entries (and its per-row reset)
 * lives in EntityReviewWizard — see there.
 *
 * ## NEO-212 — the two ways this field used to mint a duplicate team
 *
 * 1. **It could not see the batch.** Suggestions came from `teams.list`
 *    (`limit: 500`) — i.e. from `teams`, the table, which during a review
 *    contains none of what the batch is about to create. An operator who staged
 *    "Toronto Blue Jays" on row 2 got no suggestion for it on row 5, retyped it
 *    as "Toronto Bluejays", and the commit created both. `stagedNames` closes
 *    that: the batch's own pending team names are offered FIRST, tagged so the
 *    operator can tell a not-yet-saved name from a saved one.
 * 2. **It could not see past 500 rows, and matched only on substring.** Now
 *    `teams.search` (the search index, debounced like `PlayerAutocomplete`)
 *    supplies the saved half, and `rankTeamCandidates` adds the softer
 *    "did you mean?" prompt underneath — the one that catches "NY Yankees" vs
 *    "New York Yankees", which no substring filter ever will.
 *
 * Client-side year bounds mirror the server validation in
 * entityReviewQueue.recordDecision so bad input is caught before the
 * round-trip; the server re-validates regardless (defense in depth).
 */

// Mirrors MIN_CAREER_YEAR in convex/entityReviewQueue.ts (1869 = first
// openly professional baseball club — a loose lower bound to reject nonsense).
export const MIN_CAREER_YEAR = 1869;

/** See `PlayerAutocomplete`'s SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const SEARCH_DEBOUNCE_MS = 200;

/** How many suggestions the dropdown shows, staged and searched combined. */
const MAX_SUGGESTIONS = 8;

/**
 * NEO-236: `name` is the NICKNAME the operator typed ("Padres"), `location`
 * the optional place ahead of it ("San Diego"). Compose with `teamFullName`
 * for anything that matches, displays, or dedupes — never by hand.
 */
export type CareerTeamDraft = {
  name: string;
  location?: string;
  fromYear: number;
  toYear?: number;
};

/** One dropdown row. `staged` drives the "this batch" tag and the ordering. */
type Suggestion = { key: string; name: string; staged: boolean };

export default function CareerTeamEntry({
  sportId,
  stagedNames,
  onAdd,
}: {
  /** NEO-96: the sport-level selectorOptions row id, not its display name. */
  sportId: Id<"selectorOptions">;
  /**
   * Team names this review batch is already going to create or link, from
   * `deriveStagedTeamNames`. Not yet in `teams`, so `teams.search` cannot
   * return them — suggesting them is the whole point.
   */
  stagedNames: string[];
  onAdd: (entry: CareerTeamDraft) => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [debouncedName, setDebouncedName] = useState("");
  const [fromYear, setFromYear] = useState("");
  const [toYear, setToYear] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const maxYear = new Date().getFullYear() + 1;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedName(name), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [name]);

  const trimmedName = name.trim();
  const trimmedLocation = location.trim();
  const debouncedTrimmed = debouncedName.trim();
  /**
   * What this entry would actually create or match: "San Diego Padres".
   *
   * The typeahead still SEARCHES on the nickname alone — the index is
   * token-wise, so "Padres" already returns "San Diego Padres" — but the
   * duplicate warning below compares the composed string, because that is the
   * name commit will look up.
   */
  const composedName = trimmedName
    ? teamFullName({ name: trimmedName, location: trimmedLocation })
    : "";

  const searched = useQuery(
    api.teams.search,
    // Blank skips: `teams.search` returns [] for an empty term anyway, and a
    // typeahead that suggests before you type is noise.
    debouncedTrimmed ? { query: debouncedTrimmed, sportId } : "skip",
  );

  /**
   * Staged first, then saved teams the staged list does not already cover.
   *
   * Staged names go first because they are the ones the operator cannot
   * discover any other way — a saved team is still findable by typing its full
   * name, a pending one is not. Both halves are filtered by the typed text and
   * prefix-ranked, so the list stays a typeahead rather than a batch dump.
   */
  const suggestions = useMemo<Suggestion[]>(() => {
    const q = trimmedName.toLowerCase();
    if (!q) return [];

    const rank = (a: string, b: string) => {
      const aPrefix = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.localeCompare(b);
    };

    const stagedKeys = new Set(stagedNames.map(normalizeEntityName));
    const staged = stagedNames
      .filter((n) => n.toLowerCase().includes(q))
      .sort(rank)
      .map((n) => ({ key: `staged:${n}`, name: n, staged: true }));

    const saved = (searched ?? [])
      // NEO-236: the FULL name. A suggestion is something the operator can
      // pick to LINK to, and "Padres" does not identify the row it belongs to.
      .map((t) => ({ _id: t._id, name: teamFullName(t) }))
      // Dropping a saved team already offered as staged: the same name twice,
      // once tagged and once not, reads as two different teams.
      .filter((t) => !stagedKeys.has(normalizeEntityName(t.name)))
      .sort((a, b) => rank(a.name, b.name))
      .map((t) => ({ key: `team:${t._id}`, name: t.name, staged: false }));

    return [...staged, ...saved].slice(0, MAX_SUGGESTIONS);
  }, [stagedNames, searched, trimmedName]);

  /**
   * The "did you mean?" prompt: a name that is CLOSE to something already in
   * play but not equal to it. Suppressed when an exact match exists, because
   * then the typed text is already the right name and there is nothing to mean
   * instead — `rankTeamCandidates` puts any exact hit first, so one look at the
   * head of the ranking settles it.
   */
  const didYouMean = useMemo<string | null>(() => {
    if (!composedName) return null;
    const pool = [
      ...stagedNames,
      // NEO-236: `teams.search` returns whole rows, so the full name is
      // composed here rather than read off `name` — a split row's `name` is
      // just "Padres" and ranking "San Diego Padres" against it would report a
      // near match where there is an exact one.
      ...(searched ?? []).map((t) => teamFullName(t)),
    ];
    if (pool.length === 0) return null;
    const ranked = rankTeamCandidates(
      composedName,
      pool.map((n) => ({ name: n })),
    );
    if (ranked.length === 0) return null;
    if (ranked[0].confidence === "exact") return null;
    return pool[ranked[0].index] ?? null;
  }, [composedName, stagedNames, searched]);

  const fromNum = Number(fromYear);
  const toNum = toYear.trim() === "" ? undefined : Number(toYear);

  const fromValid =
    fromYear.trim() !== "" &&
    Number.isInteger(fromNum) &&
    fromNum >= MIN_CAREER_YEAR &&
    fromNum <= maxYear;
  const toValid =
    toNum === undefined ||
    (Number.isInteger(toNum) && toNum <= maxYear && toNum >= fromNum);
  const canAdd = trimmedName !== "" && fromValid && toValid;

  const commit = () => {
    if (!canAdd) return;
    onAdd({
      name: trimmedName,
      ...(trimmedLocation ? { location: trimmedLocation } : {}),
      fromYear: fromNum,
      ...(toNum !== undefined ? { toYear: toNum } : {}),
    });
    setName("");
    setLocation("");
    setDebouncedName("");
    setFromYear("");
    setToYear("");
    setSuggestionsOpen(false);
    nameInputRef.current?.focus();
  };

  /**
   * A suggestion is an existing (or already-staged) team's WHOLE name, so it
   * goes into Name with Location cleared: composed, it is byte-for-byte the
   * name commit will look up, which is what makes it link rather than create.
   * Splitting it back into two fields would be a guess, and NEO-236 has no
   * code path that guesses a location.
   */
  const pickSuggestion = (teamName: string) => {
    setName(teamName);
    setLocation("");
    setDebouncedName(teamName);
    setSuggestionsOpen(false);
    nameInputRef.current?.focus();
  };

  return (
    <div className="border border-gray-700 rounded-md bg-gray-900/60 p-2 space-y-1.5">
      {/* NEO-236: Location then Name, in the order the stored name reads. The
          nickname field keeps the whole flexible width — it is the one being
          typed against a typeahead, and it is the only required half. */}
      <div className="flex items-start gap-2">
      <Input
        bare
        type="text"
        value={location}
        placeholder="Location"
        aria-label="Career team location (optional)"
        onChange={(e) => setLocation(e.target.value)}
        className="w-28 shrink-0 p-1.5 text-sm"
      />
      <div className="relative flex-1 min-w-0">
        <Input
          bare
          ref={nameInputRef}
          type="text"
          value={name}
          placeholder="Team name (search or type new)…"
          aria-label="Career team name"
          role="combobox"
          aria-expanded={suggestionsOpen && suggestions.length > 0}
          aria-autocomplete="list"
          onChange={(e) => {
            setName(e.target.value);
            setSuggestionsOpen(true);
          }}
          onFocus={() => setSuggestionsOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSuggestionsOpen(true);
              setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              // Never let Enter here bubble to the wizard's confirm shortcut
              // or add a half-filled entry. If a suggestion is highlighted,
              // fill the name from it; otherwise just close the dropdown.
              e.preventDefault();
              if (suggestionsOpen && suggestions[highlightIdx]) {
                pickSuggestion(suggestions[highlightIdx].name);
              } else {
                setSuggestionsOpen(false);
              }
            } else if (e.key === "Escape") {
              // Swallow Escape only when the dropdown is open, so the wizard's
              // own Escape-to-cancel still works when it isn't.
              if (suggestionsOpen && suggestions.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setSuggestionsOpen(false);
              }
            }
          }}
          className="w-full p-1.5 text-sm"
        />
        {suggestionsOpen && suggestions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Existing team suggestions"
            className="absolute z-10 left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-700 bg-gray-900 shadow-lg"
          >
            {suggestions.map((s, idx) => (
              <li key={s.key} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === highlightIdx}
                  // A staged name is NOT an existing team — it is a team this
                  // batch has not created yet — so it gets its own accessible
                  // name rather than borrowing the saved-team one and lying.
                  aria-label={
                    s.staged
                      ? `Use ${s.name} from this batch`
                      : `Use existing team ${s.name}`
                  }
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => pickSuggestion(s.name)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
                    idx === highlightIdx
                      ? "bg-[#00D558]/20 text-[#00D558]"
                      : "hover:bg-gray-800 text-gray-200"
                  }`}
                >
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.staged && (
                    <span
                      aria-hidden="true"
                      className="shrink-0 rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300"
                    >
                      this batch
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>

      {/* Only once a Location is in play: with none, the composed name is the
          Name field verbatim and echoing it back is noise. */}
      {trimmedLocation && trimmedName && (
        // gray-400, not gray-500: 500 on this panel's gray-900 ground is
        // ~3.6:1, under SC 1.4.3's 4.5:1 floor for normal-size text.
        <p className="text-xs text-gray-400">Shows as: {composedName}</p>
      )}

      {didYouMean && (
        <p className="text-xs text-gray-400">
          {/* NEO-212 (a11y): no aria-label. The visible text IS the name, so
              an "Use {name}" override replaced a readable label with one that
              shares none of its words — a voice-control user saying "Did you
              mean New York Yankees" matched nothing (WCAG 2.2 SC 2.5.3). */}
          <button
            type="button"
            onClick={() => pickSuggestion(didYouMean)}
            className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
          >
            Did you mean {didYouMean}?
          </button>
        </p>
      )}

      <div className="flex items-center gap-2">
        <Input
          bare
          type="number"
          value={fromYear}
          placeholder="From year"
          aria-label="From year"
          min={MIN_CAREER_YEAR}
          max={maxYear}
          onChange={(e) => setFromYear(e.target.value)}
          className="w-24 p-1.5 text-sm"
        />
        <Input
          bare
          type="number"
          value={toYear}
          placeholder="To year (opt)"
          aria-label="To year (optional)"
          min={MIN_CAREER_YEAR}
          max={maxYear}
          onChange={(e) => setToYear(e.target.value)}
          className="w-28 p-1.5 text-sm"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!canAdd}
          aria-label="Add career team"
          className="px-2 py-1.5 text-sm rounded border border-[#00D558] text-[#00D558] hover:bg-[#00D558]/20 focus:bg-[#00D558]/20 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add
        </button>
      </div>
    </div>
  );
}
