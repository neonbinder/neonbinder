import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector, { displayByValue } from "./EntitySelector";

type ParallelSelectorProps = {
  insertId: GenericId<"selectorOptions">;
  selectedParallelId: GenericId<"selectorOptions"> | null;
  onParallelSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

export default function ParallelSelector({
  insertId,
  selectedParallelId,
  onParallelSelect,
  expanded,
  setExpanded,
}: ParallelSelectorProps) {
  return (
    <EntitySelector
      title="Parallels"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "parallel", parentId: insertId }}
      selectedId={selectedParallelId as string | null}
      onSelect={(id) => onParallelSelect(id as GenericId<"selectorOptions">)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={displayByValue}
      getDescription={() => undefined}
      // NEO-356: the column's hue, per mode — the -100 tint in light, the -900
      // fill in dark (unchanged) — with its -700 edge, which clears 3:1 on both.
      selectedColor="bg-[color:light-dark(oklch(96.2%_0.059_95.617),oklch(41.4%_0.112_45.904))] border-amber-700"
      isItemTerminal={() => true}
    />
  );
}
