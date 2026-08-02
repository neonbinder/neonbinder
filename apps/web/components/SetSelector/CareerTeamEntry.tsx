import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "../primitives/Input";

/**
 * NEO-92 follow-up: manual career-team entry for a player row in the
 * EntityReviewWizard. When the wizard's background Wikidata lookup finds no
 * career-team history (e.g. "Daulton Varsho" in our testing) — or missed a
 * team it should have — the admin can add `{ team, fromYear, toYear? }`
 * entries by hand, in ADDITION to whatever Wikidata found.
 *
 * The team field is a free-text combobox: it typeaheads against existing
 * teams for this sport (same list+client-filter pattern as EntityLinkSearch /
 * PlayerPicker), but UNLIKE EntityLinkSearch it deliberately accepts a name
 * that matches nothing — that becomes a brand-new team, resolved via
 * get-or-create at commit time (commitCardChecklist's resolveTeamIdByName),
 * exactly how Wikidata-sourced career teams are already resolved. So there's
 * no "+ Create" escape hatch here; typing IS creating.
 *
 * This component owns only its own mini-form state and emits each completed
 * entry via `onAdd`. The staged list of added entries (and its per-row reset)
 * lives in EntityReviewWizard — see there.
 *
 * Client-side year bounds mirror the server validation in
 * entityReviewQueue.recordDecision so bad input is caught before the
 * round-trip; the server re-validates regardless (defense in depth).
 */

// Mirrors MIN_CAREER_YEAR in convex/entityReviewQueue.ts (1869 = first
// openly professional baseball club — a loose lower bound to reject nonsense).
export const MIN_CAREER_YEAR = 1869;

export type CareerTeamDraft = { name: string; fromYear: number; toYear?: number };

export default function CareerTeamEntry({
  sportId,
  onAdd,
}: {
  /** NEO-96: the sport-level selectorOptions row id, not its display name. */
  sportId: Id<"selectorOptions">;
  onAdd: (entry: CareerTeamDraft) => void;
}) {
  const teams = useQuery(api.teams.list, { sportId, limit: 500 });

  const [name, setName] = useState("");
  const [fromYear, setFromYear] = useState("");
  const [toYear, setToYear] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const maxYear = new Date().getFullYear() + 1;

  useEffect(() => {
    setHighlightIdx(0);
  }, [name]);

  const matches = useMemo(() => {
    if (!teams) return [];
    const q = name.trim().toLowerCase();
    if (!q) return [];
    return teams
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [teams, name]);

  const trimmedName = name.trim();
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
    onAdd({ name: trimmedName, fromYear: fromNum, ...(toNum !== undefined ? { toYear: toNum } : {}) });
    setName("");
    setFromYear("");
    setToYear("");
    setSuggestionsOpen(false);
    nameInputRef.current?.focus();
  };

  const pickSuggestion = (teamName: string) => {
    setName(teamName);
    setSuggestionsOpen(false);
    nameInputRef.current?.focus();
  };

  return (
    <div className="border border-gray-700 rounded-md bg-gray-900/60 p-2 space-y-1.5">
      <div className="relative">
        <Input
          bare
          ref={nameInputRef}
          type="text"
          value={name}
          placeholder="Team name (search or type new)…"
          aria-label="Career team name"
          role="combobox"
          aria-expanded={suggestionsOpen && matches.length > 0}
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
              setHighlightIdx((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              // Never let Enter here bubble to the wizard's confirm shortcut
              // or add a half-filled entry. If a suggestion is highlighted,
              // fill the name from it; otherwise just close the dropdown.
              e.preventDefault();
              if (suggestionsOpen && matches[highlightIdx]) {
                pickSuggestion(matches[highlightIdx].name);
              } else {
                setSuggestionsOpen(false);
              }
            } else if (e.key === "Escape") {
              // Swallow Escape only when the dropdown is open, so the wizard's
              // own Escape-to-cancel still works when it isn't.
              if (suggestionsOpen && matches.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setSuggestionsOpen(false);
              }
            }
          }}
          className="w-full p-1.5 text-sm"
        />
        {suggestionsOpen && matches.length > 0 && (
          <ul
            role="listbox"
            aria-label="Existing team suggestions"
            className="absolute z-10 left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-700 bg-gray-900 shadow-lg"
          >
            {matches.map((m, idx) => (
              <li key={m._id} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === highlightIdx}
                  aria-label={`Use existing team ${m.name}`}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => pickSuggestion(m.name)}
                  className={`w-full text-left px-2 py-1 text-sm ${
                    idx === highlightIdx
                      ? "bg-[#00D558]/20 text-[#00D558]"
                      : "hover:bg-gray-800 text-gray-200"
                  }`}
                >
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
