import React, { useEffect, useId, useRef, useState } from "react";
import { Input } from "./Input";

/**
 * NEO-147 — the app's shared ARIA combobox.
 *
 * There were four bespoke typeaheads before this one (SetSelector's
 * `PlayerPicker`, `TeamPicker`, `EntityLinkSearch` and `CareerTeamEntry`), each
 * re-solving keyboard handling and ARIA wiring, and each fetching up to 500
 * rows to filter client-side with `.includes()`. This primitive owns the
 * interaction half of that duplication; the data half is the caller's, which is
 * what lets a server-backed caller like {@link PlayerAutocomplete} exist
 * without this component knowing anything about Convex.
 *
 * Migrating those four call sites is deliberately NOT part of NEO-147 — they
 * work, and each carries its own commit/creation semantics. The generic
 * `items` + `getKey`/`getLabel` shape here is what makes that migration
 * possible later.
 *
 * ## ARIA
 * Implements the ARIA 1.2 combobox pattern properly, which
 * `CareerTeamEntry` (the best of the four, and the model for this) only
 * partially did: it had `role="combobox"` and `aria-autocomplete="list"` but no
 * `aria-controls` and no `aria-activedescendant`, so a screen reader announced
 * that a listbox existed without ever announcing which option was highlighted
 * as the user arrowed through it. Both are wired here, and the options are
 * `<li role="option">` rather than nested `<button>`s — a button inside an
 * option is not a valid child of a listbox and made the arrow-key focus model
 * ambiguous.
 *
 * ## Keyboard
 * Arrow keys move the highlight, Enter confirms, Escape cancels — the
 * behaviour the rest of the app is held to. Escape is swallowed ONLY while the
 * list is open, so a host dialog's own Escape-to-close still works when it is
 * not; that carry-over from `CareerTeamEntry` is load-bearing and easy to lose.
 */

export interface AutocompleteProps<T> {
  /** Current text in the field. Controlled — the caller owns the query. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Results to offer. The caller decides how these are produced. */
  items: T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  /** Optional secondary line, e.g. a player's sport or a team's league. */
  getDescription?: (item: T) => string | undefined;
  onSelect: (item: T) => void;
  /** Accessible name for the input. Also the Maestro selector for it. */
  label: string;
  placeholder?: string;
  /** Shown in place of the list when a search is in flight. */
  loading?: boolean;
  /** Shown when a non-empty query produced nothing. */
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
}

export function Autocomplete<T>({
  query,
  onQueryChange,
  items,
  getKey,
  getLabel,
  getDescription,
  onSelect,
  label,
  placeholder,
  loading = false,
  emptyMessage = "No matches",
  disabled = false,
  className = "",
  inputClassName = "",
}: AutocompleteProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // The highlight indexes into `items`, so it has to reset when the results
  // change. Without that, arrowing to row 8 of a long list and then typing
  // another character leaves the highlight past the end of the new (shorter)
  // list, and Enter selects nothing.
  //
  // Keyed on the CONTENT of `items`, not its identity. A caller that builds
  // the array inline — `items={all.filter(...)}`, which is the natural way to
  // write it — produces a new array on every render, so an identity check
  // would reset the highlight on the very re-render that moving the highlight
  // causes, and arrow keys would appear completely dead.
  //
  // Done during render rather than in an effect: this is React's documented
  // "adjusting state when props change" pattern, it avoids the extra render
  // pass an effect costs, and `react-hooks/set-state-in-effect` correctly
  // rejects the effect form.
  const signature = items.map(getKey).join(" ");
  const [prevSignature, setPrevSignature] = useState(signature);
  if (signature !== prevSignature) {
    setPrevSignature(signature);
    setHighlightIdx(0);
  }

  // Close on an outside click. A combobox left open over other controls
  // swallows the next click, which reads as the UI ignoring input.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const hasResults = items.length > 0;
  // The popup is also shown for the loading and empty states, so the user gets
  // "searching…" / "no matches" rather than a silently absent list.
  const showPopup = open && query.trim().length > 0;
  const activeId = hasResults ? `${listboxId}-opt-${highlightIdx}` : undefined;

  const select = (item: T) => {
    onSelect(item);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <Input
        bare
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        // Tracks whether the POPUP is displayed, not whether it has results.
        // The loading and empty states render a real listbox containing a
        // disabled option, so reporting "collapsed" there would tell a screen
        // reader nothing is shown while sighted users are looking at "No
        // matches" — and it contradicts the `aria-controls` element being in
        // the accessibility tree. ARIA 1.2 defines it as popup visibility.
        aria-expanded={showPopup}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={showPopup ? activeId : undefined}
        autoComplete="off"
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlightIdx((i) => (hasResults ? Math.min(i + 1, items.length - 1) : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Home" && showPopup) {
            e.preventDefault();
            setHighlightIdx(0);
          } else if (e.key === "End" && showPopup) {
            e.preventDefault();
            setHighlightIdx(Math.max(items.length - 1, 0));
          } else if (e.key === "Enter") {
            // Never let Enter bubble to a host form's submit or a dialog's
            // confirm shortcut while a suggestion is highlighted.
            if (showPopup && hasResults) {
              e.preventDefault();
              select(items[highlightIdx]);
            }
          } else if (e.key === "Escape") {
            // Swallow Escape only while the list is open, so a host dialog's
            // Escape-to-cancel still works when it is not.
            if (showPopup) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }
        }}
        // `bare` Input supplies NO geometry — that is its contract, so the
        // caller can drop it into existing markup. This component IS the
        // standalone control, so it has to supply the same geometry the
        // non-bare Input would (`px-3 py-2 text-base`). Without it the
        // placeholder sits flush against the border and the field is shorter
        // than every select beside it.
        className={`w-full px-3 py-2 text-base ${inputClassName}`}
      />

      {showPopup && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-gray-700 bg-gray-900 shadow-lg"
        >
          {!hasResults && (
            // role="option" + aria-disabled, NOT role="presentation": per the
            // ARIA "Presentational Roles Conflict Resolution" rule, a global
            // property like aria-live on a role="presentation" element forces
            // the browser to ignore the presentational role and fall back to
            // implicit semantics instead — which, inside a ul[role=listbox],
            // is undefined/inconsistent across browsers, so the announcement
            // was not reliable. A disabled option is valid listbox content and
            // keeps aria-live's announcement behaviour intact.
            //
            // aria-live so the outcome of a search is announced rather than
            // only rendered — the input keeps focus throughout.
            <li
              role="option"
              aria-disabled="true"
              aria-live="polite"
              className="px-3 py-2 text-sm text-gray-400"
            >
              {loading ? "Searching…" : emptyMessage}
            </li>
          )}
          {items.map((item, idx) => {
            const description = getDescription?.(item);
            return (
              <li
                key={getKey(item)}
                id={`${listboxId}-opt-${idx}`}
                role="option"
                aria-selected={idx === highlightIdx}
                onMouseEnter={() => setHighlightIdx(idx)}
                // onMouseDown, not onClick: the input's blur fires first on a
                // click and would close the list before the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(item);
                }}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  idx === highlightIdx
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "text-gray-200 hover:bg-gray-800"
                }`}
              >
                {getLabel(item)}
                {description && (
                  <span className="ml-2 text-xs text-gray-400">{description}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
