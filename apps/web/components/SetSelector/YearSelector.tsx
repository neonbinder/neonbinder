import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector from "./EntitySelector";

type YearSelectorProps = {
  sportId: GenericId<"selectorOptions">;
  selectedYearId: GenericId<"selectorOptions"> | null;
  onYearSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function YearSelector({
  sportId,
  selectedYearId,
  onYearSelect,
  expanded,
  setExpanded,
}: YearSelectorProps) {
  return (
    <EntitySelector
      title="Years"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "year", parentId: sportId }}
      selectedId={selectedYearId as string | null}
      onSelect={(id) => onYearSelect(id as GenericId<"selectorOptions">)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={(year) => year.value as string}
      getDescription={() => undefined}
      selectedColor="bg-blue-100 dark:bg-blue-900 border-blue-300 dark:border-blue-700"
    />
  );
}
