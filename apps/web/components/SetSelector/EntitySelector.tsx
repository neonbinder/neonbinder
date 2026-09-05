import { memo, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { FunctionReference } from "convex/server";

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

  if (selectedId && selected && !expanded) {
    return (
      <div
        className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow flex items-center justify-between cursor-pointer"
        onClick={() => setExpanded(true)}
      >
        <div className="flex items-center gap-2">
          <div className="font-semibold">{getDisplayName(selected)}</div>
        </div>
        <ChevronDownIcon className="w-5 h-5 text-gray-500" />
      </div>
    );
  }

  const showSearch = sortedItems.length > 8;

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {selectedId && expanded && (
          <button
            onClick={() => setExpanded(false)}
            aria-label="Collapse"
            className="ml-2"
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
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {filteredItems.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-2">
            {searchFilter
              ? "No matches found"
              : `No ${title.toLowerCase()} available. Sync from marketplaces to populate.`}
          </div>
        ) : (
          filteredItems.map((item: SelectorItem) => {
            const pd = getPlatformData(item);
            const showPills = isItemTerminal?.(item) ?? false;
            return (
              <button
                key={item._id}
                onClick={() => {
                  onSelect(item._id);
                  setExpanded(false);
                  setSearchFilter("");
                }}
                className={`w-full text-left p-3 rounded-md border transition-colors ${
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
          })
        )}
      </div>
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
