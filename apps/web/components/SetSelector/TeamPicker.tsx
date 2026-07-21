import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * NEO-26 — multi-select-capable team picker, defaults to single.
 *
 * Renders the selected teams as a chip row (one chip per `teams._id`)
 * plus a single "+ Add team" trigger that opens a typeahead popover.
 * Card edit forms always commit the full array, even when it's
 * length 1, so the multi-team-rookie / "Traded" subset case is
 * handled without any special branching.
 *
 * Sibling component: `<PlayerPicker />` (NEO-25) mirrors this layout.
 *
 * Create-new (added alongside the card-level feature audit, 2026-07-16):
 * neither marketplace's checklist-sync endpoint carries team data — BSC's
 * own adapter comment says its catalog endpoint doesn't have it ("lives on
 * listings, not the catalog template"), while SportLots' adapter comment
 * assumes BSC supplies it instead — so in practice NEITHER source ever
 * populates the `teams` table, and this picker's candidate pool was
 * routinely empty. Building real team resolution (Wikidata career-history
 * lookup, per BSC's own deferred-to-listing-time plan) is a separate, much
 * larger effort. This picker instead gets the same "+ Create" escape hatch
 * PlayerPicker already has via the already-public `teams.findOrCreate` —
 * an operator is never blocked waiting on sync to populate a team.
 *
 * Keyboard contract (per `feedback_keyboard_navigation`):
 *   Tab/Shift+Tab — cycle chips, × buttons, "+ Add" trigger, popover input
 *   Enter on input — select highlighted match (or create, if highlighted
 *     and no exact match exists)
 *   ↑/↓ on input — move highlight
 *   Esc on input — close popover without selecting
 *   Backspace on empty input — remove last chip
 */
export default function TeamPicker({
  value,
  onChange,
  sport,
  disabled,
}: {
  value: Array<Id<"teams">>;
  onChange: (next: Array<Id<"teams">>) => void;
  /**
   * Sport to filter the typeahead candidates by. When undefined we
   * fall back to the full teams list — usable but slower; callers
   * should always pass it when they can resolve the ancestor sport.
   */
  sport?: string;
  disabled?: boolean;
}) {
  // Resolve currently-selected ids → display rows for the chip labels.
  // Convex deduplicates this between sibling pickers on the same page.
  const selectedRows = useQuery(api.teams.getManyByIds, { ids: value });

  // Candidate pool. `list` caps at 100 by default; for the per-sport
  // typeahead that's plenty (every league hits well below). The pool
  // is filtered + ranked client-side in the popover.
  const candidates = useQuery(
    api.teams.list,
    sport ? { sport, limit: 500 } : { limit: 500 },
  );
  const findOrCreate = useMutation(api.teams.findOrCreate);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Reset highlight whenever the typed query changes.
  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  // Auto-focus the input the moment the popover opens.
  useEffect(() => {
    if (popoverOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [popoverOpen]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of selectedRows ?? []) {
      map.set(row._id as unknown as string, row.name);
    }
    return map;
  }, [selectedRows]);

  const matches = useMemo(() => {
    if (!candidates) return [];
    const selectedSet = new Set(value as unknown as string[]);
    const q = query.trim().toLowerCase();
    const filtered = candidates
      .filter((c) => !selectedSet.has(c._id as unknown as string))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      // Rank exact-prefix matches above substring matches so typing
      // "New" surfaces "New York Yankees" before "New Orleans Saints"
      // before "Newark Eagles" before random substring hits.
      .sort((a, b) => {
        if (!q) return a.name.localeCompare(b.name);
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    return filtered;
  }, [candidates, query, value]);

  // An exact (case-insensitive) match already exists — no "create" offer,
  // it'd just be a confusing duplicate-name affordance.
  const hasExactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !candidates) return true;
    return candidates.some((c) => c.name.toLowerCase() === q);
  }, [query, candidates]);

  const showCreateOption =
    query.trim().length > 0 && !hasExactMatch && !creating;

  const createAndAdd = async () => {
    const name = query.trim();
    if (!name || disabled) return;
    setCreating(true);
    try {
      const id = await findOrCreate({ name, sport: sport ?? "" });
      addChip(id);
    } finally {
      setCreating(false);
    }
  };

  const removeChip = (idToRemove: Id<"teams">) => {
    if (disabled) return;
    onChange(value.filter((id) => id !== idToRemove));
  };

  const addChip = (id: Id<"teams">) => {
    if (disabled) return;
    if (value.includes(id)) return;
    onChange([...value, id]);
    setQuery("");
    setHighlightIdx(0);
    // Stay open so the user can pick a second team on a dual-team
    // card without re-clicking the trigger. Re-focus the input.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    // Return focus to the trigger so Tab order stays predictable.
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <div
      className="flex flex-wrap gap-1.5 items-center"
      aria-label="Team picker"
    >
      {value.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-xs"
        >
          <span className="truncate max-w-[140px]" aria-label={`Team: ${labelById.get(id as unknown as string) ?? "Loading…"}`}>
            {labelById.get(id as unknown as string) ?? "Loading…"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeChip(id)}
            aria-label={`Remove team ${labelById.get(id as unknown as string) ?? id}`}
            className="text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
          >
            ×
          </button>
        </span>
      ))}

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          // Always opens. Closing happens via Escape (on the input) or
          // clicking a match (addChip stays open intentionally so the
          // user can pick a second team for a multi-team card; final
          // close is the user's Escape or selecting then explicitly
          // moving on). Earlier code used `setPopoverOpen((v) => !v)`
          // — a toggle — which silently closed the popover when the
          // test (or a real user) re-tapped "+ Add team" expecting
          // it to keep opening.
          onClick={() => setPopoverOpen(true)}
          aria-label="Add team"
          aria-expanded={popoverOpen}
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-600 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
        >
          + Add team
        </button>

        {popoverOpen && (
          <div
            className="absolute left-0 top-full mt-1 z-10 w-64 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-2 space-y-1"
            role="listbox"
            aria-label="Team typeahead results"
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search or add a team..."
              aria-label="Search teams"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const rowCount = matches.length + (showCreateOption ? 1 : 0);
                if (e.key === "Escape") {
                  e.preventDefault();
                  closePopover();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.min(i + 1, rowCount - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (highlightIdx < matches.length) {
                    const pick = matches[highlightIdx];
                    if (pick) addChip(pick._id);
                  } else if (showCreateOption) {
                    void createAndAdd();
                  }
                } else if (
                  e.key === "Backspace" &&
                  query.length === 0 &&
                  value.length > 0
                ) {
                  // Reasonable shortcut: empty input + backspace
                  // removes the most recently added chip.
                  e.preventDefault();
                  removeChip(value[value.length - 1]);
                }
              }}
              className="w-full p-1.5 border rounded text-sm dark:bg-gray-900 dark:border-gray-600 focus:border-[#00D558] focus:outline-none"
            />

            {!candidates && (
              <div className="text-xs text-gray-500 px-2 py-1">Loading…</div>
            )}
            {candidates && matches.length === 0 && query.trim().length > 0 && (
              <div className="text-xs text-gray-500 px-2 py-1">
                No matches.
              </div>
            )}
            {candidates && matches.length === 0 && query.trim().length === 0 && (
              <div className="text-xs text-gray-500 px-2 py-1">
                Start typing a team name…
              </div>
            )}
            {matches.map((m, idx) => (
              <button
                key={m._id}
                type="button"
                onClick={() => addChip(m._id)}
                onMouseEnter={() => setHighlightIdx(idx)}
                aria-label={`Add ${m.name}`}
                role="option"
                aria-selected={idx === highlightIdx}
                className={`w-full text-left px-2 py-1 text-sm rounded ${
                  idx === highlightIdx
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {m.name}
                {(m.city || m.league) && (
                  <span className="ml-2 text-[10px] text-gray-500">
                    {[m.city, m.league].filter(Boolean).join(", ")}
                  </span>
                )}
              </button>
            ))}
            {showCreateOption && (
              <button
                type="button"
                disabled={creating}
                onClick={() => void createAndAdd()}
                onMouseEnter={() => setHighlightIdx(matches.length)}
                aria-label={`Create team ${query.trim()}`}
                role="option"
                aria-selected={highlightIdx === matches.length}
                className={`w-full text-left px-2 py-1 text-sm rounded border-t border-gray-200 dark:border-gray-700 ${
                  highlightIdx === matches.length
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
              >
                {creating ? "Creating…" : `+ Create "${query.trim()}"`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
