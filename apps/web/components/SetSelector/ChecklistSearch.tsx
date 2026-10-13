import { useRef } from "react";
import { Input } from "../primitives/Input";
import { useDebouncedValue } from "@/src/hooks/useDebouncedValue";

/**
 * NEO-343 — the checklist's search box.
 *
 * A checklist runs to hundreds of rows in a virtualised list, so a card far
 * down it (#6a of 554) cannot be reached by scrolling for — not by an operator
 * and not by an E2E flow. Typing narrows the list live; what a query finds is
 * `lib/cards/card-search.ts`'s rule, and `CardChecklist` owns the filtering.
 * This component is only the control: the field, its clear button, and the
 * count.
 *
 * It sits in the checklist's filter rows (same left-hand label column as
 * "Cross-release" and "Attention"), directly above the list it narrows, so the
 * count lands next to the field that produced it.
 *
 * ## Names (E2E and the a11y audit target these — keep them stable)
 *
 * - the field: `aria-label="Search cards"`, `type="search"` (role searchbox).
 *   No DOM `id`: maestro-web's resource-id is `node.id || ariaLabel`, so an id
 *   would hide the name from an `id:` find. The Input primitive's marker class
 *   is what `inputText` / `pressKey` re-find it by.
 * - the clear button: `aria-label="Clear card search"`, rendered only while
 *   there is something to clear.
 * - the count: a polite live region (`role="status"`), always mounted, text
 *   `"<n> of <total> cards"` while a query is active and empty otherwise.
 *
 * ## Keyboard
 *
 * Typing filters live. Escape clears the query and keeps focus in the field;
 * with nothing to clear, Escape is left alone for whatever is listening above.
 * The clear button returns focus to the field.
 */

/**
 * How long the count must hold still before the live region takes it. Each
 * keystroke changes the count; reading out every intermediate number would
 * queue a string of them while the operator is still typing. Short enough that
 * the visible count still reads as answering the keystroke.
 */
export const SEARCH_COUNT_DEBOUNCE_MS = 400;

export const SEARCH_INPUT_LABEL = "Search cards";
export const SEARCH_CLEAR_LABEL = "Clear card search";
export const SEARCH_PLACEHOLDER = "Number, name, team, feature or marketplace";

export function searchCountText(matched: number, total: number): string {
  return `${matched} of ${total} ${total === 1 ? "card" : "cards"}`;
}

export function searchEmptyText(query: string): string {
  return `No cards match "${query.trim()}".`;
}

export default function ChecklistSearch({
  query,
  onQueryChange,
  onFocus,
  active,
  matchedCount,
  totalCount,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  /** First focus is the cue to load team and player names for matching. */
  onFocus?: () => void;
  /** The query has something to search for (not blank, not only "#"). */
  active: boolean;
  matchedCount: number;
  totalCount: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const liveText = active ? searchCountText(matchedCount, totalCount) : "";
  const settledText = useDebouncedValue(liveText, SEARCH_COUNT_DEBOUNCE_MS);
  // A cleared search clears the count at once; only a changing count waits.
  const countText = liveText === "" ? "" : settledText;

  const clear = () => {
    onQueryChange("");
    inputRef.current?.focus();
  };

  return (
    // role="search": a search landmark, so the field is reachable from a
    // screen reader's landmark list. Unlabelled on purpose — the field's own
    // name says what it searches, and an aria-label here would become a second
    // resource-id for maestro-web.
    <div role="search" className="flex items-center gap-2 flex-wrap mb-3">
      {/* Matches the other filter rows' label column. Visible text "Search" is
          contained in the field's accessible name (SC 2.5.3). */}
      <span
        aria-hidden="true"
        className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide w-24 shrink-0"
      >
        Search
      </span>
      <div className="relative flex-1 min-w-[14rem] max-w-md">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
        >
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10.5 10.5 14 14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <Input
          bare
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || query === "") return;
            // Consumed: the query is cleared and nothing above (a panel's own
            // Escape) should also act on this press.
            e.preventDefault();
            e.stopPropagation();
            onQueryChange("");
          }}
          aria-label={SEARCH_INPUT_LABEL}
          placeholder={SEARCH_PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          // The native search-field "x" is hidden: the clear button below is
          // the one, with a name a screen reader can say.
          className="w-full pl-8 pr-10 py-1.5 text-sm [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={clear}
            aria-label={SEARCH_CLEAR_LABEL}
            // 28px: past the 24px floor (SC 2.5.8) with room to spare inside
            // the field's right padding. No `title` — a tooltip saying less
            // than the name is a second, drifting label.
            className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
          </button>
        )}
      </div>
      {/* role="status" with no explicit aria-live (the role implies polite),
          always mounted so its first text is announced — the house
          live-region pattern. */}
      <p
        role="status"
        data-card-search-status=""
        className="text-xs text-gray-500 dark:text-gray-400 tabular-nums"
      >
        {countText}
      </p>
    </div>
  );
}
