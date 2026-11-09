/**
 * NEO-431 — send one photo file to storage, riding out a one-off hiccup so a
 * collector doesn't have to pick the photo again.
 *
 * Tries again on a 5xx, a 429 or a network `TypeError`. Any other status is a
 * fault a retry can't fix (a 403 is a signing or config problem), so it surfaces
 * at once. The body is a `Blob`, which can be sent again; a stream could not.
 *
 * NEO-466 — a stalled try is caught by its silence, not by a long clock. Each
 * try is sent over XHR (`xhr-transport.ts`), which reports upload progress, and
 * runs a stall timer that every progress event resets: 2.5 s on the first try,
 * 5 s on the second, then the full `attemptTimeoutMs(size)` on the last. When it
 * fires, the try is aborted and the next one starts at once, with no backoff.
 * `attemptTimeoutMs(size)` stays a hard cap on every try, so a trickle that
 * keeps resetting the stall timer still ends. The stall seen in CI is a PUT
 * whose bytes vanish (most likely a stale pooled keep-alive socket), so every
 * try after a stall or a network error goes to the request's `retryUrl` when it
 * has one: the same object signed on another host, which can't share that
 * socket. Once switched, later tries stay there. A 5xx or 429 is an answer, so
 * it waits out the backoff and doesn't switch.
 *
 * On giving up the collector reads the same message whatever happened, so a
 * stall can't hold them on "Saving..." for good. The line logged then never
 * carries the URL: it is signed.
 */

import { xhrTransport, type UploadTransport, type UploadProgress } from "./xhr-transport";

/** The waits before the second and third tries, after a status or a network error. */
const BACKOFF_MS = [500, 1500];

/** How long the first and second tries may go without upload progress; the third gets `attemptTimeoutMs`. */
export const STALL_WINDOWS_MS = [2_500, 5_000] as const;

/** At most this many tries per file. */
const MAX_TRIES = 3;

/** About ten times the slowest normal full save, so a healthy upload never gets near it. */
const ATTEMPT_FLOOR_MS = 20_000;
/** Convex's documented timeout on an upload POST is 2 minutes; waiting longer buys nothing. */
const ATTEMPT_CAP_MS = 120_000;
/** The slowest uplink worth serving. Assumed, not measured. */
const SLOWEST_UPLINK_BYTES_PER_SECOND = 32_000;

/** The longest one try at sending `bytes` may run, progress or not, before it is aborted. */
export function attemptTimeoutMs(bytes: number): number {
  return Math.min(ATTEMPT_CAP_MS, ATTEMPT_FLOOR_MS + Math.ceil((bytes * 1000) / SLOWEST_UPLINK_BYTES_PER_SECOND));
}

/**
 * How long try number `attempt` (1-based) may go without progress before it is
 * aborted: `windows[attempt - 1]`, else the full `attemptTimeoutMs(bytes)`.
 */
export function stallWindowMs(
  attempt: number,
  bytes: number,
  windows: readonly number[] = STALL_WINDOWS_MS,
): number {
  return windows[attempt - 1] ?? attemptTimeoutMs(bytes);
}

export type PhotoFileKind = "image" | "thumb";

/** The upload gave up. `status` is what storage said to the last try, or null when nothing answered it. */
export class PhotoUploadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "PhotoUploadError";
    this.status = status;
  }
}

export interface PhotoUploadRequest {
  url: string;
  /**
   * The same upload signed on another host, for every try after a stall or a
   * network error. Optional: without it every try goes to `url`.
   */
  retryUrl?: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  body: Blob;
  /**
   * The stall window of each try in turn; a try past the end gets the full
   * `attemptTimeoutMs`. Default `STALL_WINDOWS_MS`. `[]` turns the short
   * windows off, so every try runs to `attemptTimeoutMs` (for an upload whose
   * server may take a while to answer once the body is in).
   */
  stallWindowsMs?: readonly number[];
  /** Which file this is, for the log line. */
  file: PhotoFileKind;
  /** What the collector reads on giving up, whether storage refused it or never answered. */
  failureMessage: string;
  /**
   * The caller's own abort (another file of the same photo gave up). When it
   * fires the upload stops at once, logs nothing, doesn't retry, and rejects
   * with the `AbortError`.
   */
  signal?: AbortSignal;
}

/** Why a try got no answer: nothing went out for a whole window, or all of it went out and nothing came back. */
export type StallKind = "no_progress" | "no_answer";

/**
 * How one try ended: `ok` (2xx), `status` (any other answer), `stall` (this
 * module aborted it: its stall timer or its hard cap), `network` (the browser's
 * network error), `aborted` (the caller's signal) or `error` (anything else,
 * which is rethrown).
 */
export type UploadAttemptOutcome = "ok" | "status" | "stall" | "network" | "aborted" | "error";

/** One try, for timing. Never carries a URL. */
export interface UploadAttempt {
  /** 1-based. */
  attempt: number;
  outcome: UploadAttemptOutcome;
  /** The answer's status, or null when nothing answered. */
  status: number | null;
  /** How long the try ran. */
  ms: number;
  /** Which URL it went to. */
  host: "primary" | "retry";
  /** Set when `outcome` is `stall`. */
  stall?: StallKind;
}

export interface UploadWithRetryOptions {
  /** Waits out a backoff. The signal, when given, is the caller's abort. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Sends one try. Default: XHR. */
  transport?: UploadTransport;
  /** Called once per try as it ends, success or not. Errors it throws are swallowed. */
  onAttempt?: (attempt: UploadAttempt) => void;
}

/** A wait that clears its timer when the caller aborts, so nothing is left behind. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

const isRetryableStatus = (status: number) => status >= 500 || status === 429;

const isAbortError = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";

const abortError = () => new DOMException("The upload was aborted.", "AbortError");

/** What the caller's abort rejects with: its own reason when that is an error, else an `AbortError`. */
const callerAbortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : abortError());

/** Statuses whose `Response` may not carry a body, even an empty one. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The storage answer once it is ok, as a `Response` (so `res.json()` works). On
 * giving up, throws a `PhotoUploadError` carrying `failureMessage`, so a
 * collector never reads the browser's own "Failed to fetch". Its status is null
 * when nothing answered the last try. The caller's own abort rejects with its
 * `AbortError`, and any other error goes through unchanged, with no retry.
 */
export async function uploadWithRetry(
  request: PhotoUploadRequest,
  { wait = sleep, transport = xhrTransport, onAttempt }: UploadWithRetryOptions = {},
): Promise<Response> {
  const { url, retryUrl, method, headers, body, file, failureMessage, signal: callerSignal, stallWindowsMs } = request;
  const report = (attempt: UploadAttempt) => {
    try {
      onAttempt?.(attempt);
    } catch {
      // Timing must never break the upload it measures.
    }
  };
  let onRetryHost = false;

  for (let attempt = 1; ; attempt++) {
    if (callerSignal?.aborted) throw callerAbortError(callerSignal);

    const host: UploadAttempt["host"] = onRetryHost && retryUrl ? "retry" : "primary";
    const controller = new AbortController();
    // Written from timers and progress events, so held in an object: the
    // compiler's narrowing can't see writes made inside a callback.
    const seen = { ownAbort: false, progress: false, loaded: 0, total: null as number | null };
    const abortOwn = () => {
      seen.ownAbort = true;
      controller.abort();
    };
    const stallMs = stallWindowMs(attempt, body.size, stallWindowsMs);
    let stallTimer = setTimeout(abortOwn, stallMs);
    const capTimer = setTimeout(abortOwn, attemptTimeoutMs(body.size));
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const onProgress = (progress: UploadProgress) => {
      seen.progress = true;
      seen.loaded = progress.loaded;
      seen.total = progress.total;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(abortOwn, stallMs);
    };

    const started = now();
    let status: number | null = null;
    let outcome: UploadAttemptOutcome;
    let stall: StallKind | undefined;
    try {
      const res = await transport({
        url: host === "retry" ? retryUrl! : url,
        method,
        headers,
        body,
        signal: controller.signal,
        onProgress,
      });
      if (res.status === 0) throw new TypeError("Network request failed");
      status = res.status;
      if (status >= 200 && status < 300) {
        report({ attempt, outcome: "ok", status, ms: Math.round(now() - started), host });
        return new Response(NULL_BODY_STATUSES.has(status) || res.body === "" ? null : res.body, { status });
      }
      outcome = "status";
    } catch (error) {
      if (callerSignal?.aborted) {
        report({ attempt, outcome: "aborted", status: null, ms: Math.round(now() - started), host });
        throw isAbortError(error) ? error : callerAbortError(callerSignal);
      }
      if (seen.ownAbort && isAbortError(error)) {
        outcome = "stall";
        stall = seen.progress && seen.loaded >= (seen.total ?? body.size) ? "no_answer" : "no_progress";
      } else if (error instanceof TypeError) {
        outcome = "network";
      } else {
        report({ attempt, outcome: "error", status: null, ms: Math.round(now() - started), host });
        throw error;
      }
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(capTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    report({ attempt, outcome, status, ms: Math.round(now() - started), host, ...(stall ? { stall } : {}) });

    // The caller let go while this try ended on its own: no log line, no retry.
    if (callerSignal?.aborted) throw callerAbortError(callerSignal);
    const retryable = outcome !== "status" || isRetryableStatus(status!);
    if (!retryable || attempt >= MAX_TRIES) {
      console.warn(
        JSON.stringify({
          event: "copy_photo_put_failed",
          method,
          status,
          attempts: attempt,
          file,
          size: body.size,
          ...(outcome === "stall" ? { timedOut: true, stall } : {}),
        }),
      );
      throw new PhotoUploadError(failureMessage, status);
    }
    if (outcome === "stall" || outcome === "network") onRetryHost = true;
    // A stalled try already used up its window; the next one starts at once.
    if (outcome !== "stall") {
      await wait(BACKOFF_MS[attempt - 1], callerSignal);
    }
  }
}
