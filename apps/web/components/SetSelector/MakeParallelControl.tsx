import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { ChoiceList, LandingPath, SetShapeDialog, type Choice } from "./SetShapeDialog";
import type { SelectorLevel } from "./selector-sync-feedback";

/**
 * NEO-305 Part B — "Make parallel of…" on a set row.
 *
 * Sync Sets once filed SportLots' colour lists ("Bowman Blue", "Bowman
 * Gold"…) as sets beside Bowman when they are Bowman's parallels. This is the
 * operator's fix, one set at a time: pick the set it is a parallel of, then
 * either a new parallel (named for you) or one that is already there. The
 * set's SportLots link and cards move; the set itself goes.
 *
 * Offered only when the server says the move could work for SOME target
 * (`getSetToParallelEligibility`: no BSC link, nothing under it but a Base,
 * nothing under the Base). The target-dependent checks happen in the dialog,
 * which reads the brand's sets only while it is open.
 *
 * Same shape as `MoveSetToBrandControl` beside it: a text button in the
 * attributes panel header, `inert` while the dialog is up, refusals inside
 * the dialog, the result on the panel's own `role="status"` toast.
 */

export const MAKE_PARALLEL_LABEL = "Make parallel of…";
export const MAKE_PARALLEL_TOOLTIP =
  "Turn this set into a parallel of another set in the same brand. Its SportLots link and cards come along.";

/** DRAFT copy — pending Jason's sign-off (NEO-245). */
export const makeParallelCopy = {
  title: (set: string) => `Make “${set}” a parallel`,
  description: (set: string, cards: number) =>
    `Pick the set it belongs to. Its SportLots link${
      cards > 0 ? ` and ${cards} ${cards === 1 ? "card" : "cards"}` : ""
    } move over, and “${set}” stops being a set.`,
  targetsLegend: "Parallel of",
  targetsFilter: "Find a set",
  noParallelType: "no Parallel type yet",
  destinationLegend: "Where it goes",
  destinationFilter: "Find a parallel",
  newChoice: (name: string) => `New parallel: ${name}`,
  newChoiceUnavailable: "New parallel",
  loading: "Finding this brand's sets…",
  noTargets: (brand: string) =>
    `${brand} has no other set to fold this into. Sync Sets first.`,
  confirm: "Make it a parallel",
  busy: "Moving…",
  pickTarget: "Pick the set it's a parallel of.",
  pickDestination: "Pick where it goes.",
  done: (set: string, target: string, parallel: string, created: boolean) =>
    created
      ? `“${set}” is now ${target}’s “${parallel}” parallel.`
      : `“${set}” joined ${target}’s “${parallel}” parallel.`,
  newTag: "new",
  joinsTag: "joins",
};

const NEW = "__new__";

export type ReshapeStep = { _id: Id<"selectorOptions">; level: SelectorLevel };

export default function MakeParallelControl({
  setId,
  setValue,
  showToast,
  onReshaped,
}: {
  setId: Id<"selectorOptions">;
  setValue: string;
  showToast: (message: string) => void;
  /**
   * The set is gone and its link now lives on a parallel: the owner drills the
   * cascade to that parallel (and parks focus), because only it knows the
   * columns. Same division as `onDeleted` / `onMoved`.
   */
  onReshaped?: (path: ReshapeStep[]) => void;
}) {
  const eligibility = useQuery(api.setParallelConversion.getSetToParallelEligibility, {
    setId,
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
        // A stable id so a flow's `pressKey` can re-find this exact control;
        // the visible text is its name, so the id hides nothing a flow reads.
        id="make-parallel-of"
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        onKeyDown={(event) => activateOnEnter(event, openDialog)}
        aria-haspopup="dialog"
        inert={open}
        title={MAKE_PARALLEL_TOOLTIP}
        className="shrink-0 text-xs py-1.5 text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
      >
        {MAKE_PARALLEL_LABEL}
      </button>
      {open && (
        <MakeParallelDialog
          setId={setId}
          setValue={setValue}
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

function MakeParallelDialog({
  setId,
  setValue,
  onCancel,
  onDone,
}: {
  setId: Id<"selectorOptions">;
  setValue: string;
  onCancel: () => void;
  onDone: (message: string, path: ReshapeStep[]) => void;
}) {
  const targets = useQuery(api.setParallelConversion.getSetToParallelTargets, { setId });
  const [targetSetId, setTargetSetId] = useState<Id<"selectorOptions"> | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convert = useMutation(api.setParallelConversion.convertSetToParallel);

  // The server's preselection, taken once it arrives and only if the operator
  // has not picked for themselves.
  const suggested = targets?.ok ? targets.suggestedSetId ?? null : null;
  const chosenTarget = targetSetId ?? suggested;

  const detail = useQuery(
    api.setParallelConversion.getSetToParallelTargetDetail,
    chosenTarget ? { setId, targetSetId: chosenTarget } : "skip",
  );
  const detailOk = detail?.ok ? detail : null;

  // The default destination for a target: a new parallel when one can be
  // made, else the parallel the refusal points at. Recomputed per target.
  const defaultDestination = detailOk
    ? detailOk.newName !== undefined
      ? NEW
      : (detailOk.sameAsId ?? null)
    : null;
  const chosenDestination = destination ?? defaultDestination;

  const targetChoices: Choice[] = targets?.ok
    ? targets.targets.map((t) => ({
        id: t.setId,
        label: t.value,
        ariaLabel: `Parallel of ${t.value}`,
        ...(t.parallelTypeId ? {} : { unavailable: makeParallelCopy.noParallelType }),
      }))
    : [];

  const destinationChoices: Choice[] = detailOk
    ? [
        detailOk.newName !== undefined
          ? {
              id: NEW,
              label: makeParallelCopy.newChoice(detailOk.newName),
              ariaLabel: makeParallelCopy.newChoice(detailOk.newName),
              tag: makeParallelCopy.newTag,
            }
          : {
              id: NEW,
              label: makeParallelCopy.newChoiceUnavailable,
              ariaLabel: makeParallelCopy.newChoiceUnavailable,
              unavailable: detailOk.newRefusal,
            },
        ...detailOk.parallels.map((p) => ({
          id: p._id,
          label: p.value,
          ariaLabel: `Add to ${p.value}`,
          ...(p.holdsLink ? { unavailable: detailOk.holdsLinkReason } : {}),
        })),
      ]
    : [];

  const chosenParallel = detailOk?.parallels.find((p) => p._id === chosenDestination);
  const destinationName =
    chosenDestination === NEW ? detailOk?.newName : chosenParallel?.value;
  const destinationValid =
    detailOk !== null &&
    ((chosenDestination === NEW && detailOk.newName !== undefined) ||
      (chosenParallel !== undefined && !chosenParallel.holdsLink));

  const pickTarget = (id: string) => {
    setError(null);
    setTargetSetId(id as Id<"selectorOptions">);
    setDestination(null);
  };

  const handleConfirm = async () => {
    if (busy) return;
    if (!chosenTarget || !detailOk) {
      setError(makeParallelCopy.pickTarget);
      return;
    }
    if (!destinationValid) {
      setError(makeParallelCopy.pickDestination);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await convert({
        setId,
        targetParallelTypeId: detailOk.parallelTypeId,
        ...(chosenDestination !== NEW && chosenParallel
          ? { attachToId: chosenParallel._id }
          : {}),
      });
      onDone(
        makeParallelCopy.done(
          setValue,
          result.targetSetValue,
          result.parallelValue,
          result.created,
        ),
        [
          { _id: result.targetSetId, level: "setName" },
          { _id: result.parallelTypeId, level: "variantType" },
          { _id: result.parallelId, level: "insert" },
        ],
      );
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't make this set a parallel. Nothing changed."));
      setBusy(false);
    }
  };

  let body;
  if (targets === undefined) {
    body = <p className="text-sm text-slate-400">{makeParallelCopy.loading}</p>;
  } else if (!targets.ok) {
    body = <p className="text-sm text-[#FF2EB3]">{targets.reason}</p>;
  } else if (targets.targets.length === 0) {
    body = (
      <p className="text-sm text-slate-400">
        {makeParallelCopy.noTargets(targets.brandValue)}
      </p>
    );
  } else {
    body = (
      <>
        <ChoiceList
          legend={makeParallelCopy.targetsLegend}
          choices={targetChoices}
          selectedId={chosenTarget}
          onSelect={pickTarget}
          autofocusId={chosenTarget}
          filterLabel={makeParallelCopy.targetsFilter}
        />
        {chosenTarget && detail !== undefined && !detail.ok && (
          // The server's own sentence: most often "no Parallel type yet",
          // with the step that fixes it.
          <p className="text-sm text-slate-300">{detail.reason}</p>
        )}
        {detailOk && (
          <ChoiceList
            legend={makeParallelCopy.destinationLegend}
            choices={destinationChoices}
            selectedId={chosenDestination}
            onSelect={(id) => {
              setError(null);
              setDestination(id);
            }}
            filterLabel={makeParallelCopy.destinationFilter}
          />
        )}
      </>
    );
  }

  const cardCount = targets?.ok ? targets.cardCount : 0;
  return (
    <SetShapeDialog
      title={makeParallelCopy.title(setValue)}
      description={makeParallelCopy.description(setValue, cardCount)}
      preview={
        detailOk && destinationValid && destinationName ? (
          <LandingPath
            segments={[detailOk.targetSetValue, detailOk.parallelTypeValue, destinationName]}
            verb={chosenDestination === NEW ? makeParallelCopy.newTag : makeParallelCopy.joinsTag}
          />
        ) : null
      }
      confirmLabel={makeParallelCopy.confirm}
      busyLabel={makeParallelCopy.busy}
      busy={busy}
      confirmDisabled={!destinationValid}
      error={error}
      onConfirm={() => void handleConfirm()}
      onCancel={() => {
        if (!busy) onCancel();
      }}
    >
      {body}
    </SetShapeDialog>
  );
}
