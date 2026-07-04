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
      selectedColor="bg-amber-100 dark:bg-amber-900 border-amber-300 dark:border-amber-700"
      isItemTerminal={() => true}
    />
  );
}
