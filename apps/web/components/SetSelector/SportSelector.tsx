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
      // NEO-356: the column's hue, per mode — the -100 tint in light, the -900
      // fill in dark (unchanged) — with its -700 edge, which clears 3:1 on both.
      selectedColor="bg-[color:light-dark(oklch(94.8%_0.028_342.258),oklch(40.8%_0.153_2.432))] border-pink-700"
    />
  );
}
