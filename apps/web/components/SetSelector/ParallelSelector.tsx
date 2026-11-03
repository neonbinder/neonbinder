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
      // NEO-356: the column's own hue (`pick-*` roles, app/theme.css): the
      // -900 fill in dark, a pale tint in light, the -700 edge in both.
      selectedColor="bg-pick-amber border-pick-amber-rule"
      isItemTerminal={() => true}
      // NEO-425: sub-variants are NB's own rows and no marketplace has them,
      // so the sync hint every other column carries would be untrue here.
      // The cascade hides this column while an insert has none, so the line
      // is only ever seen for the moment after the last one goes.
      emptyText="No sub-variants under this insert."
    />
  );
}
