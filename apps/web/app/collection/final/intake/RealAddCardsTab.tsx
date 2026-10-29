import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { classifyIntake } from "@/lib/placeholders/intake-kind";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";
import { useWarmPreprocess } from "@/src/hooks/useWarmPreprocess";
import { Dropzone } from "@/app/print/placeholders/dropzone";
import { ScanImage } from "@/app/print/placeholders/scan-image";
import Overlay from "../../prototypes/p1/Overlay";
import Cascade from "../catalog/Cascade";
import { EMPTY_DRILL, type Drill } from "../catalog/drill";
import { useDrillState } from "../catalog/useDrillState";
import { homesOnSide, useContainers, useDefaultCondition, useSide, writeErrorMessage } from "../data/store";
import { usePageApi } from "../pageApi";
import {
  EMPTY_LANES,
  cardLabel,
  laneOf,
  proposedCount,
  readOf,
  reasonText,
  type IntakeImage,
  type IntakeMatchRow,
  type PairRead,
  tileLabel,
  whyNotSave,
} from "./realLanes";
import { HomeSelect, QTY_ATTR, RING, StageBadge } from "./ui";
import { ScannerJoin } from "./ScannerJoin";
import "./intake.css";

/**
 * The photos dropped in this tab, by file name, as object URLs: a photo still
 * cropping has no crop to sign yet, so its tile shows the file as picked.
 * Gone after a reload, when the tile falls back to its name alone.
 */
const LocalPhotos = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * NEO-382 — Add cards from photos, signed in: the NEO-369 demo's "Mission
 * Control" screen on the real pipeline. One screen on both sides (the
 * collection files into binders, the inventory into boxes).
 *
 * A run is the unit: one placeholder upload session filing into one home,
 * matched in one variant (`convex/intakeRuns.ts`). It lives on the URL
 * (`?run=`), so it survives a closed tab, and recent runs are listed when no
 * run is open. The run starts with the first photos dropped; more photos join
 * it while its session is open.
 *
 * Every photo travels the lanes left to right (`./realLanes`): reading,
 * pairing, matching, then "Needs you". Automation is "correct but fixable"
 * (Jason, 2026-10-27): the matcher proposes and explains, and nothing saves
 * until the collector says yes (Yes, Enter in the count, or "Save all
 * matched"). Each save is idempotent per pair, so a double click never
 * counts a card twice; a card scanned twice in one run asks first.
 *
 * Keys on the selected card (as in the demo): j/k move, y saves, o opens,
 * s swaps sides, u unpairs, d sets it aside, v steps through its other
 * pictures. In the count field only digits type; Enter saves and moves on.
 *
 * Not yet: photos onto the saved line (NEO-377), the price and the common
 * price prompt (NEO-378), rotate/re-crop/reject one side, and finding the
 * set from the photos when none is picked.
 */

export const RUN_PARAM = "run";
const TILE_ATTR = "data-intake-tile";
const REVIEW_HEADING_ID = "intake-needs-you";

type Condition = "Mint" | "Near Mint" | "Excellent" | "Very Good" | "Good" | "Poor";
type Grader = "PSA" | "BGS" | "SGC" | "CGC" | "TAG";
const CONDITIONS: Condition[] = ["Mint", "Near Mint", "Excellent", "Very Good", "Good", "Poor"];
const GRADERS: Grader[] = ["PSA", "BGS", "SGC", "CGC", "TAG"];

/** The run's batch defaults, as the server keeps them. */
interface RunDefaults {
  condition?: Condition;
  grading?: { grader: Grader; grade: string; cert?: string };
  costCents?: number;
  acquiredOn?: string;
  location?: string;
  notes?: string;
}

interface VariantPick {
  variantId: Id<"selectorOptions">;
  title: string;
}

const today = () => new Date().toISOString().slice(0, 10);

const KEY_HELP: { keys: string; does: string }[] = [
  { keys: "j k ↓ ↑", does: "next, previous card" },
  { keys: "y", does: "yes, save it" },
  { keys: "o", does: "open it" },
  { keys: "v", does: "its next picture (variation)" },
  { keys: "s", does: "swap front and back" },
  { keys: "u", does: "unpair" },
  { keys: "d", does: "set it aside" },
  { keys: "Enter", does: "in a count: save, next card" },
];

export default function RealAddCardsTab() {
  useWarmPreprocess();
  const side = useSide();
  const kind = side === "inventory" ? "box" : "binder";
  const homes = homesOnSide(useContainers(), side);
  const { notify } = usePageApi();
  const [params, setParams] = useSearchParams();
  const runParam = params.get(RUN_PARAM);
  // A hand-edited `?run=` that is not an id at all would throw in the query's
  // validator; it reads as a run that is gone instead.
  const runId = (runParam && /^[a-z0-9]{16,64}$/.test(runParam) ? runParam : null) as Id<"intakeRuns"> | null;

  const run = useQuery(api.intakeRuns.getIntakeRun, runId ? { runId } : "skip");
  const recent = useQuery(api.intakeRuns.listMyIntakeRuns, runParam ? "skip" : {});

  // Setup before the run exists. Once it does, the run's own fields rule.
  const [homeId, setHomeId] = useState<string>("");
  const [variant, setVariant] = useState<VariantPick | null>(null);
  const [defaults, setDefaults] = useState<RunDefaults>({ acquiredOn: today() });
  const [panel, setPanel] = useState<null | "set" | "defaults">(null);
  const pickedHome = homes.some((h) => h.id === homeId) ? homeId : (homes[0]?.id ?? "");

  const createRun = useMutation(api.intakeRuns.createIntakeRun);
  const setRunVariant = useMutation(api.intakeRuns.setIntakeRunVariant);
  const setRunDefaults = useMutation(api.intakeRuns.setIntakeRunDefaults);
  const setRunHome = useMutation(api.intakeRuns.setIntakeRunHome);
  const usualCondition = useDefaultCondition();
  const { uploading, upload } = usePlaceholderUpload();
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState("");
  const [localPhotos, setLocalPhotos] = useState<ReadonlyMap<string, string>>(new Map());
  const localUrls = useRef<string[]>([]);
  useEffect(() => () => localUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const job = useQuery(api.placeholderPipeline.getPlaceholderJob, run ? { jobId: run.jobId } : "skip");
  const collecting = !run || job?.status === "collecting";

  const openRun = (id: Id<"intakeRuns"> | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set(RUN_PARAM, id);
      else next.delete(RUN_PARAM);
      return next;
    });

  const onFiles = async (chosen: File[]) => {
    setFiles(chosen);
    if (chosen.length === 0 || uploading) return;
    if (classifyIntake(chosen).kind === "invalid") return;
    if (!run && !pickedHome) {
      setStatus(`Make a ${kind} first: the cards need somewhere to go.`);
      return;
    }
    const added = new Map(localPhotos);
    for (const file of chosen) {
      // Only types every browser draws; a HEIC photo keeps its name alone.
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || added.has(file.name)) continue;
      const url = URL.createObjectURL(file);
      localUrls.current.push(url);
      added.set(file.name, url);
    }
    setLocalPhotos(added);
    setStatus("Sending your photos…");
    try {
      const out = await upload(chosen, { source: "web", jobId: run?.jobId });
      if (!out.ok) {
        setStatus(`Couldn't send these photos: ${out.reason}.`);
        return;
      }
      setFiles([]);
      if (!run) {
        const id = await createRun({
          jobId: out.jobId,
          homeId: pickedHome as Id<"collectionContainers">,
          variantId: variant?.variantId,
          defaults,
        });
        openRun(id);
      }
      setStatus(
        out.failed === 0
          ? `Sent ${out.uploaded} photo${out.uploaded === 1 ? "" : "s"}.`
          : `Sent ${out.uploaded} of ${out.total} photos. ${out.failed} failed.`,
      );
    } catch (error) {
      setStatus(writeErrorMessage(error));
    }
  };

  const setupBar = (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-panel-rule bg-panel p-4 shadow-offset">
      {run && run.homeKind !== kind ? (
        // A run opened from the other side (a box run under Collection) keeps
        // its home; it moves only among homes of its own kind.
        <p className="m-0 flex flex-col gap-1 text-sm">
          <span className="text-xs font-semibold text-ink-2">Going into</span>
          <span className="font-semibold text-ink">{run.homeName}</span>
        </p>
      ) : (
        <HomeSelect
          value={run ? run.homeId : pickedHome}
          homes={homes}
          label={kind === "box" ? "Put them in this box" : "Put them in this binder"}
          onChange={(id) => {
            if (!run) return setHomeId(id);
            const name = homes.find((h) => h.id === id)?.name ?? `the ${kind}`;
            setRunHome({ runId: run._id, homeId: id as Id<"collectionContainers"> })
              .then(() => setStatus(`The next cards you save go into ${name}.`))
              .catch((e: unknown) => notify(writeErrorMessage(e)));
          }}
        />
      )}
      <RealSetButton
        open={panel === "set"}
        onOpenChange={(o) => setPanel(o ? "set" : null)}
        current={
          run
            ? variant && variant.variantId === run.variantId
              ? variant.title
              : (run.variantName ?? null)
            : (variant?.title ?? null)
        }
        onPick={(pick) => {
          setVariant(pick);
          if (run && pick) {
            setRunVariant({ runId: run._id, variantId: pick.variantId }).catch((e: unknown) => notify(writeErrorMessage(e)));
          }
        }}
      />
      <NeonButton
        variant="secondary"
        outline
        aria-expanded={panel === "defaults"}
        aria-controls="intake-defaults-panel"
        onClick={() => setPanel(panel === "defaults" ? null : "defaults")}
      >
        Defaults: {(run?.defaults ?? defaults).condition ?? usualCondition}
        {(run?.defaults ?? defaults).grading ? `, ${(run?.defaults ?? defaults).grading?.grader}` : ""}
      </NeonButton>
      {run && (
        <NeonButton variant="secondary" outline className="ml-auto" onClick={() => openRun(null)}>
          New run
        </NeonButton>
      )}
      {panel === "defaults" && (
        <div id="intake-defaults-panel" className="w-full border-t border-rule pt-3">
          <DefaultsFields
            value={run?.defaults ?? defaults}
            onChange={(next) => {
              if (run) {
                setRunDefaults({ runId: run._id, defaults: next }).catch((e: unknown) => notify(writeErrorMessage(e)));
              } else setDefaults(next);
            }}
          />
        </div>
      )}
    </div>
  );

  return (
    <div data-motion="high" className="space-y-4">
      {setupBar}
      {runParam && (!runId || run === null) && (
        <p className="m-0 rounded-md border border-rule p-3 text-sm text-ink-2">
          That run isn&apos;t yours or is gone.{" "}
          <button type="button" className={`text-neon-blue-text underline ${RING}`} onClick={() => openRun(null)}>
            Start a new one
          </button>
        </p>
      )}
      {collecting ? (
        <>
          <Dropzone quiet files={files} disabled={uploading} onFiles={(chosen) => void onFiles(chosen)} />
          <ScannerJoin
            runId={run?._id ?? null}
            newRun={
              pickedHome
                ? { homeId: pickedHome as Id<"collectionContainers">, variantId: variant?.variantId, defaults }
                : null
            }
            onRunStarted={openRun}
          />
        </>
      ) : (
        <p className="m-0 rounded-md border border-rule p-3 text-sm text-ink-2">
          This run&apos;s photos are all in. To add more, start a new run.
        </p>
      )}
      <p role="status" aria-live="polite" className="m-0 min-h-5 text-sm text-ink-2">
        {status}
      </p>
      {run ? (
        <LocalPhotos.Provider value={localPhotos}>
          <RunWorkspace run={run} jobOpen={job?.status === "collecting"} />
        </LocalPhotos.Provider>
      ) : (
        !runParam && <RecentRuns runs={(recent ?? []).filter((r) => r.homeKind === kind)} onOpen={openRun} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Setup pieces                                                        */
/* ------------------------------------------------------------------ */

/**
 * The set pick: the collection's own cascade (sport to variant) behind one
 * button that folds back once a variant is picked (the demo's `SetButton`,
 * on the real catalog).
 */
function RealSetButton({
  open,
  onOpenChange,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string | null;
  onPick: (pick: VariantPick | null) => void;
}) {
  const [drill, setDrill] = useState<Drill>(EMPTY_DRILL);
  const state = useDrillState(drill, open);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    onOpenChange(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <>
      <NeonButton
        ref={button}
        variant="secondary"
        outline
        aria-expanded={open}
        aria-controls="intake-set-panel"
        onClick={() => onOpenChange(!open)}
      >
        Set: {current ?? "pick one"}
      </NeonButton>
      {open && (
        <div id="intake-set-panel" className="order-last w-full space-y-3 border-t border-rule pt-3">
          <p className="m-0 text-sm text-ink-2">
            Pick the set down to the variant. Cards are matched in it.
          </p>
          <Cascade
            state={state}
            onDrill={setDrill}
            label="Sport, year, brand, set and variant"
            onReachedChecklist={() => {
              const variantId = state.checklist?.variantId;
              if (!state.checklist || !variantId) return false;
              onPick({
                variantId: variantId as Id<"selectorOptions">,
                title: state.checklistTitle ?? state.checklist.name,
              });
              close();
              return true;
            }}
          />
        </div>
      )}
    </>
  );
}

const FIELD = `rounded-md border border-field-rule bg-field px-2 py-1 text-sm text-ink ${RING}`;

/** The run's batch defaults: every card starts with these. */
function DefaultsFields({ value, onChange }: { value: RunDefaults; onChange: (next: RunDefaults) => void }) {
  // No "your usual" choice: the field shows the seller's default (Profile →
  // Settings) until they pick another.
  const usualCondition = useDefaultCondition();
  // Seeded once, when the panel opens; every change is written straight back.
  const [draft, setDraft] = useState(value);
  const commit = (patch: Partial<RunDefaults>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(next);
  };
  const g = draft.grading;
  const cost = draft.costCents === undefined ? "" : (draft.costCents / 100).toFixed(2);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Condition
        <select
          className={FIELD}
          value={draft.condition ?? usualCondition}
          onChange={(e) => commit({ condition: e.target.value as Condition })}
        >
          {CONDITIONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Graded by
        <select
          className={FIELD}
          value={g?.grader ?? ""}
          onChange={(e) =>
            commit({ grading: e.target.value ? { grader: e.target.value as Grader, grade: g?.grade ?? "", cert: g?.cert } : undefined })
          }
        >
          <option value="">Raw</option>
          {GRADERS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      {g && (
        <label className="flex flex-col gap-1 text-xs text-ink-3">
          Grade
          <Input bare className={FIELD} defaultValue={g.grade} onBlur={(e) => commit({ grading: { ...g, grade: e.target.value } })} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Cost each
        <Input
          bare
          className={FIELD}
          inputMode="decimal"
          placeholder="$0.00"
          defaultValue={cost}
          key={cost}
          onBlur={(e) => {
            const n = Number(e.target.value);
            commit({ costCents: e.target.value && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined });
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Acquired
        <Input bare type="date" className={FIELD} value={draft.acquiredOn ?? ""} onChange={(e) => commit({ acquiredOn: e.target.value || undefined })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3">
        Location
        <Input bare className={FIELD} placeholder="Row 2" defaultValue={draft.location ?? ""} onBlur={(e) => commit({ location: e.target.value || undefined })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-3 sm:col-span-3">
        Notes
        <Input bare className={FIELD} defaultValue={draft.notes ?? ""} onBlur={(e) => commit({ notes: e.target.value || undefined })} />
      </label>
    </div>
  );
}

type RunSummary = NonNullable<ReturnType<typeof useRunSummaryType>>;
// Only for the type: the shape `getIntakeRun` answers.
function useRunSummaryType() {
  return useQuery(api.intakeRuns.getIntakeRun, "skip");
}

function RecentRuns({ runs, onOpen }: { runs: RunSummary[]; onOpen: (id: Id<"intakeRuns">) => void }) {
  if (runs.length === 0) return null;
  return (
    <section aria-labelledby="intake-recent" className="space-y-2">
      <h2 id="intake-recent" className="m-0 text-sm font-semibold text-ink">
        Recent runs
      </h2>
      <ul className="m-0 list-none space-y-1 p-0">
        {runs.map((r) => (
          <li key={r._id}>
            <button type="button" onClick={() => onOpen(r._id)} className={`text-sm text-neon-blue-text underline ${RING}`}>
              Into {r.homeName}
              {r.variantName ? `, ${r.variantName}` : ""}, {new Date(r.lastActivityAt).toLocaleString()}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The live workspace                                                  */
/* ------------------------------------------------------------------ */

const LANE_LABEL = {
  reading: "Cropping & reading",
  pairing: "Pairing",
  matching: "Matching",
  review: "Needs you",
  saved: "Saved",
} as const;

function RunWorkspace({ run, jobOpen }: { run: RunSummary; jobOpen: boolean }) {
  const { notify } = usePageApi();
  const images = useQuery(api.placeholderPipeline.listPlaceholderImages, { jobId: run.jobId });
  const pairs = useQuery(api.placeholderPipeline.listPlaceholderPairs, { jobId: run.jobId });
  const matches = useQuery(api.intakeRuns.listIntakeMatches, { runId: run._id });
  const lanes = useMemo(
    () => (images && pairs && matches ? laneOf(images, pairs, matches) : EMPTY_LANES),
    [images, pairs, matches],
  );
  const byIndex = useMemo(() => new Map((images ?? []).map((i) => [i.entryIndex, i])), [images]);

  const save = useMutation(api.intakeRuns.saveIntakeMatch);
  const pick = useMutation(api.intakeRuns.pickIntakeCard);
  const answerRepeat = useMutation(api.intakeRuns.answerIntakeRepeat);
  const aside = useMutation(api.intakeRuns.setIntakeMatchAside);
  const swap = useMutation(api.placeholderPairing.swapPairSides);
  const unpair = useMutation(api.placeholderPairing.unpairPlaceholderImages);
  const pairUp = useMutation(api.placeholderPairing.manuallyPairPlaceholderImages);
  const closeStream = useMutation(api.placeholderStream.closePlaceholderStream);

  const [selected, setSelected] = useState<Id<"placeholderPairs"> | null>(null);
  const [openId, setOpenId] = useState<Id<"placeholderPairs"> | null>(null);
  /** Counts typed but not saved yet, per pair. */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const saving = useRef(new Set<string>());

  const fail = (e: unknown) => notify(writeErrorMessage(e));
  const canSave = (row: IntakeMatchRow) => !!row.cardId && !(row.repeatOfPairId && !row.repeatIsSecondCopy);
  const actions: RowActions = {
    save: (row, total) => {
      if (!canSave(row)) return notify(whyNotSave(row));
      if (saving.current.has(row.pairId)) return;
      const quantity = (total ?? counts[row.pairId] ?? proposedCount(row)) - row.haveHere;
      if (quantity < 1) return notify("The count must go up by at least one to save.");
      saving.current.add(row.pairId);
      save({ runId: run._id, pairId: row.pairId, quantity })
        .catch(fail)
        .finally(() => saving.current.delete(row.pairId));
    },
    setCount: (row, total) => setCounts((c) => ({ ...c, [row.pairId]: total })),
    count: (row) => counts[row.pairId] ?? proposedCount(row),
    pick: (row, cardId) => void pick({ runId: run._id, pairId: row.pairId, cardId }).catch(fail),
    repeat: (row, secondCopy) => void answerRepeat({ runId: run._id, pairId: row.pairId, secondCopy }).catch(fail),
    aside: (row, setAside) => void aside({ runId: run._id, pairId: row.pairId, setAside }).catch(fail),
    swap: (row) => void swap({ jobId: run.jobId, frontIndex: row.frontIndex, backIndex: row.backIndex }).catch(fail),
    unpair: (row) => void unpair({ jobId: run.jobId, frontIndex: row.frontIndex, backIndex: row.backIndex }).catch(fail),
    nextVariation: (row) => {
      const ring = [...new Set([row.card?._id, ...row.variations.map((v) => v._id)].filter(Boolean))] as Id<"cardChecklist">[];
      if (ring.length < 2 || !row.cardId) return;
      const at = ring.indexOf(row.cardId);
      void pick({ runId: run._id, pairId: row.pairId, cardId: ring[(at + 1) % ring.length] }).catch(fail);
    },
  };
  const readFor = (row: IntakeMatchRow) => readOf(byIndex, row.frontIndex, row.backIndex);

  const review = lanes.review;
  const matched = review.filter((r) => r.band === "matched" && canSave(r));
  const find = (id: Id<"placeholderPairs"> | null) => review.find((r) => r.pairId === id) ?? null;
  const open = find(openId);

  const focusTile = (id: Id<"placeholderPairs"> | null, preferCount: boolean) => {
    setSelected(id);
    if (!id) {
      // The last card is done: land on the lane, never on the page body.
      requestAnimationFrame(() => document.getElementById(REVIEW_HEADING_ID)?.focus({ preventScroll: true }));
      return;
    }
    requestAnimationFrame(() => {
      const tile = document.querySelector<HTMLElement>(`[${TILE_ATTR}="${id}"]`);
      if (!tile) return;
      tile.scrollIntoView({ block: "nearest" });
      const qty = tile.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`);
      ((preferCount && qty) || tile.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    });
  };
  const after = (id: Id<"placeholderPairs">) => {
    const at = review.findIndex((r) => r.pairId === id);
    return (review[at + 1] ?? review[at - 1])?.pairId ?? null;
  };

  // Keys act only on the card that has focus (WCAG 2.1.4), or on the open
  // drawer's card; read through a ref so the listener is added once.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const inQty = !!target?.closest?.(`[${QTY_ATTR}]`);
    if (!inQty && target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return;
    if (inQty && (e.key.length !== 1 || /\d/.test(e.key))) return;
    const run1 = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (openId) {
      if (!open || !target?.closest?.('[role="dialog"]')) return;
      if (e.key === "s") run1(() => actions.swap(open));
      else if (e.key === "v") run1(() => actions.nextVariation(open));
      else if (e.key === "u") run1(() => closeAndMoveOn(open, () => actions.unpair(open)));
      else if (e.key === "d") run1(() => closeAndMoveOn(open, () => actions.aside(open, true)));
      return;
    }
    const tile = target?.closest?.(`[${TILE_ATTR}]`);
    const row = find((tile?.getAttribute(TILE_ATTR) as Id<"placeholderPairs"> | null) ?? null);
    if (!row) return;
    const key = e.key === "ArrowDown" ? "j" : e.key === "ArrowUp" ? "k" : e.key;
    if (key === "j" || key === "k") {
      const at = review.findIndex((r) => r.pairId === row.pairId);
      const to = review[key === "j" ? at + 1 : at - 1];
      if (to) run1(() => focusTile(to.pairId, inQty));
      return;
    }
    if (key === "y") run1(() => {
      if (!canSave(row)) return notify(whyNotSave(row));
      const typed = inQty ? Number.parseInt((target as HTMLInputElement).value, 10) : NaN;
      actions.save(row, Number.isFinite(typed) ? typed : undefined);
      focusTile(after(row.pairId), inQty);
    });
    else if (key === "o") run1(() => setOpenId(row.pairId));
    else if (key === "v") run1(() => actions.nextVariation(row));
    else if (key === "s") run1(() => actions.swap(row));
    else if (key === "u") run1(() => { focusTile(after(row.pairId), false); actions.unpair(row); });
    else if (key === "d") run1(() => { focusTile(after(row.pairId), false); actions.aside(row, true); });
  };
  /** Close the drawer after an action that takes its card off the lane, landing on the next card. */
  const closeAndMoveOn = (row: IntakeMatchRow, act: () => void) => {
    const next = after(row.pairId);
    act();
    setOpenId(null);
    focusTile(next, false);
  };
  const keyRef = useRef(onKey);
  useEffect(() => {
    keyRef.current = onKey;
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const loading = images === undefined || pairs === undefined || matches === undefined;
  const working = lanes.reading.length + lanes.matching.length;
  const summary = loading
    ? "Loading this run…"
    : working > 0
      ? `Working on ${working} photo${working === 1 ? "" : "s"}. ${review.length} waiting for you, ${lanes.saved.length} saved.`
      : review.length > 0
        ? `Everything is read. ${review.length} waiting for you, ${lanes.saved.length} saved.`
        : `${lanes.saved.length} saved.`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <dl className="m-0 flex flex-wrap gap-x-5 gap-y-1">
          {(
            [
              ["Reading", lanes.reading.length, "text-neon-blue-text"],
              ["Pairing", lanes.loose.length, "text-neon-purple-text"],
              ["Matching", lanes.matching.length, "text-neon-teal-text"],
              ["Needs you", review.length, "text-notice-warn-ink"],
              ["Saved", lanes.saved.length, "text-neon-green-text"],
            ] as const
          ).map(([label, n, tone]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-xs text-ink-3">{label}</dt>
              <dd className={`m-0 text-lg font-bold tabular-nums ${tone}`}>{n}</dd>
            </div>
          ))}
        </dl>
        <p aria-hidden="true" className="m-0 text-sm text-ink-2">
          {summary}
        </p>
        {/* Said once while the photos work, then when they're done: not every tick. */}
        <p role="status" aria-live="polite" className="sr-only">
          {loading ? "" : working > 0 ? "Working on your photos." : summary}
        </p>
        {/* A scanner run (NEO-386) opens before any photo, so it closes with none. */}
        {jobOpen && (
          <NeonButton
            size="1"
            variant="secondary"
            outline
            className="ml-auto"
            onClick={() => void closeStream({ jobId: run.jobId }).catch(fail)}
          >
            Done adding photos
          </NeonButton>
        )}
      </div>

      <details className="rounded-md border border-rule px-3 py-2 text-sm text-ink-2">
        <summary className={`cursor-pointer rounded-sm text-ink ${RING}`}>Keyboard shortcuts</summary>
        <p className="mt-2 text-xs text-ink-3">Click or tab to a card to select it (it turns green), then:</p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
          {KEY_HELP.map((k) => (
            <div key={k.keys} className="contents">
              <dt>
                <kbd className="font-mono text-ink">{k.keys}</kbd>
              </dt>
              <dd className="m-0">{k.does}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(3,minmax(0,0.8fr))_minmax(0,1.5fr)_minmax(0,0.9fr)]">
        <Lane label={LANE_LABEL.reading} count={lanes.reading.length}>
          {lanes.reading.map((i) => (
            <li key={i.entryIndex} className="intake-arrive">
              <PhotoTile image={i} />
            </li>
          ))}
        </Lane>
        <Lane label={LANE_LABEL.pairing} count={lanes.loose.length}>
          <LoosePile
            jobId={run.jobId}
            loose={lanes.loose}
            onPair={(front, back) =>
              void pairUp({ jobId: run.jobId, frontIndex: front, backIndex: back }).catch(fail)
            }
          />
        </Lane>
        <Lane label={LANE_LABEL.matching} count={lanes.matching.length}>
          {lanes.matching.map((p) => (
            <li key={`${p.frontIndex}-${p.backIndex}`} className="intake-arrive">
              <div className="flex items-center gap-2 rounded-md border-2 border-rule bg-surface p-1.5 text-xs">
                <ScanImage jobId={run.jobId} entryIndex={p.frontIndex} alt={`Front, ${byIndex.get(p.frontIndex)?.originalName ?? "scan"}`} className="h-14 w-auto rounded" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-2">{p.player ?? "Matching…"}</span>
                  <span className="block text-ink-3">{p.cardNumber ? `#${p.cardNumber}` : "Matching…"}</span>
                </span>
              </div>
            </li>
          ))}
        </Lane>
        <Lane
          label={LANE_LABEL.review}
          count={review.length}
          review
          action={
            // Always there, so the cards below it never shift when it would appear.
            <NeonButton
              size="1"
              variant="primary"
              className="mb-2"
              disabled={matched.length === 0}
              onClick={() => {
                matched.forEach((r) => actions.save(r));
                focusTile(review.find((r) => !matched.includes(r))?.pairId ?? null, false);
              }}
            >
              Save {matched.length} matched
            </NeonButton>
          }
        >
          {review.map((row) => (
            <li
              key={row.pairId}
              {...{ [TILE_ATTR]: row.pairId }}
              onFocusCapture={() => setSelected(row.pairId)}
              onClick={(e) => {
                setSelected(row.pairId);
                if (!(e.target as HTMLElement).closest("button, input, select, a, label")) {
                  e.currentTarget.querySelector<HTMLInputElement>(`[${QTY_ATTR}]:not(:disabled)`)?.focus();
                }
              }}
              className="intake-arrive"
            >
              <ReviewTile
                row={row}
                jobId={run.jobId}
                read={readFor(row)}
                selected={row.pairId === selected}
                actions={actions}
                canSave={canSave(row)}
                onOpen={() => setOpenId(row.pairId)}
                onSaved={() => focusTile(after(row.pairId), true)}
                onAnswered={(movesOn) => focusTile(movesOn ? after(row.pairId) : row.pairId, false)}
              />
            </li>
          ))}
        </Lane>
        <Lane label={LANE_LABEL.saved} count={lanes.saved.length}>
          {lanes.saved.map((row) => (
            <li key={row.pairId} className="intake-arrive intake-saved rounded-md">
              <div className="flex items-center gap-2 rounded-md border-2 border-rule bg-surface p-1.5 text-xs">
                <ScanImage jobId={run.jobId} entryIndex={row.frontIndex} alt={`Front, ${cardLabel(row.card)}`} className="h-14 w-auto rounded" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink-2">{cardLabel(row.card)}</span>
                  <span className="block text-neon-green-text">Saved +{row.savedQuantity ?? 1}</span>
                </span>
              </div>
            </li>
          ))}
          {lanes.setAside.length > 0 && (
            <li className="list-none border-t border-rule pt-2">
              <h3 className="m-0 mb-1 text-xs font-semibold text-ink-2">Set aside</h3>
              <ul className="m-0 list-none space-y-1 p-0">
                {lanes.setAside.map((row) => (
                  <li key={row.pairId} className="flex items-center justify-between gap-2 text-xs text-ink-3">
                    <span className="truncate">{tileLabel(row, readFor(row))}</span>
                    <button
                      type="button"
                      className={`-my-1.5 shrink-0 py-1.5 text-neon-blue-text underline ${RING}`}
                      onClick={() => {
                        actions.aside(row, false);
                        focusTile(null, false);
                      }}
                      aria-label={`Bring back ${tileLabel(row, readFor(row))}`}
                    >
                      Bring back
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </Lane>
      </div>

      {open && (
        <Overlay labelledBy="intake-drawer-title" onClose={() => setOpenId(null)}>
          <Drawer
            row={open}
            run={run}
            read={readFor(open)}
            actions={actions}
            canSave={canSave(open)}
            onClose={() => setOpenId(null)}
            onMoveOn={(act) => closeAndMoveOn(open, act)}
          />
        </Overlay>
      )}
    </div>
  );
}

interface RowActions {
  save: (row: IntakeMatchRow, total?: number) => void;
  setCount: (row: IntakeMatchRow, total: number) => void;
  count: (row: IntakeMatchRow) => number;
  pick: (row: IntakeMatchRow, cardId: Id<"cardChecklist"> | null) => void;
  repeat: (row: IntakeMatchRow, secondCopy: boolean) => void;
  aside: (row: IntakeMatchRow, setAside: boolean) => void;
  swap: (row: IntakeMatchRow) => void;
  unpair: (row: IntakeMatchRow) => void;
  nextVariation: (row: IntakeMatchRow) => void;
}

function Lane({
  label,
  count,
  review = false,
  action,
  children,
}: {
  label: string;
  count: number;
  review?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`${label}, ${count}`}
      className={`flex min-h-[16rem] flex-col rounded-lg border p-2 ${review ? "border-notice-warn-rule bg-notice-warn-bg/40" : "border-rule bg-raised"}`}
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <h2
          id={review ? REVIEW_HEADING_ID : undefined}
          tabIndex={review ? -1 : undefined}
          className={`m-0 text-sm font-semibold text-ink ${review ? RING : ""}`}
        >
          {label}
        </h2>
        <span className="text-sm font-bold tabular-nums text-ink-2">{count}</span>
      </header>
      {action}
      <ul className={`m-0 list-none space-y-2 overflow-auto p-0 ${review ? "" : "max-h-[34rem]"}`}>{children}</ul>
    </section>
  );
}

function PhotoTile({ image }: { image: IntakeImage }) {
  const failed = image.status === "failed";
  const local = useContext(LocalPhotos).get(image.originalName);
  return (
    <div className="flex items-center gap-2 rounded-md border-2 border-rule bg-surface p-1.5 text-xs">
      {local && <img src={local} alt="" className="h-14 w-10 shrink-0 rounded object-cover" />}
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink-2" title={image.originalName}>
          {image.originalName}
        </span>
        <span className="block">
          {failed ? (
            <span className="text-neon-pink-text">Couldn&apos;t read this photo</span>
          ) : (
            <StageBadge stage={image.status === "awaiting_upload" ? "uploading" : "reading"} />
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * The loose pile: read photos not in a pair yet. Pick two (the front first)
 * and pair them by hand; pairing usually finds them on its own.
 */
function LoosePile({
  jobId,
  loose,
  onPair,
}: {
  jobId: string;
  loose: IntakeImage[];
  onPair: (front: number, back: number) => void;
}) {
  const [chosen, setChosen] = useState<number[]>([]);
  const live = chosen.filter((n) => loose.some((i) => i.entryIndex === n));
  const toggle = (n: number) =>
    setChosen(live.includes(n) ? live.filter((x) => x !== n) : [...live, n].slice(-2));
  return (
    <>
      {loose.map((i) => (
        <li key={i.entryIndex} className="intake-arrive">
          <button
            type="button"
            aria-pressed={live.includes(i.entryIndex)}
            onClick={() => toggle(i.entryIndex)}
            className={`flex w-full items-center gap-2 rounded-md border-2 bg-surface p-1.5 text-left text-xs ${live.includes(i.entryIndex) ? "border-neon-green-text" : "border-rule"} ${RING}`}
          >
            {i.status !== "failed" && (
              <ScanImage jobId={jobId} entryIndex={i.entryIndex} alt="" className="h-14 w-auto shrink-0 rounded" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink-2">{i.originalName}</span>
              <span className="block text-ink-3">
                {i.status === "failed"
                  ? "Couldn't read it"
                  : [i.side, i.players?.join(", "), i.cardNumber ? `#${i.cardNumber}` : null].filter(Boolean).join(" · ") ||
                    "Waiting for its other side"}
              </span>
            </span>
          </button>
        </li>
      ))}
      {loose.length > 1 && (
        <li className="list-none">
          <NeonButton
            size="1"
            variant="secondary"
            outline
            disabled={live.length !== 2}
            onClick={() => {
              onPair(live[0], live[1]);
              setChosen([]);
            }}
          >
            Pair these two (first is the front)
          </NeonButton>
        </li>
      )}
    </>
  );
}

/** The band, as a pill: matched, check this, or no match. */
function Band({ row }: { row: IntakeMatchRow }) {
  const pct = `${row.confidence}%`;
  if (row.byUser) {
    return <span className="rounded-full bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">You picked</span>;
  }
  if (row.band === "matched") {
    return <span className="rounded-full bg-wash-green px-2 py-0.5 text-xs font-semibold text-neon-green-text">Matched {pct}</span>;
  }
  if (row.band === "check") {
    return <span className="rounded-full bg-notice-warn-bg px-2 py-0.5 text-xs font-semibold text-notice-warn-ink">Check this {pct}</span>;
  }
  return <span className="rounded-full border border-neon-pink-text bg-wash-pink px-2 py-0.5 text-xs font-semibold text-ink">No match</span>;
}

function edge(row: IntakeMatchRow, selected: boolean): string {
  if (selected) return "border-neon-green-text";
  if (row.byUser) return "border-rule";
  return row.band === "none" ? "border-neon-pink-text" : row.band === "check" ? "border-notice-warn-rule" : "border-rule";
}

function readLine(read: PairRead): string {
  const parts = [read.number ? `#${read.number}` : null, read.players.join(", ") || null].filter(Boolean);
  return parts.length ? `Read: ${parts.join(" · ")}` : "Nothing read yet";
}

/**
 * A card waiting for you. Its first line is the scans beside the title;
 * its second starts with Yes, so the top card's Yes stays in one spot and
 * the next card slides up under the pointer.
 */
function ReviewTile({
  row,
  jobId,
  read,
  selected,
  actions,
  canSave,
  onOpen,
  onSaved,
  onAnswered,
}: {
  row: IntakeMatchRow;
  jobId: string;
  read: PairRead;
  selected: boolean;
  actions: RowActions;
  canSave: boolean;
  onOpen: () => void;
  onSaved: () => void;
  onAnswered: (movesOn: boolean) => void;
}) {
  const label = tileLabel(row, read);
  const reasonId = useId();
  return (
    <article aria-label={label} className={`rounded-md border-2 bg-surface p-2 ${edge(row, selected)}`}>
      <div className="flex gap-2">
        <div className="flex shrink-0 gap-1">
          <ScanImage jobId={jobId} entryIndex={row.frontIndex} alt="Front scan" className="h-24 w-auto rounded" />
          <ScanImage jobId={jobId} entryIndex={row.backIndex} alt="Back scan" className="h-24 w-auto rounded" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="m-0 truncate text-sm font-semibold text-ink">{cardLabel(row.card)}</p>
          <Band row={row} />
          <p className="m-0 text-xs text-ink-3">{readLine(read)}</p>
          {!row.byUser && row.band !== "matched" && <p className="m-0 text-xs text-ink-3">{reasonText(row, read)}</p>}
          {!canSave && (
            <p id={reasonId} className="sr-only">
              {whyNotSave(row)}
            </p>
          )}
        </div>
      </div>
      <Prompts row={row} actions={actions} onAnswered={onAnswered} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <NeonButton
          size="1"
          variant="primary"
          // aria-disabled keeps it reachable, so its reason can be heard.
          aria-disabled={!canSave}
          aria-describedby={canSave ? undefined : reasonId}
          aria-keyshortcuts="y"
          aria-label={`Yes, save ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            actions.save(row);
            if (canSave) onSaved();
          }}
        >
          Yes
        </NeonButton>
        <NeonButton size="1" variant="secondary" outline aria-keyshortcuts="o" onClick={onOpen} aria-label={`Review ${label}`}>
          Review
        </NeonButton>
        <CountField row={row} actions={actions} disabled={!canSave} onEnter={onSaved} />
      </div>
    </article>
  );
}

/** The questions only the collector can answer, with one-click answers. */
function Prompts({
  row,
  actions,
  onAnswered,
}: {
  row: IntakeMatchRow;
  actions: RowActions;
  /** The answer's button is gone; where focus goes. True when the card leaves the lane. */
  onAnswered: (movesOn: boolean) => void;
}) {
  const answer = (act: () => void, movesOn = false) => {
    act();
    onAnswered(movesOn);
  };
  const parts: ReactNode[] = [];
  if (row.repeatOfPairId && !row.repeatIsSecondCopy) {
    parts.push(
      <Prompt key="repeat" text="This card is already in this run. Is it a second copy, or the same card scanned twice?">
        <NeonButton size="1" variant="secondary" onClick={() => answer(() => actions.repeat(row, true))}>
          Second copy
        </NeonButton>
        <NeonButton size="1" variant="negative" outline onClick={() => answer(() => actions.repeat(row, false), true)}>
          Same card, set it aside
        </NeonButton>
      </Prompt>,
    );
  }
  const others = row.candidates.filter((c) => c._id !== row.cardId);
  if (!row.byUser && others.length > 0) {
    parts.push(
      <Prompt key="cands" text={row.cardId ? "Or is it:" : "Which card is it?"}>
        {others.map((c) => (
          <NeonButton key={c._id} size="1" variant="secondary" outline onClick={() => answer(() => actions.pick(row, c._id))}>
            {cardLabel(c)}
          </NeonButton>
        ))}
      </Prompt>,
    );
  }
  if (row.variations.length > 0) {
    parts.push(
      <Prompt key="vars" text="This card has other pictures (variations). Is it one of these?">
        {[row.card, ...row.variations]
          .filter((c): c is NonNullable<typeof c> => !!c && c._id !== row.cardId)
          .map((c) => (
            <NeonButton key={c._id} size="1" variant="secondary" outline onClick={() => answer(() => actions.pick(row, c._id))}>
              {c.variation ?? "The regular picture"}
            </NeonButton>
          ))}
      </Prompt>,
    );
  }
  return parts.length ? <div className="mt-2 space-y-2">{parts}</div> : null;
}

function Prompt({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-notice-warn-rule bg-notice-warn-bg px-3 py-2">
      <p className="m-0 text-sm text-notice-warn-ink">{text}</p>
      {children && <div className="mt-2 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

/**
 * "Had 3 → 4": the count already in this home and the line's count once
 * saved. Enter saves at the number shown and moves on. Only digits type: any
 * other key is a shortcut for this card.
 */
function CountField({
  row,
  actions,
  disabled,
  onEnter,
}: {
  row: IntakeMatchRow;
  actions: RowActions;
  disabled: boolean;
  onEnter?: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(actions.count(row));
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="whitespace-nowrap text-ink-3">
        {row.haveHere > 0 ? `Had ${row.haveHere} →` : "Count"}
      </label>
      <Input
        bare
        id={id}
        {...{ [QTY_ATTR]: row.pairId }}
        inputMode="numeric"
        value={shown}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const n = Number.parseInt(shown, 10);
            if (Number.isFinite(n)) {
              actions.setCount(row, n);
              actions.save(row, n);
            }
            setDraft(null);
            onEnter?.();
          } else if (e.key === "Escape") {
            // Undo the typing only; inside the drawer this must not close it too.
            if (draft !== null) e.stopPropagation();
            setDraft(null);
          } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (draft === null) return;
          const n = Number.parseInt(draft, 10);
          if (Number.isFinite(n)) actions.setCount(row, n);
          setDraft(null);
        }}
        className={`w-14 rounded-md border border-field-rule bg-field px-2 py-1 text-right tabular-nums text-ink ${RING}`}
        aria-describedby={`${id}-hint`}
        aria-keyshortcuts="Enter"
      />
      <span id={`${id}-hint`} className="sr-only">
        Enter saves and moves to the next card.
      </span>
    </div>
  );
}

/** Search the run's variant and pick the card by hand. */
function CardSearch({ row, run, actions, onDone }: { row: IntakeMatchRow; run: RunSummary; actions: RowActions; onDone: () => void }) {
  const id = useId();
  const [q, setQ] = useState("");
  const hits = useQuery(api.intakeRuns.searchIntakeCards, { runId: run._id, q });
  const [active, setActive] = useState(0);
  const list = hits ?? [];
  const choose = (cardId: Id<"cardChecklist">) => {
    actions.pick(row, cardId);
    onDone();
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-2">
        Find the card in {run.variantName ?? "this set"}
      </label>
      <Input
        bare
        id={id}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={list[active] ? `${id}-${list[active]._id}` : undefined}
        autoFocus
        value={q}
        placeholder="Number or player"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && list[active]) {
            e.preventDefault();
            choose(list[active]._id);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        className={`w-full rounded-md border border-field-rule bg-field px-2 py-1.5 text-sm text-ink ${RING}`}
      />
      <ul id={`${id}-list`} role="listbox" aria-label="Cards" className="m-0 max-h-56 list-none space-y-0.5 overflow-auto p-0">
        {list.map((c, n) => (
          <li
            key={c._id}
            id={`${id}-${c._id}`}
            role="option"
            aria-selected={n === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(c._id)}
            className={`cursor-pointer rounded-md px-2 py-1 text-sm ${n === active ? "bg-pick-blue text-pick-blue-ink" : "text-ink-2 hover:bg-list-hover"}`}
          >
            {cardLabel(c)}
          </li>
        ))}
        {hits !== undefined && list.length === 0 && <li className="px-2 py-1 text-sm text-ink-3">Nothing in this set matches.</li>}
      </ul>
    </div>
  );
}

function Drawer({
  row,
  run,
  read,
  actions,
  canSave,
  onClose,
  onMoveOn,
}: {
  row: IntakeMatchRow;
  run: RunSummary;
  read: PairRead;
  actions: RowActions;
  canSave: boolean;
  onClose: () => void;
  /** Do something that takes the card off the lane, close, and land on the next card. */
  onMoveOn: (act: () => void) => void;
}) {
  const [searching, setSearching] = useState(false);
  // A control that took focus with it (a prompt answer, the search): focus goes back to the title.
  const toTitle = () => requestAnimationFrame(() => document.getElementById("intake-drawer-title")?.focus());
  const tool = `min-h-11 rounded-md border border-rule bg-button-neutral px-2 py-1 text-xs text-ink-2 hover:bg-button-neutral-hover sm:min-h-8 ${RING}`;
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <h2 id="intake-drawer-title" tabIndex={-1} className="m-0 text-xl font-bold text-ink">
          {cardLabel(row.card)}
        </h2>
        <NeonButton size="1" variant="secondary" outline onClick={onClose}>
          Close
        </NeonButton>
      </div>
      <Band row={row} />
      <p className="m-0 text-sm text-ink-2">{readLine(read)}</p>
      <p className="m-0 text-sm text-ink-3">{reasonText(row, read)}</p>
      <div className="flex gap-3">
        <ScanImage jobId={run.jobId} entryIndex={row.frontIndex} alt="Front scan" className="h-64 w-auto rounded" />
        <ScanImage jobId={run.jobId} entryIndex={row.backIndex} alt="Back scan" className="h-64 w-auto rounded" />
      </div>
      <Prompts row={row} actions={actions} onAnswered={(movesOn) => (movesOn ? onMoveOn(() => {}) : toTitle())} />
      {searching ? (
        <CardSearch
          row={row}
          run={run}
          actions={actions}
          onDone={() => {
            setSearching(false);
            toTitle();
          }}
        />
      ) : (
        <button type="button" onClick={() => setSearching(true)} className={`text-sm text-neon-blue-text underline ${RING}`}>
          Wrong card? Find it
        </button>
      )}
      <div role="group" aria-label="Fix this scan" className="flex flex-wrap gap-1.5">
        <button type="button" className={tool} aria-keyshortcuts="s" onClick={() => actions.swap(row)}>
          <kbd className="mr-1 font-mono">s</kbd>Swap sides
        </button>
        <button type="button" className={tool} aria-keyshortcuts="u" onClick={() => onMoveOn(() => actions.unpair(row))}>
          <kbd className="mr-1 font-mono">u</kbd>Unpair
        </button>
        {row.byUser && (
          <button
            type="button"
            className={tool}
            onClick={() => {
              actions.pick(row, null);
              toTitle();
            }}
          >
            Let the matcher pick again
          </button>
        )}
        <NeonButton size="1" variant="negative" outline aria-keyshortcuts="d" className="min-h-11 sm:min-h-8" onClick={() => onMoveOn(() => actions.aside(row, true))}>
          <kbd className="mr-1 font-mono">d</kbd>Set aside
        </NeonButton>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
        <CountField row={row} actions={actions} disabled={!canSave} onEnter={() => onMoveOn(() => {})} />
        <NeonButton
          variant="primary"
          aria-disabled={!canSave}
          onClick={() => {
            if (!canSave) return actions.save(row);
            onMoveOn(() => actions.save(row));
          }}
        >
          Save this card
        </NeonButton>
      </div>
    </div>
  );
}
