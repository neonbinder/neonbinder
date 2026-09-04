import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { primarySlot, slotIds, slotLabel } from "../../convex/platformSlots";
import type { PlatformSide, SlotBearingRow } from "../../convex/platformSlots";
import type { GenericId } from "convex/values";
import NeonButton from "../modules/NeonButton";
import BaseSetPicker, { type BaseRemapNotice } from "./BaseSetPicker";
import type { PlatformItem } from "./ReconciliationModal";
import { blockedMessageFromErrors } from "./selector-sync-feedback";

type RawOptionsResult = {
  success: boolean;
  bscOptions: PlatformItem[];
  slOptions: PlatformItem[];
  /** Per-platform failures. `success` stays true for a PARTIAL outage. */
  errors: Array<{ platform: string; message: string }>;
  message?: string;
};

/**
 * Lead-in for this form's fetch-failure message. Unchanged text, now a
 * constant because `blockedMessageFromErrors` appends to it — the same shape
 * `VariantForm` / `ParallelForm` use for their own prefixes.
 */
const SYNC_FAILED_PREFIX = "Failed to fetch options";

/**
 * The refusal `setVariantTypePlatformData` raises when the row moved under us
 * (NEO-219). Fixed text: the operator's picks were NOT written, and the only
 * safe next step is to look at the mapping as it now stands.
 */
const STALE_MESSAGE =
  "This Base mapping changed somewhere else while you were picking. Nothing was written — the choices below have been refreshed, so pick again.";

/**
 * Read a ConvexError's structured `code` without `instanceof`.
 *
 * Same reasoning as `RenameEntityControl.refusalMessage`: a rethrown or mocked
 * error, and a convex-client version skew, must still be recognised. Production
 * redacts `.message`, so `data.code` is the only field that crosses intact.
 */
function errorCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code } = data as { code?: unknown };
  return typeof code === "string" ? code : null;
}

/**
 * Cards fetched through a side's CURRENT PRIMARY slot.
 *
 * `getSlotCardCounts` reports per-slot tallies because detach acts on one slot;
 * a re-map only ever moves the primary. A side whose primary cannot be resolved
 * falls back to the side's total, which over-states rather than under-states —
 * the wrong direction to be wrong in is "this will move nothing".
 */
function primarySlotCards(
  perSlot: Record<string, number> | undefined,
  slot: string | undefined,
): number {
  if (!perSlot) return 0;
  if (slot && typeof perSlot[slot] === "number") return perSlot[slot];
  return Object.values(perSlot).reduce((a, b) => a + b, 0);
}

type SlotCardCounts = {
  bsc?: Record<string, number>;
  sportlots?: Record<string, number>;
  total?: number;
};

type BaseMappingFormProps = {
  variantTypeId: GenericId<"selectorOptions">;
  // When true, the form auto-runs fetchRawOptions and opens BaseSetPicker
  // on mount. When false, the form waits for an explicit "Sync Base Mapping"
  // click. The picker is the only piece of UI shown either way — there's no
  // form layout otherwise.
  autoOpen: boolean;
  /**
   * `initial` — this Base has no SportLots mapping yet; nothing is at stake.
   * `remap` — the operator opened "Re-map Base" on a row that IS mapped, so
   * the dialog states how many cards the existing mapping holds and the write
   * is version-guarded. The parent already keys this component on the mode, so
   * the two never share an instance.
   */
  mode: "initial" | "remap";
  onClose: () => void;
};

// Captures the Base variantType's SL/BSC platform mapping by reusing the
// reconciliation pipeline (fetchRawOptions + BaseSetPicker). On confirm,
// writes the mapping onto the variantType row itself via
// setVariantTypePlatformData — no child insert row is created.
//
// Replaces the isBase branch of VariantForm under the new "Base is
// terminal" model.
//
// NEO-219: this form no longer writes ANYTHING the operator did not pick. It
// used to take two silent shortcuts — storing `bscOptions[0]` whenever
// SportLots came back empty, and storing the SET's own BSC slug when both
// sides came back empty — so a Base row could end up linked to a marketplace
// set nobody ever saw. Both are gone: every successful fetch opens the picker,
// the set slug is offered there as a visible candidate row, and the only
// outcomes that write nothing and skip the dialog are a failed fetch and
// "nothing on either side, and no set slug either".
export default function BaseMappingForm({
  variantTypeId,
  autoOpen,
  mode,
  onClose,
}: BaseMappingFormProps) {
  const fetchRawOptions = useAction(api.setReconciliation.fetchRawOptions);
  const setPlatformData = useMutation(
    api.selectorOptions.setVariantTypePlatformData,
  );
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: variantTypeId,
  });
  // Remap only: the row itself (for `baseVersion` + the current labels) and the
  // per-slot card counts behind the impact sentence. Skipped in `initial` mode
  // — there is no prior mapping to be stale against or to count.
  const variantTypeRow = useQuery(
    api.selectorOptions.getSelectorOptionById,
    mode === "remap" ? { id: variantTypeId } : "skip",
  );
  const slotCounts = useQuery(
    api.selectorOptions.getSlotCardCounts,
    mode === "remap" ? { selectorOptionId: variantTypeId } : "skip",
  ) as SlotCardCounts | undefined;

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerData, setPickerData] = useState<RawOptionsResult | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
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

  // The SET's own BSC slug. NEO-137: read through `slotIds` — `platformData.bsc`
  // is a slot MAP, so the old typeof-string / Array.isArray narrowing was
  // type-legal against a Record and silently always undefined.
  const setListingSlug = setNameAncestor
    ? slotIds(setNameAncestor, "bsc")[0]
    : undefined;
  const setListing: PlatformItem | undefined =
    setListingSlug && setNameValue
      ? { value: setNameValue, platformValue: setListingSlug }
      : undefined;

  const currentLabel = (side: PlatformSide): string | undefined => {
    if (!variantTypeRow) return undefined;
    const row = variantTypeRow as unknown as SlotBearingRow;
    const slot = primarySlot(row, side);
    return slot ? slotLabel(row, side, slot) : undefined;
  };

  const remapNotice: BaseRemapNotice | undefined =
    mode === "remap" && slotCounts
      ? {
          totalCards: typeof slotCounts.total === "number" ? slotCounts.total : 0,
          slCards: primarySlotCards(
            slotCounts.sportlots,
            variantTypeRow
              ? primarySlot(variantTypeRow as unknown as SlotBearingRow, "sportlots")
              : undefined,
          ),
          bscCards: primarySlotCards(
            slotCounts.bsc,
            variantTypeRow
              ? primarySlot(variantTypeRow as unknown as SlotBearingRow, "bsc")
              : undefined,
          ),
          currentSlLabel: currentLabel("sportlots"),
          currentBscLabel: currentLabel("bsc"),
        }
      : undefined;

  const writePlatformData = async (platformData: {
    bsc?: string;
    sportlots?: string;
    sportlotsDisplay?: string;
  }) => {
    await setPlatformData({
      variantTypeId,
      platformData,
      // Only the re-map is version-guarded: an `initial` mapping has no prior
      // state a concurrent write could invalidate, and an older Convex would
      // reject the unknown argument outright.
      ...(mode === "remap" && typeof variantTypeRow?.lastUpdated === "number"
        ? { baseVersion: variantTypeRow.lastUpdated }
        : {}),
    });
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
        // NEO-211 F3: `result.message` here is fetchRawOptions' OUTER-CATCH
        // string, which embeds the thrown exception text — an adapter response
        // body, a marketplace URL, or a credential hint. Twin of the line fixed
        // in VariantForm/ParallelForm: raw marketplace text must never reach
        // the DOM, so the platform names are ours and the detail stays in the
        // Convex logs.
        setMessage(
          blockedMessageFromErrors(SYNC_FAILED_PREFIX, result.errors ?? []) ??
            `${SYNC_FAILED_PREFIX}.`,
        );
        return;
      }

      // Nothing anywhere — not one SportLots row, not one BSC row, and the set
      // carries no BSC slug either. This is the ONLY successful outcome that
      // does not open the picker, and it still writes nothing.
      if (
        result.slOptions.length === 0 &&
        result.bscOptions.length === 0 &&
        !setListing
      ) {
        setPickerOpen(false);
        setMessage("No marketplace data found for this Base set.");
        onClose();
        return;
      }

      // Everything else is a decision for the operator, including the cases
      // that used to be taken silently on their behalf.
      setPickerData(result);
    } catch {
      setPickerOpen(false);
      // NEO-211 F3: the thrown text is a Convex/adapter error that can carry a
      // marketplace URL, a response body or a credential hint. Our own fixed
      // string; the detail stays in the Convex logs. This panel shows Retry for
      // EVERY message (not only errors), so there is no isError branch to
      // preserve.
      setMessage(`${SYNC_FAILED_PREFIX}. Nothing was changed.`);
    } finally {
      setLoading(false);
    }
  };

  const handlePickerConfirm = async (selected: {
    sl?: PlatformItem;
    bsc?: PlatformItem;
  }) => {
    // Exactly what was picked. No implicit set-slug substitution: the set
    // listing is a candidate row in the dialog now, so if it is what should be
    // linked, it was chosen.
    const platformData: {
      bsc?: string;
      sportlots?: string;
      sportlotsDisplay?: string;
    } = {};
    if (selected.sl) {
      platformData.sportlots = selected.sl.platformValue;
      platformData.sportlotsDisplay = selected.sl.value;
    }
    if (selected.bsc) {
      platformData.bsc = selected.bsc.platformValue;
    }
    if (!platformData.sportlots && !platformData.bsc) return;

    try {
      await writePlatformData(platformData);
    } catch (e) {
      if (errorCode(e) === "BASE_MAPPING_STALE") {
        // Re-open on the FRESH row: `variantTypeRow` is reactive, so the next
        // confirm carries the current `baseVersion`, and re-running the fetch
        // means the candidate rows are current too.
        setStaleNotice(STALE_MESSAGE);
        void doSync();
        return;
      }
      setPickerOpen(false);
      setMessage(`${SYNC_FAILED_PREFIX}. Nothing was changed.`);
      return;
    }
    setStaleNotice(null);
    setPickerOpen(false);
    onClose();
  };

  useEffect(() => {
    if (!autoOpen) return;
    if (triggered.current) return;
    if (!sportValue || !yearValue || !setNameValue) return;
    triggered.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fires the auto-sync action; latched by triggered.current so it runs once
    void doSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- doSync is deliberately omitted: it is not referentially stable, and including it would refire the auto-sync it is latched (triggered.current) to run once
  }, [autoOpen, sportValue, yearValue, setNameValue]);

  if (!autoOpen && !pickerOpen && !loading && !message) {
    // Nothing to render when invoked with autoOpen=false until the user
    // clicks the trigger that opens this form. Parent owns visibility.
    return null;
  }

  return (
    <>
      {/* Inline message panel shows for every terminal state that doesn't
          render a picker: errors, the nothing-anywhere case, AND a cancelled
          picker (NEO-71-74 fix — previously Cancel called onClose() immediately
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
            setStaleNotice(null);
            setMessage(
              "Base mapping cancelled — nothing was linked. Click Retry to pick a set, or Close to leave it unmapped for now.",
            );
          }}
          onConfirm={handlePickerConfirm}
          slOptions={pickerData?.slOptions ?? []}
          bscOptions={pickerData?.bscOptions ?? []}
          setListing={setListing}
          setName={setNameValue || ""}
          manufacturer={manufacturerValue || ""}
          loading={loading}
          mode={mode}
          remapNotice={remapNotice}
          notice={staleNotice}
        />
      )}
    </>
  );
}
