/**
 * NEO-431 — send one photo file to storage, riding out a one-off hiccup so a
 * collector doesn't have to pick the photo again.
 *
 * Tries again on a 5xx, a 429 or a network `TypeError`. Any other status is a
 * fault a retry can't fix (a 403 is a signing or config problem), so it surfaces
 * at once. The body is a `Blob`, which can be sent again; a stream could not.
 *
 * The line logged on giving up never carries the URL: it is signed.
 */

/** The waits before the second and third tries. */
const BACKOFF_MS = [500, 1500];

export type PhotoFileKind = "image" | "thumb";

/** The upload gave up. `status` is what storage last said, or null when nothing answered. */
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

/**
 * The storage answer once it is ok. On giving up, throws a `PhotoUploadError`
 * carrying `failureMessage`, so a collector never reads the browser's own
 * "Failed to fetch". Its status is null when nothing ever answered. An error
 * that isn't the network's goes through unchanged, with no retry.
 */
export async function uploadWithRetry(request: PhotoUploadRequest, wait: (ms: number) => Promise<void> = sleep): Promise<Response> {
  const { url, method, headers, body, file, failureMessage } = request;
  for (let attempts = 1; ; attempts++) {
    let status: number | null = null;
    let retryable = true;
    try {
      const res = await fetch(url, { method, headers, body });
      if (res.ok) return res;
      status = res.status;
      retryable = isRetryableStatus(status);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    const backoff = retryable ? BACKOFF_MS[attempts - 1] : undefined;
    if (backoff === undefined) {
      console.warn(JSON.stringify({ event: "copy_photo_put_failed", method, status, attempts, file, size: body.size }));
      throw new PhotoUploadError(failureMessage, status);
    }
    await wait(backoff);
  }
}
