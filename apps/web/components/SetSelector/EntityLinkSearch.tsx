import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * NEO-92: single-select existing-player/team search for the review wizard's
 * "Link to Existing…" action. Modeled on PlayerPicker/TeamPicker's
 * list+client-filter typeahead (bulk fetch + substring/prefix-ranked filter,
 * capped to 8 results) but single-select and chip-free — the wizard only
 * ever needs to pick exactly one existing row to link this reviewed name to.
 *
 * Unlike PlayerPicker/TeamPicker, there is no "+ Create" escape hatch here —
 * the wizard's own "Add as New" action already covers that case.
 */
export default function EntityLinkSearch({
  kind,
  sport,
  onSelect,
  onCancel,
}: {
  kind: "player" | "team";
  sport: string;
  onSelect: (id: Id<"players"> | Id<"teams">, name: string) => void;
  onCancel: () => void;
}) {
  const players = useQuery(
    api.players.list,
    kind === "player" ? { sport, limit: 500 } : "skip",
  );
  const teams = useQuery(
    api.teams.list,
    kind === "team" ? { sport, limit: 500 } : "skip",
  );
  const candidates = kind === "player" ? players : teams;

  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    if (!candidates) return [];
    const q = query.trim().toLowerCase();
    return candidates
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (!q) return a.name.localeCompare(b.name);
        const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [candidates, query]);

  const label = kind === "player" ? "player" : "team";

  return (
    <div
      className="border border-gray-700 rounded-md bg-gray-900/60 p-2 space-y-1"
      role="listbox"
      aria-label={`Search existing ${label}s`}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={`Search existing ${label}s…`}
        aria-label={`Search existing ${label}s`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
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
        className="w-full p-1.5 border rounded text-sm dark:bg-gray-900 dark:border-gray-600 focus:border-[#00D558] focus:outline-none"
      />

      {!candidates && (
        <div className="text-xs text-gray-500 px-2 py-1">Loading…</div>
      )}
      {candidates && matches.length === 0 && (
        <div className="text-xs text-gray-500 px-2 py-1">
          No matching {label}s found.
        </div>
      )}
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
