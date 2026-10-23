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
      // NEO-356: the column's hue, per mode — the -100 tint in light, the -900
      // fill in dark (unchanged) — with its -700 edge, which clears 3:1 on both.
      selectedColor="bg-[color:light-dark(oklch(95.3%_0.051_180.801),oklch(38.6%_0.063_188.416))] border-teal-700"
      isItemTerminal={() => true}
    />
  );
}
