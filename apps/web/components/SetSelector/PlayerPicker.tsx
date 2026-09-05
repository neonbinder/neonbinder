import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "../primitives/Input";

/**
 * NEO-220 — the four container-level accessible names, overridable per
 * instance. Every one of them is present whatever the picker's state, and
 * NONE of them carries a player's name, so they are exactly the labels that
 * collide when two PlayerPickers are on screen at once — which is now
 * reachable in `CardChecklist`, where the card drawer and the quick-add form
 * mount one each and neither hides the other.
 *
 * Whole strings rather than a prefix/suffix knob, deliberately. Maestro
 * selects by `resource-id` (= the aria-label) with a REGEX FIND, so a derived
 * label that contains the base one — "Add player to new card" — would make the
 * drawer's own `id: "Add player"` match BOTH elements: strictly worse than the
 * collision it set out to fix. Every override below is checked to share no
 * substring with its default in either direction.
 *
 * Chip and option labels ("Player: Mike Trout", "Add Mike Trout", "Create
 * player X") are deliberately NOT overridable: they carry the player's name,
 * which is the disambiguator, and the existing drawer flows target them that
 * way.
 */
export type PlayerPickerLabels = {
  /** The chip row's own name. Default "Player picker". */
  root: string;
  /** The "+ Add player" trigger. Default "Add player". */
  trigger: string;
  /** The popover's search input. Default "Search players". */
  search: string;
  /** The popover listbox. Default "Player typeahead results". */
  results: string;
};

const DEFAULT_LABELS: PlayerPickerLabels = {
  root: "Player picker",
  trigger: "Add player",
  search: "Search players",
  results: "Player typeahead results",
};

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
 *
 * NEO-220 — the three dismissal/feedback behaviours `TeamPicker` grew in
 * NEO-208 are ported here verbatim, because this picker now sits in the SAME
 * place that forced them: `CardChecklist`'s quick-add form, immediately ABOVE
 * the Team row and the Add/Cancel buttons. Its popover is `absolute top-full
 * w-64 z-10`, so an open one physically covers all three. See
 * `handleRootBlur` (WCAG 2.4.11), the pointerdown-outside effect, and
 * `createError` below.
 */
export default function PlayerPicker({
  value,
  onChange,
  sportId,
  disabled,
  labels = DEFAULT_LABELS,
}: {
  value: Array<Id<"players">>;
  onChange: (next: Array<Id<"players">>) => void;
  /**
   * NEO-96: the sport-level selectorOptions row id, not its display name.
   * Filters typeahead candidates and tags a newly-created player. When absent,
   * listing still works but creating is disabled — the old `sport ?? ""`
   * fallback wrote players no query could find again.
   */
  sportId?: Id<"selectorOptions">;
  disabled?: boolean;
  /**
   * Accessible names for this instance's four container controls. Omit on the
   * one picker a screen can be sure of having only one of; pass all four when a
   * second picker can be mounted alongside it. All four together, never a
   * subset — a half-renamed instance is a collision you then have to find.
   */
  labels?: PlayerPickerLabels;
}) {
  const selectedRows = useQuery(api.players.getManyByIds, { ids: value });
  const candidates = useQuery(
    api.players.list,
    sportId ? { sportId, limit: 500 } : { limit: 500 },
  );
  const findOrCreate = useMutation(api.players.findOrCreate);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  /**
   * NEO-220 — why the last "+ Create" attempt was refused, shown inline
   * beside the search input. Ported from `TeamPicker` (NEO-208), where the
   * handler being a bare try/finally meant a refusal landed as a silent
   * no-op — "Creating…" flipped back, no chip appeared, no reason given —
   * plus an unhandled rejection in the console.
   *
   * Safe to render verbatim: NEO-220 gave `players.findOrCreate` the same
   * refusals its `teams` twin carries (a name over the 120-char cap, a
   * `sportId` that is not a SPORT row, an empty name), and every one of those
   * messages names a LENGTH or a category, never the typed content. Anything
   * that is not a ConvexError gets the generic fallback instead, because
   * production redacts a plain Error to "Server Error" (see
   * `userFacingMessage`).
   */
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- typeahead highlight resets with the query it indexes into
    setHighlightIdx(0);
  }, [query]);

  useEffect(() => {
    if (popoverOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [popoverOpen]);

  /**
   * Close on a pointerdown outside the picker — see `TeamPicker`, where the
   * same effect is documented at length. This picker had no outside-close at
   * all, which was survivable while its only homes were the card drawer and
   * `UnreviewedNameFixer` (both of which have room below the popover). In the
   * quick-add form it is not: an operator who opens this popover and then
   * reaches for the Team picker or Add/Cancel is clicking at a control the
   * popover is drawn over.
   *
   * `pointerdown`, not `click`, so the popover is gone before the click
   * resolves underneath it. Deliberately NOT `closePopover`, which would pull
   * focus back to the trigger mid-press.
   */
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (e: Event) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
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

  // NEO-96: no sport row → no create. See TeamPicker for the rationale.
  //
  // NEO-220 (focus-park pattern): deliberately no longer gated on `!creating`.
  // This row used to unmount the instant `creating` flipped true, which parks
  // focus — a click had just landed on the button — onto <body>.
  // `handleRootBlur` below closes the popover on exactly that signal, so it
  // would fire mid-request and clear `createError` before the awaited
  // `findOrCreate` had even settled, leaving the refusal invisible. The row
  // stays mounted and announces itself `aria-disabled` instead; the `creating`
  // guard inside `createAndAdd` is what actually blocks a second submit.
  const showCreateOption =
    query.trim().length > 0 && !hasExactMatch && !!sportId;

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
    // `creating` guard: re-entry protection now that the button stays mounted
    // (and clickable — `aria-disabled`, not `disabled`) for the request.
    if (!name || disabled || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (!sportId) return;
      const id = await findOrCreate({ name, sportId });
      addChip(id);
    } catch (err) {
      // The ConvexError's `data`, never `.message`: production redacts a plain
      // Error, and a surviving message arrives wrapped in "[CONVEX M(...)]
      // [Request ID: ...]" noise. The query is left alone so "+ Create" stays
      // available for a retry after a fix.
      setCreateError(userFacingMessage(err, "Could not create player."));
      // Land the operator back in the input, which is what a retry needs to
      // edit — not on the button they just pressed verbatim.
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setCreating(false);
    }
  };

  const closePopover = () => {
    setPopoverOpen(false);
    setQuery("");
    setCreateError(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  /**
   * Close on Tab (or Shift+Tab) out of the picker while the popover is open —
   * the keyboard counterpart to the pointerdown handler above, and WCAG 2.4.11
   * (Focus Not Obscured) in the quick-add form specifically: the popover has
   * no focus trap, so Tab from its last row walks focus onto whatever the
   * caller placed next in the DOM — there, the Team picker's "+ Add team"
   * trigger and then Add/Cancel, all of which this `absolute … z-10` popover
   * is drawn over.
   *
   * Checked via a deferred read of `document.activeElement` rather than the
   * blur event's `relatedTarget`, which is unreliable across environments
   * (notably jsdom, where it comes back `null` for an ordinary focus move).
   * Deliberately NOT `closePopover`: that steals focus back to the trigger,
   * fighting the Tab the operator just pressed.
   */
  const handleRootBlur = () => {
    // The "+ Create" row no longer unmounts mid-request (see
    // `showCreateOption`), so this should not fire during a create at all —
    // guarded anyway, so a future change to that row's mount behaviour cannot
    // silently reopen the race.
    if (!popoverOpen || creating) return;
    setTimeout(() => {
      if (rootRef.current?.contains(document.activeElement)) return;
      setPopoverOpen(false);
      setQuery("");
      setCreateError(null);
    }, 0);
  };

  // Highlight index spans matches PLUS the trailing "create" row when shown.
  const rowCount = matches.length + (showCreateOption ? 1 : 0);

  return (
    <div
      ref={rootRef}
      className="flex flex-wrap gap-1.5 items-center"
      aria-label={labels.root}
      onBlur={handleRootBlur}
    >
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
          aria-label={labels.trigger}
          aria-expanded={popoverOpen}
          className="px-2 py-0.5 text-xs rounded border border-dashed border-gray-400 dark:border-gray-600 hover:border-[#00D558] focus:border-[#00D558] focus:outline-none text-gray-600 dark:text-gray-300"
        >
          + Add player
        </button>

        {popoverOpen && (
          <div
            className="absolute left-0 top-full mt-1 z-10 w-64 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg p-2 space-y-1"
            role="listbox"
            aria-label={labels.results}
          >
            <Input
              bare
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search or add a player..."
              aria-label={labels.search}
              onChange={(e) => {
                // The refusal described the name that was in this box; the
                // next keystroke makes it stale, so it goes with the query.
                setCreateError(null);
                setQuery(e.target.value);
              }}
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
              className="w-full p-1.5 text-sm"
            />

            {createError && (
              // a11y: NOT the brand `#FF2EB3` — measured against this
              // popover's own `bg-white dark:bg-gray-800` it is 3.34:1 /
              // 4.4:1, both under WCAG 1.4.3's 4.5:1 floor for normal text.
              // Same-hue darkened/lightened pair CardDetailPanel's
              // `parentError` and TeamPicker already use: 5.55:1 on white,
              // 5.87:1 on dark:bg-gray-800.
              <p
                role="alert"
                className="px-2 py-1 text-xs text-[#C2178A] dark:text-[#FF6FCB]"
              >
                {createError}
              </p>
            )}

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
                // NEO-220: `aria-disabled`, not `disabled` — the row stays
                // mounted and focusable for the request (see
                // `showCreateOption`). Native `disabled` force-blurs a focused
                // element straight to <body>, which is the same focus-park
                // pattern documented on `TitleFixer`'s Save button and would
                // reproduce the very bug this avoids.
                aria-disabled={creating || undefined}
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
