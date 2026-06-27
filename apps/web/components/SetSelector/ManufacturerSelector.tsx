import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector from "./EntitySelector";

type ManufacturerSelectorProps = {
  yearId: GenericId<"selectorOptions">;
  selectedManufacturerId: GenericId<"selectorOptions"> | null;
  onManufacturerSelect: (id: GenericId<"selectorOptions">) => void;
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
  return (
    <EntitySelector
      title="Manufacturers"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "manufacturer", parentId: yearId }}
      selectedId={selectedManufacturerId as string | null}
      onSelect={(id) =>
        onManufacturerSelect(id as GenericId<"selectorOptions">)
      }
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={(manufacturer) => manufacturer.value as string}
      getDescription={() => undefined}
      selectedColor="bg-green-100 dark:bg-green-900 border-green-300 dark:border-green-700"
    />
  );
}
