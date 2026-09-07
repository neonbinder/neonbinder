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
import { MIN_CAREER_YEAR, maxCareerYear } from "../../lib/players/career-years";

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
 * ## NEO-236 — ONE box, and creating happens on its own step
 *
 * Jason, 2026-09-05: "we should also remove the Location box from New Players
 * as we should only be selecting existing teams or entering it in the singular
 * field which would trigger that new team dialog."
 *
 * An earlier pass put a Location field beside the name here. It asked the
 * operator to split a team while they were dating a stint, in a form with no
 * room for the League, and it asked it in a different place from every other
 * team creation in the product. The field is gone: this is a single team box
 * again, and a name that matches nothing STAGES a New Team step in the wizard
 * — Location, Name and League, answered where every other new team is answered.
 *
 * That is why typing still creates and there is still no "+ Create" row here:
 * what this component reports upward is a STINT, and the team it names is
 * either one we already hold or one the batch is about to ask about.
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

// NEO-254: re-exported from the one place the number now lives, rather than
// mirrored by hand. The comment this replaced pointed at the file it was
// copying — which is exactly how the Players page's copy drifted to 1850
// without anybody noticing the two validators had stopped agreeing.
export { MIN_CAREER_YEAR } from "../../lib/players/career-years";

/** See `PlayerAutocomplete`'s SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const SEARCH_DEBOUNCE_MS = 200;

/** How many suggestions the dropdown shows, staged and searched combined. */
const MAX_SUGGESTIONS = 8;

/**
 * NEO-236: `name` is the WHOLE team name as the operator typed or picked it —
 * "San Diego Padres", not "Padres". Splitting it into a Location and a nickname
 * is the New Team step's question, asked once, where the League is asked too.
 */
export type CareerTeamDraft = {
  name: string;
  fromYear: number;
  toYear?: number;
};

/** One dropdown row. `staged` drives the ordering and the dedupe — never a
 *  visible difference; see the option's `aria-label`. */
type Suggestion = { key: string; name: string; staged: boolean };

export default function CareerTeamEntry({
  sportId,
  stagedNames,
  onAdd,
  onDirtyChange,
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
  /**
   * NEO-236 — "the operator has started filling this in".
   *
   * The wizard's walk may revise its own choice of row while nobody has begun
   * work on it (teams jump the queue as their lookups land). Half-typed text in
   * THIS form is work, and it lives here rather than in the wizard, so the
   * wizard cannot see it without being told. Fires on the transitions only, not
   * per keystroke.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [debouncedName, setDebouncedName] = useState("");
  const [fromYear, setFromYear] = useState("");
  const [toYear, setToYear] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  /** Where focus goes after a suggestion is taken — the next thing to fill in. */
  const fromYearRef = useRef<HTMLInputElement>(null);
  /** The input + its listbox. Blur out of THIS closes the list; blur between
   *  its two halves does not. */
  const comboRef = useRef<HTMLDivElement>(null);

  const maxYear = maxCareerYear();

  /**
   * Anything typed into any of the three fields counts. A name alone is enough:
   * it is the half the operator cannot get back by re-picking a suggestion.
   */
  const dirty =
    name.trim() !== "" || fromYear.trim() !== "" || toYear.trim() !== "";

  /*
   * Emitted on the TRANSITIONS only, and through a ref rather than a dep.
   *
   * The parent's handler is an inline arrow, so it is a new function every
   * render; depending on it would fire this effect every render, and since the
   * handler sets parent state that is a render loop. Holding it in a ref and
   * gating on the value's own change makes the call count equal to the number
   * of times the answer actually changed — twice per stint, typically.
   */
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  const lastDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastDirtyRef.current === dirty) return;
    lastDirtyRef.current = dirty;
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedName(name), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [name]);

  const trimmedName = name.trim();
  const debouncedTrimmed = debouncedName.trim();
  /** What this entry will match against, and what a New Team step would be
   *  staged for: the whole typed name. */
  const composedName = trimmedName;

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
      fromYear: fromNum,
      ...(toNum !== undefined ? { toYear: toNum } : {}),
    });
    setName("");
    setDebouncedName("");
    setFromYear("");
    setToYear("");
    setSuggestionsOpen(false);
    // Safe to refocus now: the list opens on TYPING, not on focus. See the
    // note on `pickSuggestion`.
    nameInputRef.current?.focus();
  };

  /**
   * A suggestion is an existing (or already-staged) team's WHOLE name, and it
   * goes into the box verbatim — byte-for-byte the name the prelude will look
   * up, which is what makes it link rather than create.
   *
   * ## Why taking a suggestion used to leave the list open
   *
   * Jason, 2026-09-06, on "Buffalo Sabres": "I can't find any way to dismiss
   * the green list." This closed the list and then called
   * `nameInputRef.current.focus()` — and the input carried
   * `onFocus={() => setSuggestionsOpen(true)}`, so the refocus immediately
   * reopened what the line above had just closed. The list then covered the
   * From/To year fields underneath, which are the very next thing to fill in,
   * and nothing could dismiss it: blur was unhandled too.
   *
   * The `onFocus` auto-open is GONE rather than worked around with a
   * suppression flag. Focusing a text box should not drop a list over the
   * fields below it; the list belongs to typing (and to ArrowDown, for a
   * keyboard operator who wants it back). That removes the whole class of bug
   * rather than this one instance of it.
   *
   * Focus lands on FROM YEAR, not back on the name: the team is chosen, and
   * the stint is not finished until it has a year.
   */
  const pickSuggestion = (teamName: string) => {
    setName(teamName);
    setDebouncedName(teamName);
    setSuggestionsOpen(false);
    fromYearRef.current?.focus();
  };

  /**
   * Focus left the combobox entirely — close the list.
   *
   * Deferred, and checked against `document.activeElement` rather than the
   * event's `relatedTarget`: `relatedTarget` on blur/focusout is unreliable
   * across environments (notably jsdom, where it comes back null for an
   * ordinary focus move), so the read has to happen after focus has actually
   * settled. Same reasoning, same shape as `TeamPicker.handleRootBlur`.
   *
   * Scoped to the combobox, so moving between the input and one of its own
   * options does not count as leaving.
   */
  const handleComboBlur = () => {
    setTimeout(() => {
      if (comboRef.current?.contains(document.activeElement)) return;
      setSuggestionsOpen(false);
    }, 0);
  };

  return (
    <div className="border border-gray-700 rounded-md bg-gray-900/60 p-2 space-y-1.5">
      {/* NEO-236: one box. The team's Location is asked on its own New Team
          step, which is also the only place its League can be asked. */}
      <div className="relative" ref={comboRef} onBlur={handleComboBlur}>
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
              /*
               * NEO-220 — Escape in this field NEVER reaches the wizard.
               *
               * It used to be swallowed only while the dropdown had
               * suggestions in it, so Escape on a typed name that matched
               * nothing — the exact case this field exists for, a team
               * Wikidata and `teams` have both never heard of — bubbled to the
               * dialog root and cancelled the whole review batch. The operator
               * pressed a key that means "clear this" and lost every decision
               * they had made.
               *
               * Now it steps out one level at a time and stops there: close
               * the dropdown if it is open, otherwise clear the name. Both are
               * local, both are what Escape means in a combobox, and neither
               * can reach past this field. `stopPropagation` unconditionally,
               * so the guarantee does not depend on which branch ran.
               */
              e.preventDefault();
              e.stopPropagation();
              if (suggestionsOpen && suggestions.length > 0) {
                setSuggestionsOpen(false);
              } else if (name !== "") {
                setName("");
                setDebouncedName("");
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
                  /*
                   * NEO-236 — ONE name for every suggestion, saved or staged.
                   *
                   * Jason, 2026-09-06, on the tag this used to carry: "'not
                   * saved yet' is equally confusing. Do we need anything there
                   * at all? Is there any value in telling the user anything
                   * about that?" There is not. Whether a team already exists or
                   * this review is about to create it changes nothing the
                   * operator can act on here — picking it does the same thing
                   * either way, and the difference is bookkeeping we were
                   * narrating at them.
                   *
                   * `staged` still earns its keep: it orders these rows (a
                   * pending name is the one you cannot find any other way) and
                   * it dedupes them against the saved half. It just no longer
                   * says anything.
                   */
                  aria-label={`Use ${s.name}`}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => pickSuggestion(s.name)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
                    idx === highlightIdx
                      ? "bg-[#00D558]/20 text-[#00D558]"
                      : "hover:bg-gray-800 text-gray-200"
                  }`}
                >
                  <span className="flex-1 truncate">{s.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
          ref={fromYearRef}
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
