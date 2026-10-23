import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector, { displayByValue } from "./EntitySelector";

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
      getDisplayName={displayByValue}
      getDescription={() => undefined}
      // NEO-356: the column's own hue (`pick-*` roles, app/theme.css): the
      // -900 fill in dark, a pale tint in light, the -700 edge in both.
      selectedColor="bg-pick-pink border-pick-pink-rule"
    />
  );
}
