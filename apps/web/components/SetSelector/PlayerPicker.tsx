import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * NEO-25 — multi-select player picker. Mirrors `TeamPicker`'s chip/popover
 * layout (that component's docstring names this as the reuse target), with
 * one addition: teams can only ever be picked from existing candidates, but
 * a card's players are frequently NOT in the `players` table yet (a brand
 * new rookie, or any player on a manually-added custom card, since custom
 * cards never went through the marketplace-sync UnknownEntitiesDialog
 * confirmation flow that normally creates player rows). So alongside typeahead
 * matches, an exact-name miss offers a "+ Create '<name>'" option that calls
 * the already-public `players.findOrCreate` mutation — the same
 * create-if-missing helper the sync pipeline uses — and adds the resulting id
 * as a chip. This is what makes custom cards able to hold players at all: no
 * separate custom-card code path is needed, `findOrCreate` + `updateCard`'s
 * existing `playerIds` arg already covers it.
 *
 * Keyboard contract mirrors TeamPicker:
 *   Tab/Shift+Tab — cycle chips, x buttons, "+ Add" trigger, popover input
 *   Enter on input — select highlighted match (or create, if it's the
 *     highlighted row and no exact match exists)
 *   Up/Down on input — move highlight
 *   Esc on input — close popover without selecting
 *   Backspace on empty input — remove last chip
 */
export default function PlayerPicker({
  value,
  onChange,
  sport,
  disabled,
}: {
  value: Array<Id<"players">>;
  onChange: (next: Array<Id<"players">>) => void;
  /** Sport to filter typeahead candidates + tag a newly-created player. */
  sport?: string;
  disabled?: boolean;
}) {
  const selectedRows = useQuery(api.players.getManyByIds, { ids: value });
  const candidates = useQuery(
    api.players.list,
    sport ? { sport, limit: 500 } : { limit: 500 },
  );
  const findOrCreate = useMutation(api.players.findOrCreate);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

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
    return candidates
      .filter((c) => !selectedSet.has(c._id as unknown as string))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!q) return a.name.localeCompare(b.name);
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [candidates, query, value]);

  // An exact (case-insensitive) match already exists — no need to offer
  // "create", it'd just be a confusing duplicate-name affordance.
  const hasExactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !candidates) return true;
    return candidates.some((c) => c.name.toLowerCase() === q);
  }, [query, candidates]);

  const showCreateOption =
    query.trim().length > 0 && !hasExactMatch && !creating;

  const removeChip = (idToRemove: Id<"players">) => {
    if (disabled) return;
    onChange(value.filter((id) => id !== idToRemove));
  };

  const addChip = (id: Id<"players">) => {
    if (disabled) return;
    if (value.includes(id)) return;
    onChange([...value, id]);
    setQuery("");
    setHighlightIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

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

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  // Highlight index spans matches PLUS the trailing "create" row when shown.
  const rowCount = matches.length + (showCreateOption ? 1 : 0);

  return (
    <div className="flex flex-wrap gap-1.5 items-center" aria-label="Player picker">
      {value.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-xs"
        >
          <span
            className="truncate max-w-[140px]"
            aria-label={`Player: ${labelById.get(id as unknown as string) ?? "Loading…"}`}
          >
            {labelById.get(id as unknown as string) ?? "Loading…"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => removeChip(id)}
            aria-label={`Remove player ${labelById.get(id as unknown as string) ?? id}`}
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
          onClick={() => setPopoverOpen(true)}
          aria-label="Add player"
          aria-expanded={popoverOpen}
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-600 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
        >
          + Add player
        </button>

        {popoverOpen && (
          <div
            className="absolute left-0 top-full mt-1 z-10 w-64 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-2 space-y-1"
            role="listbox"
            aria-label="Player typeahead results"
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search or add a player..."
              aria-label="Search players"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
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
                  e.preventDefault();
                  removeChip(value[value.length - 1]);
                }
              }}
              className="w-full p-1.5 border rounded text-sm dark:bg-gray-900 dark:border-gray-600 focus:border-[#00D558] focus:outline-none"
            />

            {!candidates && (
              <div className="text-xs text-gray-500 px-2 py-1">Loading…</div>
            )}
            {candidates &&
              matches.length === 0 &&
              query.trim().length === 0 && (
                <div className="text-xs text-gray-500 px-2 py-1">
                  Start typing a player name…
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
              </button>
            ))}
            {showCreateOption && (
              <button
                type="button"
                disabled={creating}
                onClick={() => void createAndAdd()}
                onMouseEnter={() => setHighlightIdx(matches.length)}
                aria-label={`Create player ${query.trim()}`}
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
