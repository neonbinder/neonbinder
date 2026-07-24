import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import BaseSetPicker from "./BaseSetPicker";
import type { PlatformItem } from "./ReconciliationModal";

type RawOptionsResult = {
  success: boolean;
  bscOptions: PlatformItem[];
  slOptions: PlatformItem[];
  message?: string;
};

type BaseMappingFormProps = {
  variantTypeId: GenericId<"selectorOptions">;
  // When true, the form auto-runs fetchRawOptions and opens BaseSetPicker
  // on mount. When false, the form waits for an explicit "Sync Base Mapping"
  // click. The picker is the only piece of UI shown either way — there's no
  // form layout otherwise.
  autoOpen: boolean;
  onClose: () => void;
};

// Captures the Base variantType's SL/BSC platform mapping by reusing the
// reconciliation pipeline (fetchRawOptions + BaseSetPicker). On confirm,
// writes the mapping onto the variantType row itself via
// setVariantTypePlatformData — no child insert row is created.
//
// Replaces the isBase branch of VariantForm under the new "Base is
// terminal" model.
export default function BaseMappingForm({
  variantTypeId,
  autoOpen,
  onClose,
}: BaseMappingFormProps) {
  const fetchRawOptions = useAction(api.setReconciliation.fetchRawOptions);
  const setPlatformData = useMutation(
    api.selectorOptions.setVariantTypePlatformData,
  );
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: variantTypeId,
  });

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerData, setPickerData] = useState<RawOptionsResult | null>(null);
  const triggered = useRef(false);

  const sportValue = ancestorChain?.find((a) => a.level === "sport")?.value;
  const yearValue = ancestorChain?.find((a) => a.level === "year")?.value;
  const manufacturerValue = ancestorChain?.find(
    (a) => a.level === "manufacturer",
  )?.value;
  const setNameAncestor = ancestorChain?.find((a) => a.level === "setName");
  const setNameValue = setNameAncestor?.value;
  const variantTypeValue = ancestorChain?.find(
    (a) => a.level === "variantType",
  )?.value;

  const writePlatformData = async (platformData: {
    bsc?: string;
    sportlots?: string;
    sportlotsDisplay?: string;
  }) => {
    await setPlatformData({ variantTypeId, platformData });
  };

  const doSync = async () => {
    if (!sportValue || !yearValue || !setNameValue) return;
    // Open picker immediately so the user gets a dialog they can Escape
    // out of even while fetchRawOptions is in flight. The picker renders
    // skeletons until data arrives.
    setLoading(true);
    setMessage(null);
    setPickerData(null);
    setPickerOpen(true);
    try {
      const result = await fetchRawOptions({
        level: "insert",
        parentId: variantTypeId,
        parentFilters: {
          sport: sportValue,
          year: yearValue,
          manufacturer: manufacturerValue,
          setName: setNameValue,
          variantType: variantTypeValue,
        },
      });

      if (!result.success) {
        setPickerOpen(false);
        setMessage(result.message || "Failed to fetch options");
        return;
      }

      // SL has options → populate the picker. User confirms inside it.
      if (result.slOptions.length > 0) {
        setPickerData(result);
        return;
      }

      // No SL data — close picker and auto-take BSC fallback. Brief flash
      // of the skeleton picker is acceptable; the message below explains.
      setPickerOpen(false);
      if (result.bscOptions.length > 0) {
        const bscPick = result.bscOptions[0];
        await writePlatformData({ bsc: bscPick.platformValue });
        setMessage(`Stored Base mapping: ${bscPick.value}`);
        onClose();
        return;
      }

      // No data on either platform — fall back to the SET's BSC slug so
      // BSC card lookups under variant=Base still resolve to the set's
      // search results. SL mapping is left empty; the user can retry sync
      // later or add custom cards by hand.
      const setBsc = setNameAncestor?.platformData?.bsc;
      const bscFallback =
        typeof setBsc === "string"
          ? setBsc
          : Array.isArray(setBsc) && setBsc.length > 0
            ? setBsc[0]
            : undefined;
      if (bscFallback) {
        await writePlatformData({ bsc: bscFallback });
        setMessage(`Stored Base mapping (fallback to set slug)`);
      } else {
        setMessage("No marketplace data found for this Base set.");
      }
      onClose();
    } catch (error) {
      setPickerOpen(false);
      setMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handlePickerConfirm = async (selected: {
    sl: PlatformItem;
    bsc?: PlatformItem;
  }) => {
    // BSC's variantName facet is often empty under variant=Base — fall back
    // to the SET's BSC slug so card-checklist queries still resolve.
    const setBsc = setNameAncestor?.platformData?.bsc;
    const bscFallback =
      typeof setBsc === "string"
        ? setBsc
        : Array.isArray(setBsc) && setBsc.length > 0
          ? setBsc[0]
          : undefined;
    const bscPlatformValue = selected.bsc?.platformValue ?? bscFallback;

    await writePlatformData({
      sportlots: selected.sl.platformValue,
      sportlotsDisplay: selected.sl.value,
      ...(bscPlatformValue ? { bsc: bscPlatformValue } : {}),
    });
    setPickerOpen(false);
    onClose();
  };

  useEffect(() => {
    if (!autoOpen) return;
    if (triggered.current) return;
    if (!sportValue || !yearValue || !setNameValue) return;
    triggered.current = true;
    void doSync();
  }, [autoOpen, sportValue, yearValue, setNameValue]);

  if (!autoOpen && !pickerOpen && !loading && !message) {
    // Nothing to render when invoked with autoOpen=false until the user
    // clicks the trigger that opens this form. Parent owns visibility.
    return null;
  }

  return (
    <>
      {/* Inline message panel shows for every terminal state that doesn't
          render a picker: errors, no-data fallbacks, AND a cancelled picker
          (NEO-71-74 fix — previously Cancel called onClose() immediately
          with no recovery UI, and because this component's React `key`
          doesn't change on cancel, its internal `triggered` ref stayed
          tripped forever, silently rendering nothing on every later visit —
          a dead end with no "Re-map Base" button either, since that's
          correctly gated on baseHasMapping being true, which it never was.
          Retry is now offered for every message, not just errors, since
          re-running doSync is always a safe, idempotent action here.
          Loading lives inside BaseSetPicker via skeletons. */}
      {!pickerOpen && message && (
        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow">
          <h3 className="text-sm font-semibold mb-2">Base mapping</h3>
          <div className="p-3 mb-2 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm">
            {message}
          </div>
          <div className="flex gap-2">
            <NeonButton onClick={doSync}>Retry</NeonButton>
            <NeonButton cancel onClick={onClose}>
              Close
            </NeonButton>
          </div>
        </div>
      )}

      {pickerOpen && (
        <BaseSetPicker
          isOpen={pickerOpen}
          onClose={() => {
            setPickerOpen(false);
            setMessage(
              "Base mapping cancelled — no SportLots set was selected. Click Retry to pick one, or Close to leave it unmapped for now.",
            );
          }}
          onConfirm={handlePickerConfirm}
          slOptions={pickerData?.slOptions ?? []}
          bscOptions={pickerData?.bscOptions ?? []}
          setName={setNameValue || ""}
          manufacturer={manufacturerValue || ""}
          loading={loading}
        />
      )}
    </>
  );
}
