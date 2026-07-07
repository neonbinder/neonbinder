import type { GenericId } from "convex/values";
import { useCallback, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import EntitySelector, {
  displayByValue,
  type SelectorItem,
} from "./EntitySelector";

type SetVariantSelectorProps = {
  setId: GenericId<"selectorOptions">;
  selectedVariantTypeId: GenericId<"selectorOptions"> | null;
  onVariantTypeSelect: (id: GenericId<"selectorOptions">) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

// Module-level stable identities so the memoized EntitySelector can actually
// skip re-rendering the variant-type list when SetSelector re-renders. Passing a
// fresh inline arrow per render would change the prop identity every time,
// defeating the React.memo shallow compare (NEO-85). Both are pure functions of
// the item with no closure over props, so hoisting them is safe.
const noDescription = () => undefined;
// Variant types are mostly intermediate (Insert/Parallel lead to a further
// Variants column), but Base is terminal — its checklist attaches directly to
// the variantType row, so its SL/BSC mapping is meaningful here and drives the
// SL/BSC pills.
const isBaseTerminal = (item: SelectorItem) =>
  typeof item.value === "string" && item.value.toLowerCase().trim() === "base";

export default function SetVariantSelector({
  setId,
  selectedVariantTypeId,
  onVariantTypeSelect,
  expanded,
  setExpanded,
}: SetVariantSelectorProps) {
  // Memoize the query args on setId so the object reference is stable across
  // re-renders. convex/react already stringifies args to dedupe the subscription,
  // so this doesn't change what data loads — it keeps the prop identity stable so
  // the React.memo'd EntitySelector below isn't re-rendered by a bare parent
  // re-render (NEO-85).
  const queryArgs = useMemo(
    () => ({ level: "variantType", parentId: setId }),
    [setId],
  );
  const handleSelect = useCallback(
    (id: string) => onVariantTypeSelect(id as GenericId<"selectorOptions">),
    [onVariantTypeSelect],
  );

  return (
    <EntitySelector
      title="Variant Types"
      query={api.selectorOptions.getSelectorOptions}
      queryArgs={queryArgs}
      selectedId={selectedVariantTypeId as string | null}
      onSelect={handleSelect}
      expanded={expanded}
      setExpanded={setExpanded}
      getDisplayName={displayByValue}
      getDescription={noDescription}
      selectedColor="bg-orange-100 dark:bg-orange-900 border-orange-300 dark:border-orange-700"
      isItemTerminal={isBaseTerminal}
    />
  );
}
