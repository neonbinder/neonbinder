import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { FunctionReference } from "convex/server";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";

export type SelectorItem = { _id: string; [key: string]: unknown };

// Stable, module-level display accessor shared by every column wrapper
// (Sport / Year / Manufacturer / Set / SetVariant / Variant / Parallel all
// display `item.value`). Passing this ONE reference instead of a fresh inline
// arrow per render keeps `getDisplayName` referentially stable, so the
// `sortedItems` useMemo below actually memoizes across re-renders (NEO-85). An
// inline arrow would give the memo a new dep identity every render, silently
// defeating it.
export const displayByValue = (item: SelectorItem) => item.value as string;

type EntitySelectorProps = {
  title: string;
  query: FunctionReference<"query">;
  queryArgs?: Record<string, unknown>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  getDisplayName: (item: SelectorItem) => string;
  getDescription?: (item: SelectorItem) => string | undefined;
  selectedColor: string;
  // Returns true if the item is a terminal node — i.e., selecting it
  // shows a card checklist. Only terminal items render SL/BSC pills,
  // since the platform mappings only become user-meaningful at the
  // checklist boundary. Defaults to false everywhere.
  isItemTerminal?: (item: SelectorItem) => boolean;
};

function getPlatformData(item: SelectorItem): {
  sportlots?: string;
  bsc?: string | string[];
} | null {
  const pd = item.platformData;
  if (pd && typeof pd === "object") {
    return pd as { sportlots?: string; bsc?: string | string[] };
  }
  return null;
}

/**
 * NEO-260 — the option rows of one column, in DOM order.
 *
 * Read out of the DOM rather than kept in a ref array because the rows are
 * rebuilt on every filter keystroke and the array order is the only thing the
 * arrow keys care about. `querySelectorAll` on THIS column's own listbox node
 * can never reach a sibling column's rows, which a document-wide query could.
 */
const OPTION_SELECTOR = '[role="option"]';

function optionsIn(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(OPTION_SELECTOR));
}

/**
 * Left/Right across the cascade.
 *
 * The columns are siblings inside the `[data-set-selector-scroll]` row that
 * `components/modules/SetSelector.tsx` owns, and each open one contributes
 * exactly one `role="listbox"`. So "the next column" is "the next listbox in
 * that row" — no prop plumbing, and a collapsed column (which renders no
 * listbox) is simply skipped, which is the right behaviour: there is nothing to
 * move onto in a column that is showing a single collapsed card.
 *
 * Focus lands on that column's roving stop (`tabIndex === 0`) so arrowing away
 * and back returns to where you were. Deliberately NOT `preventScroll`: unlike
 * the focus PARKS — which fire on unmount and must not fight EntityColumn's own
 * reveal scrolling — this is an explicit navigation the operator asked for, and
 * a column they have just moved into needs to be on screen.
 */
function focusAdjacentColumn(list: HTMLElement | null, delta: 1 | -1): boolean {
  if (!list) return false;
  const row = list.closest<HTMLElement>("[data-set-selector-scroll]");
  if (!row) return false;
  const lists = Array.from(
    row.querySelectorAll<HTMLElement>('[role="listbox"]'),
  );
  const here = lists.indexOf(list);
  if (here < 0) return false;
  const target = lists[here + delta];
  if (!target) return false;
  const options = optionsIn(target);
  const stop = options.find((o) => o.tabIndex === 0) ?? options[0];
  if (!stop) return false;
  stop.focus();
  return true;
}

/**
 * How long a typeahead buffer survives between keystrokes. 500ms is the
 * WAI-ARIA APG's own listbox figure; longer and a second, unrelated jump feels
 * like the first one mis-fired.
 */
const TYPEAHEAD_RESET_MS = 500;

function EntitySelector({
  title,
  query,
  queryArgs,
  selectedId,
  onSelect,
  expanded,
  setExpanded,
  getDisplayName,
  getDescription,
  selectedColor,
  isItemTerminal,
}: EntitySelectorProps) {
  const items = useQuery(query, queryArgs);
  const [searchFilter, setSearchFilter] = useState("");

  // NEO-260 — the column is ONE tab stop, and the arrows move inside it.
  //
  // ## The defect
  //
  // Every option row was its own tab stop. Past a synced Sports list that is
  // ~25 Tab presses to reach the Years column, and six columns deep the cascade
  // is not operable by keyboard at all even though every control in it is
  // technically reachable. A list of mutually-exclusive choices is a LISTBOX,
  // and a listbox is one stop with arrow keys inside it.
  //
  // ## Roving tabindex, not aria-activedescendant
  //
  // Both satisfy the ARIA pattern; the roving tabindex is the one that survives
  // this app's E2E driver and this component's existing behaviour:
  //
  //  * **DOM focus stays on the row.** maestro-web's `pressKey` re-finds
  //    `document.activeElement` by an XPath built from ancestor CLASS names
  //    (`.maestro/README.md`), then dispatches there. With
  //    `aria-activedescendant` the real focus would sit on the listbox
  //    container — and every column's container carries the SAME Tailwind class
  //    string, so two open columns would collapse into one XPath and Selenium
  //    would return the first. Enter aimed at a Years row would fire in Sports.
  //  * **`activateOnEnter` keeps working unchanged.** It lives on the row and
  //    needs the keydown to originate there; with activedescendant the key
  //    never reaches the row at all.
  //  * **`:focus-visible` lands on the thing that looks focused.** With
  //    activedescendant the ring has to be faked from an attribute, and a
  //    faked ring is exactly the class of bug this ticket exists to close.
  //
  // The roving stop is tracked by ITEM ID rather than index so it survives the
  // search filter re-ordering the list under it.
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typeaheadRef = useRef<{ buffer: string; at: number }>({
    buffer: "",
    at: 0,
  });

  const selected = items?.find(
    (item: SelectorItem) => item._id === selectedId,
  );

  // Sort items by their display names. Memoized on `items` (and the
  // `getDisplayName` reader the comparator uses) so an unrelated re-render —
  // e.g. a Convex query invalidation from a sibling column — reuses the same
  // sorted array reference instead of rebuilding it. Rebuilding a fresh array
  // on every render churns the list and reflows the column under Maestro's
  // coordinate taps (NEO-85). Declared before the early return so hook order
  // stays stable when `items` is still loading.
  const sortedItems = useMemo(() => {
    if (!items) return [];
    return [...items].sort((a, b) => {
      const nameA = getDisplayName(a);
      const nameB = getDisplayName(b);

      const numA = Number(nameA);
      const numB = Number(nameB);

      if (!isNaN(numA) && !isNaN(numB)) {
        return numB - numA;
      } else {
        return nameA.localeCompare(nameB);
      }
    });
  }, [items, getDisplayName]);

  // NEO-260 (a11y) — hand focus to the collapsed card when a selection closes
  // the list.
  //
  // Choosing a row unmounts that row: the column shrinks to its single
  // collapsed card, focus falls to <body>, and the next Tab restarts from the
  // top of the DOCUMENT rather than continuing into the column this selection
  // just opened. Six columns deep that makes the cascade unusable by keyboard
  // even though every control in it is now reachable.
  //
  // Guarded on `document.activeElement === document.body`, the same rule
  // EntityColumn's parks use, so focus a user or a flow has already placed is
  // never stolen. `preventScroll` because EntityColumn owns the horizontal
  // scroll position of the column row (it scrolls each newly-revealed column
  // into view) and a browser scroll-into-view here would pull it straight back.
  const collapsedCardRef = useRef<HTMLButtonElement | null>(null);
  const showedListRef = useRef(false);
  const showsCollapsedCard = !!(selectedId && selected && !expanded);
  useEffect(() => {
    const showedList = showedListRef.current;
    showedListRef.current = !showsCollapsedCard;
    if (
      showedList &&
      showsCollapsedCard &&
      document.activeElement === document.body
    ) {
      collapsedCardRef.current?.focus({ preventScroll: true });
    }
  }, [showsCollapsedCard]);

  // NEO-167 — keep the heading on screen while the read is in flight.
  //
  // This used to be `return <div>Loading {title}...</div>`, which removed the
  // column's identity text from the DOM for as long as `getSelectorOptions`
  // took. Maestro matches a selector as a FULL-STRING regex, so
  // `visible: "Variant Types"` cannot match "Loading variant types…" — every
  // flow asserting on a column heading failed outright on a slow read while
  // the app was behaving correctly (CI run 31839119469). Dropping the card
  // also collapsed the column's height and reflowed its siblings, the same
  // movement NEO-85 worked to remove.
  //
  // SCOPE IS LOAD-BEARING. The heading is absent in TWO situations and only
  // the second is the defect:
  //   1. Column not open — `EntityColumn.tsx:376` returns null on `!isVisible`,
  //      so this component never renders. Flows rely on that: they use heading
  //      visibility to detect that a selection opened the NEXT column
  //      (`when: notVisible: "Manufacturers"` guards against a second tap,
  //      which would re-toggle and deselect the row). That still works,
  //      because this branch is only reachable once the column is mounted.
  //   2. Column open, read in flight — here.
  // Do not "simplify" this by lifting the heading above the `isVisible` gate;
  // that would make every guard in (1) permanently false and silently stop the
  // drill utils from progressing.
  if (!items) {
    return (
      <div
        className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow"
        aria-busy="true"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {/* EXACTLY ONE placeholder row. Keep it that way.
            The first version of this reserved FIVE rows (~282px) to "match"
            the loaded column so nothing reflowed when data landed. That
            reasoning was wrong and it broke the seed flow deterministically.

            The columns sit ABOVE the card checklist, so every pixel added here
            pushes the checklist down — and the headless viewport is only 625px
            tall. Measured on the failing run: "Fetch from Marketplaces" landed
            at y=620..652, i.e. 5px of a 32px control on screen (15.6% visible
            against a required 50%). scrollUntilVisible gave up, the tap ran on
            a clipped element, and CdpWebDriver.scrollToPoint failed with
            "null cannot be cast to non-null type kotlin.Int" — a CDP error
            that reads like a driver bug and is really a layout bug.

            This is the same trap as NEO-47 (raised empty-state height pushed
            "Add custom" to y≈605) and NEO-155 (five header lines pushed the
            cascade below the fold). Height above a fold-sensitive control is
            never free here.

            Reflow-on-load was hypothetical; fold-clipping is measured. One row
            keeps the column from collapsing to nothing without spending the
            budget the checklist needs.

            Also deliberately NOT animated: `animate-pulse` would run an
            infinite CSS animation on a screen a coordinate-tap driver works
            on, which is the movement NEO-85 was spent eliminating. The bar
            plus the aria-label carry the meaning, and static is the better
            prefers-reduced-motion default. */}
        <div
          className="space-y-2"
          role="status"
          aria-label={`Loading ${title.toLowerCase()}`}
        >
          <div className="h-[50px] rounded-md border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  // Apply search filter
  const filteredItems = searchFilter
    ? sortedItems.filter((item) =>
        getDisplayName(item)
          .toLowerCase()
          .includes(searchFilter.toLowerCase()),
      )
    : sortedItems;

  // Which row is the column's single tab stop. The row the operator last stood
  // on if it is still in the filtered list, else the selected row, else the
  // first — so tabbing into a column with a selection lands on that selection,
  // which is what a listbox is supposed to do.
  const rovingIndex = (() => {
    const byActive = filteredItems.findIndex((i) => i._id === activeOptionId);
    if (byActive >= 0) return byActive;
    const bySelected = filteredItems.findIndex((i) => i._id === selectedId);
    return bySelected >= 0 ? bySelected : 0;
  })();

  // One delegated handler on the listbox rather than one per row: the rows are
  // rebuilt on every keystroke in the search box, and the key handling is about
  // the LIST, not about any row.
  //
  // Enter never arrives here — the row's own `activateOnEnter` consumes it and
  // stops propagation — and Space is left alone on purpose, because the browser
  // clicks a <button> on key*up* and intercepting keydown would either
  // double-fire or break the second half of that native contract.
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const options = optionsIn(listRef.current);
    if (options.length === 0) return;
    const focused = options.findIndex((o) => o === document.activeElement);
    const from = focused >= 0 ? focused : rovingIndex;
    const moveTo = (to: number) => {
      event.preventDefault();
      event.stopPropagation();
      options[Math.max(0, Math.min(options.length - 1, to))]?.focus();
    };

    switch (event.key) {
      // No wrap-around, per the APG's default for a listbox: running off the
      // end silently reappearing at the top reads as a dropped keypress.
      case "ArrowDown":
        return moveTo(from + 1);
      case "ArrowUp":
        return moveTo(from - 1);
      case "Home":
        return moveTo(0);
      case "End":
        return moveTo(options.length - 1);
      case "ArrowRight":
      case "ArrowLeft":
        if (
          focusAdjacentColumn(listRef.current, event.key === "ArrowRight" ? 1 : -1)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      default:
        break;
    }

    // Typeahead. Free here because the rows are already sorted by the same
    // display name the search box filters on, so "first row whose name starts
    // with the buffer" is one findIndex. It matters most on the columns with
    // eight or fewer rows, which render no search box at all.
    if (event.key.length !== 1 || event.key === " ") return;
    const now = Date.now();
    const carried =
      now - typeaheadRef.current.at > TYPEAHEAD_RESET_MS
        ? ""
        : typeaheadRef.current.buffer;
    const buffer = (carried + event.key).toLowerCase();
    typeaheadRef.current = { buffer, at: now };
    const hit = filteredItems.findIndex((item) =>
      getDisplayName(item).toLowerCase().startsWith(buffer),
    );
    if (hit >= 0) moveTo(hit);
  };

  if (showsCollapsedCard && selected) {
    // NEO-260 — a real <button>, not a clickable <div>.
    //
    // Once a column has a selection it collapses to this single card, and
    // re-opening it is the ONLY way to change that selection. As a <div> it was
    // unreachable by Tab, so a keyboard-only operator who picked the wrong
    // sport could not get back to the list — the cascade was one-way. It also
    // drops the column's <h2>, so the accessible name has to carry the column
    // ("Sports: Baseball — change"); the visible name is inside it, which is
    // what WCAG 2.5.3 asks and what keeps a voice-control "click Baseball"
    // working. `aria-expanded` states what pressing it does.
    return (
      <button
        ref={collapsedCardRef}
        type="button"
        className="w-full text-left bg-white dark:bg-gray-800 p-6 rounded-lg shadow flex items-center justify-between cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
        aria-label={`${title}: ${getDisplayName(selected)} — change`}
        aria-expanded={false}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => activateOnEnter(e, () => setExpanded(true))}
      >
        <div className="flex items-center gap-2">
          <div className="font-semibold">{getDisplayName(selected)}</div>
        </div>
        <ChevronDownIcon className="w-5 h-5 text-gray-500" />
      </button>
    );
  }

  const showSearch = sortedItems.length > 8;

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {selectedId && expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            onKeyDown={(e) => activateOnEnter(e, () => setExpanded(false))}
            // Named per column. Every open column with a selection renders one
            // of these, so a bare "Collapse" is neither distinguishable to a
            // screen-reader user moving across the cascade nor unambiguous as a
            // Maestro `resource-id` (matched as an UNANCHORED regex, so a bare
            // "Collapse" also finds "Collapse matched cards…" elsewhere).
            aria-label={`Collapse ${title.toLowerCase()}`}
            aria-expanded={true}
            className="ml-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] rounded"
          >
            <ChevronUpIcon className="w-5 h-5 text-gray-500" />
          </button>
        )}
      </div>
      {showSearch && (
        <Input
          bare
          type="text"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          // Unique per-column class (mb-search-<slug>) so Maestro web's
          // inputText targets THIS column's box. When two columns are open
          // and both have >8 items (e.g. Sports + Sets), every search box
          // otherwise shares one className; Maestro's createXPathFromElement
          // builds a non-unique class XPath and types into the FIRST box on
          // the page instead of the tapped one (NEO-46: pg-suggestions-0 was
          // typed into Sports → "No matches found"; Sets never filtered).
          // Same fix class as the mb-field-<slug> inputs. aria-label alone
          // doesn't help — inputText keys off className, not aria-label.
          className={`mb-search-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")} w-full p-2 mb-3 text-sm`}
          placeholder={`Search ${title.toLowerCase()}...`}
          aria-label={`Search ${title.toLowerCase()}`}
        />
      )}
      {filteredItems.length === 0 ? (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          <div className="text-sm text-gray-500 dark:text-gray-400 py-2">
            {searchFilter
              ? "No matches found"
              : `No ${title.toLowerCase()} available. Sync from marketplaces to populate.`}
          </div>
        </div>
      ) : (
        <div
          ref={listRef}
          // The list of choices IS a listbox. The role goes on the container
          // that ALREADY existed (same node, same class string) rather than a
          // new wrapper: Maestro reads a view hierarchy off this DOM and ~105
          // flows target these rows, so the shape stays byte-identical and only
          // attributes are added.
          //
          // Named with the column title, which is the same string the <h2>
          // above already shows — the listbox is present exactly when that
          // heading is, so this adds no name to the screen that was not already
          // on it.
          role="listbox"
          aria-label={title}
          onKeyDown={onListKeyDown}
          className="space-y-2 max-h-[400px] overflow-y-auto"
        >
          {filteredItems.map((item: SelectorItem, index: number) => {
            const pd = getPlatformData(item);
            const showPills = isItemTerminal?.(item) ?? false;
            const select = () => {
              onSelect(item._id);
              setExpanded(false);
              setSearchFilter("");
            };
            return (
              <button
                key={item._id}
                type="button"
                // `option`, not the implicit `button`: these are the mutually
                // exclusive choices of one column, and `aria-selected` is what
                // says which one is chosen. `aria-pressed` (a toggle-button
                // property) was the previous approximation and is NOT supported
                // on `option`, so the two must never both be present — this is
                // the reconciliation.
                role="option"
                aria-selected={selectedId === item._id}
                // Roving tabindex: exactly one row in the column is tabbable.
                tabIndex={index === rovingIndex ? 0 : -1}
                // Pointer, arrow key and Tab all end up here, so the roving
                // stop follows focus from every input method without each of
                // them having to remember to move it.
                onFocus={() => setActiveOptionId(item._id)}
                onClick={select}
                // A synthetic KeyboardEvent has no default action, so a focused
                // row is NOT clicked by `pressKey: Enter` — the row has to
                // activate itself. Harmless for a real keypress, which this
                // handler consumes instead of letting it click twice.
                onKeyDown={(e) => activateOnEnter(e, select)}
                className={`w-full text-left p-3 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] ${
                  selectedId === item._id
                    ? `${selectedColor}`
                    : "bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold">
                    {getDisplayName(item)}
                  </span>
                  {showPills && pd?.sportlots && (
                    <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                      SL
                    </span>
                  )}
                  {showPills && pd?.bsc && (
                    <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                      BSC
                    </span>
                  )}
                </div>
                {getDescription && getDescription(item) && (
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {getDescription(item)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// NEO-85: memoized so a parent re-render that recreates this element with
// referentially-stable props does NOT re-render the whole column — and re-run
// the sort/filter + rebuild every row button. A gratuitously re-rendered list
// churns the DOM subtree Maestro's hierarchyBasedTap reads mid-tap, feeding the
// coordinate-staleness dropped-tap class (the Variant Types "Base" flake).
// Effective only where the wrapper passes stable props (see SetVariantSelector);
// columns still passing inline props re-render exactly as before (shallow prop
// compare simply never matches for them — no behavior change either way).
export default memo(EntitySelector);
