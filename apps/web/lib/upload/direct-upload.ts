/**
 * Client helper for uploading a file straight to GCS via a signed POST
 * policy (NEO-148), returned by
 * `api.adapters.placeholderUploads.createPlaceholderUploadUrl` as
 * `{ uploadUrl, fields }`.
 *
 * Why XMLHttpRequest and not `fetch`: `fetch` has no way to report request
 * (upload) progress — only response-body download progress, via
 * `response.body`'s reader. There is no upload-progress primitive anywhere
 * else in apps/web, so this wraps `xhr.upload.onprogress` in a promise and
 * exposes a small typed surface (progress callback + `AbortSignal`
 * cancellation) that the NEO-152 upload UI can consume without knowing
 * XHR exists underneath.
 *
 * Why a signed POST policy (`multipart/form-data`) and not a signed PUT
 * URL: a POST policy's `content-length-range` condition is enforced by GCS
 * server-side — a signed PUT URL has no equivalent, so a client-side size
 * check would be the only thing standing between an authenticated user and
 * an arbitrarily large object for the life of the URL. Mechanically this
 * means the policy `fields` (bucket-scoped tokens, NOT the object bytes)
 * must be appended to the `FormData` BEFORE the file, and the browser must
 * be left to set its own `Content-Type: multipart/form-data; boundary=...`
 * header — setting it manually breaks the multipart boundary GCS expects.
 */

export interface DirectUploadProgress {
  /** Bytes sent so far. */
  loaded: number;
  /** Total bytes to send, if the browser could compute it. */
  total: number | undefined;
  /** `loaded / total` in [0, 1], or undefined when `total` is unknown. */
  fraction: number | undefined;
}

export interface DirectUploadOptions {
  /** The signed POST policy URL (from `createPlaceholderUploadUrl`). */
  uploadUrl: string;
  /**
   * The policy's form fields (from `createPlaceholderUploadUrl`), appended
   * to the multipart body ahead of the file. Order matters to GCS: any
   * field appended after the file field is ignored, which is why this
   * helper appends all of `fields` first and `body` last.
   */
  fields: Record<string, string>;
  /** The file/blob to upload. */
  body: Blob;
  /** Filename recorded on the multipart `file` field. */
  filename: string;
  /** Called as the browser reports upload progress. */
  onProgress?: (progress: DirectUploadProgress) => void;
  /** Abort the in-flight upload. Rejects with a `DirectUploadError` (aborted: true). */
  signal?: AbortSignal;
}

export class DirectUploadError extends Error {
  readonly status: number | undefined;
  readonly aborted: boolean;

  constructor(message: string, opts: { status?: number; aborted?: boolean } = {}) {
    super(message);
    this.name = "DirectUploadError";
    this.status = opts.status;
    this.aborted = opts.aborted ?? false;
  }
}

/**
 * POST `body` to `uploadUrl` as a signed-policy multipart form, resolving
 * once GCS returns a 2xx (a successful POST-policy upload is a 204 by
 * default). Rejects with a `DirectUploadError` on a non-2xx response (e.g.
 * 412 if `x-goog-if-generation-match` finds the object already exists, or
 * 400 if the body exceeds the policy's `content-length-range`), a network
 * error, or abort.
 */
export function uploadDirectToStorage(options: DirectUploadOptions): Promise<void> {
  const { uploadUrl, fields, body, filename, onProgress, signal } = options;

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DirectUploadError("Upload aborted", { aborted: true }));
      return;
    }

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    // Must be appended last — GCS's POST-policy form processor ignores any
    // field that comes after the file field.
    formData.append("file", body, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl, true);
    // Deliberately no `setRequestHeader("Content-Type", ...)` call: the
    // browser must generate its own multipart boundary for a FormData body.

    const onAbort = () => {
      xhr.abort();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort);
    }

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      onProgress({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : undefined,
        fraction: event.lengthComputable && event.total > 0 ? event.loaded / event.total : undefined,
      });
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new DirectUploadError(`Upload failed with status ${xhr.status}`, {
            status: xhr.status,
          }),
        );
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new DirectUploadError("Network error during upload"));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new DirectUploadError("Upload aborted", { aborted: true }));
    };

    xhr.send(formData);
  });
}
