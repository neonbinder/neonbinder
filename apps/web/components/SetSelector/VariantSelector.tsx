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
      // NEO-356: the column's own hue (`pick-*` roles, app/theme.css): the
      // -900 fill in dark, a pale tint in light, the -700 edge in both.
      selectedColor="bg-pick-teal border-pick-teal-rule"
      isItemTerminal={() => true}
    />
  );
}
