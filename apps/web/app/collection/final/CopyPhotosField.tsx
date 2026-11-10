/**
 * NEO-377, NEO-431 — the one photo box: the front and the back side by side,
 * each with Add (or Replace) and Remove. A photo opens the card photo viewer
 * (NEO-481): a saved one can be turned and cropped there, a held one is only
 * on this page, so it opens view-only. Three places show it: a line's Edit form, the drawer's Add form and Request
 * a card. It looks and behaves the same in all three; what differs is when a
 * photo saves.
 *
 * - `CopyPhotosField` (live): there is a copy to save against, so a photo saves
 *   as soon as it is picked. The form's Save and Cancel are for the rest of the
 *   line. The file is resized in the browser (`resizeCopyPhoto`); only the
 *   listing-sized copy and a thumbnail are saved.
 * - `HeldPhotosField` (held): nothing to save against yet, so the picked files
 *   wait in the parent's state, shown from object URLs, and nothing uploads
 *   until the parent's form is submitted.
 *
 * Drag and drop: drop photo files on the box (the first is the front, the
 * second the back) or on one side to put it there; drag one photo onto the
 * other to swap them. Swap front and back does the same from the keyboard.
 */

import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { COPY_PHOTO_ACCEPT } from "@/lib/collection/copy-photo-resize";
import CardPhotoViewer from "@/components/modules/CardPhotoViewer/CardPhotoViewer";
import { CardPhoto } from "@/components/modules/CardPhotoViewer/EditedPhoto";
import { copyPreviewKey } from "@/components/modules/CardPhotoViewer/convexEdits";
import { heldPhotoSource, viewOnlySource } from "@/components/modules/CardPhotoViewer/sources";
import type { PhotoSource } from "@/components/modules/CardPhotoViewer/types";
import { usePhotoViewer } from "@/components/modules/CardPhotoViewer/usePhotoViewer";
import { QUIET_BUTTON } from "../prototypes/p1/ui";
import { useCopyPhotos, writeErrorMessage, type CopyPhotosExtension } from "./data/store";
import type { Copy, CopyPhotos, PhotoSide } from "./data/types";

export const PHOTO_SIDES: readonly PhotoSide[] = ["front", "back"];
const SIDE_WORD: Record<PhotoSide, string> = { front: "Front", back: "Back" };
const DIMMED = "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
const TILE_IMAGE = "aspect-[5/7] w-full rounded-sm border border-rule object-contain text-xs text-ink-3";
/** The drag payload of one photo tile, so a drop can tell a swap from a file. */
const SIDE_DRAG = "application/x-neonbinder-photo-side";
const NOT_A_PHOTO = "Only photos can be added here.";
/** What a drop lets through. An empty type is a file the browser can't name: a later step decides. */
const looksLikePhoto = (file: File) => file.type.startsWith("image/") || file.type === "";
const HOLDABLE_TYPES = new Set(COPY_PHOTO_ACCEPT.split(","));
/** What the box holds by default: the types a photo can be saved from, or a type the browser can't name. */
const notHoldable = (file: File) => (file.type === "" || HOLDABLE_TYPES.has(file.type) ? null : NOT_A_PHOTO);

const THUMB = "aspect-[5/7] h-12 w-auto shrink-0 rounded-sm border border-rule object-contain";

/**
 * A line's front thumbnail beside its words, when it has one. With the line's
 * `copy` it is a button that opens the card photo viewer (NEO-481) on that
 * side; `card` names the card in the viewer's heading.
 */
export function LineThumb({
  photos,
  line,
  copy,
  card,
}: {
  photos: CopyPhotos | undefined;
  line: string;
  copy?: Copy;
  card?: string;
}) {
  const ext = useCopyPhotos();
  const viewer = usePhotoViewer();
  const stateId = useId();
  const side: PhotoSide = photos?.front ? "front" : "back";
  const shown = photos?.[side];
  if (!shown) return null;
  const picture = (
    <CardPhoto
      src={shown.thumbUrl}
      alt={`${SIDE_WORD[side]} of ${line}`}
      className={THUMB}
      pending={shown.pending}
      previewKey={copy ? copyPreviewKey(copy.id, side) : undefined}
      chip={false}
      chipId={copy ? stateId : undefined}
      loading="lazy"
    />
  );
  if (!copy) return picture;
  return (
    <>
      <button
        type="button"
        className="shrink-0 rounded-sm focus-outline max-sm:min-h-11"
        aria-label={`Open photos of ${line}`}
        aria-describedby={shown.pending ? stateId : undefined}
        data-copy-photo-open={copy.id}
        onClick={(e) => viewer.open(side, e.currentTarget)}
      >
        {picture}
      </button>
      {viewer.side && (
        <LinePhotoViewer copy={copy} label={card ?? line} photos={photos} ext={ext} side={viewer.side} onClose={viewer.close} />
      )}
    </>
  );
}

/** A line's photos when the store has no viewer source: look, no edits. */
function useViewOnlyLine(_copy: Copy, label: string, photos: CopyPhotos | undefined): PhotoSource {
  return viewOnlySource(label, { front: photos?.front?.imageUrl, back: photos?.back?.imageUrl }, "These photos can't be turned or cropped here.");
}

/** The viewer on one line's photos, mounted only while open (its source is a hook). */
function LinePhotoViewer({
  copy,
  label,
  photos,
  ext,
  side,
  onClose,
}: {
  copy: Copy;
  label: string;
  photos: CopyPhotos | undefined;
  ext: CopyPhotosExtension | undefined;
  side: PhotoSide;
  onClose: () => void;
}) {
  // A store either has a viewer source or it does not, for its whole life: the hook order never changes.
  const usePhotoSourceOf = ext?.usePhotoSource ?? useViewOnlyLine;
  const source = usePhotoSourceOf(copy, label, photos);
  return <CardPhotoViewer source={source} initialSide={side} onClose={onClose} />;
}

/** Which side each dropped file goes to: one on a side goes there; otherwise front, then back. */
export function sidesForDrop(count: number, onto: PhotoSide | null, photos: CopyPhotos | undefined): PhotoSide[] {
  if (count === 0) return [];
  if (count === 1) {
    if (onto) return [onto];
    return [photos?.front && !photos.back ? "back" : "front"];
  }
  return ["front", "back"];
}

interface PickedPhoto {
  side: PhotoSide;
  file: File;
}

/**
 * The box itself: what it shows and what the collector can do, with no opinion
 * on when a photo saves. The two wrappers below supply that.
 */
function PhotosBox({
  boxId,
  line,
  photos,
  accept,
  help,
  busy,
  status,
  error,
  ownAlert = true,
  onOpen,
  previewKeyOf,
  className = "mt-4",
  onPut,
  onRemove,
  onSwap,
  onRefuse,
}: {
  /** This box, in a drag's payload: a photo dragged from any other box does nothing here. */
  boxId: string;
  /** What the photos are of ("Raw, Mint ×3"), for their names. */
  line: string;
  photos: CopyPhotos | undefined;
  /** The file picker's types. Each caller keeps its own. */
  accept: string;
  /** The help line's first sentence: when these photos save. */
  help: string;
  busy: boolean;
  status: string;
  error: string | null;
  /** False when the form has its own alert and `onRefuse` goes there: nothing would ever be said in this one. */
  ownAlert?: boolean;
  /** A photo's tile opens the card photo viewer on that side (NEO-481); `from` gets focus back. */
  onOpen: (side: PhotoSide, from: HTMLElement) => void;
  /** A side's key in the viewer's preview memory, so a tile shows an edit still rendering. */
  previewKeyOf?: (side: PhotoSide) => string;
  className?: string;
  onPut: (picked: readonly PickedPhoto[]) => void;
  /** `done` parks the keyboard: Remove unmounts itself. */
  onRemove: (side: PhotoSide, done: () => void) => void;
  onSwap: () => void;
  /** Says why a file or a move was turned away. */
  onRefuse: (message: string) => void;
}) {
  const headingId = useId();
  const helpId = useId();
  /** A tile's pending-edit words, its button's description (the aria-label hides them). */
  const tileStateId = useId();
  const [over, setOver] = useState<PhotoSide | "box" | null>(null);
  const inputs = useRef<Record<PhotoSide, HTMLInputElement | null>>({ front: null, back: null });
  const addRefs = useRef<Record<PhotoSide, HTMLButtonElement | null>>({ front: null, back: null });
  const hasAny = !!(photos?.front || photos?.back);

  /** These files on these sides. */
  const put = (files: readonly File[], sides: readonly PhotoSide[]) => {
    const picked = sides.slice(0, files.length).map((side, i) => ({ side, file: files[i] }));
    if (picked.length === 0) return;
    if (busy) {
      // Never drop a photo silently.
      onRefuse("Still saving the last photo. Add this one again in a moment.");
      return;
    }
    onPut(picked);
  };

  const swap = () => {
    if (busy || !hasAny) return;
    onSwap();
  };

  const dragOver = (e: DragEvent, target: PhotoSide | "box") => {
    const types = Array.from(e.dataTransfer.types);
    const isSwap = types.includes(SIDE_DRAG);
    if (!isSwap && !types.includes("Files")) return;
    // A photo dropped back on its own box (not a side) does nothing.
    if (isSwap && target === "box") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isSwap ? "move" : "copy";
    setOver(target);
  };

  const drop = (e: DragEvent, target: PhotoSide | "box") => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const dragged = e.dataTransfer.getData(SIDE_DRAG);
    if (dragged) {
      // Only a photo of THIS box swaps; one dragged from another line does nothing.
      const [fromBox, from] = dragged.split("|");
      if (fromBox === boxId && target !== "box" && from !== target) {
        if (busy) onRefuse("Still saving the last photo. Swap them again in a moment.");
        else swap();
      }
      return;
    }
    const dropped = Array.from(e.dataTransfer.files);
    const files = dropped.filter(looksLikePhoto);
    if (files.length === 0) {
      if (dropped.length > 0) onRefuse(NOT_A_PHOTO);
      return;
    }
    // Never drop a file silently: say what was left out, then save the rest.
    const skipped =
      files.length < dropped.length
        ? "Only photos can be added here; the other files were left out."
        : files.length > 2
          ? "Two photos at most, the front and the back; the others were left out."
          : null;
    put(files, sidesForDrop(files.length, target === "box" ? null : target, photos));
    if (skipped && !busy) onRefuse(skipped);
  };

  /** A photo's tile, dragged onto the other side to swap them. */
  const dragTile = (side: PhotoSide) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      // Not the photo's own address: its URL never leaves the page in a drag.
      e.dataTransfer.clearData();
      e.dataTransfer.setData(SIDE_DRAG, `${boxId}|${side}`);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => setOver(null),
  });

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={helpId}
      onDragOver={(e) => dragOver(e, "box")}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      }}
      onDrop={(e) => drop(e, "box")}
      className={`${className} rounded-md p-3 ${
        over !== null ? "border-2 border-solid border-selection bg-pick-blue/20" : "border border-dashed border-control"
      }`}
      data-copy-photos-field={boxId}
    >
      <h3 id={headingId} className="text-sm font-semibold text-ink">
        Photos<span className="sr-only"> of {line}</span>
      </h3>
      <p id={helpId} className="mt-0.5 text-xs text-ink-3">
        {help}
        {/* Dragging is a pointer's: on a touch screen, Add and Swap do it. */}
        <span className="[@media(pointer:coarse)]:hidden">
          {" "}
          Drop two photos here for the front and back, or drag one onto the other to swap.
        </span>
      </p>
      <div className="mt-2 grid max-w-xs grid-cols-2 gap-3">
        {PHOTO_SIDES.map((side) => {
          const shown = photos?.[side];
          const word = SIDE_WORD[side];
          return (
            <div
              key={side}
              className="min-w-0"
              onDragOver={(e) => dragOver(e, side)}
              onDrop={(e) => drop(e, side)}
              data-copy-photo-side={side}
            >
              <p className="text-xs text-ink-3">{word}</p>
              {shown ? (
                <button
                  type="button"
                  {...dragTile(side)}
                  className={`mt-1 block w-full cursor-grab rounded-sm focus-outline ${
                    over === side ? "ring-4 ring-selection" : ""
                  }`}
                  aria-label={`Open ${side} of ${line}`}
                  aria-describedby={shown.pending ? `${tileStateId}-${side}` : undefined}
                  data-copy-photo-open={side}
                  onClick={(e) => onOpen(side, e.currentTarget)}
                >
                  <CardPhoto
                    src={shown.thumbUrl}
                    // The button names it. This is for a picture the browser can't draw (a HEIC off Safari).
                    alt={`${word} of ${line}`}
                    className={TILE_IMAGE}
                    pending={shown.pending}
                    previewKey={previewKeyOf?.(side)}
                    chipId={`${tileStateId}-${side}`}
                  />
                </button>
              ) : (
                <div
                  className={`mt-1 flex aspect-[5/7] w-full items-center justify-center rounded-sm border border-dashed text-ink-3 ${
                    over === side ? "border-2 border-solid border-selection bg-pick-blue/30" : "border-rule-strong"
                  }`}
                >
                  <PhotoIcon aria-hidden className="h-8 w-8" />
                  <span className="sr-only">No {side} photo yet</span>
                </div>
              )}
              <input
                ref={(el) => {
                  inputs.current[side] = el;
                }}
                type="file"
                accept={accept}
                className="sr-only"
                // The Add / Replace button opens it; it stays out of the Tab order.
                tabIndex={-1}
                aria-label={`${word} photo file`}
                data-copy-photo-input={side}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) put([file], [side]);
                  e.target.value = "";
                }}
              />
              <div className="mt-1 flex flex-wrap gap-1">
                <button
                  ref={(el) => {
                    addRefs.current[side] = el;
                  }}
                  type="button"
                  className={`${QUIET_BUTTON} ${DIMMED} max-sm:min-h-11`}
                  aria-disabled={busy || undefined}
                  data-copy-photo-add={side}
                  onClick={() => {
                    if (!busy) inputs.current[side]?.click();
                  }}
                >
                  {shown ? `Replace ${side}` : `Add ${side}`}
                </button>
                {shown && (
                  <button
                    type="button"
                    className={`${QUIET_BUTTON} ${DIMMED} hover:text-neon-pink-text max-sm:min-h-11`}
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (busy) return;
                      onRemove(side, () => addRefs.current[side]?.focus());
                    }}
                  >
                    Remove {side}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {hasAny && (
        <button
          type="button"
          className={`${QUIET_BUTTON} ${DIMMED} mt-2 max-sm:min-h-11`}
          aria-disabled={busy || undefined}
          onClick={swap}
        >
          Swap front and back
        </button>
      )}
      <p className="mt-2 text-xs text-ink-3" role="status">
        {status}
        {PHOTO_SIDES.filter((side) => photos?.[side]?.pending?.status === "failed").map((side) => (
          <span key={side} className="block text-notice-danger-ink">
            The {side} edit didn&rsquo;t save. Open the {side} photo to try again.
          </span>
        ))}
      </p>
      {/* Mounted from the start, so a screen reader announces what lands in it. */}
      {ownAlert && (
        <p className="mt-1 min-h-4 text-xs text-neon-pink-text" role="alert">
          {error ?? ""}
        </p>
      )}
    </section>
  );
}

/** Live: an existing copy's photos, each saved as soon as it is picked. */
export default function CopyPhotosField({
  copy,
  line,
  card,
  photos,
  ext,
  initialError,
}: {
  copy: Copy;
  /** The line's name ("Raw, Mint ×3"), for the photos' names. */
  line: string;
  /** The card's name, for the photo viewer's heading; the line's name when absent. */
  card?: string;
  photos: CopyPhotos | undefined;
  ext: CopyPhotosExtension;
  /** Shown when the field opens: a photo that failed on the way in with the copy. */
  initialError?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const viewer = usePhotoViewer();

  const run = async (doing: string, done: string, work: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setStatus(doing);
    try {
      await work();
      setStatus(done);
    } catch (e) {
      setStatus("");
      setError(writeErrorMessage(e));
    } finally {
      setBusy(false);
      after?.();
    }
  };

  return (
    <>
    <PhotosBox
      boxId={copy.id}
      line={line}
      photos={photos}
      accept={COPY_PHOTO_ACCEPT}
      help="Saved as soon as you add them. Open one to turn or crop it."
      busy={busy}
      status={status}
      error={error}
      onOpen={viewer.open}
      previewKeyOf={(side) => copyPreviewKey(copy.id, side)}
      onPut={(picked) => {
        const words = picked.map((p) => p.side).join(" and ");
        const saved = picked.length > 1 ? "Front and back photos saved." : `${SIDE_WORD[picked[0].side]} photo saved.`;
        void run(`Saving the ${words} photo${picked.length > 1 ? "s" : ""}…`, saved, async () => {
          for (const p of picked) await ext.addPhoto(copy, p.side, p.file);
        });
      }}
      onRemove={(side, done) => {
        void run(`Removing the ${side} photo…`, `${SIDE_WORD[side]} photo removed.`, () => ext.removePhoto(copy, side), done);
      }}
      onSwap={() => {
        void run("Swapping the photos…", "Front and back swapped.", () => ext.swapPhotos(copy));
      }}
      onRefuse={setError}
    />
    {viewer.side && (
      <LinePhotoViewer copy={copy} label={card ?? line} photos={photos} ext={ext} side={viewer.side} onClose={viewer.close} />
    )}
    </>
  );
}

/** A file's address for this page, for as long as it is picked. */
function useObjectUrl(file: File | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  // In an effect, not a memo: StrictMode's second run would revoke a memo's URL and keep it.
  useEffect(() => {
    if (!file) return;
    const made = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is an outside resource, made and revoked with this effect
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  return file ? url : undefined;
}

/** The files `HeldPhotosField` holds for its parent: what the form uploads when it is submitted. */
export type HeldPhotos = Partial<Record<PhotoSide, File>>;

/** Held: photos with nothing to save against yet. The parent keeps the files and uploads them on submit. */
export function HeldPhotosField({
  files,
  onChange,
  line,
  accept,
  help,
  saving,
  check = notHoldable,
  onProblem,
  className,
}: {
  files: HeldPhotos;
  onChange: (files: HeldPhotos) => void;
  /** What the photos are of ("your new copy"), for their names. */
  line: string;
  accept: string;
  /** The help line's first sentence: when these photos go up. */
  help: string;
  /** Said while the form uploads them; the box takes no changes meanwhile. */
  saving?: string;
  /** Why a file can't be held, or null when it can. */
  check?: (file: File) => string | null;
  /** Where refusals go when the form has its own alert (null clears it); else the box says them. */
  onProblem?: (problem: string | null) => void;
  className?: string;
}) {
  const boxId = useId();
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const viewer = usePhotoViewer();
  const say = onProblem ?? setError;
  const frontUrl = useObjectUrl(files.front);
  const backUrl = useObjectUrl(files.back);
  const photos: CopyPhotos = {
    ...(files.front && frontUrl ? { front: { imageUrl: frontUrl, thumbUrl: frontUrl } } : {}),
    ...(files.back && backUrl ? { back: { imageUrl: backUrl, thumbUrl: backUrl } } : {}),
  };

  return (
    <>
    <PhotosBox
      boxId={boxId}
      line={line}
      photos={photos}
      accept={accept}
      help={help}
      busy={saving !== undefined}
      status={saving ?? status}
      error={error}
      ownAlert={!onProblem}
      onOpen={viewer.open}
      className={className}
      onPut={(picked) => {
        const good = picked.filter((p) => check(p.file) === null);
        const refused = picked.find((p) => check(p.file) !== null);
        say(refused ? check(refused.file) : null);
        if (good.length === 0) {
          setStatus("");
          return;
        }
        const next = { ...files };
        for (const p of good) next[p.side] = p.file;
        onChange(next);
        setStatus(good.length > 1 ? "Front and back photos picked." : `${SIDE_WORD[good[0].side]} photo picked.`);
      }}
      onRemove={(side, done) => {
        const next = { ...files };
        delete next[side];
        onChange(next);
        say(null);
        setStatus(`${SIDE_WORD[side]} photo removed.`);
        done();
      }}
      onSwap={() => {
        onChange({ ...(files.back ? { front: files.back } : {}), ...(files.front ? { back: files.front } : {}) });
        say(null);
        setStatus("Front and back swapped.");
      }}
      onRefuse={say}
    />
    {viewer.side && (
      <CardPhotoViewer
        source={heldPhotoSource(line, { front: photos.front?.imageUrl, back: photos.back?.imageUrl })}
        initialSide={viewer.side}
        onClose={viewer.close}
      />
    )}
    </>
  );
}
