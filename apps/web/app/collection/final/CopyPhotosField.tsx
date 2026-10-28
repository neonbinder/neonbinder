/**
 * NEO-377 — a copy line's photos, inside the line's Edit form: the front and
 * the back side by side, each with Add (or Replace) and Remove. A photo
 * opens full size in a new tab. Photos save as soon as they are picked; the
 * form's Save and Cancel are for the rest of the line.
 *
 * Drag and drop: drop photo files on the box (the first is the front, the
 * second the back) or on one side to put it there; drag one photo onto the
 * other to swap them. Swap front and back does the same from the keyboard.
 *
 * The file the collector picks is resized in the browser
 * (`resizeCopyPhoto`); only the listing-sized copy and a thumbnail are saved.
 */

import { useId, useRef, useState, type DragEvent } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { COPY_PHOTO_ACCEPT } from "@/lib/collection/copy-photo-resize";
import { QUIET_BUTTON } from "../prototypes/p1/ui";
import { writeErrorMessage, type CopyPhotosExtension } from "./data/store";
import type { Copy, CopyPhotos, PhotoSide } from "./data/types";

const SIDES: readonly PhotoSide[] = ["front", "back"];
const SIDE_WORD: Record<PhotoSide, string> = { front: "Front", back: "Back" };
const DIMMED = "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
/** The drag payload of one photo tile, so a drop can tell a swap from a file. */
const SIDE_DRAG = "application/x-neonbinder-photo-side";

/** A line's front thumbnail beside its words, when it has one. */
export function LineThumb({ photos, line }: { photos: CopyPhotos | undefined; line: string }) {
  const shown = photos?.front ?? photos?.back;
  if (!shown) return null;
  return (
    <img
      src={shown.thumbUrl}
      alt={`${photos?.front ? "Front" : "Back"} of ${line}`}
      className="aspect-[5/7] h-12 w-auto shrink-0 rounded-sm border border-rule object-contain"
      loading="lazy"
      decoding="async"
    />
  );
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

export default function CopyPhotosField({
  copy,
  line,
  photos,
  ext,
}: {
  copy: Copy;
  /** The line's name ("Raw, Mint ×3"), for the photos' names. */
  line: string;
  photos: CopyPhotos | undefined;
  ext: CopyPhotosExtension;
}) {
  const headingId = useId();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<PhotoSide | "box" | null>(null);
  const inputs = useRef<Record<PhotoSide, HTMLInputElement | null>>({ front: null, back: null });
  const addRefs = useRef<Record<PhotoSide, HTMLButtonElement | null>>({ front: null, back: null });
  const hasAny = !!(photos?.front || photos?.back);

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

  /** Save these files to these sides, one after the other. */
  const put = (files: readonly File[], sides: readonly PhotoSide[]) => {
    const pairs = sides.slice(0, files.length).map((side, i) => ({ side, file: files[i] }));
    if (pairs.length === 0 || busy) return;
    const words = pairs.map((p) => p.side).join(" and ");
    const saved = pairs.length > 1 ? "Front and back photos saved." : `${SIDE_WORD[pairs[0].side]} photo saved.`;
    void run(`Saving the ${words} photo${pairs.length > 1 ? "s" : ""}…`, saved, async () => {
      for (const p of pairs) await ext.addPhoto(copy, p.side, p.file);
    });
  };

  const swap = () => {
    if (busy || !hasAny) return;
    void run("Swapping the photos…", "Front and back swapped.", () => ext.swapPhotos(copy));
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
      // Only a photo of THIS line swaps; one dragged from another line does nothing.
      const [fromCopy, from] = dragged.split("|");
      if (fromCopy === copy.id && target !== "box" && from !== target) swap();
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/") || f.type === "");
    put(files, sidesForDrop(files.length, target === "box" ? null : target, photos));
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={helpId}
      onDragOver={(e) => dragOver(e, "box")}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
      }}
      onDrop={(e) => drop(e, "box")}
      className={`mt-4 rounded-md border border-dashed p-3 ${
        over === "box" ? "border-selection bg-pick-blue/10" : "border-control"
      }`}
      data-copy-photos-field={copy.id}
    >
      <h4 id={headingId} className="text-sm font-semibold text-ink">
        Photos
      </h4>
      <p id={helpId} className="mt-0.5 text-xs text-ink-3">
        Saved as soon as you add them. Drop two photos here for the front and back, or drag one onto the other to
        swap.
      </p>
      <div className="mt-2 grid max-w-xs grid-cols-2 gap-3">
        {SIDES.map((side) => {
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
                <a
                  href={shown.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  draggable
                  onDragStart={(e) => {
                    // Not the link's own address: the photo URL never leaves the page in a drag.
                    e.dataTransfer.clearData();
                    e.dataTransfer.setData(SIDE_DRAG, `${copy.id}|${side}`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setOver(null)}
                  className={`mt-1 block cursor-grab rounded-sm focus-outline ${
                    over === side ? "ring-2 ring-selection" : ""
                  }`}
                  aria-label={`${word} of ${line}, full size (opens a new tab)`}
                >
                  <img
                    src={shown.thumbUrl}
                    alt=""
                    draggable={false}
                    className="aspect-[5/7] w-full rounded-sm border border-rule object-contain"
                    decoding="async"
                  />
                </a>
              ) : (
                <div
                  className={`mt-1 flex aspect-[5/7] w-full items-center justify-center rounded-sm border border-dashed text-ink-3 ${
                    over === side ? "border-selection bg-pick-blue/10" : "border-rule-strong"
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
                accept={COPY_PHOTO_ACCEPT}
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
                      void run(
                        `Removing the ${side} photo…`,
                        `${word} photo removed.`,
                        () => ext.removePhoto(copy, side),
                        // Remove unmounts itself; park the keyboard on Add.
                        () => addRefs.current[side]?.focus(),
                      );
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
      </p>
      {error && (
        <p className="mt-1 text-xs text-neon-pink-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
