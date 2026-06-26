import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector from "./EntitySelector";

type SportSelectorProps = {
  selectedSportId: GenericId<"selectorOptions"> | null;
  onSportSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function SportSelector({
  selectedSportId,
  onSportSelect,
  expanded,
  setExpanded,
}: SportSelectorProps) {
  return (
    <EntitySelector
      title="Sports"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "sport" }}
      selectedId={selectedSportId as string | null}
      onSelect={(id) => onSportSelect(id as GenericId<"selectorOptions">)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={(sport) => sport.value as string}
      getDescription={() => undefined}
      selectedColor="bg-pink-100 dark:bg-pink-900 border-pink-300 dark:border-pink-700"
    />
  );
}
