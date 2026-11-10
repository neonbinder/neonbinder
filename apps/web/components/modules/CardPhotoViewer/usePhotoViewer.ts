/**
 * NEO-481 — opening the viewer from a photo button, and putting focus back on
 * that button when it closes.
 *
 * The Overlay already returns focus to whatever held it when it opened, but a
 * click does not focus a button in Safari, so that can be the page itself.
 * This keeps the button that was pressed and focuses it after the viewer has
 * gone (if it is still on the page).
 *
 *   const viewer = usePhotoViewer();
 *   <button onClick={(e) => viewer.open("front", e.currentTarget)}>…</button>
 *   {viewer.side && <CardPhotoViewer source={…} initialSide={viewer.side} onClose={viewer.close} />}
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerSide } from "./types";

export function usePhotoViewer() {
  const [side, setSide] = useState<ViewerSide | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);

  const open = useCallback((which: ViewerSide, from?: HTMLElement | null) => {
    opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSide(which);
  }, []);

  const close = useCallback(() => {
    restore.current = true;
    setSide(null);
  }, []);

  // After the Overlay's own cleanup, so this focus is the last word.
  useEffect(() => {
    if (side !== null || !restore.current) return;
    restore.current = false;
    const el = opener.current;
    opener.current = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }, [side]);

  return { side, open, close };
}
