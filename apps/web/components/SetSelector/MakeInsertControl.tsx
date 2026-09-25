import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { RectangleStackIcon } from "@heroicons/react/24/outline";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { Input } from "../primitives/Input";
import { ChoiceList, LandingPath, SetShapeDialog, type Choice } from "./SetShapeDialog";
import SetRowActionButton from "./SetRowActionButton";
import {
  lossItems,
  makeParallelCopy,
  movesSentence,
  type ReshapeStep,
} from "./MakeParallelControl";

/**
 * NEO-306 — "Make insert of…" on a set row or an insert-level row.
 *
 * SportLots (or the Parallels reconcile, or the SportLots-only review) files
 * some things in the wrong place: "Bowman All-America Game Autos Red Ink" as a
 * set of its own, or as a parallel of the base, when it is a parallel of an
 * INSERT. This is the operator's fix: pick the set it belongs to, then where
 * under that set's Insert type it lands —
 *
 *   - a new insert (named for you, the set's name taken off the front),
 *   - an existing insert, and then under it: the insert itself, a new
 *     parallel (named for you), or an existing parallel,
 *   - or a new insert the operator NAMES, which the row becomes a parallel
 *     of. NB never guesses where a label splits into insert | parallel, so
 *     "new insert and a new parallel under it" is typed, never derived.
 *
 * Its SportLots link and cards move by id; the emptied row goes
 * (`convex/setInsertConversion.ts`, which re-checks every guard shown here).
 *
 * Offered only when the server says the move could work for SOME target
 * (`getMakeInsertEligibility`); the target-dependent checks happen in the
 * dialog. Same skeleton as `MakeParallelControl`: a `SetRowActionButton` chip
 * in the panel's "Set actions" row, `inert` while the dialog is up, refusals
 * inside the dialog, the result on the panel's `role="status"` toast, and the
 * owner drills to the landed row (a 4-step path ends on a parallel-level row).
 */

export const MAKE_INSERT_LABEL = "Make insert of…";
/** DRAFT copy — pending Jason's sign-off (NEO-245). */
export const MAKE_INSERT_TOOLTIP =
  "File this as an insert of a set in this brand, or as a parallel of one of its inserts. Its cards come along.";

/** DRAFT copy — Jason's decisions 2026-09-25 folded in; the rest pending sign-off. */
export const makeInsertCopy = {
  /** The title follows the landing: an insert, or a parallel of one. */
  title: (row: string) => `Make “${row}” an insert`,
  titleParallel: (row: string) => `Make “${row}” a parallel`,
  /**
   * What moves (only as far as it is true — see `movesOverClause`), and what
   * happens to the row: a set stops being one; an insert-level row leaves the
   * set › type it sits under now.
   */
  description: (
    row: string,
    source: { kind: "set" } | { kind: "row"; ownSet: string; ownType: string },
    cards: number,
    links: number,
  ) =>
    `Pick the set it belongs to, then where it goes. ${movesSentence(
      links,
      cards,
      source.kind === "set"
        ? `“${row}” stops being a set`
        : `“${row}” leaves ${source.ownSet} › ${source.ownType}`,
    )}`,
  targetsLegend: "Insert of",
  targetsFilter: "Find a set",
  noInsertType: "no Insert type yet",
  whereLegend: "Where it goes",
  whereFilter: "Find an insert",
  newInsert: (name: string) => `New insert: ${name}`,
  newInsertUnavailable: "New insert",
  namedChoice: "New insert named…",
  nameLabel: "New insert name",
  underLegend: (insert: string) => `Under ${insert} as`,
  underFilter: "Find a parallel",
  insertItself: "The insert itself",
  newParallel: (name: string) => `New parallel: ${name}`,
  newParallelUnavailable: "New parallel",
  loading: "Finding this brand's sets…",
  noTargets: (brand: string) => `${brand} has no set to file this under. Sync Sets first.`,
  /** The confirm follows the landing too; this is the one before anything is chosen. */
  confirm: "Make it an insert",
  confirmParallel: "Make it a parallel",
  /**
   * Joining an existing row. "Add it to", not "Add to": the choice the
   * operator just pressed is named "Add to {row}", and a confirm with the
   * same name would make two buttons one name in the same dialog.
   */
  confirmJoin: (row: string) => `Add it to ${row}`,
  busy: "Moving…",
  pickTarget: "Pick the set it's an insert of.",
  pickDestination: "Pick where it goes.",
  typeName: "Type the new insert's name.",
  newTag: "new",
  joinsTag: "joins",
  failed: "Couldn't make this an insert. Nothing changed.",
  /**
   * Jason, 2026-09-25: the PATH form, built from the server's own `path`
   * (set › type › insert[ › parallel]) — every segment NB's name for the row
   * that is actually there.
   */
  done: (row: string, path: ReadonlyArray<{ value: string }>, created: boolean) => {
    const where = path.map((step) => step.value).join(" › ");
    return created ? `“${row}” now lives at ${where}.` : `“${row}” joined ${where}.`;
  },
};

/** How long the typed insert name rests before it is previewed. */
export const NAMED_PREVIEW_DEBOUNCE_MS = 300;

const NEW = "__new__";
const NAMED = "__named__";
const SELF = "__self__";
const NEW_PARALLEL = "__new_parallel__";

type Landing =
  | { kind: "newInsert" }
  | { kind: "joinInsert"; insertId: Id<"selectorOptions"> }
  | { kind: "newParallel"; insertId: Id<"selectorOptions"> }
  | { kind: "joinParallel"; parallelId: Id<"selectorOptions"> }
  | { kind: "newInsertNamed"; name: string };

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function MakeInsertControl({
  rowId,
  rowValue,
  showToast,
  onReshaped,
}: {
  /** The set (S1) or the insert-level row (S2) the panel is showing. */
  rowId: Id<"selectorOptions">;
  rowValue: string;
  showToast: (message: string) => void;
  /** The row is gone and its link lives on the landed row: the owner drills there. */
  onReshaped?: (path: ReshapeStep[]) => void;
}) {
  const eligibility = useQuery(api.setInsertConversion.getMakeInsertEligibility, { rowId });
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
      <SetRowActionButton
        ref={triggerRef}
        icon={RectangleStackIcon}
        onActivate={openDialog}
        aria-haspopup="dialog"
        inert={open}
        title={MAKE_INSERT_TOOLTIP}
      >
        {MAKE_INSERT_LABEL}
      </SetRowActionButton>
      {open && (
        <MakeInsertDialog
          rowId={rowId}
          rowValue={rowValue}
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

function MakeInsertDialog({
  rowId,
  rowValue,
  onCancel,
  onDone,
}: {
  rowId: Id<"selectorOptions">;
  rowValue: string;
  onCancel: () => void;
  onDone: (message: string, path: ReshapeStep[]) => void;
}) {
  const targets = useQuery(api.setInsertConversion.getMakeInsertTargets, { rowId });
  const convert = useMutation(api.setInsertConversion.convertToInsert);

  const [targetSetId, setTargetSetId] = useState<Id<"selectorOptions"> | null>(null);
  /** NEW, NAMED, or an insert's id. */
  const [where, setWhere] = useState<string | null>(null);
  /** SELF, NEW_PARALLEL, or a parallel's id — only once an insert is chosen. */
  const [under, setUnder] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetReasonId = useId();
  const whereReasonId = useId();
  const underReasonId = useId();
  const nameReasonId = useId();
  const leftBehindId = useId();

  // ── 1. the set ────────────────────────────────────────────────────────
  // The server's preselection, taken once it arrives and only if the
  // operator has not picked for themselves.
  const suggested = targets?.ok ? (targets.suggestedSetId ?? null) : null;
  const chosenTarget = targetSetId ?? suggested;

  const detail = useQuery(
    api.setInsertConversion.getMakeInsertTargetDetail,
    chosenTarget ? { rowId, targetSetId: chosenTarget } : "skip",
  );
  const detailOk = detail?.ok ? detail : null;
  // Something under this set's Insert type already holds the link: NO
  // landing here is valid, new or existing (the server refuses them all).
  const blockedByLink = detailOk?.holdsLinkReason;
  const targetReason =
    chosenTarget && detail !== undefined && !detail.ok ? detail.reason : undefined;

  // ── 2. where it goes ──────────────────────────────────────────────────
  const defaultWhere =
    detailOk && !blockedByLink
      ? detailOk.newInsertName !== undefined
        ? NEW
        : (detailOk.sameAsInsertId ?? null)
      : null;
  const chosenWhere = where ?? defaultWhere;
  const chosenInsert = detailOk?.inserts.find((i) => i._id === chosenWhere);
  const whereReason = detailOk
    ? (blockedByLink ??
      (detailOk.newInsertName === undefined ? detailOk.newInsertRefusal : undefined))
    : undefined;

  // ── 2b. a new insert the operator names ───────────────────────────────
  const naming = chosenWhere === NAMED;
  const trimmedName = typedName.trim();
  const debouncedName = useDebounced(trimmedName, NAMED_PREVIEW_DEBOUNCE_MS);
  const namedPreview = useQuery(
    api.setInsertConversion.getMakeInsertNamedPreview,
    naming && chosenTarget && debouncedName.length > 0
      ? { rowId, targetSetId: chosenTarget, name: debouncedName }
      : "skip",
  );
  // The preview answers for what is in the box NOW, or it answers nothing.
  const namedCurrent = naming && debouncedName === trimmedName && trimmedName.length > 0;
  const namedOk = namedCurrent && namedPreview?.ok ? namedPreview : null;
  const nameReason =
    namedCurrent && namedPreview !== undefined && !namedPreview.ok
      ? namedPreview.reason
      : undefined;

  // ── 3. under an existing insert ───────────────────────────────────────
  const insertDetail = useQuery(
    api.setInsertConversion.getMakeInsertInsertDetail,
    chosenInsert && !blockedByLink ? { rowId, insertId: chosenInsert._id } : "skip",
  );
  const insertDetailOk = insertDetail?.ok ? insertDetail : null;
  const underBlocked = insertDetailOk?.holdsLinkReason;
  // The insert itself when the label IS its name; else a new parallel when
  // one can be named; else the parallel the refusal points at.
  const defaultUnder =
    insertDetailOk && !underBlocked
      ? insertDetailOk.sameAsInsertSelf
        ? SELF
        : insertDetailOk.newParallelName !== undefined
          ? NEW_PARALLEL
          : (insertDetailOk.sameAsParallelId ?? SELF)
      : null;
  const chosenUnder = under ?? defaultUnder;
  const chosenParallel = insertDetailOk?.parallels.find((p) => p._id === chosenUnder);
  const underReason = chosenInsert
    ? insertDetail !== undefined && !insertDetail.ok
      ? insertDetail.reason
      : insertDetailOk
        ? (underBlocked ??
          (insertDetailOk.newParallelName === undefined
            ? insertDetailOk.newParallelRefusal
            : undefined))
        : undefined
    : undefined;

  // ── the landing the choices add up to, and where it lands ─────────────
  type Plan = {
    landing: Landing;
    segments: string[];
    created: boolean;
    loss: Parameters<typeof lossItems>[0];
  };
  /** The confirm's words for a landing, and whether it lands as a parallel. */
  const confirmFor = (p: Plan): string => {
    switch (p.landing.kind) {
      case "newInsert":
        return makeInsertCopy.confirm;
      case "joinInsert":
      case "joinParallel":
        return makeInsertCopy.confirmJoin(p.segments[p.segments.length - 1]);
      case "newParallel":
      case "newInsertNamed":
        return makeInsertCopy.confirmParallel;
    }
  };
  let plan: Plan | null = null;
  if (detailOk && !blockedByLink) {
    const head = [detailOk.targetSetValue, detailOk.insertTypeValue];
    if (chosenWhere === NEW && detailOk.newInsertName !== undefined) {
      plan = {
        landing: { kind: "newInsert" },
        segments: [...head, detailOk.newInsertName],
        created: true,
        loss: detailOk.newLoses,
      };
    } else if (naming && namedOk) {
      plan = {
        landing: { kind: "newInsertNamed", name: trimmedName },
        segments: [...head, namedOk.insertName, namedOk.parallelName],
        created: true,
        loss: detailOk.newLoses,
      };
    } else if (chosenInsert && !chosenInsert.holdsLink && insertDetailOk && !underBlocked) {
      const insertHead = [...head, insertDetailOk.insertValue];
      if (chosenUnder === SELF) {
        plan = {
          landing: { kind: "joinInsert", insertId: chosenInsert._id },
          segments: insertHead,
          created: false,
          loss: insertDetailOk.joinLoses,
        };
      } else if (chosenUnder === NEW_PARALLEL && insertDetailOk.newParallelName !== undefined) {
        plan = {
          landing: { kind: "newParallel", insertId: chosenInsert._id },
          segments: [...insertHead, insertDetailOk.newParallelName],
          created: true,
          loss: insertDetailOk.newLoses,
        };
      } else if (chosenParallel && !chosenParallel.holdsLink) {
        plan = {
          landing: { kind: "joinParallel", parallelId: chosenParallel._id },
          segments: [...insertHead, chosenParallel.value],
          created: false,
          loss: chosenParallel.loses,
        };
      }
    }
  }
  const leftBehind = plan ? lossItems(plan.loss) : [];

  // ── choices ───────────────────────────────────────────────────────────
  const targetChoices: Choice[] = targets?.ok
    ? targets.targets.map((t) => ({
        id: t.setId,
        label: t.value,
        ariaLabel: `Insert of ${t.value}`,
        ...(t.insertTypeId ? {} : { unavailable: makeInsertCopy.noInsertType }),
      }))
    : [];

  const whereChoices: Choice[] = detailOk
    ? [
        detailOk.newInsertName !== undefined && !blockedByLink
          ? {
              id: NEW,
              label: makeInsertCopy.newInsert(detailOk.newInsertName),
              ariaLabel: makeInsertCopy.newInsert(detailOk.newInsertName),
              tag: makeInsertCopy.newTag,
            }
          : {
              id: NEW,
              label: makeInsertCopy.newInsertUnavailable,
              ariaLabel: makeInsertCopy.newInsertUnavailable,
              unavailable: blockedByLink ?? detailOk.newInsertRefusal,
            },
        ...detailOk.inserts.map((i) => ({
          id: i._id,
          label: i.value,
          ariaLabel: `Add to ${i.value}`,
          ...(blockedByLink ? { unavailable: blockedByLink } : {}),
        })),
        {
          id: NAMED,
          label: makeInsertCopy.namedChoice,
          ariaLabel: makeInsertCopy.namedChoice,
          tag: makeInsertCopy.newTag,
          ...(blockedByLink ? { unavailable: blockedByLink } : {}),
        },
      ]
    : [];

  const underChoices: Choice[] = insertDetailOk
    ? [
        {
          id: SELF,
          label: makeInsertCopy.insertItself,
          ariaLabel: makeInsertCopy.insertItself,
          tag: makeInsertCopy.joinsTag,
          ...(underBlocked ? { unavailable: underBlocked } : {}),
        },
        insertDetailOk.newParallelName !== undefined && !underBlocked
          ? {
              id: NEW_PARALLEL,
              label: makeInsertCopy.newParallel(insertDetailOk.newParallelName),
              ariaLabel: makeInsertCopy.newParallel(insertDetailOk.newParallelName),
              tag: makeInsertCopy.newTag,
            }
          : {
              id: NEW_PARALLEL,
              label: makeInsertCopy.newParallelUnavailable,
              ariaLabel: makeInsertCopy.newParallelUnavailable,
              unavailable: underBlocked ?? insertDetailOk.newParallelRefusal,
            },
        ...insertDetailOk.parallels.map((p) => ({
          id: p._id,
          label: p.value,
          ariaLabel: `Add to ${p.value}`,
          // A parallel holding a moving link blocks the whole Insert type
          // (the server's tree-wide rule), so `underBlocked` covers it.
          ...(underBlocked ? { unavailable: underBlocked } : {}),
        })),
      ]
    : [];

  // ── actions ───────────────────────────────────────────────────────────
  const pickTarget = (id: string) => {
    setError(null);
    setTargetSetId(id as Id<"selectorOptions">);
    setWhere(null);
    setUnder(null);
    setTypedName("");
  };

  const pickWhere = (id: string) => {
    setError(null);
    setWhere(id);
    setUnder(null);
  };

  const handleConfirm = async () => {
    if (busy) return;
    if (!chosenTarget || !detailOk) {
      setError(makeInsertCopy.pickTarget);
      return;
    }
    if (!plan) {
      // A name mid-debounce is not a mistake: the preview is on its way.
      if (naming && trimmedName.length > 0 && !namedCurrent) return;
      setError(
        naming && trimmedName.length === 0
          ? makeInsertCopy.typeName
          : makeInsertCopy.pickDestination,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await convert({
        rowId,
        targetInsertTypeId: detailOk.insertTypeId,
        landing: plan.landing,
      });
      onDone(
        makeInsertCopy.done(rowValue, result.path, result.created),
        result.path.map((step) => ({ _id: step._id, level: step.level })),
      );
    } catch (e) {
      setError(userFacingMessage(e, makeInsertCopy.failed));
      setBusy(false);
    }
  };

  // ── body ──────────────────────────────────────────────────────────────
  let body;
  if (targets === undefined) {
    body = <p className="text-sm text-slate-400">{makeInsertCopy.loading}</p>;
  } else if (!targets.ok) {
    body = <p className="text-sm text-[#FF2EB3]">{targets.reason}</p>;
  } else if (targets.targets.length === 0) {
    body = (
      <p className="text-sm text-slate-400">{makeInsertCopy.noTargets(targets.brandValue)}</p>
    );
  } else {
    body = (
      <>
        <ChoiceList
          legend={makeInsertCopy.targetsLegend}
          choices={targetChoices}
          selectedId={chosenTarget}
          onSelect={pickTarget}
          autofocusId={chosenTarget}
          filterLabel={makeInsertCopy.targetsFilter}
          describedBy={targetReason ? targetReasonId : undefined}
        />
        {targetReason && (
          // The server's own sentence: most often "no Insert type yet", with
          // the step that fixes it.
          <p id={targetReasonId} className="text-sm text-slate-300">
            {targetReason}
          </p>
        )}
        {detailOk && (
          <ChoiceList
            legend={makeInsertCopy.whereLegend}
            choices={whereChoices}
            selectedId={blockedByLink ? null : chosenWhere}
            onSelect={pickWhere}
            filterLabel={makeInsertCopy.whereFilter}
            describedBy={whereReason ? whereReasonId : undefined}
          />
        )}
        {whereReason && (
          <p id={whereReasonId} className="text-sm text-slate-300">
            {whereReason}
          </p>
        )}
        {naming && (
          // Right under the choice that opened it, so the Tab order runs
          // choice → name → confirm. Enter here confirms, as it does on the
          // confirm button; Escape reaches the dialog and cancels.
          <div>
            <Input
              label={makeInsertCopy.nameLabel}
              // The same words as the label: Maestro finds a field by its
              // aria-label (`id:`), never by a wrapping <label>.
              aria-label={makeInsertCopy.nameLabel}
              inputSize="small"
              fieldKey="new-insert-name"
              value={typedName}
              autoComplete="off"
              aria-describedby={nameReason ? nameReasonId : undefined}
              onChange={(e) => {
                setError(null);
                setTypedName(e.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                void handleConfirm();
              }}
            />
            {nameReason && (
              <p id={nameReasonId} className="mt-1 text-sm text-slate-300">
                {nameReason}
              </p>
            )}
          </div>
        )}
        {insertDetailOk && (
          <ChoiceList
            legend={makeInsertCopy.underLegend(insertDetailOk.insertValue)}
            choices={underChoices}
            selectedId={underBlocked ? null : chosenUnder}
            onSelect={(id) => {
              setError(null);
              setUnder(id);
            }}
            filterLabel={makeInsertCopy.underFilter}
            describedBy={underReason ? underReasonId : undefined}
          />
        )}
        {underReason && (
          <p id={underReasonId} className="text-sm text-slate-300">
            {underReason}
          </p>
        )}
        {leftBehind.length > 0 && (
          <p id={leftBehindId} className="text-sm text-slate-300">
            {makeParallelCopy.leftBehind(leftBehind)}
          </p>
        )}
      </>
    );
  }

  // Why the confirm is not live, said on the confirm itself.
  const blockers = plan
    ? []
    : [
        ...(targetReason ? [targetReasonId] : []),
        ...(whereReason && (blockedByLink || chosenWhere === null || chosenWhere === NEW)
          ? [whereReasonId]
          : []),
        ...(nameReason ? [nameReasonId] : []),
        ...(underReason ? [underReasonId] : []),
      ];

  const cardCount = targets?.ok ? targets.cardCount : 0;
  const linkCount = targets?.ok ? targets.linkCount : 0;
  const source =
    targets?.ok && targets.kind === "row"
      ? {
          kind: "row" as const,
          ownSet: targets.ownSetValue ?? "",
          ownType: targets.ownTypeValue ?? "",
        }
      : { kind: "set" as const };
  const asParallel =
    plan !== null &&
    (plan.landing.kind === "newParallel" ||
      plan.landing.kind === "joinParallel" ||
      plan.landing.kind === "newInsertNamed");
  return (
    <SetShapeDialog
      title={
        asParallel ? makeInsertCopy.titleParallel(rowValue) : makeInsertCopy.title(rowValue)
      }
      description={makeInsertCopy.description(rowValue, source, cardCount, linkCount)}
      preview={
        plan ? (
          <LandingPath
            segments={plan.segments}
            verb={plan.created ? makeInsertCopy.newTag : makeInsertCopy.joinsTag}
          />
        ) : null
      }
      confirmLabel={plan ? confirmFor(plan) : makeInsertCopy.confirm}
      busyLabel={makeInsertCopy.busy}
      busy={busy}
      confirmDisabled={plan === null}
      confirmDescribedBy={
        [...blockers, ...(leftBehind.length > 0 ? [leftBehindId] : [])].join(" ") || undefined
      }
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
