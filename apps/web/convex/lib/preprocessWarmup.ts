/**
 * Heavy warm-up timing shared by the adapter and the heavy pool (NEO-299).
 *
 * Dependency-free on purpose: the adapter that uses the fetch budget is a
 * `"use node"` module (convex/adapters/preprocess.ts), and the mutation that
 * uses the dedup window runs in the default runtime
 * (convex/placeholderHeavyPool.ts). A default-runtime module cannot import a
 * `"use node"` one, so the number both of them need lives here.
 */

/**
 * How long a HEAVY warm-up call waits before giving up.
 *
 * Much longer than the fast budget, and it has to be, because heavy warm-ups
 * run THROUGH the heavy workpool: each one holds a pool slot for exactly as
 * long as this fetch is open. The heavy `/warmup` holds its instance for the
 * whole ~180-240s model load, and the service runs `container_concurrency = 1`.
 * If this fetch gave up at 60s, the pool would free the slot and dispatch the
 * next heavy request while the abandoned warm-up still occupied that instance
 * for another two or three minutes — the pool would believe it had a free
 * instance that Cloud Run did not have, and the request it sent would be shed
 * with a 429. The slot must stay held until the instance is actually free.
 *
 * 330s clears the slowest measured cold load (~240s) with margin, and stays
 * under the heavy Cloud Run service's request timeout, so it is Cloud Run that
 * ends a genuinely hung request, not an abort racing it.
 */
export const WARMUP_HEAVY_FETCH_TIMEOUT_MS = 330_000;

/**
 * The deployment-wide window during which a second heavy warm-up fan-out is
 * skipped (`enqueueHeavyWarmups` in convex/placeholderHeavyPool.ts).
 *
 * Equal to the heavy warm-up fetch budget, because that is the longest one
 * fan-out can still be in flight: inside the window the previous round's
 * warm-ups are either still loading the model or have finished and left the
 * fleet warm, and in both cases another round adds nothing but queue in front
 * of real escalations. Once the window has passed, every warm-up from the
 * previous round has returned or been aborted, so a new round is the only way
 * to bring a fleet that has since scaled down back up.
 */
export const HEAVY_WARMUP_WINDOW_MS = WARMUP_HEAVY_FETCH_TIMEOUT_MS;
