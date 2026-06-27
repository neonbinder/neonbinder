import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector from "./EntitySelector";

type SetSelectorProps = {
  manufacturerId: GenericId<"selectorOptions">;
  selectedSetId: GenericId<"selectorOptions"> | null;
  onSetSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function SetSelector({
  manufacturerId,
  selectedSetId,
  onSetSelect,
  expanded,
  setExpanded,
}: SetSelectorProps) {
  return (
    <EntitySelector
      title="Sets"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "setName", parentId: manufacturerId }}
      selectedId={selectedSetId as string | null}
      onSelect={(id) => onSetSelect(id as GenericId<"selectorOptions">)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={(set) => set.value as string}
      getDescription={() => undefined}
      selectedColor="bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700"
    />
  );
}
