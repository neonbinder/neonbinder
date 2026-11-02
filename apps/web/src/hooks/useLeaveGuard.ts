import { useEffect, useRef } from "react";

/**
 * Asks before the user leaves the page while `active` (NEO-370: photo intake
 * after "Done adding photos", until every column but Saved is clear).
 *
 * The app runs React Router in declarative mode (`<BrowserRouter>`), where
 * `useBlocker` and `usePrompt` do not exist (they need a data router), and
 * nothing else in the app guarded in-app navigation before this. So this is
 * the lightest guard that covers the three ways out, without swapping the
 * router:
 *
 *   1. Closing or reloading the tab: `beforeunload`. The browser shows its
 *      own words; the text is not settable.
 *   2. An in-app link (the nav, the page's tab strip, any router `<Link>`): a
 *      capture-phase click on `document` runs before React's own handler, so
 *      a "Stay" stops the router `<Link>` from ever navigating. Only a plain
 *      left click on a same-origin link that changes the URL is asked about;
 *      a new tab (modifier key, `target`, `download`) leaves the page in place.
 *   3. Browser Back or Forward: `popstate` cannot be cancelled, so a "Stay"
 *      steps history straight back to where the user was (React Router keeps
 *      each entry's index in `history.state.idx`). The page they tried to
 *      leave for may flash for a frame; the caller keeps whatever it guards
 *      outside component state, so the remount comes back the same.
 *
 * A navigation done in code (`navigate()`) is not asked about: those are the
 * page's own moves, and it knows when it is guarding.
 *
 * After a Back/Forward "Stay", focus would be left on the document (the page
 * may even have remounted). `onStay` parks it on a stable target: it runs on
 * the first commit of the guarding component once history is back where the
 * user was, whether the component survived the round trip or remounted, and
 * again on later commits until it answers `true` (its target may not be drawn
 * yet while the remounted page loads). A Stay not settled within
 * `STAY_FOCUS_WINDOW_MS` is dropped.
 */
export function useLeaveGuard(
  active: boolean,
  message: string,
  options: { onStay?: () => boolean } = {},
): void {
  const messageRef = useRef(message);
  const onStayRef = useRef(options.onStay);
  useEffect(() => {
    messageRef.current = message;
    onStayRef.current = options.onStay;
  });

  // Every commit: a Stay waiting to put focus back, once history is back.
  useEffect(() => {
    const pending = stayPending;
    if (!pending) return;
    if (Date.now() - pending.at > STAY_FOCUS_WINDOW_MS) {
      stayPending = null;
      return;
    }
    if (indexOf(window.history.state) !== pending.idx) return;
    if (onStayRef.current?.() !== false) stayPending = null;
  });

  useEffect(() => {
    if (!active) return;
    const ask = () => window.confirm(messageRef.current);

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need a returnValue to show the prompt.
      event.returnValue = "";
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const to = new URL(anchor.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (ask()) return;
      event.preventDefault();
      event.stopPropagation();
    };

    // Where the user is now, by React Router's history index.
    let here = indexOf(window.history.state);
    let restoring = false;
    const onPopState = (event: PopStateEvent) => {
      const to = indexOf(event.state);
      if (restoring) {
        restoring = false;
        here = to;
        return;
      }
      if (here === null || to === null || to === here || ask()) {
        here = to;
        return;
      }
      restoring = true;
      stayPending = { at: Date.now(), idx: here };
      window.history.go(here - to);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [active]);
}

/** How long a Stay waits for the page to come back before its focus move is dropped. */
export const STAY_FOCUS_WINDOW_MS = 2_000;

/**
 * A Back/Forward "Stay" whose focus move has not happened yet: when, and the
 * history index it restores. Module state, because the guarding component
 * may unmount and remount on the round trip.
 */
let stayPending: { at: number; idx: number } | null = null;

function indexOf(state: unknown): number | null {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : null;
}
