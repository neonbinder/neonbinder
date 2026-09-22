import { useMemo } from "react";
import type { GenericId } from "convex/values";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import EntitySelector, {
  displayByValue,
  type PinnedEntry,
  type SelectorItem,
} from "./EntitySelector";
import { ALL_BRANDS_VIEW, type ManufacturerSelection } from "./all-brands-view";

/**
 * NEO-237 — the year's Unknown row leads the data rows (Jason, 2026-09-21:
 * the column's top two are "All Brands", the pinned view, then Unknown, then
 * every brand in the usual order). It is recognised by the flag
 * `ensureBrandUnknownRow` writes, never by its name — an operator may have
 * renamed it, and a brand called "Unknown" without the flag is just a brand.
 * Unknown stays a real data row: selectable, with attributes and its own
 * "+ Custom" sets, and the search box matches it like any other row.
 *
 * Module-level so `EntitySelector`'s sort memo sees one reference.
 */
const isBrandUnknownRow = (item: SelectorItem): boolean =>
  (item.metadata as { isBrandUnknown?: boolean } | undefined)
    ?.isBrandUnknown === true;

/**
 * The visible text of the pinned entry is exactly "All Brands": the cold-drill
 * utils and the one-marketplace checklist flow tap it by that text, and the
 * name is what SportLots' own no-filter option is called, which is what an
 * operator who has used SportLots expects to find here. The sentinel and its
 * type live in `all-brands-view.ts`.
 */
type ManufacturerSelectorProps = {
  yearId: GenericId<"selectorOptions">;
  selectedManufacturerId: ManufacturerSelection | null;
  onManufacturerSelect: (id: ManufacturerSelection) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function ManufacturerSelector({
  yearId,
  selectedManufacturerId,
  onManufacturerSelect,
  expanded,
  setExpanded,
}: ManufacturerSelectorProps) {
  // The year's own value, for the view's accessible name ("every set in
  // 1995"). Deduped by the Convex client against the Attributes panel's and
  // the cascade's reads of the same row.
  const year = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: yearId,
  });
  const yearLabel = year?.value ?? "this year";

  // Memoised on the year label so EntitySelector's row array is rebuilt only
  // when the name it carries changes, not on every parent render.
  const pinnedEntries = useMemo<PinnedEntry[]>(
    () => [
      {
        id: ALL_BRANDS_VIEW,
        name: "All Brands",
        ariaLabel: `All Brands — every set in ${yearLabel}`,
        description: `Every set in ${yearLabel}`,
      },
    ],
    [yearLabel],
  );

  return (
    <EntitySelector
      title="Manufacturers"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "manufacturer", parentId: yearId }}
      selectedId={selectedManufacturerId as string | null}
      onSelect={(id) => onManufacturerSelect(id as ManufacturerSelection)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={displayByValue}
      getDescription={() => undefined}
      selectedColor="bg-green-100 dark:bg-green-900 border-green-300 dark:border-green-700"
      pinnedEntries={pinnedEntries}
      leadRow={isBrandUnknownRow}
    />
  );
}
