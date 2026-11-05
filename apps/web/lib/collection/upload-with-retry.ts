/**
 * NEO-431 — send one photo file to storage, riding out a one-off hiccup so a
 * collector doesn't have to pick the photo again.
 *
 * Tries again on a 5xx, a 429 or a network `TypeError`. Any other status is a
 * fault a retry can't fix (a 403 is a signing or config problem), so it surfaces
 * at once. The body is a `Blob`, which can be sent again; a stream could not.
 *
 * A try that gets no answer in time is aborted and counts as a network failure:
 * it is tried again, each try with a full window of its own, and on giving up the
 * collector reads the same message, so a stall can't hold them on "Saving..."
 * for good. The clock stops when the headers arrive, so reading the body of an
 * answer afterwards is not covered.
 *
 * The line logged on giving up never carries the URL: it is signed.
 */

/** The waits before the second and third tries. */
const BACKOFF_MS = [500, 1500];

/** About ten times the slowest normal full save, so a healthy upload never gets near it. */
const ATTEMPT_FLOOR_MS = 20_000;
/** Convex's documented timeout on an upload POST is 2 minutes; waiting longer buys nothing. */
const ATTEMPT_CAP_MS = 120_000;
/** The slowest uplink worth serving. Assumed, not measured. */
const SLOWEST_UPLINK_BYTES_PER_SECOND = 32_000;

/** How long one try at sending `bytes` may go unanswered before it is aborted. */
export function attemptTimeoutMs(bytes: number): number {
  return Math.min(ATTEMPT_CAP_MS, ATTEMPT_FLOOR_MS + Math.ceil((bytes * 1000) / SLOWEST_UPLINK_BYTES_PER_SECOND));
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
  method: "PUT" | "POST";
  headers: Record<string, string>;
  body: Blob;
  /** Which file this is, for the log line. */
  file: PhotoFileKind;
  /** What the collector reads on giving up, whether storage refused it or never answered. */
  failureMessage: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number) => status >= 500 || status === 429;

/** Only this try's own timer aborts `signal`, and an abort rejects with an `AbortError`. */
const isOwnAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted && (error as { name?: unknown } | null)?.name === "AbortError";

/**
 * The storage answer once it is ok. On giving up, throws a `PhotoUploadError`
 * carrying `failureMessage`, so a collector never reads the browser's own
 * "Failed to fetch". Its status is null when nothing answered the last try. An
 * error that is neither the network's nor this try's own timeout goes through
 * unchanged, with no retry.
 */
export async function uploadWithRetry(request: PhotoUploadRequest, wait: (ms: number) => Promise<void> = sleep): Promise<Response> {
  const { url, method, headers, body, file, failureMessage } = request;
  for (let attempts = 1; ; attempts++) {
    let status: number | null = null;
    let retryable = true;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs(body.size));
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      if (res.ok) return res;
      status = res.status;
      retryable = isRetryableStatus(status);
    } catch (error) {
      timedOut = isOwnAbort(error, controller.signal);
      if (!timedOut && !(error instanceof TypeError)) throw error;
    } finally {
      clearTimeout(timer);
    }
    const backoff = retryable ? BACKOFF_MS[attempts - 1] : undefined;
    if (backoff === undefined) {
      console.warn(
        JSON.stringify({
          event: "copy_photo_put_failed",
          method,
          status,
          attempts,
          file,
          size: body.size,
          ...(timedOut ? { timedOut } : {}),
        }),
      );
      throw new PhotoUploadError(failureMessage, status);
    }
    await wait(backoff);
  }
}
