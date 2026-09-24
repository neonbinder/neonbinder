import { useEffect, useRef } from "react";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";

/**
 * A typed reference to the public warm-up action, by string (NEO-170).
 *
 * `placeholderBatch` holds the INTERNAL `warmupPreprocess` fan-out; the public
 * authenticated `warmPreprocess` wrapper lives in `placeholderPipeline` (a
 * default-runtime module — the wrapper only schedules the fan-out, so it must
 * not pay `placeholderBatch`'s Node cold-start on every client call). It is not
 * in the generated `api` types yet (codegen is a concurrent backend step, never
 * run in this worktree), so it is named directly rather than reached through
 * `any`.
 */
const warmPreprocessRef = makeFunctionReference<
  "action",
  Record<string, never>,
  unknown
>("placeholderPipeline:warmPreprocess");

/**
 * Warm the preprocess model the moment an upload page mounts, so it is loading
 * while the user is still choosing files rather than only from the first upload.
 *
 * A cold heavy instance takes ~180-240s to load the BiRefNet model; firing the
 * warm-up on mount starts that load (on every heavy instance, through the heavy
 * workpool — see `warmupPreprocess` in convex/placeholderBatch.ts) while a
 * person is still picking a folder of scans, so escalated images meet a warm
 * fleet instead of paying the load themselves. This
 * is complementary to — not a replacement for — the queued-state "Warming up the
 * card processor…" indicator: this makes the wait shorter, the indicator
 * explains it when it still happens.
 *
 * Contract:
 *   - **At most once per mount.** A ref latch survives StrictMode's
 *     mount→unmount→mount, so the double-invoke does not double-fire. A stray
 *     extra call is harmless server-side (the heavy fan-out is deduped
 *     deployment-wide, so a second call inside the window enqueues nothing) —
 *     but this must never LOOP, which is why the effect has an empty
 *     dependency list and the unstable `useAction` identity is deliberately
 *     not a dependency.
 *   - **Best-effort.** A warm-up that fails, times out, or hits a deployment
 *     that has not shipped `warmPreprocess` yet is swallowed. It can never block
 *     or fault the page; the real images that follow warm the model regardless.
 */
export function useWarmPreprocess(): void {
  const warm = useAction(warmPreprocessRef);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    void (async () => {
      try {
        await warm({});
      } catch {
        // Swallowed on purpose — see the "best-effort" note above.
      }
    })();
    // `warm` (useAction) has a fresh identity each render; depending on it would
    // re-run this effect in a loop. The fire is a one-shot keyed on mount, and
    // the ref latch enforces at-most-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
