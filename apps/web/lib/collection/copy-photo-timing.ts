/**
 * NEO-466 — where a copy photo's save spends its time.
 *
 * A save is: resize in the browser, `startUpload` (Convex signs two URLs), the
 * two PUTs to storage (side by side), then `finishUpload` (Convex checks both
 * files and attaches the photo). The collector waits on all of it under one
 * "Saving the front photo..." line, so a slow save can't say which part was
 * slow. This records each part and reports a save worth a look: one that took
 * over {@link SLOW_SAVE_MS}, needed a second try at either file, or failed.
 *
 * The report is one `console.warn` JSON line (event `copy_photo_save_timing`)
 * and, under E2E only, the same numbers as a PostHog diagnostic event (NEO-392).
 * It carries timings, sizes, statuses and try outcomes: never a URL, a token or
 * a photo id.
 */

import { e2eDiagnostic } from "@/lib/observability/e2e-diagnostics";
import type { PhotoFileKind, UploadAttempt } from "./upload-with-retry";

export const COPY_PHOTO_TIMING_EVENT = "copy_photo_save_timing";

/** A save slower than this is reported even when it went through first time. */
export const SLOW_SAVE_MS = 3_000;

export type CopyPhotoPhase = "resize" | "startUpload" | "finishUpload";

/** One file's PUT: how long it took in all, its size, and every try. */
export interface CopyPhotoPutTiming {
  file: PhotoFileKind;
  ms: number;
  bytes: number;
  tries: UploadAttempt[];
}

export interface CopyPhotoSaveTiming {
  outcome: "saved" | "failed";
  totalMs: number;
  /** Each phase that ran, in ms. A phase that never started is absent. */
  phases: Partial<Record<CopyPhotoPhase, number>>;
  puts: CopyPhotoPutTiming[];
  /** On a failed save, the part that failed. */
  failedAt?: CopyPhotoPhase | "put";
  /** On a failed save, the error's class name (never its message). */
  errorName?: string;
  /** On a failed save that storage answered, its last status. */
  errorStatus?: number | null;
}

/** Whether a save is worth reporting: slow, retried or failed. */
export function shouldReportCopyPhotoTiming(timing: CopyPhotoSaveTiming): boolean {
  return (
    timing.outcome === "failed" || timing.totalMs > SLOW_SAVE_MS || timing.puts.some((put) => put.tries.length > 1)
  );
}

/** One try as a short token: `ok`, `status:503`, `stall:no_progress`, `network`, then `@retry` when it went to the retry host. */
function tryToken(attempt: UploadAttempt): string {
  const detail =
    attempt.outcome === "status" ? `:${attempt.status}` : attempt.outcome === "stall" && attempt.stall ? `:${attempt.stall}` : "";
  return `${attempt.outcome}${detail}${attempt.host === "retry" ? "@retry" : ""}`;
}

/** The report as flat primitives, for the PostHog diagnostic channel. */
export function flattenCopyPhotoTiming(
  timing: CopyPhotoSaveTiming,
): Record<string, string | number | boolean | null> {
  const flat: Record<string, string | number | boolean | null> = {
    outcome: timing.outcome,
    total_ms: timing.totalMs,
    resize_ms: timing.phases.resize ?? null,
    start_upload_ms: timing.phases.startUpload ?? null,
    finish_upload_ms: timing.phases.finishUpload ?? null,
  };
  for (const put of timing.puts) {
    flat[`${put.file}_ms`] = put.ms;
    flat[`${put.file}_bytes`] = put.bytes;
    flat[`${put.file}_tries`] = put.tries.length;
    flat[`${put.file}_try_outcomes`] = put.tries.map(tryToken).join(",");
    flat[`${put.file}_try_ms`] = put.tries.map((attempt) => attempt.ms).join(",");
  }
  if (timing.failedAt) flat.failed_at = timing.failedAt;
  if (timing.errorName) flat.error_name = timing.errorName;
  if (timing.errorStatus !== undefined) flat.error_status = timing.errorStatus;
  return flat;
}

/** Reports a save when it is worth it: one console line, plus the E2E diagnostic. */
export function reportCopyPhotoTiming(timing: CopyPhotoSaveTiming): void {
  if (!shouldReportCopyPhotoTiming(timing)) return;
  try {
    console.warn(JSON.stringify({ event: COPY_PHOTO_TIMING_EVENT, ...timing }));
    e2eDiagnostic(COPY_PHOTO_TIMING_EVENT, flattenCopyPhotoTiming(timing));
  } catch {
    // Timing must never break the save it measures.
  }
}

export interface CopyPhotoTimer {
  /** Runs one phase and records how long it took, even when it throws. */
  phase<T>(name: CopyPhotoPhase, run: () => Promise<T>): Promise<T>;
  /**
   * Runs one file's PUT. `run` gets the `onAttempt` to hand `uploadWithRetry`,
   * so every try is recorded.
   */
  put<T>(file: PhotoFileKind, bytes: number, run: (onAttempt: (attempt: UploadAttempt) => void) => Promise<T>): Promise<T>;
  /** Ends the save: builds the record and reports it if worth it. Call once. */
  finish(outcome: "saved" | "failed", error?: unknown): CopyPhotoSaveTiming;
}

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Starts timing one save now. */
export function startCopyPhotoTimer(
  clock: () => number = defaultClock,
  report: (timing: CopyPhotoSaveTiming) => void = reportCopyPhotoTiming,
): CopyPhotoTimer {
  const began = clock();
  const phases: Partial<Record<CopyPhotoPhase, number>> = {};
  const puts: CopyPhotoPutTiming[] = [];
  let failedAt: CopyPhotoSaveTiming["failedAt"];
  const since = (from: number) => Math.round(clock() - from);

  return {
    async phase(name, run) {
      const from = clock();
      try {
        return await run();
      } catch (error) {
        failedAt ??= name;
        throw error;
      } finally {
        phases[name] = since(from);
      }
    },
    async put(file, bytes, run) {
      const timing: CopyPhotoPutTiming = { file, ms: 0, bytes, tries: [] };
      puts.push(timing);
      const from = clock();
      try {
        return await run((attempt) => timing.tries.push(attempt));
      } catch (error) {
        // The first file to give up is the failure; the other one, aborted
        // because of it, is not.
        failedAt ??= "put";
        throw error;
      } finally {
        timing.ms = since(from);
      }
    },
    finish(outcome, error) {
      const timing: CopyPhotoSaveTiming = { outcome, totalMs: since(began), phases, puts };
      if (outcome === "failed") {
        if (failedAt) timing.failedAt = failedAt;
        if (error instanceof Error) timing.errorName = error.name;
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status === "number" || status === null) timing.errorStatus = status;
      }
      try {
        report(timing);
      } catch {
        // Timing must never break the save it measures.
      }
      return timing;
    },
  };
}
