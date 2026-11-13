/**
 * NEO-481 — the `PhotoSource` adapters that need no server: a held photo
 * (view-only), a picture whose edits are kept as numbers (the Add cards demo)
 * and a picture re-drawn in the browser (the collection demo).
 */

import { NO_EDIT, type PhotoEdit } from "@/lib/photo-edit/geometry";
import { renderEdit } from "./canvasRender";
import type { EditStart, PhotoSideSource, PhotoSource, ViewerSide } from "./types";

/** Said on a photo that is only picked, not yet uploaded (the Add form, Request a card). */
export const HELD_REASON = "Add the card first, then you can turn or crop it.";
/** Said on a saved pair whose scans are still being copied onto its line. */
export const ON_THE_WAY_REASON = "Photos are on their way.";

/** A picture's natural size, read by loading it. Rejects when it will not load. */
export function measureImage(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth > 0 ? resolve({ w: img.naturalWidth, h: img.naturalHeight }) : reject(new Error("empty image")));
    img.onerror = () => reject(new Error("That photo didn't load."));
    img.src = url;
  });
}

/** Photos that can be looked at but not edited, with the reason said in the viewer. */
export function viewOnlySource(
  label: string,
  urls: Partial<Record<ViewerSide, string>>,
  reason: string,
  keyPrefix = "view",
): PhotoSource {
  const side = (s: ViewerSide): PhotoSideSource | undefined =>
    urls[s] ? { imageUrl: urls[s], previewKey: `${keyPrefix}:${s}`, viewOnly: reason } : undefined;
  return { label, front: side("front"), back: side("back") };
}

/** A held photo (picked, not uploaded): view-only until the card is added. */
export function heldPhotoSource(label: string, urls: Partial<Record<ViewerSide, string>>): PhotoSource {
  return viewOnlySource(label, urls, HELD_REASON, "held");
}

/**
 * A picture whose edit is kept as numbers and drawn over it (the Add cards
 * demo). Every edit starts from the untouched picture, so nothing compounds;
 * `onSave` keeps the new numbers wherever the caller keeps them.
 */
export function numbersOnlySide({
  imageUrl,
  edit,
  previewKey,
  onSave,
}: {
  imageUrl: string;
  edit: PhotoEdit | undefined;
  previewKey: string;
  onSave: (edit: PhotoEdit) => void;
}): PhotoSideSource {
  return {
    imageUrl,
    previewKey,
    ...(edit ? { shown: edit } : {}),
    async load(): Promise<EditStart> {
      const { w, h } = await measureImage(imageUrl);
      return { mode: "original", sourceUrl: imageUrl, srcW: w, srcH: h, opening: edit ?? NO_EDIT, reset: NO_EDIT };
    },
    async save(next) {
      onSave(next);
    },
  };
}

/**
 * A picture re-drawn in the browser on every save (the collection demo's
 * copy photos, which only ever live on the page). Like a stored photo, each
 * edit starts from the current picture, so a crop can only trim it.
 * `onSave` gets the new picture and its thumbnail.
 */
export function redrawnSide({
  imageUrl,
  previewKey,
  onSave,
}: {
  imageUrl: string;
  previewKey: string;
  onSave: (image: Blob, thumb: Blob) => void | Promise<void>;
}): PhotoSideSource {
  return {
    imageUrl,
    previewKey,
    async load(): Promise<EditStart> {
      const { w, h } = await measureImage(imageUrl);
      return { mode: "stored", sourceUrl: imageUrl, srcW: w, srcH: h, opening: NO_EDIT, reset: NO_EDIT };
    },
    async save(edit) {
      const { image, thumb } = await renderEdit(imageUrl, edit);
      await onSave(image, thumb);
    },
  };
}
