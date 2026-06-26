import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";

/**
 * Front-end backstop budget for a single `fetchAggregatedOptions` sync.
 *
 * The backend's worst case is 10s × 3 BSC retries ≈ 33s; 38s is that plus
 * margin. If the action's promise never resolves (hung action, dropped
 * websocket, etc.) the column would otherwise show "Syncing…" forever with no
 * error and no way to recover. The backstop timer flips us into a recoverable
 * error state so a user (and our E2E) always has a visible, focusable Retry.
 *
 * Kept here as the single source of truth so the literal is not duplicated
 * across SportForm / ManufacturerForm / YearForm / SetVariantForm.
 */
export const SELECTOR_SYNC_FE_TIMEOUT_MS = 38_000;

/** Drill levels that run an aggregated-options sync. Used only for diagnostics. */
export type SelectorSyncLevel =
  | "sport"
  | "year"
  | "manufacturer"
  | "variantType";

/**
 * The subset of `fetchAggregatedOptions`' result that the give-up logic needs.
 * The backend currently returns `{ success, message, optionsCount }` — no
 * `requestId`. If one is surfaced later, thread it through `requestId` and it
 * will ride along on the diagnostic event automatically.
 */
export interface SelectorSyncResult {
  success: boolean;
  message: string;
  optionsCount: number;
  requestId?: string;
}

type Phase = "idle" | "syncing" | "done" | "error";

interface UseSelectorSyncArgs {
  /** Drill level, used for copy and the diagnostic payload. */
  level: SelectorSyncLevel;
  /**
   * Runs the actual `fetchAggregatedOptions` action. Returning `undefined`
   * means "preconditions not ready" (e.g. ancestor chain still loading) — the
   * sync is treated as a no-op and stays idle without arming the backstop.
   */
  run: () => Promise<SelectorSyncResult | undefined>;
  /** Called on the happy path (success, or an empty-but-non-error result). */
  onDone?: () => void;
}

interface UseSelectorSyncState {
  /** True while the action is in flight and the backstop is armed. */
  loading: boolean;
  /** True once we have given up (timeout, reject, or failure result). */
  hasError: boolean;
  /** Human-readable message for the current phase (success info or error). */
  message: string | null;
  /** Re-run the sync and reset the backstop timer. */
  retry: () => void;
  /** Fire the initial sync (call once, e.g. from a mount effect). */
  start: () => void;
}

/**
 * Shared "sync aggregated options with a front-end give-up + recover" engine.
 *
 * Behaviour:
 *  - Arms a {@link SELECTOR_SYNC_FE_TIMEOUT_MS} backstop when a sync begins.
 *  - On reject, on a genuine failure result, or on the backstop firing →
 *    surfaces a recoverable error (`hasError`) and emits a
 *    `selector_sync_fe_timeout` PostHog event with
 *    `{ level, stage: "fe", reason, requestId? }`.
 *  - On success — or on an empty-but-non-error result (`optionsCount === 0`),
 *    which NEO-47 treats as "go idle so + Custom isn't blocked" — calls
 *    `onDone` and leaves the happy path unchanged.
 *
 * The hook is resilient to unmount/late-resolve: a per-run token guards against
 * a superseded or post-unmount promise mutating state or firing the timeout.
 */
export function useSelectorSync({
  level,
  run,
  onDone,
}: UseSelectorSyncArgs): UseSelectorSyncState {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  // Monotonic token: only the most recent run may mutate state. Bumped on every
  // start/retry and on unmount, which invalidates any in-flight promise/timer.
  const runIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const emitGiveUp = useCallback(
    (reason: "timeout" | "error", requestId?: string) => {
      try {
        posthog.capture("selector_sync_fe_timeout", {
          level,
          stage: "fe",
          reason,
          ...(requestId ? { requestId } : {}),
        });
      } catch {
        // Diagnostics must never break the recover flow.
      }
    },
    [level],
  );

  const doRun = useCallback(() => {
    const runId = ++runIdRef.current;
    clearTimer();
    setPhase("syncing");
    setMessage(null);

    // Backstop: if the action hasn't resolved in budget, give up + recover.
    timerRef.current = setTimeout(() => {
      if (runIdRef.current !== runId || !mountedRef.current) return;
      timerRef.current = null;
      setPhase("error");
      setMessage(`Couldn't sync ${level} options.`);
      emitGiveUp("timeout");
    }, SELECTOR_SYNC_FE_TIMEOUT_MS);

    void (async () => {
      try {
        const result = await run();

        // A superseded run (retry) or unmount invalidates this resolution.
        if (runIdRef.current !== runId || !mountedRef.current) return;

        // Preconditions weren't ready — stay idle, don't arm an error.
        if (result === undefined) {
          clearTimer();
          setPhase("idle");
          return;
        }

        clearTimer();
        setMessage(result.message);

        // NEO-47: success OR an empty-but-non-error result goes idle so the
        // column doesn't hard-block "+ Custom". Anything else is a real failure.
        if (result.success || result.optionsCount === 0) {
          setPhase("done");
          onDone?.();
        } else {
          setPhase("error");
          emitGiveUp("error", result.requestId);
        }
      } catch (error) {
        if (runIdRef.current !== runId || !mountedRef.current) return;
        clearTimer();
        // Preserve the existing "Error: <msg>" contract that the FE tests assert.
        setPhase("error");
        setMessage(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        emitGiveUp("error");
      }
    })();
  }, [clearTimer, emitGiveUp, level, onDone, run]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight run + timer so they can't touch dead state.
      runIdRef.current++;
      clearTimer();
    };
  }, [clearTimer]);

  return {
    loading: phase === "syncing",
    hasError: phase === "error",
    message,
    retry: doRun,
    start: doRun,
  };
}
