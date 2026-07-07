import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import EntitySelector, { displayByValue } from "./EntitySelector";

type VariantSelectorProps = {
  variantTypeId: GenericId<"selectorOptions">;
  selectedVariantId: GenericId<"selectorOptions"> | null;
  onVariantSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  title?: string;
};

export default function VariantSelector({
  variantTypeId,
  selectedVariantId,
  onVariantSelect,
  expanded,
  setExpanded,
  title = "Variants",
}: VariantSelectorProps) {
  return (
    <EntitySelector
      title={title}
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={{ level: "insert", parentId: variantTypeId }}
      selectedId={selectedVariantId as string | null}
      onSelect={(id) => onVariantSelect(id as GenericId<"selectorOptions">)}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={displayByValue}
      getDescription={() => undefined}
      selectedColor="bg-teal-100 dark:bg-teal-900 border-teal-300 dark:border-teal-700"
      isItemTerminal={() => true}
    />
  );
}
