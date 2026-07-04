import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { FunctionReference } from "convex/server";

type SelectorItem = { _id: string; [key: string]: unknown };

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

function isCustom(item: SelectorItem): boolean {
  return item.isCustom === true;
}

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

export default function EntitySelector({
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

  if (!items) {
    // NEO-85: render the loading state inside the same card shell with a
    // reserved list-area min-height. A transient `undefined` (normal Convex
    // refetch when the user picks a new parent) otherwise collapses this
    // column to a single text line, shrinking the flex row and reflowing
    // sibling columns under Maestro's coordinate taps. No stale data is held —
    // this is a skeleton, not the previous parent's list.
    return (
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        <div className="min-h-[400px]">
          <div className="text-sm text-gray-500 dark:text-gray-400 py-2">
            Loading {title.toLowerCase()}...
          </div>
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
          {isCustom(selected) && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700">
              Custom
            </span>
          )}
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
        <input
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
          className={`mb-search-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")} w-full p-2 mb-3 border rounded-md dark:bg-gray-700 dark:border-gray-600 text-sm`}
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
                    : isCustom(item)
                      ? "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900"
                      : "bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold">
                    {getDisplayName(item)}
                  </span>
                  {isCustom(item) && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700">
                      Custom
                    </span>
                  )}
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
