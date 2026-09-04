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
  coveredSidesFromFetch,
  returnedIdsFromFetch,
  skippedSidesOf,
  totalsBySideFor,
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
  // The server truncates `unlinked` to a 50-row sample and reports the real
  // count here, so the notice can say "312 sets" while naming two of them.
  const [unlinkedTotal, setUnlinkedTotal] = useState<number | undefined>(undefined);
  // NEO-211: a failed save from inside the reconciliation dialog. Shown IN the
  // dialog so the operator's reconciliation survives and Save can be retried.
  const [saveError, setSaveError] = useState<string | null>(null);
  const triggered = useRef(false);
  // a11y: focus-park landing spot — see VariantForm.tsx's own copy of these
  // two effects for the full rationale (Retry-unmount and Dismiss-unmount).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = `parallel-sync-heading-${insertId}`;
  const wasLoadingRef = useRef(false);
  const hadUnlinkedRef = useRef(false);

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
        // NEO-211 F3: `result.message` here is fetchRawOptions' OUTER-CATCH
        // string, which embeds the thrown exception text — an adapter response
        // body, a marketplace URL, or a credential hint. Raw marketplace text
        // must never reach the DOM, so the platform names are ours and the
        // detail stays in the Convex logs.
        setMessage(
          blockedMessageFromErrors(SYNC_FAILED_PREFIX, result.errors) ??
            `${SYNC_FAILED_PREFIX}.`,
        );
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
        // Not `result.message`: its warning suffix interpolates each adapter's
        // own error text. The modal is opening anyway, so there is nothing to say.
        setMessage(null);
      } else {
        // Only ONE platform has data — see VariantForm.doSync for the full
        // rationale. NEO-211 (plan B): storing a one-sided result is a claim
        // about the OTHER side too, so an adapter error means write nothing and
        // name the platform. No onDone() on this path: it would unmount the
        // form and take the alert and its Retry button with it.
        // NEO-239: a side skipped for lack of ids is not "reached and empty",
        // so it never enters coveredSides — see VariantForm.doSync.
        const plan = planSinglePlatformStore(
          result.errors,
          skippedSidesOf(result),
        );
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

        // NEO-239 — NOTHING CAME BACK, AND THAT IS NOT A FAILURE.
        //
        // Either both sides were skipped for want of ids on this chain (a
        // hand-built subtree: `skippedSides` is both, `errors` is empty), or a
        // side that WAS reached genuinely had nothing. In neither case is there
        // anything to store, anything to unlink, or anything to retry — the
        // only useful next move is "+ Custom", which lives on the idle column
        // behind this form. So go idle rather than sitting on a Retry the
        // operator cannot act on.
        //
        // A routing rule, not an optimisation: leaving the panel up stranded
        // ten E2E flows at the Inserts column of a hand-made subtree (CI run
        // 5), and it is what a real operator building a set by hand meets on
        // their very first Sync.
        if (items.length === 0) {
          setMessage(null);
          onDone?.();
          return;
        }

        const stored = await storeReconciledOptions({
          level: "parallel",
          parentId: insertId,
          reconciledItems: items,
          // Every side that was REACHED — a skipped one is excluded, so the
          // store never detaches on a marketplace nobody asked (NEO-239).
          coveredSides: plan.coveredSides,
          // The empty side arrives as [] — the statement that licenses
          // unlinking its rows.
          returnedIds: returnedIdsFromFetch(result),
        });
        const unlinkedRows: UnlinkedEntry[] = stored?.unlinked ?? [];
        setUnlinkedTotal(stored?.unlinkedTotal);

        setUnlinked(unlinkedRows);
        setMessage(
          // Our own sentence. `result.message` carries the same adapter-text
          // warning suffix as the modal path above.
          `Stored ${items.length} parallels (single platform)`,
        );
        // Hold the panel open while there is a detach to report.
        if (unlinkedRows.length === 0) onDone?.();
      }
    } catch {
      // NEO-211 F3: the thrown text here is a Convex/adapter error that can
      // carry a marketplace URL, a response body or a credential hint, and this
      // catch also covers the single-platform store call. Our own fixed string;
      // the detail stays in the Convex logs. Keeps the SYNC_FAILED_PREFIX lead
      // so the isError branch still renders Retry + Cancel.
      setMessage(`${SYNC_FAILED_PREFIX}. Nothing was changed.`);
    } finally {
      setLoading(false);
    }
  };

  const handleReconciliationConfirm = async (result: ReconciledResult) => {
    // Both read off the fetch result the modal was built from. If it is gone
    // we say nothing rather than guessing — see `coveredSidesFromFetch`. A side
    // the fetch SKIPPED for lack of ids is subtracted too (NEO-239): it raises
    // no error, and calling it covered would unlink every child's slot on a
    // marketplace that was never asked.
    const covered = coveredSidesFromFetch(
      reconciliationData?.errors,
      skippedSidesOf(reconciliationData),
    );
    const returnedIds = reconciliationData
      ? returnedIdsFromFetch(reconciliationData)
      : undefined;
    // Clear any previous failure so a retry does not show a stale reason.
    setSaveError(null);
    let stored;
    try {
      stored = await storeReconciledOptions({
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
        // Every side that answered. Both did here (the modal only opens when both
        // returned rows), but deriving it keeps the guarantee honest. Spread
        // rather than assigned so an absent fetch result OMITS the arg — the
        // store then unlinks nothing, instead of being told both sides were fine.
        ...(covered ? { coveredSides: covered } : {}),
        // NEO-211 F1: what the MARKETPLACE returned, sent separately from what the
        // operator confirmed above. The store cannot derive "no longer listed"
        // from `reconciledItems`: a restored row is always in there (so a delisted
        // set could never be unlinked) and a row the operator disbanded is not
        // (so a set the marketplace still lists looked delisted, and the admin got
        // a false "No longer listed" notice). Derived from the FETCH, never from
        // the modal's output.
        ...(returnedIds ? { returnedIds } : {}),
      });
    } catch {
      // Our own fixed string: the thrown text is a Convex server error that can
      // carry marketplace/response detail, and it must not reach the DOM.
      // Deliberately does NOT close the dialog — the operator's whole
      // reconciliation is in there and closing would discard it.
      setSaveError(
        "Couldn't save these sets. Nothing was changed — press Save to try again, or Cancel to close.",
      );
      return;
    }
    setShowReconciliation(false);
    const unlinkedRows = stored?.unlinked ?? [];
    setUnlinkedTotal(stored?.unlinkedTotal);
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

  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = loading;
    if (!wasLoading && loading && document.activeElement === document.body) {
      panelRef.current?.focus();
    }
  }, [loading]);

  useEffect(() => {
    const hadUnlinked = hadUnlinkedRef.current;
    hadUnlinkedRef.current = unlinked.length > 0;
    if (hadUnlinked && unlinked.length === 0 && document.activeElement === document.body) {
      panelRef.current?.focus();
    }
  }, [unlinked]);

  return (
    <>
      <div
        ref={panelRef}
        tabIndex={-1}
        aria-labelledby={headingId}
        className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow"
      >
        <h2 id={headingId} className="text-xl font-semibold mb-4">
          Syncing Parallels
        </h2>

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
                  notices={buildUnlinkedNotices(unlinked, "parallel", {
                    totalsBySide: totalsBySideFor(unlinked, unlinkedTotal),
                  })}
                  onDismiss={() => setUnlinked([])}
                />
              )}

              {message && !showReconciliation && (
                // WCAG 4.1.3: give the success/info case an announcement too —
                // see VariantForm.tsx's identical fix for the full rationale.
                <div
                  role={isError ? "alert" : "status"}
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
            setSaveError(null);
            setShowReconciliation(false);
            onDone?.();
          }}
          onConfirm={handleReconciliationConfirm}
          saveError={saveError}
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
