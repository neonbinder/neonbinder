/**
 * NEO-481 — the page's memory of what each saved edit should look like while
 * its new file renders.
 *
 * A save is accepted at once and rendered in the background (cold, that can
 * take half a minute). Meanwhile the tile and the viewer draw the edit from
 * the picture the tools used, so the collector sees the turn or crop straight
 * away. That picture (a scan's original, or the stored photo) is only known
 * to the viewer that made the edit, so it is kept here, by photo, for the
 * life of the page. A reload forgets it: the tile then shows the old photo
 * with "Touching it up…" until the new one lands, never a wrong picture.
 *
 * Nothing here is ever saved; the server's file is the truth.
 */

import { useSyncExternalStore } from "react";
import { editsEqual, type PhotoEdit } from "@/lib/photo-edit/geometry";

export interface EditPreview {
  edit: PhotoEdit;
  sourceUrl: string;
  srcW: number;
  srcH: number;
}

const previews = new Map<string, EditPreview>();
const listeners = new Set<() => void>();

/** Remember how `key`'s saved edit looks, until its file lands. */
export function rememberPreview(key: string, preview: EditPreview): void {
  previews.set(key, preview);
  for (const l of listeners) l();
}

/** Forget `key`'s preview (its file landed, or the edit was dropped). */
export function forgetPreview(key: string): void {
  if (!previews.delete(key)) return;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The preview for this photo's pending edit, or undefined: none remembered,
 * no edit pending, or a preview of some OTHER edit (a second tab saved a
 * different one), which would show the wrong picture.
 */
export function usePreview(key: string | undefined, pending: PhotoEdit | undefined): EditPreview | undefined {
  const preview = useSyncExternalStore(
    subscribe,
    () => (key ? previews.get(key) : undefined),
    () => undefined,
  );
  if (!preview || !pending) return undefined;
  return editsEqual(preview.edit, pending) ? preview : undefined;
}

/** For tests: start each one with an empty memory. */
export function resetPreviewsForTest(): void {
  previews.clear();
  for (const l of listeners) l();
}
