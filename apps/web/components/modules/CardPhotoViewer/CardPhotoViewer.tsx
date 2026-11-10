/**
 * NEO-481 — the one card photo viewer: a big look at a card's front or back,
 * a quarter turn either way, and a crop by hand with a box that spins a full
 * circle. Every surface that shows a card photo it can edit opens this, with a
 * `PhotoSource` that says where the photo lives (`./types.ts`).
 *
 * The save is asynchronous. Save photo hands the edit over and is accepted at
 * once; the picture shows the edit straight away from the source the tools
 * drew on (`./previewStore.ts`), with "Touching it up…" until the new file
 * lands. A render that fails leaves the old photo live and offers Try again.
 *
 * A dialog, so it stays out of the URL: Escape closes it (and only it, never
 * the card drawer under it) and focus goes back to the photo that opened it
 * (`usePhotoViewer`).
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  MinusIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import Overlay from "@/app/collection/prototypes/p1/Overlay";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import {
  cropOrNull,
  describeCrop,
  editsEqual,
  effectiveCrop,
  nudgeCrop,
  normalizeAngle,
  RESIZE_STEP,
  resizeCrop,
  resizeCropSide,
  setCropAngle,
  tidyEdit,
  tiltCrop,
  turnBy,
  type PhotoCrop,
  type PhotoEdit,
} from "@/lib/photo-edit/geometry";
import CropStage from "./CropStage";
import { CardPhoto, EditedImage, pendingWords } from "./EditedPhoto";
import { forgetPreview, rememberPreview } from "./previewStore";
import type { EditableStart, EditStart, PhotoSideSource, PhotoSource, ViewerSide } from "./types";

const SIDE_WORD: Record<ViewerSide, string> = { front: "Front", back: "Back" };

/** Words the viewer says (and the specs read). One place, so a rename is one edit. */
export const VIEWER_WORDS = {
  storedMode: "This photo's original scan is gone, so a crop can only trim what's here.",
  loading: "Getting the photo ready…",
  loadFailed: "Couldn't open this photo for editing.",
  saved: "Saved.",
  landed: "All set. Your edited photo is in.",
  stillRendering: "Still touching up the last edit. Give it a moment.",
  nothingChanged: "Turn or crop the photo first.",
  outOfEdits: "This photo is out of hand edits.",
  noAutoCrop: "No auto crop here. Drag the box to fit the card.",
  unsavedEdit: "Unsaved edit. Esc again to toss it, or Save photo.",
  keepOld: "Keep the old photo",
  keys: "Keys: [ and ] turn it, C crops it.",
} as const;

/** How long the box holds still before its size is read out. */
const ANNOUNCE_AFTER_MS = 600;

type Loaded = { state: "loading" } | { state: "ready"; start: EditStart; forUrl: string } | { state: "error" };

/** True when focus sits in a text field, where the viewer's letter keys are typing. */
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export default function CardPhotoViewer({
  source,
  initialSide = "front",
  onClose,
}: {
  source: PhotoSource;
  initialSide?: ViewerSide;
  onClose: () => void;
}) {
  const headingId = useId();
  const helpId = useId();
  const sides = (["front", "back"] as const).filter((s) => source[s]);
  const [side, setSide] = useState<ViewerSide>(source[initialSide] ? initialSide : (sides[0] ?? "front"));
  const current: PhotoSideSource | undefined = source[side];

  const [loaded, setLoaded] = useState<Partial<Record<ViewerSide, Loaded>>>({});
  /** The edit being drawn, per side; absent = the side's saved state. */
  const [drafts, setDrafts] = useState<Partial<Record<ViewerSide, PhotoEdit>>>({});
  /** What each side was saved as in this viewer (the baseline the draft compares with), and what it was before. */
  const [saves, setSaves] = useState<Partial<Record<ViewerSide, { before: PhotoEdit; after: PhotoEdit }>>>({});
  const [cropping, setCropping] = useState(false);
  const [busy, setBusy] = useState(false);
  // A live region only speaks when its text changes, so a line said twice in a
  // row carries a count: the second "Saved." gets a trailing no-break space.
  const [said, setSaidLine] = useState({ text: "", n: 0 });
  const [error, setErrorLine] = useState<{ text: string; n: number } | null>(null);
  const setSaid = useCallback((text: string) => setSaidLine((p) => ({ text, n: text && text === p.text ? p.n + 1 : 0 })), []);
  const setError = useCallback(
    (text: string | null) => setErrorLine((p) => (text === null ? null : { text, n: p && text === p.text ? p.n + 1 : 0 })),
    [],
  );
  const [heard, setHeard] = useState("");

  // Focus never drops to <body> when the control holding it goes away: a
  // control that unmounts while focused hands focus to the heading (or, for
  // the crop tools, to "Crop by hand"). React runs a ref's cleanup before the
  // node leaves the page, so it can still tell whether focus was inside.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cropButtonRef = useRef<HTMLButtonElement>(null);
  const parkOnHeading = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return () => {
      if (el.contains(document.activeElement)) headingRef.current?.focus({ preventScroll: true });
    };
  }, []);
  const parkOnCropButton = useCallback((el: Element | null) => {
    if (!el) return;
    return () => {
      if (el.contains(document.activeElement)) (cropButtonRef.current ?? headingRef.current)?.focus({ preventScroll: true });
    };
  }, []);
  const sideRefs = useRef<Partial<Record<ViewerSide, HTMLButtonElement | null>>>({});

  const entry = loaded[side];
  const start = entry?.state === "ready" ? entry.start : undefined;
  const editable: EditableStart | undefined = start && start.mode !== "viewOnly" ? start : undefined;
  const viewOnlyReason = current?.viewOnly ?? (start?.mode === "viewOnly" ? start.reason : undefined) ?? (current && !current.load ? "" : undefined);
  const baseline = editable ? (saves[side]?.after ?? editable.opening) : undefined;
  const draft = drafts[side] ?? baseline;
  const dirty = !!(draft && baseline && !editsEqual(draft, baseline));
  const pending = current?.pending;
  const rendering = pending?.status === "rendering";
  const outOfEdits = editable?.editsLeft === 0;

  // Read where an edit starts when a side opens, and again when its photo
  // changes underneath (a new version landed): an old start would draw on an
  // old picture. Loading is also the server's cue to warm the renderer.
  const loadFor = useRef<Partial<Record<ViewerSide, string>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const hasDraft = !!drafts[side];
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!current?.load || current.viewOnly) return;
    if (!current.imageUrl || loadFor.current[side] === current.imageUrl) return;
    if (hasDraft) return; // never pull the picture out from under a draft
    const forUrl = current.imageUrl;
    const thisSide = side;
    loadFor.current[thisSide] = forUrl;
    // A later load for this side (its photo changed again) wins over this one.
    const latest = () => mounted.current && loadFor.current[thisSide] === forUrl;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the start is an outside answer, asked for when the side opens
    setLoaded((l) => ({ ...l, [thisSide]: l[thisSide]?.state === "ready" ? l[thisSide] : { state: "loading" } }));
    current.load().then(
      (s) => {
        if (latest()) setLoaded((l) => ({ ...l, [thisSide]: { state: "ready", start: s, forUrl } }));
      },
      () => {
        // Stays failed until the collector asks again (`retryLoad`): never a loop of reads.
        if (latest()) setLoaded((l) => ({ ...l, [thisSide]: { state: "error" } }));
      },
    );
  }, [side, current, hasDraft, reloads]);
  const retryLoad = () => {
    loadFor.current[side] = undefined;
    setReloads((n) => n + 1);
  };

  // Follow each side's pending edit as it moves on. Rendering then gone: the
  // new file landed, so say so. Turned failed: nothing new landed, so "Saved."
  // goes, the failure notice is the only word, and there is nothing to Undo
  // (the photo is still the one from before). Per side, so switching sides
  // never reads as a landing.
  const status = pending?.status;
  const lastStatus = useRef<Partial<Record<ViewerSide, "rendering" | "failed" | undefined>>>({});
  useEffect(() => {
    const was = lastStatus.current[side];
    lastStatus.current[side] = status;
    if (was === status) return;
    if (was === "rendering" && status === undefined && saves[side]) setSaid(VIEWER_WORDS.landed);
    if (status === "failed") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the failure is an outside answer arriving
      setSaid("");
      setSaves((s) => (s[side] ? { ...s, [side]: undefined } : s));
    }
  }, [status, saves, side, setSaid]);

  // Read the box out once it holds still.
  const description = cropping && editable && draft ? describeCrop(draft, editable.srcW, editable.srcH) : "";
  useEffect(() => {
    if (!description) return;
    const t = setTimeout(() => setHeard(description), ANNOUNCE_AFTER_MS);
    return () => clearTimeout(t);
  }, [description]);

  const setDraft = (next: PhotoEdit) => {
    setError(null);
    setCloseArmed(false);
    setDrafts((d) => ({ ...d, [side]: next }));
  };
  const crop: PhotoCrop | null = editable && draft ? effectiveCrop(draft, editable.srcW, editable.srcH) : null;
  const setCrop = (next: PhotoCrop) => draft && setDraft({ ...draft, crop: next });

  const turn = (delta: number) => draft && setDraft({ ...draft, turns: turnBy(draft.turns, delta) });
  const toggleCrop = () => {
    if (!editable || !draft) return;
    if (cropping && draft.crop) setDraft({ ...draft, crop: cropOrNull(draft.crop) });
    setCropping((c) => !c);
  };
  const startOver = () => editable && setDraft(editable.reset);

  const blockedBy = (): string | null => {
    if (busy) return "";
    if (rendering) return VIEWER_WORDS.stillRendering;
    if (outOfEdits) return VIEWER_WORDS.outOfEdits;
    return null;
  };

  const send = async (edit: PhotoEdit, done: (sent: PhotoEdit) => void) => {
    if (!editable || !current?.save) return;
    const sent = tidyEdit(edit);
    setBusy(true);
    setError(null);
    rememberPreview(current.previewKey, { edit: sent, sourceUrl: editable.sourceUrl, srcW: editable.srcW, srcH: editable.srcH });
    try {
      await current.save(sent, editable);
      done(sent);
      setSaid(VIEWER_WORDS.saved);
    } catch (e) {
      forgetPreview(current.previewKey);
      setSaid("");
      setError(e instanceof Error && e.message ? e.message : "That edit didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const blocked = blockedBy();
    if (blocked !== null) {
      if (blocked) setError(blocked);
      return;
    }
    if (!draft || !baseline || !dirty) {
      setError(VIEWER_WORDS.nothingChanged);
      return;
    }
    const before = baseline;
    const edit = draft.crop ? { ...draft, crop: cropOrNull(draft.crop) } : draft;
    void send(edit, (sent) => {
      setSaves((s) => ({ ...s, [side]: { before, after: sent } }));
      setDrafts((d) => ({ ...d, [side]: undefined }));
      setCropping(false);
    });
  };

  const lastSave = saves[side];
  const canUndo = !!lastSave && (!!current?.undo || editable?.mode === "original");
  const undo = () => {
    if (!lastSave || blockedBy() !== null) return;
    if (current?.undo) {
      setBusy(true);
      setError(null);
      current.undo().then(
        () => {
          setSaves((s) => ({ ...s, [side]: undefined }));
          setDrafts((d) => ({ ...d, [side]: undefined }));
          setSaid("Put back the photo from before.");
        },
        (e: unknown) => setError(e instanceof Error && e.message ? e.message : "Couldn't put the old photo back."),
      ).finally(() => setBusy(false));
      return;
    }
    // A scan re-renders from its original, so its Undo saves the edit it had before.
    void send(lastSave.before, () => {
      setSaves((s) => ({ ...s, [side]: undefined }));
      setDrafts((d) => ({ ...d, [side]: undefined }));
    });
  };

  const tryAgain = () => {
    if (!pending || pending.status !== "failed" || busy) return;
    void send(pending.edit, (sent) => {
      setSaves((s) => ({ ...s, [side]: { before: s[side]?.before ?? editable?.opening ?? sent, after: sent } }));
    });
  };
  const keepOld = () => {
    if (!current?.dismissFailure || busy) return;
    forgetPreview(current.previewKey);
    current.dismissFailure().catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : "Couldn't clear that note."));
  };

  // An edit not saved yet, on either side: the first Close or Escape says so, the second tosses it.
  const unsaved = sides.some((s) => {
    const d = drafts[s];
    const l = loaded[s];
    if (!d || l?.state !== "ready" || l.start.mode === "viewOnly") return false;
    return !editsEqual(d, saves[s]?.after ?? l.start.opening);
  });
  const [closeArmed, setCloseArmed] = useState(false);
  const requestClose = () => {
    if (unsaved && !closeArmed && !busy) {
      setCloseArmed(true);
      setError(VIEWER_WORDS.unsavedEdit);
      return;
    }
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Only this dialog: the card drawer under it stays open.
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || !editable) return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      e.stopPropagation();
      turn(e.key === "]" ? 1 : -1);
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      e.stopPropagation();
      toggleCrop();
    }
  };

  const switchSide = (to: ViewerSide) => {
    if (to === side) return;
    setCropping(false);
    setError(null);
    setSaid("");
    setSide(to);
  };

  const onSideKeys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    e.stopPropagation();
    const to = sides[(sides.indexOf(side) + by + sides.length) % sides.length];
    switchSide(to);
    sideRefs.current[to]?.focus();
  };

  const word = SIDE_WORD[side];
  const alt = `${word} of ${source.label}`;
  const blocked = blockedBy();

  return (
    <Overlay labelledBy={headingId} onClose={requestClose} variant="stage">
      <div
        className="pointer-events-auto absolute inset-0 flex flex-col overflow-y-auto bg-sheet text-ink sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(54rem,calc(100dvh-2rem))] sm:w-[min(60rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border sm:border-rule-strong sm:shadow-xl sm:shadow-offset"
        onKeyDown={onKeyDown}
        data-card-photo-viewer=""
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-4 py-3">
          <h2 ref={headingRef} id={headingId} tabIndex={-1} className="min-w-0 flex-1 rounded-sm text-lg font-semibold focus-outline">
            {alt}
          </h2>
          {sides.length > 1 && (
            <div role="radiogroup" aria-label="Which side" className="flex rounded-md border border-control p-0.5">
              {sides.map((s) => (
                <button
                  key={s}
                  ref={(el) => {
                    sideRefs.current[s] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={s === side}
                  tabIndex={s === side ? 0 : -1}
                  onClick={() => switchSide(s)}
                  onKeyDown={onSideKeys}
                  className={`min-h-11 min-w-16 rounded px-3 text-sm font-medium focus-outline ${
                    s === side ? "bg-neon-blue text-on-neon-blue" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {SIDE_WORD[s]}
                </button>
              ))}
            </div>
          )}
        </div>

        <Notices
          viewOnly={viewOnlyReason}
          loading={entry?.state === "loading"}
          loadFailed={entry?.state === "error"}
          onRetryLoad={retryLoad}
          stored={editable?.mode === "stored"}
          editsLeft={editable?.editsLeft}
          pending={pending}
          busy={busy}
          onTryAgain={editable && current?.save ? tryAgain : undefined}
          onKeepOld={current?.dismissFailure ? keepOld : undefined}
          parkRef={parkOnHeading}
        />

        <div
          // The stage takes whatever height the panel leaves; the picture fills it, letterboxed.
          // A tint that differs from the sheet in both modes (the page grey in light, the input well in dark), so a
          // white-bordered card still shows its edge. No role is both yet: a token candidate.
          className="relative mx-4 my-1 min-h-[15rem] flex-1 overflow-hidden rounded-md bg-[color:light-dark(var(--surface),var(--field))] sm:my-3"
        >
          {editable && draft && cropping ? (
            <div ref={parkOnCropButton} className="contents">
              <CropStage
                sourceUrl={editable.sourceUrl}
                srcW={editable.srcW}
                srcH={editable.srcH}
                turns={draft.turns}
                crop={draft.crop}
                onChange={setCrop}
                instructionsId={helpId}
              />
            </div>
          ) : editable && draft && (dirty || current?.shown) ? (
            <EditedImage
              src={editable.sourceUrl}
              alt={alt}
              edit={draft}
              srcW={editable.srcW}
              srcH={editable.srcH}
              className="absolute inset-0 block h-full w-full"
            />
          ) : current && !current.imageUrl ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">Loading the photo…</p>
          ) : current?.imageUrl ? (
            <CardPhoto
              src={current.imageUrl}
              alt={alt}
              shown={current.shown}
              pending={pending}
              previewKey={current.previewKey}
              chip={false}
              className="absolute inset-0 block h-full w-full object-contain"
            />
          ) : (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">No {side} photo yet.</p>
          )}
        </div>

        {editable && draft && (
          <div className="flex flex-col gap-3 px-4">
            <div role="toolbar" aria-label="Photo tools" className="flex flex-wrap gap-2">
              <Tool label="Turn left" icon={<ArrowUturnLeftIcon />} onClick={() => turn(-1)} shortcut="[" />
              <Tool label="Turn right" icon={<ArrowUturnRightIcon />} onClick={() => turn(1)} shortcut="]" />
              <NeonButton
                ref={cropButtonRef}
                type="button"
                variant="tertiary"
                outline={!cropping}
                aria-pressed={cropping}
                aria-keyshortcuts="C"
                title="Crop by hand (C)"
                onClick={toggleCrop}
                className="min-h-11"
              >
                Crop by hand
              </NeonButton>
              <Tool label="Start over" icon={<ArrowPathIcon />} onClick={startOver} />
              {canUndo && (
                <Tool
                  label="Undo"
                  icon={<ArrowUturnLeftIcon />}
                  onClick={undo}
                  disabledBecause={blocked ?? undefined}
                  parkRef={parkOnHeading}
                />
              )}
            </div>
            <p className="-mt-1 text-xs text-ink-3 [@media(pointer:coarse)]:hidden">{VIEWER_WORDS.keys}</p>

            {cropping && crop && (
              <CropControls
                parkRef={parkOnCropButton}
                crop={crop}
                turns={draft.turns}
                onChange={setCrop}
                helpId={helpId}
                noAutoCrop={editable?.noAutoCrop === true}
              />
            )}
          </div>
        )}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {heard}
        </div>
        <p className="min-h-5 px-4 pt-2 text-sm text-ink-2" role="status" data-viewer-said="">
          {said.text + (said.n % 2 ? "\u00a0" : "")}
        </p>
        <p className="min-h-5 px-4 text-sm text-notice-warn-ink" role="alert">
          {error ? error.text + (error.n % 2 ? "\u00a0" : "") : ""}
        </p>

        <div className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-rule px-4 py-3">
          {editable && current?.save && (
            <NeonButton
              type="button"
              variant="primary"
              onClick={save}
              aria-disabled={!dirty || blocked !== null || undefined}
              title={blocked || (!dirty ? VIEWER_WORDS.nothingChanged : undefined)}
              className="min-h-11"
            >
              {busy ? "Saving…" : "Save photo"}
            </NeonButton>
          )}
          <NeonButton type="button" variant="negative" outline onClick={requestClose} className="min-h-11">
            Close
          </NeonButton>
        </div>
      </div>
    </Overlay>
  );
}

/** One tool button: an icon and its words, 44 px tall. */
function Tool({
  label,
  icon,
  onClick,
  shortcut,
  disabledBecause,
  parkRef,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  shortcut?: string;
  disabledBecause?: string;
  /** Where focus goes if this tool unmounts while it holds focus. */
  parkRef?: (el: HTMLElement | null) => (() => void) | undefined;
}) {
  return (
    <NeonButton
      ref={parkRef}
      type="button"
      variant="secondary"
      outline
      onClick={() => {
        if (disabledBecause === undefined) onClick();
      }}
      aria-disabled={disabledBecause !== undefined || undefined}
      title={disabledBecause || (shortcut ? `${label} (${shortcut})` : undefined)}
      aria-keyshortcuts={shortcut}
      className="min-h-11"
    >
      <span aria-hidden="true" className="h-4 w-4">
        {icon}
      </span>
      {label}
    </NeonButton>
  );
}

/** The visible steps for everything a drag does, and the angle as a number. */
function CropControls({
  crop,
  turns,
  onChange,
  helpId,
  noAutoCrop,
  parkRef,
}: {
  parkRef: (el: HTMLElement | null) => (() => void) | undefined;
  crop: PhotoCrop;
  turns: PhotoEdit["turns"];
  onChange: (c: PhotoCrop) => void;
  helpId: string;
  /** The photo has no auto crop, so the box opened on the whole frame. */
  noAutoCrop: boolean;
}) {
  const angleNoteId = useId();
  const moreId = useId();
  // On a phone the stage needs the height: Move and Size stay out, the rest waits behind "More steps".
  const [more, setMore] = useState(false);
  const [angleText, setAngleText] = useState<string | null>(null);
  const shownAngle = angleText ?? String(Math.round(normalizeAngle(crop.angle) * 10) / 10);
  const typed = angleText === null || angleText.trim() === "" ? null : Number(angleText);
  // An angle past ±180 is the same tilt the short way round: it is taken as that, and said so.
  const wrapped = typed !== null && Number.isFinite(typed) && (typed < -180 || typed > 180) ? normalizeAngle(typed) : null;
  const angleNote =
    typed !== null && !Number.isFinite(typed)
      ? "Type the angle as a number of degrees."
      : wrapped !== null
        ? `${typed}° is the same tilt as ${Math.round(wrapped * 10) / 10}°.`
        : "";
  const step = (label: string, icon: ReactNode, next: () => PhotoCrop) => (
    <NeonButton
      type="button"
      variant="secondary"
      outline
      aria-label={label}
      title={label}
      onClick={() => onChange(next())}
      className="min-h-11 min-w-11 px-0"
    >
      <span aria-hidden="true" className="h-5 w-5">
        {icon}
      </span>
    </NeonButton>
  );
  return (
    <div ref={parkRef} className="flex flex-col gap-2 rounded-md border border-rule p-3">
      {noAutoCrop && <p className="text-sm text-ink-2">{VIEWER_WORDS.noAutoCrop}</p>}
      <p id={helpId} className="text-xs text-ink-3">
        Drag the box to move it, a corner to resize it, or the round handle to spin it.
        <span className="[@media(pointer:coarse)]:sr-only">
          {" "}
          On the box: arrows nudge it (Shift for bigger steps), + and − resize it, W and H make it wider and taller (Shift+W
          and Shift+H narrower and shorter), comma and period tilt it a degree (Shift for 15°).
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Move steps" className="flex gap-1">
          {step("Nudge crop left", <ArrowLeftIcon />, () => nudgeCrop(crop, -1, 0, turns))}
          {step("Nudge crop up", <ArrowUpIcon />, () => nudgeCrop(crop, 0, -1, turns))}
          {step("Nudge crop down", <ArrowDownIcon />, () => nudgeCrop(crop, 0, 1, turns))}
          {step("Nudge crop right", <ArrowRightIcon />, () => nudgeCrop(crop, 1, 0, turns))}
        </div>
        <div role="group" aria-label="Size steps" className="flex gap-1">
          {step("Shrink crop", <MinusIcon />, () => resizeCrop(crop, 1 / RESIZE_STEP))}
          {step("Grow crop", <PlusIcon />, () => resizeCrop(crop, RESIZE_STEP))}
        </div>
        <NeonButton
          type="button"
          variant="secondary"
          outline
          aria-expanded={more}
          aria-controls={moreId}
          onClick={() => setMore((m) => !m)}
          className="min-h-11 sm:hidden"
        >
          More steps
        </NeonButton>
        <div id={moreId} className={`${more ? "flex" : "hidden"} flex-wrap items-center gap-2 sm:contents`}>
        <div role="group" aria-label="Width and height steps" className="flex items-center gap-1">
          <span aria-hidden="true" className="text-sm text-ink-2">
            Width
          </span>
          {step("Make crop narrower", <MinusIcon />, () => resizeCropSide(crop, "w", 1 / RESIZE_STEP))}
          {step("Make crop wider", <PlusIcon />, () => resizeCropSide(crop, "w", RESIZE_STEP))}
          <span aria-hidden="true" className="ml-2 text-sm text-ink-2">
            Height
          </span>
          {step("Make crop shorter", <MinusIcon />, () => resizeCropSide(crop, "h", 1 / RESIZE_STEP))}
          {step("Make crop taller", <PlusIcon />, () => resizeCropSide(crop, "h", RESIZE_STEP))}
        </div>
        <div role="group" aria-label="Tilt steps" className="flex items-center gap-1">
          {step("Tilt crop left", <ArrowUturnLeftIcon />, () => tiltCrop(crop, -1))}
          {step("Tilt crop right", <ArrowUturnRightIcon />, () => tiltCrop(crop, 1))}
          <label className="ml-1 flex items-center gap-2 text-sm text-ink-2">
            <span>Angle</span>
            <Input
              bare
              type="number"
              inputMode="decimal"
              min={-180}
              max={180}
              step={1}
              aria-label="Angle, degrees"
              value={shownAngle}
              aria-describedby={angleNote ? angleNoteId : undefined}
              onChange={(e) => {
                const text = e.target.value;
                setAngleText(text);
                const n = Number(text);
                if (text.trim() !== "" && Number.isFinite(n)) onChange(setCropAngle(crop, normalizeAngle(n)));
              }}
              onBlur={() => setAngleText(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setAngleText(null);
              }}
              className="h-11 w-20 rounded-md border border-field-rule bg-field px-2 text-sm text-ink"
            />
            <span aria-hidden="true">°</span>
          </label>
        </div>
        </div>
      </div>
      <p id={angleNoteId} role="status" className="min-h-4 text-xs text-ink-2 empty:min-h-0">
        {angleNote}
      </p>
    </div>
  );
}

/** The lines above the photo: why it is view-only, what the source is, a pending or failed edit. */
function Notices({
  viewOnly,
  loading,
  loadFailed,
  stored,
  editsLeft,
  pending,
  busy,
  onTryAgain,
  onKeepOld,
  onRetryLoad,
  parkRef,
}: {
  /** Where focus goes when a notice's button leaves while it holds focus. */
  parkRef: (el: HTMLElement | null) => (() => void) | undefined;
  viewOnly: string | undefined;
  loading: boolean;
  loadFailed: boolean;
  stored: boolean;
  editsLeft: number | undefined;
  pending: PhotoSideSource["pending"];
  busy: boolean;
  onTryAgain?: () => void;
  onKeepOld?: () => void;
  onRetryLoad: () => void;
}) {
  const lines: ReactNode[] = [];
  if (viewOnly) lines.push(<p key="view">{viewOnly}</p>);
  else if (loading) lines.push(<p key="load">{VIEWER_WORDS.loading}</p>);
  else if (loadFailed) {
    lines.push(
      <div key="fail" className="flex flex-wrap items-center gap-2">
        <p>{VIEWER_WORDS.loadFailed}</p>
        <NeonButton ref={parkRef} type="button" variant="secondary" outline onClick={onRetryLoad} className="min-h-11">
          Open it again
        </NeonButton>
      </div>,
    );
  }
  if (stored) lines.push(<p key="stored">{VIEWER_WORDS.storedMode}</p>);
  if (editsLeft !== undefined && editsLeft <= 3) {
    lines.push(
      <p key="left">{editsLeft === 0 ? VIEWER_WORDS.outOfEdits : `${editsLeft} hand ${editsLeft === 1 ? "edit" : "edits"} left on this photo.`}</p>,
    );
  }
  const failed = pending?.status === "failed";
  // Always on the page, so an edit that fails (or starts rendering) while the viewer is open is announced.
  lines.push(
    <div
      key="pending"
      className={
        failed
          ? "flex flex-wrap items-center gap-2 rounded-md border border-notice-warn-rule bg-notice-warn-bg px-3 py-2 text-notice-warn-ink"
          : "flex flex-wrap items-center gap-2"
      }
      data-viewer-pending={pending?.status}
    >
      <p role="status" className="empty:hidden">
        {pendingWords(pending)}
      </p>
      {pending && (
        <>
        {failed && onTryAgain && (
          <NeonButton
            ref={parkRef}
            type="button"
            variant="primary"
            outline
            onClick={onTryAgain}
            aria-disabled={busy || undefined}
            className="min-h-11"
          >
            Try again
          </NeonButton>
        )}
        {failed && onKeepOld && (
          <NeonButton ref={parkRef} type="button" variant="secondary" outline onClick={onKeepOld} className="min-h-11">
            {VIEWER_WORDS.keepOld}
          </NeonButton>
        )}
        </>
      )}
    </div>,
  );
  const quiet = lines.length === 1 && !pending;
  return <div className={`flex flex-col gap-1 px-4 text-sm text-ink-2 ${quiet ? "" : "pt-3"}`}>{lines}</div>;
}

/** Re-exported for a surface that only needs the words. */
export { SIDE_WORD };
export type { EditableStart, EditStart };
