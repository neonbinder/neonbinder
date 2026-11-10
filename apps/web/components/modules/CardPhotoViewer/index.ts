/**
 * NEO-481 — the card photo viewer (turn, crop by hand) and its adapters.
 *
 * - `CardPhotoViewer`: the dialog, given any `PhotoSource`.
 * - `ScanPhotoViewer`: the dialog on a scan (Add cards).
 * - `usePhotoViewer`: open from a photo button; focus goes back to it.
 * - `CardPhoto`: a tile's picture, with the preview and "Touching it up…" while an edit renders.
 * - `heldPhotoSource`, `viewOnlySource`, `numbersOnlySide`, `redrawnSide`: the server-free sources.
 */

export { default as CardPhotoViewer, VIEWER_WORDS } from "./CardPhotoViewer";
export { default as ScanPhotoViewer } from "./ScanPhotoViewer";
export { PHOTO_OPENER_ATTR, photoOpenerProps, usePhotoViewer, type PhotoOpenerReturn } from "./usePhotoViewer";
export { CardPhoto, EditedImage, pendingWords } from "./EditedPhoto";
export {
  HELD_REASON,
  ON_THE_WAY_REASON,
  heldPhotoSource,
  measureImage,
  numbersOnlySide,
  redrawnSide,
  viewOnlySource,
} from "./sources";
export { copyPreviewKey, scanPreviewKey, useScanPhotoSource, type ScanImageFacts, type ScanSideInput } from "./convexEdits";
export type { EditableStart, EditStart, PhotoSideSource, PhotoSource, ViewerSide } from "./types";
