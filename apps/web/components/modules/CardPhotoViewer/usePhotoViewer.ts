/**
 * NEO-481 — opening the viewer from a photo button, and putting focus back on
 * that button when it closes.
 *
 * The Overlay already returns focus to whatever held it when it opened, but a
 * click does not focus a button in Safari, so that can be the page itself.
 * This keeps the button that was pressed and focuses it after the viewer has
 * gone.
 *
 * A button can leave the page while the viewer is open (an Add cards tile
 * moves to another lane). For that, `open` takes a stable `key`, put on the
 * button as `data-photo-opener={key}` (`photoOpenerProps(key)`): on close,
 * the button now carrying that key gets focus. Failing that, `fallback` (an
 * element, or a function that finds one: a lane heading) does. Neither one
 * there: focus stays where the Overlay left it.
 *
 *   const viewer = usePhotoViewer();
 *   <button {...photoOpenerProps(tileKey)} onClick={(e) => viewer.open("front", e.currentTarget, { key: tileKey, fallback: () => laneHeading.current })}>…</button>
 *   {viewer.side && <CardPhotoViewer source={…} initialSide={viewer.side} onClose={viewer.close} />}
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerSide } from "./types";

/** The attribute a re-findable opener carries. */
export const PHOTO_OPENER_ATTR = "data-photo-opener";

/** Spread on a photo button so the viewer can find it again by `key` after it moved. */
export function photoOpenerProps(key: string): { "data-photo-opener": string } {
  return { [PHOTO_OPENER_ATTR]: key } as { "data-photo-opener": string };
}

export interface PhotoOpenerReturn {
  /** The opener's stable key: on close, `[data-photo-opener="<key>"]` is focused if the opener itself has gone. */
  key?: string;
  /** Focused when neither the opener nor a keyed replacement is on the page. */
  fallback?: HTMLElement | null | (() => HTMLElement | null | undefined);
}

/** Can this element take focus back: on the page and not under an inert layer. */
const focusable = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && !el.closest("[inert]");

function findByKey(key: string | undefined): HTMLElement | null {
  if (!key) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLElement>(`[${PHOTO_OPENER_ATTR}="${escaped}"]`);
}

export function usePhotoViewer() {
  const [side, setSide] = useState<ViewerSide | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const back = useRef<PhotoOpenerReturn>({});
  const restore = useRef(false);

  const open = useCallback((which: ViewerSide, from?: HTMLElement | null, returnTo: PhotoOpenerReturn = {}) => {
    opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    back.current = returnTo;
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
    const { key, fallback } = back.current;
    const el = opener.current;
    opener.current = null;
    back.current = {};
    const fall = typeof fallback === "function" ? fallback() : fallback;
    const target = [el, findByKey(key), fall].find(focusable);
    target?.focus({ preventScroll: true });
  }, [side]);

  return { side, open, close };
}
