/**
 * The upload half of /placeholders (NEO-170) — kept out of the component so it
 * can be tested without a DOM, a Convex client, or a network.
 *
 * ## Strictly sequential, on purpose
 * Pairing's cheapest and most reliable signal is ADJACENCY: entry 0 is the
 * front of the card whose back is entry 1, because that is the order the pages
 * came off the scanner. `createPlaceholderImageUploadUrl` allocates the entry
 * index server-side, one per call, in call order — so the order these calls are
 * MADE is the order the deck is reconstructed in. Fire them concurrently and
 * the allocation order becomes whatever the event loop and the network felt
 * like, which silently pairs the back of one card with the front of another.
 * Nothing errors; the results are just wrong, in a way only a human comparing
 * printed placeholders would catch.
 *
 * That is why this is a plain `for` loop with `await` in it, and why the loop is
 * the unit under test. A future version can pipeline the POSTs behind a small
 * window, but only if allocation stays strictly ordered.
 *
 * ## Confirm comes after the bytes land
 * `confirmPlaceholderImageUpload` is what moves an entry from `awaiting_upload`
 * into the work queue. Calling it before the POST resolves would enqueue an
 * object that is not there yet; the entry would fail against GCS instead of
 * against the upload, and the user would be told the wrong thing. Any entry
 * whose POST fails is simply never confirmed — the idle sweep reclaims it.
 */

/** What `createPlaceholderImageUploadUrl` hands back for one file. */
export interface UploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
  entryIndex: number;
  expiresAt: number;
  maxUploadBytes: number;
}

export type FileUploadState =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed";

/** One file's place in the run, as the UI needs to render it. */
export interface FileProgress {
  /** Position in the user's selection — stable, unlike `entryIndex`. */
  position: number;
  name: string;
  state: FileUploadState;
  entryIndex?: number;
  error?: string;
}

export interface UploadRunDeps {
  createUploadUrl(args: {
    jobId: string;
    contentType: string;
    originalName: string;
  }): Promise<UploadTicket>;
  postToStorage(ticket: UploadTicket, file: File): Promise<void>;
  confirmUpload(args: {
    jobId: string;
    entryIndex: number;
  }): Promise<{ confirmed: boolean; alreadyConfirmed: boolean; totalImages: number }>;
  onProgress(progress: FileProgress): void;
}

export interface UploadRunResult {
  uploaded: number;
  failed: number;
}

/**
 * POST a file into GCS with the signed policy the server minted.
 *
 * The policy fields go in FIRST and `file` LAST — GCS ignores anything after the
 * file part, so a field appended afterwards is simply not seen and the upload is
 * rejected as unsigned. This is the one ordering rule in the request body.
 *
 * Injected as a dependency above rather than called directly by the loop, so the
 * orchestration can be tested without a network.
 */
export async function postSignedForm(
  // Narrowed to what this actually reads, rather than the whole UploadTicket.
  // The zip path (NEO-152) has a signed policy but no `entryIndex` — there is
  // one object, not an indexed entry — and widening the caller to satisfy an
  // unused field would mean inventing a number that means nothing.
  ticket: Pick<UploadTicket, "uploadUrl" | "fields">,
  file: File,
): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) {
    form.append(key, value);
  }
  form.append("file", file);

  const response = await fetch(ticket.uploadUrl, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    // The body is XML from GCS and says nothing a user can act on; the status
    // is the part worth surfacing.
    throw new Error(`Storage rejected the upload (HTTP ${response.status})`);
  }
}

/**
 * Allocate → upload → confirm, one file at a time, in selection order.
 *
 * A file that fails does NOT stop the run. The remaining files still hold their
 * places in the deck, and stopping would leave a half-uploaded session the user
 * has to reason about; instead every file gets its own outcome and the caller
 * reports the tally.
 */
export async function runPlaceholderUpload(
  jobId: string,
  files: File[],
  deps: UploadRunDeps,
): Promise<UploadRunResult> {
  let uploaded = 0;
  let failed = 0;

  for (let position = 0; position < files.length; position += 1) {
    const file = files[position];
    deps.onProgress({ position, name: file.name, state: "uploading" });

    try {
      const ticket = await deps.createUploadUrl({
        jobId,
        contentType: file.type || "image/jpeg",
        originalName: file.name,
      });

      // Checked here rather than left to GCS: the policy enforces the same
      // ceiling, but it answers with an XML 400 that reads as "something went
      // wrong" instead of "this file is too big".
      if (file.size > ticket.maxUploadBytes) {
        throw new Error(
          `File is larger than the ${Math.floor(ticket.maxUploadBytes / (1024 * 1024))}MB limit`,
        );
      }

      await deps.postToStorage(ticket, file);
      await deps.confirmUpload({ jobId, entryIndex: ticket.entryIndex });

      uploaded += 1;
      deps.onProgress({
        position,
        name: file.name,
        state: "uploaded",
        entryIndex: ticket.entryIndex,
      });
    } catch (error) {
      failed += 1;
      deps.onProgress({
        position,
        name: file.name,
        state: "failed",
        error: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }

  return { uploaded, failed };
}
