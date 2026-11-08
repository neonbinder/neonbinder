import { useEffect, useRef } from "react";
import type { Scope } from "@sentry/react";
import { LoadingLine } from "./lazy-routes";

/**
 * NEO-434 — a tab left open across a deploy asks for a hashed chunk that no
 * longer exists. The rejected import reaches the top-level error boundary, so
 * the recovery lives there: the app has already crashed by then, and the reload
 * lands on the same URL. It is deliberately NOT a `vite:preloadError` listener.
 * That event also fires for a background prefetch (PrefetchBinderTabs, the demo
 * warm-ups), which must never pull the page out from under someone mid-form.
 */

/** Chrome, Firefox, Safari, and Vite's own preload helper for a chunk's CSS. */
const CHUNK_LOAD_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css for/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && CHUNK_LOAD_FAILURE.test(message);
}

export const CHUNK_RELOAD_GUARD_KEY = "neonbinder.chunkReloadAt";

/**
 * Long enough that a reload on a slow connection still falls inside it (the new
 * page has to load and hit the same failure), so a chunk that is really gone
 * shows the message instead of looping. Short enough that the next deploy in the
 * same tab gets a reload of its own. Worst case, a chunk that never comes back
 * costs one automatic reload per window.
 */
export const CHUNK_RELOAD_WINDOW_MS = 5 * 60 * 1000;

/** Records the reload. False if one ran inside the window, or the guard cannot be kept. */
function claimReload(): boolean {
  try {
    const storage = window.sessionStorage;
    const now = Date.now();
    const elapsed = now - Number(storage.getItem(CHUNK_RELOAD_GUARD_KEY));
    // A negative gap is a clock that moved; a guard that can only expire when
    // the clock catches up is no use to anyone.
    if (elapsed >= 0 && elapsed < CHUNK_RELOAD_WINDOW_MS) return false;
    storage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    // No guard means a possible loop, so no reload.
    return false;
  }
}

type ChunkRecovery = "reload" | "gave-up";

const recoveries = new WeakMap<object, ChunkRecovery>();

/**
 * What to do about this error; null when it is not a chunk failure. Decided once
 * per error, because beforeCapture and the fallback both ask and StrictMode
 * renders the fallback twice: a second claim would read the first as a loop.
 */
export function chunkRecovery(error: unknown): ChunkRecovery | null {
  if (!isChunkLoadError(error)) return null;
  const key = error as object;
  let recovery = recoveries.get(key);
  if (!recovery) {
    recovery = claimReload() ? "reload" : "gave-up";
    recoveries.set(key, recovery);
  }
  return recovery;
}

/** A failure the reload recovers should not read as an error in Sentry. */
function markChunkReload(scope: Scope, error: unknown) {
  const recovery = chunkRecovery(error);
  if (recovery === "reload") {
    scope.setLevel("warning");
    scope.setTag("chunk_reload", "recovering");
  } else if (recovery === "gave-up") {
    scope.setTag("chunk_reload", "gave_up");
  }
}

function AppCrashFallback({ error }: { error: unknown }) {
  const reloading = chunkRecovery(error) === "reload";
  const reloaded = useRef(false);
  const message = useRef<HTMLDivElement>(null);
  // An effect, not componentDidCatch: by now the crashed page's cleanups have
  // run, so a form's leave guard cannot ask the visitor to confirm this reload.
  // The ref is for StrictMode, which runs the effect twice.
  useEffect(() => {
    if (!reloading) {
      // Whatever held focus went with the app, so the message takes it.
      message.current?.focus();
    } else if (!reloaded.current) {
      reloaded.current = true;
      window.location.reload();
    }
  }, [reloading]);
  // The router, header and page landmark are gone, so this brings its own.
  return (
    <main className="p-4">
      {reloading ? (
        <LoadingLine />
      ) : (
        <div ref={message} role="alert" tabIndex={-1} className="outline-none">
          An error occurred. Please refresh the page.
        </div>
      )}
    </main>
  );
}

/** The top-level boundary's options, for Sentry.withErrorBoundary in main.tsx. */
export const APP_BOUNDARY_OPTIONS = {
  fallback: AppCrashFallback,
  beforeCapture: markChunkReload,
};
