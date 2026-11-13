/**
 * NEO-481 — the viewer on a scan, ready to mount: reads the scan's source and
 * renders `CardPhotoViewer`. Mount it only while open, so a grid of tiles
 * holds no viewer subscriptions.
 */

import CardPhotoViewer from "./CardPhotoViewer";
import { useScanPhotoSource, type ScanSideInput } from "./convexEdits";
import type { ViewerSide } from "./types";

export default function ScanPhotoViewer({
  jobId,
  label,
  front,
  back,
  viewOnly,
  initialSide = "front",
  onClose,
}: {
  jobId: string;
  /** What the photos are of: the card's name, or the tile's label. */
  label: string;
  front?: ScanSideInput;
  back?: ScanSideInput;
  /** Opens view-only with this reason (`ON_THE_WAY_REASON` for a saved pair still attaching). */
  viewOnly?: string;
  initialSide?: ViewerSide;
  onClose: () => void;
}) {
  const source = useScanPhotoSource({ jobId, label, front, back, viewOnly });
  return <CardPhotoViewer source={source} initialSide={initialSide} onClose={onClose} />;
}
