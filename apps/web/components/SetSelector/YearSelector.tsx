import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector, { displayByValue } from "./EntitySelector";

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
      getDisplayName={displayByValue}
      getDescription={() => undefined}
      // NEO-356: the column's own hue (`pick-*` roles, app/theme.css): the
      // -900 fill in dark, a pale tint in light, the -700 edge in both.
      selectedColor="bg-pick-blue border-pick-blue-rule"
    />
  );
}
