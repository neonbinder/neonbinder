import type { GenericId } from "convex/values";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import EntitySelector, {
  displayByValue,
  type SelectorItem,
} from "./EntitySelector";

/**
 * The brand's display value on a row of the All Brands view — the muted
 * second line under the set name. `getSetsUnderYear` stamps every row with
 * it; a brand-scoped row has none and the line does not render.
 */
const describeByBrand = (item: SelectorItem): string | undefined =>
  typeof item.brand === "string" ? item.brand : undefined;

const noDescription = () => undefined;

type SetSelectorProps = {
  /** The brand whose sets to list; `null` in the All Brands view. */
  manufacturerId: GenericId<"selectorOptions"> | null;
  /** NEO-237: the year the view lists every set of. */
  yearId: GenericId<"selectorOptions">;
  selectedSetId: GenericId<"selectorOptions"> | null;
  /**
   * The set, and the brand it lives under. The brand is what the cascade
   * back-fills the Manufacturers column from when a set is picked in the All
   * Brands view; in a brand's own column it is that brand.
   */
  onSetSelect: (
    id: GenericId<"selectorOptions">,
    parentId: GenericId<"selectorOptions"> | undefined,
  ) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function SetSelector({
  manufacturerId,
  yearId,
  selectedSetId,
  onSetSelect,
  expanded,
  setExpanded,
}: SetSelectorProps) {
  // NEO-237 (D17): with no brand chosen the column is the All Brands VIEW —
  // every set under every manufacturer of the year, brand alongside — read
  // through its own query rather than `getSelectorOptions`, which is scoped
  // to one parent and would return nothing for a year.
  const view = manufacturerId === null;
  // The view's rows, for the parent look-up on select. The SAME subscription
  // EntitySelector holds (identical reference and args), which the Convex
  // client dedupes — so this costs no second read, and it means
  // EntitySelector's `onSelect(id)` contract stays exactly what every other
  // column relies on.
  const viewRows = useQuery(
    api.brandView.getSetsUnderYear,
    view ? { yearId } : "skip",
  );
  return (
    <EntitySelector
      title="Sets"
      query={
        view ? api.brandView.getSetsUnderYear : api.selectorOptions.getSelectorOptions
      }
      queryArgs={
        view ? { yearId } : { level: "setName", parentId: manufacturerId }
      }
      selectedId={selectedSetId as string | null}
      onSelect={(id) =>
        onSetSelect(
          id as GenericId<"selectorOptions">,
          view
            ? viewRows?.find((row) => row._id === id)?.parentId
            : manufacturerId ?? undefined,
        )
      }
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={displayByValue}
      getDescription={view ? describeByBrand : noDescription}
      selectedColor="bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700"
    />
  );
}
