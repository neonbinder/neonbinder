import React, { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import ReconciliationModal, { type ReconciledResult, type MatchedPair, type PlatformItem } from "./ReconciliationModal";

type RawOptionsResult = {
  success: boolean;
  bscOptions: PlatformItem[];
  slOptions: PlatformItem[];
  autoMatched: MatchedPair[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
  errors: Array<{ platform: string; message: string }>;
  message?: string;
};

// Stable, unique-to-this-error-mode string. Maestro flows assert on this
// substring to verify the column surfaced (not silently swallowed) a
// platform fetch failure.
const SYNC_FAILED_PREFIX = "Sync failed: could not load variants";

export default function VariantForm({
  variantTypeId,
  onDone,
}: {
  variantTypeId: GenericId<"selectorOptions">;
  onDone?: () => void;
}) {
  const fetchRawOptions = useAction(api.setReconciliation.fetchRawOptions);
  const storeReconciledOptions = useMutation(api.setReconciliation.storeReconciledOptions);
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: variantTypeId,
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showReconciliation, setShowReconciliation] = useState(false);
  const [reconciliationData, setReconciliationData] = useState<RawOptionsResult | null>(null);
  const triggered = useRef(false);

  const sportValue = ancestorChain?.find((a: { level: string }) => a.level === "sport")?.value;
  const yearValue = ancestorChain?.find((a: { level: string }) => a.level === "year")?.value;
  const manufacturerValue = ancestorChain?.find(
    (a: { level: string }) => a.level === "manufacturer",
  )?.value;
  const setNameAncestor = ancestorChain?.find(
    (a: { level: string }) => a.level === "setName",
  );
  const setNameValue = setNameAncestor?.value;
  const setId = setNameAncestor?._id as GenericId<"selectorOptions"> | undefined;

  // Exclude the *current* variantType from the "used" check so re-running
  // the same sync still surfaces previously-saved rows (the user can then
  // prune them via the keep shelf). Sibling variantTypes remain blocked.
  const usedIdentifiers = useQuery(
    api.selectorOptions.getUsedInsertIdentifiersBySet,
    setId ? { setId, excludeVariantTypeId: variantTypeId } : "skip",
  );
  const variantTypeValue = ancestorChain?.find(
    (a: { level: string }) => a.level === "variantType",
  )?.value;
  // Pluralized variantType label ("Insert" → "Inserts") for headings and
  // the reconciliation modal title. Falls back to "Variants" until the
  // ancestor chain resolves.
  const variantsLabel = variantTypeValue
    ? variantTypeValue.endsWith("s")
      ? variantTypeValue
      : `${variantTypeValue}s`
    : "Variants";

  // For Insert/Parallel variantTypes, look up the sibling Base variantType
  // (terminal, no children) so its SL platform mapping can be passed as an
  // additional SL prefix to ReconciliationModal — SL has no native set
  // entity, so the Base anchor's SL set name is the tightest SL-side
  // filter we have without a new scraper.
  // Previously-saved insert rows under THIS variantType. Threaded into
  // ReconciliationModal as `existingRows` so re-running the sync preserves
  // prior matched pairs and keep-shelf entries instead of starting over.
  const existingVariantRows = useQuery(
    api.selectorOptions.getSelectorOptions,
    { level: "insert", parentId: variantTypeId },
  );

  const baseVariant = useQuery(
    api.selectorOptions.getBaseVariantBySet,
    setId ? { setId } : "skip",
  );

  const doSync = async () => {
    if (!sportValue || !yearValue) return;
    setLoading(true);
    setMessage(null);
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
        ...(baseVariant?.platformData?.sportlotsDisplay
          ? { baseSlPrefix: baseVariant.platformData.sportlotsDisplay }
          : {}),
      });

      if (!result.success) {
        setMessage(result.message || "Failed to fetch options");
        return;
      }

      // Defensive: if both adapters returned no options AND at least one
      // reported an error, surface a visible error AND return EntityColumn
      // to idle so the panel-header actions ("Group Parallels", etc.) are
      // reachable. The auto-synced-key set prevents this from immediately
      // re-firing; the user (or test) can re-trigger sync explicitly via
      // the sync button.
      if (
        result.bscOptions.length === 0 &&
        result.slOptions.length === 0 &&
        result.errors.length > 0
      ) {
        const detail = result.errors
          .map((e) => `${e.platform}: ${e.message}`)
          .join("; ");
        setMessage(`${SYNC_FAILED_PREFIX}. ${detail}`);
        onDone?.();
        return;
      }

      if (result.bscOptions.length > 0 && result.slOptions.length > 0) {
        // Both platforms have data — show reconciliation modal
        setReconciliationData(result);
        setShowReconciliation(true);
        setMessage(result.message || null);
      } else {
        // Only one platform has data — store directly
        const items = [
          ...result.bscOptions.map((o: PlatformItem) => ({
            value: o.value,
            platformData: { bsc: o.platformValue as string | undefined, sportlots: undefined },
          })),
          ...result.slOptions.map((o: PlatformItem) => ({
            value: o.value,
            platformData: { bsc: undefined, sportlots: o.platformValue as string | undefined },
          })),
        ];

        if (items.length > 0) {
          await storeReconciledOptions({
            level: "insert",
            parentId: variantTypeId,
            reconciledItems: items,
          });
        }

        setMessage(
          result.message || `Stored ${items.length} variants (single platform)`,
        );
        onDone?.();
      }
    } catch (error) {
      setMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleReconciliationConfirm = async (result: ReconciledResult) => {
    await storeReconciledOptions({
      level: "insert",
      parentId: variantTypeId,
      reconciledItems: result.items.map((item) => ({
        value: item.value,
        platformData: item.platformData,
        metadata: item.metadata,
      })),
    });
    setShowReconciliation(false);
    onDone?.();
  };

  useEffect(() => {
    // Gate on baseVariant being loaded (object or null) so the SL Base
    // prefix can flow into fetchRawOptions on the first call. Without
    // this, doSync fires before getBaseVariantBySet resolves and
    // baseSlPrefix arrives empty.
    if (
      sportValue &&
      yearValue &&
      baseVariant !== undefined &&
      !triggered.current
    ) {
      triggered.current = true;
      doSync();
    }
  }, [sportValue, yearValue, baseVariant]);

  return (
    <>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4">Syncing {variantsLabel}</h2>

        {loading && (
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Fetching {variantsLabel.toLowerCase()} for {setNameValue || "..."} from all connected platforms...
          </p>
        )}

        {(() => {
          const isError =
            !!message &&
            (message.startsWith("Error") ||
              message.startsWith("Failed") ||
              message.startsWith(SYNC_FAILED_PREFIX));
          return (
            <>
              {message && !showReconciliation && (
                <div
                  role={isError ? "alert" : undefined}
                  className={
                    isError
                      ? "p-3 mb-4 bg-[#FF2EB3]/10 border border-[#FF2EB3] rounded-md text-[#FF2EB3] text-sm"
                      : "p-3 mb-4 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm"
                  }
                >
                  {message}
                </div>
              )}

              {!loading && !showReconciliation && (
                <div className="flex gap-2">
                  {isError && <NeonButton onClick={doSync}>Retry</NeonButton>}
                  <NeonButton cancel onClick={onDone}>
                    {isError ? "Cancel" : "Close"}
                  </NeonButton>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {showReconciliation && reconciliationData && existingVariantRows !== undefined && (
        <ReconciliationModal
          isOpen={showReconciliation}
          onClose={() => {
            setShowReconciliation(false);
            onDone?.();
          }}
          onConfirm={handleReconciliationConfirm}
          level="insert"
          levelLabel={variantsLabel}
          initialData={{
            autoMatched: reconciliationData.autoMatched,
            unmatchedBsc: reconciliationData.unmatchedBsc,
            unmatchedSl: reconciliationData.unmatchedSl,
          }}
          showMetadata
          setName={setNameValue || ""}
          manufacturer={manufacturerValue || ""}
          extraSlPrefixes={(() => {
            // extraSlPrefixes wants human display strings for the SL prefix
            // filter (sibling `sportlots` holds numeric radio IDs).
            // Primary's display name comes from sportlotsDisplay (NEO-16).
            // For multi-source rows (NEO-6), extra IDs may carry human
            // labels in platformLabels.sportlots — include those too.
            const prefixes: string[] = [];
            const seen = new Set<string>();
            const push = (s?: string) => {
              if (s && !seen.has(s)) {
                seen.add(s);
                prefixes.push(s);
              }
            };
            push(baseVariant?.platformData?.sportlotsDisplay);
            const slLabels = baseVariant?.platformLabels?.sportlots;
            const sl = baseVariant?.platformData?.sportlots;
            const ids = !sl ? [] : Array.isArray(sl) ? sl : [sl];
            for (const id of ids) push(slLabels?.[id]);
            return prefixes;
          })()}
          usedSlPlatformValues={usedIdentifiers?.slPlatformValues}
          usedBscPlatformValues={usedIdentifiers?.bscPlatformValues}
          existingRows={existingVariantRows?.map((r) => ({
            value: r.value,
            platformData: r.platformData,
            metadata: r.metadata,
          }))}
        />
      )}
    </>
  );
}
