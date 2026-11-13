/**
 * NEO-481 — the page's memory of what each saved edit should look like while
 * its new file renders.
 *
 * A save is accepted at once and rendered in the background (cold, that can
 * take half a minute). Meanwhile the tile and the viewer draw the edit from
 * the picture the tools used, so the collector sees the turn or crop straight
 * away. That picture (a scan's original, or the stored photo) is only known
 * to the viewer that made the edit, so it is kept here, by photo, for the
 * life of the page and the signed-in user (`keepPreviewsFor`). A reload forgets it: the tile then shows the old photo
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

/** Whose previews these are: unset until Clerk has loaded, null when signed out. */
let owner: string | null | undefined;

/**
 * The signed-in user changed (or signed out): forget every preview. Each one
 * holds a signed URL to the last user's picture, which must not wait in this
 * page for the next person on the browser. Run from above the signed-in
 * layout (`PreviewOwner`), like the held-photo store's `keepHeldFor`.
 */
export function keepPreviewsFor(userId: string | null | undefined): void {
  const next = userId ?? null;
  if (owner !== undefined && owner === next) return;
  owner = next;
  if (previews.size === 0) return;
  previews.clear();
  for (const l of listeners) l();
}

/** For tests: how many previews are remembered. */
export function previewCountForTest(): number {
  return previews.size;
}

/** For tests: start each one with an empty memory and no owner. */
export function resetPreviewsForTest(): void {
  previews.clear();
  owner = undefined;
  for (const l of listeners) l();
}
