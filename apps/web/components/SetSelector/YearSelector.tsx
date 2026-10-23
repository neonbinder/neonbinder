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
      // NEO-356: the column's hue, per mode — the -100 tint in light, the -900
      // fill in dark (unchanged) — with its -700 edge, which clears 3:1 on both.
      selectedColor="bg-[color:light-dark(oklch(93.2%_0.032_255.585),oklch(37.9%_0.146_265.522))] border-blue-700"
    />
  );
}
