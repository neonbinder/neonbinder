/**
 * NEO-377 — a copy line's photos, open under the line like Move: the front
 * and the back side by side, each with Add (or Replace) and Remove. A photo
 * opens full size in a new tab. Escape closes the panel and hands the
 * keyboard back to the line's Photos button.
 *
 * The file the collector picks is resized in the browser
 * (`resizeCopyPhoto`); only the listing-sized copy and a thumbnail are saved.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { COPY_PHOTO_ACCEPT } from "@/lib/collection/copy-photo-resize";
import { QUIET_BUTTON } from "../prototypes/p1/ui";
import { writeErrorMessage, type CopyPhotosExtension } from "./data/store";
import type { Copy, CopyPhotos, PhotoSide } from "./data/types";

const SIDES: readonly PhotoSide[] = ["front", "back"];
const SIDE_WORD: Record<PhotoSide, string> = { front: "Front", back: "Back" };

/** A line's front thumbnail beside its words, when it has one. */
export function LineThumb({ photos, line }: { photos: CopyPhotos | undefined; line: string }) {
  const shown = photos?.front ?? photos?.back;
  if (!shown) return null;
  return (
    <img
      src={shown.thumbUrl}
      alt={`${photos?.front ? "Front" : "Back"} of ${line}`}
      className="h-12 w-auto shrink-0 rounded-sm border border-rule object-contain"
      loading="lazy"
      decoding="async"
    />
  );
}

export default function CopyPhotosPanel({
  copy,
  line,
  photos,
  ext,
  onClose,
}: {
  copy: Copy;
  /** The line's name ("Raw, Mint ×3"), for the panel's own name. */
  line: string;
  photos: CopyPhotos | undefined;
  ext: CopyPhotosExtension;
  onClose: () => void;
}) {
  const headingId = useId();
  const [busy, setBusy] = useState<PhotoSide | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Record<PhotoSide, HTMLInputElement | null>>({ front: null, back: null });
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const run = async (side: PhotoSide, doing: string, done: string, work: () => Promise<void>) => {
    setBusy(side);
    setError(null);
    setStatus(doing);
    try {
      await work();
      setStatus(done);
    } catch (e) {
      setStatus("");
      setError(writeErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const pick = (side: PhotoSide, file: File | undefined) => {
    if (!file) return;
    void run(side, `Saving the ${side} photo…`, `${SIDE_WORD[side]} photo saved.`, () => ext.addPhoto(copy, side, file));
  };

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className="basis-full rounded-md border border-dashed border-control bg-sheet p-3"
      data-copy-photos-panel={copy.id}
    >
      <h4 id={headingId} className="text-sm font-semibold text-ink">
        Photos of {line}
      </h4>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {SIDES.map((side, i) => {
          const shown = photos?.[side];
          const word = SIDE_WORD[side];
          return (
            <div key={side} className="min-w-0">
              <p className="text-xs text-ink-3">{word}</p>
              {shown ? (
                <a
                  href={shown.imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block rounded-sm focus-outline"
                  aria-label={`${word} of ${line}, full size (opens a new tab)`}
                >
                  <img
                    src={shown.thumbUrl}
                    alt=""
                    className="aspect-[5/7] w-full rounded-sm border border-rule object-contain"
                    decoding="async"
                  />
                </a>
              ) : (
                <div className="mt-1 flex aspect-[5/7] w-full items-center justify-center rounded-sm border border-dashed border-rule-strong text-ink-3">
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
                  pick(side, e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <div className="mt-1 flex flex-wrap gap-1">
                <button
                  ref={i === 0 ? firstRef : undefined}
                  type="button"
                  className={`${QUIET_BUTTON} max-sm:min-h-11`}
                  aria-disabled={busy !== null || undefined}
                  onClick={() => {
                    if (busy === null) inputs.current[side]?.click();
                  }}
                >
                  {shown ? `Replace ${side}` : `Add ${side}`}
                </button>
                {shown && (
                  <button
                    type="button"
                    className={`${QUIET_BUTTON} hover:text-neon-pink-text max-sm:min-h-11`}
                    aria-disabled={busy !== null || undefined}
                    onClick={() => {
                      if (busy === null) {
                        void run(side, `Removing the ${side} photo…`, `${word} photo removed.`, () =>
                          ext.removePhoto(copy, side),
                        );
                      }
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
      <p className="mt-2 text-xs text-ink-3" role="status">
        {status}
      </p>
      {error && (
        <p className="mt-1 text-xs text-neon-pink-text" role="alert">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={onClose} className={`${QUIET_BUTTON} max-sm:min-h-11`}>
          Done
        </button>
      </div>
    </section>
  );
}
