/**
 * NEO-481 — what the card photo viewer needs from wherever a photo lives.
 *
 * Every surface that shows a card photo builds one `PhotoSource` and hands it
 * to `CardPhotoViewer`. The viewer never knows whether the photo is a scan,
 * a saved copy's photo, a picked file or a demo picture: an adapter answers
 * these questions for it (`./sources.ts`, `./scanSource.ts`, the collection
 * stores' `usePhotoSource`).
 */

import type { PendingPhotoEdit, PhotoEdit } from "@/lib/photo-edit/geometry";

export type ViewerSide = "front" | "back";

/** Where an edit starts from, read when the viewer opens a side. */
export type EditStart = EditableStart | { mode: "viewOnly"; reason: string };

export interface EditableStart {
  /**
   * `original`: the scan's full original, so the box can go anywhere and every
   * edit re-renders from it. `stored`: the kept listing photo, so a crop can
   * only trim what is there.
   */
  mode: "original" | "stored";
  /** The picture the tools draw on (full size). */
  sourceUrl: string;
  srcW: number;
  srcH: number;
  /** What the tools open on: the last hand edit, else the auto crop and the scan's turn. */
  opening: PhotoEdit;
  /** What Start over goes back to: the auto crop, else the whole frame. */
  reset: PhotoEdit;
  /**
   * True when the photo has no auto crop (the cropper declined it, or the
   * picture came already cropped), so the tools open on the whole frame.
   */
  noAutoCrop?: boolean;
  /** Hand edits left on this photo, when the server counts them. */
  editsLeft?: number;
  /** The adapter's own race guard (a scan's version, a photo's token), handed back to `save` untouched. */
  guard?: unknown;
}

export interface PhotoSideSource {
  /** The photo as it stands now, full size; undefined while its address is being fetched. */
  imageUrl: string | undefined;
  /** Its address could not be fetched (the file is gone): the viewer shows "Image unavailable", never a wait. */
  imageFailed?: boolean;
  /**
   * Show `imageUrl` with this edit drawn over it, not as it is: a picture whose
   * edits are kept as numbers only (the Add cards demo). Absent everywhere a
   * real file is made.
   */
  shown?: PhotoEdit;
  /** This photo, for the local preview memory (`./previewStore.ts`): the same key on its tile. */
  previewKey: string;
  /** An edit saved and still rendering, or one whose render failed. The photo shown is the old one. */
  pending?: PendingPhotoEdit;
  /** Why this side opens view-only, decided without asking anything (a held photo, one on its way). */
  viewOnly?: string;
  /** Reads where an edit starts; the server also warms the renderer on it. Absent = view-only. */
  load?(): Promise<EditStart>;
  /** Hands the edit over. Resolves as soon as it is accepted; the new file lands later (`pending`). */
  save?(edit: PhotoEdit, start: EditableStart): Promise<void>;
  /**
   * Puts back the photo from before the last edit. Absent: a scan's Undo is a
   * save of the edit it had before, which the viewer does itself.
   */
  undo?(): Promise<void>;
  /** Clears a failed edit's note, keeping the old photo. */
  dismissFailure?(): Promise<void>;
}

export interface PhotoSource {
  /** What the photos are of, for the heading: "Front of <label>". */
  label: string;
  front?: PhotoSideSource;
  back?: PhotoSideSource;
}
