/**
 * NEO-466 — send one upload once, over XMLHttpRequest, and report its progress.
 *
 * `fetch` can't say how many bytes of a request body have gone out, so a
 * stalled upload (a pooled socket that swallows the bytes) looks the same as a
 * slow one until a long timer fires. XHR's `upload.onprogress` tells them apart,
 * which is what `uploadWithRetry`'s stall timer needs.
 *
 * This module only sends: no retry, no timer, no log line. It never reads or
 * reports the URL.
 */

export interface UploadProgress {
  /** Bytes of the body sent so far. */
  loaded: number;
  /** The body's size, when the browser knows it. */
  total: number | null;
}

export interface UploadTransportRequest {
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  body: Blob;
  /** Aborts the send. The promise then rejects with an `AbortError`. */
  signal: AbortSignal;
  /** Called on every upload progress event, and once more when the body is fully sent. */
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadTransportResponse {
  status: number;
  /** The answer's body as text ("" when empty). */
  body: string;
}

/**
 * Sends `request` once. Resolves with whatever status the server answered
 * (2xx or not); rejects with a `TypeError` when the network failed and with a
 * `DOMException` named `AbortError` when `signal` aborted it.
 */
export type UploadTransport = (request: UploadTransportRequest) => Promise<UploadTransportResponse>;

const abortError = () => new DOMException("The upload was aborted.", "AbortError");

/**
 * The browser's transport. The body goes as the `Blob` it is: XHR appends a
 * `charset` to the content type only for a string or document body, so the
 * `Content-Type` header given here reaches storage exactly as signed (R2
 * refuses any other).
 */
export const xhrTransport: UploadTransport = ({ url, method, headers, body, signal, onProgress }) =>
  new Promise<UploadTransportResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      // xhr.abort() fires `abort` on the request, which settles below; settle
      // here too in case the browser fires nothing for an unsent request.
      xhr.abort();
      finish(() => reject(abortError()));
    };

    xhr.open(method, url, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.responseType = "text";

    // Upload listeners go on BEFORE send(): a browser decides at send time
    // whether to report upload progress at all, and Chromium reports none for
    // listeners added later. (They also force a CORS preflight, which a PUT
    // has anyway.)
    if (onProgress) {
      const report = (event: ProgressEvent) =>
        onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null });
      xhr.upload.addEventListener("progress", report);
      xhr.upload.addEventListener("load", report);
    }

    xhr.addEventListener("load", () => {
      finish(() => resolve({ status: xhr.status, body: typeof xhr.response === "string" ? xhr.response : "" }));
    });
    xhr.addEventListener("error", () => finish(() => reject(new TypeError("Network request failed"))));
    xhr.addEventListener("timeout", () => finish(() => reject(new TypeError("Network request timed out"))));
    xhr.addEventListener("abort", () => finish(() => reject(abortError())));
    signal.addEventListener("abort", onAbort, { once: true });

    xhr.send(body);
  });
