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

// Mirrors VariantForm's SYNC_FAILED_PREFIX. Phrased for the parallel
// column so Maestro can distinguish variant vs parallel failure surfacing
// when it eventually asserts on this text.
const SYNC_FAILED_PREFIX = "Sync failed: could not load parallels";

export default function ParallelForm({
  insertId,
  onDone,
}: {
  insertId: GenericId<"selectorOptions">;
  onDone?: () => void;
}) {
  const fetchRawOptions = useAction(api.setReconciliation.fetchRawOptions);
  const storeReconciledOptions = useMutation(api.setReconciliation.storeReconciledOptions);
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: insertId,
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
  const variantTypeValue = ancestorChain?.find(
    (a: { level: string }) => a.level === "variantType",
  )?.value;
  const setNameAncestor = ancestorChain?.find(
    (a: { level: string }) => a.level === "setName",
  );
  const setNameValue = setNameAncestor?.value;
  const setId = setNameAncestor?._id as GenericId<"selectorOptions"> | undefined;
  // Previously-saved parallel rows for THIS insert. Threaded into the modal
  // as existingRows so re-running preserves prior reconciliation work.
  const existingParallelRows = useQuery(
    api.selectorOptions.getSelectorOptions,
    { level: "parallel", parentId: insertId },
  );
  const usedIdentifiers = useQuery(
    api.selectorOptions.getUsedInsertIdentifiersBySet,
    setId ? { setId } : "skip",
  );

  const doSync = async () => {
    if (!sportValue || !yearValue || !manufacturerValue || !variantTypeValue || !setNameValue) return;
    setLoading(true);
    setMessage(null);
    try {
      const result = await fetchRawOptions({
        level: "parallel",
        parentId: insertId,
        parentFilters: {
          sport: sportValue,
          year: yearValue,
          manufacturer: manufacturerValue,
          variantType: variantTypeValue,
          setName: setNameValue,
        },
      });

      if (!result.success) {
        setMessage(result.message || "Failed to fetch options");
        return;
      }

      // Defensive empty-with-errors guard — see VariantForm.doSync for the
      // full rationale. Surface the error AND return to idle so the panel-
      // header actions remain reachable.
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
        setReconciliationData(result);
        setShowReconciliation(true);
        setMessage(result.message || null);
      } else {
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
            level: "parallel",
            parentId: insertId,
            reconciledItems: items,
          });
        }

        setMessage(
          result.message || `Stored ${items.length} parallels (single platform)`,
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
      level: "parallel",
      parentId: insertId,
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
    if (sportValue && yearValue && manufacturerValue && variantTypeValue && setNameValue && !triggered.current) {
      triggered.current = true;
      doSync();
    }
  }, [sportValue, yearValue, manufacturerValue, variantTypeValue, setNameValue]);

  return (
    <>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4">Syncing Parallels</h2>

        {loading && (
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Fetching parallels for <strong>{setNameValue || "..."}</strong>...
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

      {showReconciliation && reconciliationData && existingParallelRows !== undefined && (
        <ReconciliationModal
          isOpen={showReconciliation}
          onClose={() => {
            setShowReconciliation(false);
            onDone?.();
          }}
          onConfirm={handleReconciliationConfirm}
          level="parallel"
          initialData={{
            autoMatched: reconciliationData.autoMatched,
            unmatchedBsc: reconciliationData.unmatchedBsc,
            unmatchedSl: reconciliationData.unmatchedSl,
          }}
          showMetadata
          setName={setNameValue || ""}
          manufacturer={manufacturerValue || ""}
          usedSlPlatformValues={usedIdentifiers?.slPlatformValues}
          usedBscPlatformValues={usedIdentifiers?.bscPlatformValues}
          existingRows={existingParallelRows.map((r) => ({
            value: r.value,
            platformData: r.platformData,
            metadata: r.metadata,
          }))}
        />
      )}
    </>
  );
}
