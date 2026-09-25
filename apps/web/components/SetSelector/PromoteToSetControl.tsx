import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { ChoiceList, LandingPath, SetShapeDialog, type Choice } from "./SetShapeDialog";
import type { ReshapeStep } from "./MakeParallelControl";

/**
 * NEO-305 Part C — "Promote to set" on a parallel row, the way back from
 * "Make parallel of…".
 *
 * When Sync Sets files a real SportLots-only set (Topps Pristine, say) as a
 * flagship parallel, or an operator folds one in by mistake, this lifts one
 * SportLots link — and the cards that came from it — back out into a set of
 * its own under the same brand, named the way the sync names a SportLots set
 * ("Pristine" under Topps is "Topps Pristine"). If the brand already has a
 * set by that name, the dialog offers to add the link to that set's Base
 * instead. The parallel row stays while it still holds anything (a BSC link,
 * other cards) and goes once it is empty.
 *
 * Offered only on a parallel of a set that carries a SportLots link
 * (`getParallelPromotionEligibility`).
 */

export const PROMOTE_LABEL = "Promote to set";
export const PROMOTE_TOOLTIP =
  "Turn this parallel's SportLots set into a set of its own in the same brand. Its cards come along.";

/** DRAFT copy — pending Jason's sign-off (NEO-245). */
export const promoteCopy = {
  title: (row: string) => `Promote “${row}” to a set`,
  description: (brand: string, cards: number) =>
    `Its SportLots set${
      cards > 0 ? ` and ${cards} ${cards === 1 ? "card" : "cards"}` : ""
    } become a set of its own under ${brand}.`,
  rowStays: (row: string) => `“${row}” stays, keeping everything else on it.`,
  rowGoes: (row: string) => `Nothing else is on “${row}”, so it goes.`,
  linksLegend: "Which SportLots set?",
  linksFilter: "Find a SportLots set",
  loading: "Checking the name…",
  clash: (brand: string, set: string) =>
    `${brand} already has a set called “${set}”. Add this to its Base instead.`,
  clashNoBase: (brand: string, set: string) =>
    `${brand} already has a set called “${set}”, and it has no Base yet. Pick ${set}, run Sync Variant Types, then come back.`,
  clashHoldsLink: (set: string) =>
    `“${set}”’s Base already has this SportLots set, so there's nothing to move.`,
  // Not "Promote to set": that is the trigger's name, and the trigger is
  // still in the document (inert) while this dialog is up.
  confirmNew: "Promote it",
  confirmAttach: (set: string) => `Add to ${set}`,
  busy: "Promoting…",
  done: (set: string, created: boolean) =>
    created ? `“${set}” is its own set now.` : `Added to “${set}”’s Base.`,
  newTag: "new",
  joinsTag: "joins",
};

export default function PromoteToSetControl({
  parallelId,
  parallelValue,
  showToast,
  onReshaped,
}: {
  parallelId: Id<"selectorOptions">;
  parallelValue: string;
  showToast: (message: string) => void;
  /** The owner drills the cascade to the new set's Base and parks focus. */
  onReshaped?: (path: ReshapeStep[]) => void;
}) {
  const eligibility = useQuery(api.setParallelConversion.getParallelPromotionEligibility, {
    parallelId,
  });
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef(false);

  useEffect(() => {
    if (open || !restoreRef.current) return;
    restoreRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  if (!eligibility?.eligible) return null;

  const openDialog = () => setOpen(true);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        onKeyDown={(event) => activateOnEnter(event, openDialog)}
        aria-haspopup="dialog"
        inert={open}
        title={PROMOTE_TOOLTIP}
        className="shrink-0 text-xs py-1.5 text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
      >
        {PROMOTE_LABEL}
      </button>
      {open && (
        <PromoteDialog
          parallelId={parallelId}
          parallelValue={parallelValue}
          links={eligibility.links}
          onCancel={() => {
            restoreRef.current = true;
            setOpen(false);
          }}
          onDone={(message, path) => {
            setOpen(false);
            showToast(message);
            onReshaped?.(path);
          }}
        />
      )}
    </>
  );
}

function PromoteDialog({
  parallelId,
  parallelValue,
  links,
  onCancel,
  onDone,
}: {
  parallelId: Id<"selectorOptions">;
  parallelValue: string;
  links: Array<{ slot: string; label: string }>;
  onCancel: () => void;
  onDone: (message: string, path: ReshapeStep[]) => void;
}) {
  const [slot, setSlot] = useState<string>(links[0]?.slot ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promote = useMutation(api.setParallelConversion.promoteParallelToSet);
  const preview = useQuery(
    api.setParallelConversion.getParallelPromotionPreview,
    slot ? { parallelId, slSlotKey: slot } : "skip",
  );
  const ok = preview?.ok ? preview : null;
  // The reason the confirm is blocked (or what it will do instead), said on
  // the confirm itself (a11y audit, NEO-305).
  const noteId = useId();
  const reasonId = useId();

  // What pressing confirm would do, and whether it can.
  const clash = ok?.clash;
  const attachTo = clash && clash.hasBase && !clash.holdsLink ? clash : undefined;
  const blocked =
    ok === null ||
    ok.refusal !== undefined ||
    (clash !== undefined && attachTo === undefined);

  const linkChoices: Choice[] = links.map((l) => ({
    id: l.slot,
    label: l.label,
    ariaLabel: `Promote ${l.label}`,
  }));

  const handleConfirm = async () => {
    if (busy || blocked || !ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await promote({
        parallelId,
        slSlotKey: slot,
        ...(attachTo ? { attachToSetId: attachTo.setId } : {}),
      });
      onDone(promoteCopy.done(result.setValue, result.created), [
        { _id: result.setId, level: "setName" },
        { _id: result.baseId, level: "variantType" },
      ]);
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't promote this parallel. Nothing changed."));
      setBusy(false);
    }
  };

  let note: string | null = null;
  if (ok?.refusal) note = ok.refusal;
  else if (clash && !clash.hasBase) note = promoteCopy.clashNoBase(ok!.brandValue, clash.value);
  else if (clash && clash.holdsLink) note = promoteCopy.clashHoldsLink(clash.value);
  else if (clash) note = promoteCopy.clash(ok!.brandValue, clash.value);

  const description = ok
    ? `${promoteCopy.description(ok.brandValue, ok.cardCount)} ${
        ok.rowStays ? promoteCopy.rowStays(parallelValue) : promoteCopy.rowGoes(parallelValue)
      }`
    : promoteCopy.description("its brand", 0);

  return (
    <SetShapeDialog
      title={promoteCopy.title(parallelValue)}
      description={description}
      preview={
        ok && !blocked ? (
          <LandingPath
            segments={[ok.brandValue, attachTo ? attachTo.value : ok.setName, "Base"]}
            verb={attachTo ? promoteCopy.joinsTag : promoteCopy.newTag}
          />
        ) : null
      }
      confirmLabel={attachTo ? promoteCopy.confirmAttach(attachTo.value) : promoteCopy.confirmNew}
      busyLabel={promoteCopy.busy}
      busy={busy}
      confirmDisabled={blocked}
      confirmDescribedBy={
        [
          ...(preview !== undefined && !preview.ok ? [reasonId] : []),
          ...(note ? [noteId] : []),
        ].join(" ") || undefined
      }
      autofocusConfirm={links.length <= 1}
      error={error}
      onConfirm={() => void handleConfirm()}
      onCancel={() => {
        if (!busy) onCancel();
      }}
    >
      {links.length > 1 && (
        <ChoiceList
          legend={promoteCopy.linksLegend}
          choices={linkChoices}
          selectedId={slot}
          onSelect={(id) => {
            setError(null);
            setSlot(id);
          }}
          autofocusId={slot}
          filterLabel={promoteCopy.linksFilter}
          describedBy={note ? noteId : undefined}
        />
      )}
      {preview === undefined && <p className="text-sm text-slate-400">{promoteCopy.loading}</p>}
      {preview !== undefined && !preview.ok && (
        <p id={reasonId} className="text-sm text-[#FF2EB3]">
          {preview.reason}
        </p>
      )}
      {note && (
        <p id={noteId} className="text-sm text-slate-300">
          {note}
        </p>
      )}
    </SetShapeDialog>
  );
}
