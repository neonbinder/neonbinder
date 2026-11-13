/**
 * NEO-481 — a card photo as it should look: the file as it is, or an edit
 * drawn over a source picture without rendering anything.
 *
 * - `EditedImage` draws `edit` from `src` in an SVG whose view box is the
 *   output's shape, so it sizes like the `<img>` it stands in for.
 * - `CardPhoto` is what a tile shows: the file, or while an edit renders the
 *   remembered preview (`./previewStore.ts`), with a "Touching it up…" chip;
 *   a failed edit gets its own chip and the old photo.
 */

import { useEffect, useState } from "react";
import { previewGeometry, type PendingPhotoEdit, type PhotoEdit } from "@/lib/photo-edit/geometry";
import { usePreview } from "./previewStore";

/** A picture's natural size, once it has loaded; undefined until then (and where nothing loads). */
export function useNaturalSize(src: string | undefined): { w: number; h: number } | undefined {
  const [size, setSize] = useState<{ src: string; w: number; h: number } | undefined>(undefined);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const probe = new Image();
    probe.onload = () => {
      if (live && probe.naturalWidth > 0) setSize({ src, w: probe.naturalWidth, h: probe.naturalHeight });
    };
    probe.src = src;
    return () => {
      live = false;
      probe.onload = null;
    };
  }, [src]);
  return size && size.src === src ? { w: size.w, h: size.h } : undefined;
}

/** `edit` drawn from `src` (a picture `srcW` x `srcH`), shaped like its output. */
export function EditedImage({
  src,
  alt,
  edit,
  srcW,
  srcH,
  className,
}: {
  src: string;
  alt: string;
  edit: PhotoEdit;
  srcW: number;
  srcH: number;
  className?: string;
}) {
  const g = previewGeometry(edit, srcW, srcH);
  return (
    <svg
      role="img"
      aria-label={alt}
      viewBox={`0 0 ${g.viewW} ${g.viewH}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      data-photo-preview=""
    >
      <image href={src} width={srcW} height={srcH} transform={g.transform} preserveAspectRatio="none" />
    </svg>
  );
}

/** `edit` drawn from `src` once its size is known; the plain picture until then. */
function ShownImage({ src, alt, edit, className }: { src: string; alt: string; edit: PhotoEdit; className?: string }) {
  const natural = useNaturalSize(edit.crop ? undefined : src);
  const w = edit.crop?.srcW ?? natural?.w;
  const h = edit.crop?.srcH ?? natural?.h;
  if (!w || !h) return <img src={src} alt={alt} className={className} decoding="async" />;
  return <EditedImage src={src} alt={alt} edit={edit} srcW={w} srcH={h} className={className} />;
}

const CHIP = "pointer-events-none absolute inset-x-1 bottom-1 truncate rounded-sm px-1.5 py-0.5 text-center text-[0.6875rem] font-medium leading-tight shadow";

/**
 * One card photo for a tile or a line: the file, an edit kept as numbers
 * (`shown`, the demo), or the preview of an edit still rendering (`pending`).
 * `className` sizes the picture exactly as it would an `<img>`.
 */
export function CardPhoto({
  src,
  alt,
  className,
  shown,
  pending,
  previewKey,
  chip = true,
  loading,
  chipId,
  onError,
}: {
  src: string;
  alt: string;
  className?: string;
  shown?: PhotoEdit;
  pending?: PendingPhotoEdit;
  previewKey?: string;
  /** False on a tile too small for words: the chip's text is said elsewhere. */
  chip?: boolean;
  loading?: "lazy" | "eager";
  /** The file could not be drawn (gone, or its address expired). */
  onError?: () => void;
  /**
   * The id of the words for a pending edit, for an opener's `aria-describedby`
   * (its `aria-label` hides what is inside it). With `chip` false the words are
   * there for a screen reader only.
   */
  chipId?: string;
}) {
  const rendering = pending?.status === "rendering" ? pending.edit : undefined;
  const preview = usePreview(previewKey, rendering);
  const picture = preview ? (
    <EditedImage src={preview.sourceUrl} alt={alt} edit={preview.edit} srcW={preview.srcW} srcH={preview.srcH} className={className} />
  ) : shown ? (
    <ShownImage src={src} alt={alt} edit={shown} className={className} />
  ) : (
    <img src={src} alt={alt} className={className} decoding="async" loading={loading} draggable={false} onError={onError} />
  );
  if (!pending) return picture;
  const words = pending.status === "rendering" ? "Touching it up…" : "Edit didn\u2019t save";
  if (!chip) {
    if (!chipId) return picture;
    return (
      <>
        {picture}
        <span id={chipId} className="sr-only">
          {words}
        </span>
      </>
    );
  }
  return (
    <span className="relative inline-block max-w-full align-top" data-photo-pending={pending.status}>
      {picture}
      {/* An opaque ground: the chip sits over the card's own (often white) border. */}
      {pending.status === "rendering" ? (
        <span id={chipId} className={`${CHIP} bg-raised text-ink-2`}>
          {words}
        </span>
      ) : (
        <span id={chipId} className={`${CHIP} bg-raised text-notice-warn-ink ring-1 ring-notice-warn-rule`}>
          {words}
        </span>
      )}
    </span>
  );
}

/** A line of words for a photo's pending edit, for a status line or a screen reader. */
export function pendingWords(pending: PendingPhotoEdit | undefined): string {
  if (!pending) return "";
  if (pending.status === "rendering") return "Touching it up…";
  return pending.error ?? "That edit didn't save. Your old photo is still here.";
}
