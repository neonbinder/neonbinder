import React, { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { slotIds } from "../../convex/platformSlots";
import ReconciliationModal, { type ReconciledResult, type MatchedPair, type PlatformItem, type SlCandidateGroup } from "./ReconciliationModal";
import SyncDoneNotice from "./SyncDoneNotice";
import {
  blockedMessageFromErrors,
  buildUnlinkedNotices,
  coveredSidesFromErrors,
  partialFailureMessage,
  planSinglePlatformStore,
  type UnlinkedEntry,
} from "./selector-sync-feedback";

type RawOptionsResult = {
  success: boolean;
  bscOptions: PlatformItem[];
  slOptions: PlatformItem[];
  autoMatched: MatchedPair[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
  // NEO-137: ranked SL candidates per unmatched BSC row, including sets an
  // auto-match already claimed. Feeds the modal's "Use this set too" affordance.
  slCandidates?: SlCandidateGroup[];
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
  // NEO-211 (plan D): rows whose marketplace link the store just detached
  // because that side was reached and no longer lists them. The rows themselves
  // survive — this is the only place the admin is told it happened.
  const [unlinked, setUnlinked] = useState<UnlinkedEntry[]>([]);
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

      // Both adapters came back empty with at least one error — see
      // VariantForm.doSync for the full rationale, including why this path
      // deliberately does NOT call onDone (NEO-211: it would unmount the form
      // and destroy the alert and its Retry button).
      if (
        result.bscOptions.length === 0 &&
        result.slOptions.length === 0 &&
        result.errors.length > 0
      ) {
        setMessage(
          blockedMessageFromErrors(SYNC_FAILED_PREFIX, result.errors) ??
            `${SYNC_FAILED_PREFIX}.`,
        );
        return;
      }

      if (result.bscOptions.length > 0 && result.slOptions.length > 0) {
        setReconciliationData(result);
        setShowReconciliation(true);
        setMessage(result.message || null);
      } else {
        // Only ONE platform has data — see VariantForm.doSync for the full
        // rationale. NEO-211 (plan B): storing a one-sided result is a claim
        // about the OTHER side too, so an adapter error means write nothing and
        // name the platform. No onDone() on this path: it would unmount the
        // form and take the alert and its Retry button with it.
        const plan = planSinglePlatformStore(result.errors);
        if (plan.kind === "blocked") {
          setMessage(partialFailureMessage(SYNC_FAILED_PREFIX, plan));
          return;
        }

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

        let unlinkedRows: UnlinkedEntry[] = [];
        if (items.length > 0) {
          const stored = await storeReconciledOptions({
            level: "parallel",
            parentId: insertId,
            reconciledItems: items,
            // Both sides were reached, so the store may act on the empty one.
            coveredSides: plan.coveredSides,
          });
          unlinkedRows = stored?.unlinked ?? [];
        }

        setUnlinked(unlinkedRows);
        setMessage(
          result.message || `Stored ${items.length} parallels (single platform)`,
        );
        // Hold the panel open while there is a detach to report.
        if (unlinkedRows.length === 0) onDone?.();
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
    const stored = await storeReconciledOptions({
      level: "parallel",
      parentId: insertId,
      reconciledItems: result.items.map((item) => ({
        value: item.value,
        platformData: item.platformData,
        // Forwarded so every allocated slot gets the marketplace's own set
        // name. A set may map to several sets per side, and without labels
        // the slots are indistinguishable ids downstream.
        platformLabels: item.platformLabels,
        metadata: item.metadata,
        // NEO-211 (plan E): the NB row this modal row IS, so a title edit here
        // renames that row instead of deleting and reinserting it.
        existingId: item.existingId,
      })),
      coveredSides: coveredSidesFromErrors(reconciliationData?.errors ?? []),
    });
    setShowReconciliation(false);
    const unlinkedRows = stored?.unlinked ?? [];
    setUnlinked(unlinkedRows);
    if (unlinkedRows.length === 0) onDone?.();
  };

  useEffect(() => {
    if (sportValue && yearValue && manufacturerValue && variantTypeValue && setNameValue && !triggered.current) {
      triggered.current = true;
      doSync();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- doSync deliberately omitted — same one-shot auto-sync latch as BaseMappingForm; including it would loop
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
              {/* NEO-211 (plan D): rows the marketplace stopped listing. The
                  rows are still ours — only the link went away — so this is a
                  notice, not an error. */}
              {!showReconciliation && (
                <SyncDoneNotice
                  notices={buildUnlinkedNotices(unlinked, "parallel")}
                  onDismiss={() => setUnlinked([])}
                />
              )}

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
            // NEO-137: lets the modal offer an already-claimed SL set to a
            // second NB row (the 1996 Score shared-set case).
            slCandidates: reconciliationData.slCandidates,
          }}
          showMetadata
          setName={setNameValue || ""}
          manufacturer={manufacturerValue || ""}
          usedSlPlatformValues={usedIdentifiers?.slPlatformValues}
          usedBscPlatformValues={usedIdentifiers?.bscPlatformValues}
          existingRows={existingParallelRows.map((r) => ({
            // NEO-211 (plan E): carried through so a rename in the modal stays
            // a rename of THIS row.
            existingId: r._id,
            value: r.value,
            // The modal speaks marketplace IDs, not slots (NEO-137).
            platformData: {
              bsc: slotIds(r, "bsc"),
              sportlots: slotIds(r, "sportlots"),
            },
            metadata: r.metadata,
          }))}
        />
      )}
    </>
  );
}
