import React, { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import { primarySlot, slotEntries, slotIds, slotLabel } from "../../convex/platformSlots";
import ReconciliationModal, { type ReconciledResult, type MatchedPair, type PlatformItem, type SlCandidateGroup } from "./ReconciliationModal";
import SyncDoneNotice from "./SyncDoneNotice";
import {
  blockedMessageFromErrors,
  buildUnlinkedNotices,
  coveredSidesFromErrors,
  returnedIdsFromFetch,
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
  // a11y: a11y-focus-park landing spot for the two moments below where the
  // control that had focus unmounts out from under it.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = `variant-sync-heading-${variantTypeId}`;
  const wasLoadingRef = useRef(false);
  const hadUnlinkedRef = useRef(false);

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
        // NEO-137: the SL display name is the PRIMARY SLOT's label. It used to
        // live in platformData.sportlotsDisplay, a single string that had no
        // meaning once a row could hold several SL sets.
        ...(() => {
          if (!baseVariant) return {};
          const slot = primarySlot(baseVariant, "sportlots");
          if (!slot) return {};
          const label = slotLabel(baseVariant, "sportlots", slot);
          return label ? { baseSlPrefix: label } : {};
        })(),
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

      // Both adapters came back empty AND at least one reported an error, so
      // nothing is known about either side. Surface it and write nothing.
      //
      // Deliberately NO onDone() here (NEO-211). onDone returns EntityColumn to
      // idle, which unmounts this form — taking the alert AND its Retry button
      // with it, so the operator was told nothing and had no way to re-run. The
      // original reason for calling it was to make the panel-header actions
      // ("Group Parallels") reachable again; they still are, one Cancel click
      // away in this panel's own footer, which is a far better trade than an
      // invisible failure. Partial-failure visibility is acceptance #2 of the
      // ticket, and it cannot be delivered by a message that never renders.
      //
      // The copy is built entirely from OUR strings — the adapter's own
      // `message` is deliberately not interpolated, per the same rule as the
      // partial-failure branch below: marketplace response text is untrusted
      // third-party output and never becomes user-facing error copy here.
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
        // Both platforms have data — show reconciliation modal
        setReconciliationData(result);
        setShowReconciliation(true);
        // Not `result.message`: its warning suffix interpolates each adapter's
        // own error text. The modal is opening anyway, so there is nothing to say.
        setMessage(null);
      } else {
        // Only ONE platform has data. Storing that is a claim about BOTH sides:
        // the store may act on rows linked to the side that came back empty. So
        // the empty side has to have been genuinely REACHED and genuinely empty.
        //
        // NEO-211 (plan B): if any adapter errored, we know nothing about the
        // empty side, so write nothing at all and name the platform that failed.
        // Deliberately NOT calling onDone() here — onDone returns EntityColumn
        // to idle mode, which unmounts this form and takes the alert (and its
        // Retry button) with it. The operator has to be able to see that their
        // data was left alone and to re-run the sync.
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
            level: "insert",
            parentId: variantTypeId,
            reconciledItems: items,
            // Both sides were reached (plan.kind === "store" proves it), so the
            // store is allowed to detach links on the side that returned
            // nothing. Without this the mutation infers coverage from the items
            // it was handed and would never touch the empty side at all.
            coveredSides: plan.coveredSides,
            // What the FETCH returned, which on this path is the whole story:
            // the empty side comes through as [], the statement that licenses
            // unlinking its rows.
            returnedIds: returnedIdsFromFetch(result),
          });
          unlinkedRows = stored?.unlinked ?? [];
          setUnlinkedTotal(stored?.unlinkedTotal);
        }

        setUnlinked(unlinkedRows);
        setMessage(
          // Our own sentence. `result.message` carries the same adapter-text
          // warning suffix as the modal path above.
          `Stored ${items.length} variants (single platform)`,
        );
        // A detach the operator has not seen is a silent data change. Hold the
        // panel open so the notice renders; they close it themselves.
        // NB: empty-empty-no-errors MUST land here and call onDone — it is the
        // normal path for a custom subtree (both adapters short-circuit), and
        // EntityColumn renders this form INSTEAD of the idle "+ Custom" button
        // while mode === "sync", so not returning to idle hides that button.
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
    // we say nothing rather than guessing — see `coveredSidesFromErrors`.
    const covered = coveredSidesFromErrors(reconciliationData?.errors);
    const returnedIds = reconciliationData
      ? returnedIdsFromFetch(reconciliationData)
      : undefined;
    // Clear any previous failure so a retry does not show a stale reason.
    setSaveError(null);
    let stored;
    try {
      stored = await storeReconciledOptions({
        level: "insert",
        parentId: variantTypeId,
        reconciledItems: result.items.map((item) => ({
          value: item.value,
          platformData: item.platformData,
          // Forwarded so every allocated slot gets the marketplace's own set
          // name. A set may map to several sets per side, and without labels
          // the slots are indistinguishable ids downstream.
          platformLabels: item.platformLabels,
          metadata: item.metadata,
          // NEO-211 (plan E): the NB row this modal row IS. With it the store
          // treats a title edit as a rename of that row, keeping its _id and its
          // whole subtree; without it, a rename was delete-and-reinsert.
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
    // Same rule as the single-platform path: a silent detach is not acceptable,
    // so the panel stays up to carry the notice.
    if (unlinkedRows.length === 0) onDone?.();
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- doSync deliberately omitted — same one-shot auto-sync latch; including it would loop
  }, [sportValue, yearValue, baseVariant]);

  // a11y: `loading` hides the ENTIRE button row below (Retry/Cancel), so a
  // click on Retry unmounts itself on the very next render — the browser
  // drops focus to <body> with no recovery. Guarded on the actual blur (per
  // this codebase's rAF-focus-park lesson) so it only fires when something
  // really did just vanish, not on every loading change.
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = loading;
    if (!wasLoading && loading && document.activeElement === document.body) {
      panelRef.current?.focus();
    }
  }, [loading]);

  // a11y: clicking the unlink notice's Dismiss unmounts the notice — Dismiss
  // included — with no sibling control taking focus. Same guard shape as
  // above, keyed on the notice's own visibility instead of `loading`.
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
          Syncing {variantsLabel}
        </h2>

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
              {/* NEO-211 (plan D): rows the marketplace stopped listing. The
                  rows are still ours — only the marketplace link went away —
                  so this is a notice, not an error, and it sits above the
                  outcome message it explains. */}
              {!showReconciliation && (
                <SyncDoneNotice
                  notices={buildUnlinkedNotices(unlinked, "insert", {
                    totalsBySide: totalsBySideFor(unlinked, unlinkedTotal),
                  })}
                  onDismiss={() => setUnlinked([])}
                />
              )}

              {message && !showReconciliation && (
                // WCAG 4.1.3: the success/info case ("Stored N variants…")
                // needs a role too, or a screen-reader user gets zero
                // announcement that the sync finished — role="status" implies
                // aria-live="polite" on its own, so no explicit aria-live here.
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

      {showReconciliation && reconciliationData && existingVariantRows !== undefined && (
        <ReconciliationModal
          isOpen={showReconciliation}
          onClose={() => {
            setSaveError(null);
            setShowReconciliation(false);
            onDone?.();
          }}
          onConfirm={handleReconciliationConfirm}
          saveError={saveError}
          level="insert"
          levelLabel={variantsLabel}
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
          extraSlPrefixes={(() => {
            // extraSlPrefixes wants human display strings for the SL prefix
            // filter (the stored value is a numeric SL radio ID).
            // NEO-137: every attached SL slot carries a label, so this is
            // simply "the label of each slot" — primary included. That
            // subsumes the old sportlotsDisplay-plus-platformLabels union.
            if (!baseVariant) return [];
            const prefixes: string[] = [];
            const seen = new Set<string>();
            for (const { slot } of slotEntries(baseVariant, "sportlots")) {
              const label = slotLabel(baseVariant, "sportlots", slot);
              if (label && !seen.has(label)) {
                seen.add(label);
                prefixes.push(label);
              }
            }
            return prefixes;
          })()}
          usedSlPlatformValues={usedIdentifiers?.slPlatformValues}
          usedBscPlatformValues={usedIdentifiers?.bscPlatformValues}
          existingRows={existingVariantRows?.map((r) => ({
            // NEO-211 (plan E): carried through the modal so a rename inside it
            // stays a rename of THIS row.
            existingId: r._id,
            value: r.value,
            // The modal speaks marketplace IDs, not slots.
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
