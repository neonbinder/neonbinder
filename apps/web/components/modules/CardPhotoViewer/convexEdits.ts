/**
 * NEO-481 — the Convex side of the viewer: the scan adapter, and the pieces
 * the copy-photo adapter in the collection store shares with it.
 *
 * The server (`convex/photoEdits.ts`) decides everything that matters: which
 * picture an edit starts from (a HEAD on the scan's original, per open),
 * whether the photo can be edited at all, the race guard and the caps. This
 * file only carries its answers to the viewer.
 */

import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { asPendingPhotoEdit, asPhotoEdit, openingTurns, type PhotoCrop, type PhotoEdit, type QuarterTurns } from "@/lib/photo-edit/geometry";
import { measureImage } from "./sources";
import type { EditStart, PhotoSideSource, PhotoSource, ViewerSide } from "./types";

/** What `photoEdits.photoEditSource` answers, read loosely: every field is checked before use. */
export interface RawEditSource {
  mode: "original" | "stored" | "viewOnly";
  reason?: string;
  edit?: unknown;
  autoCrop?: unknown;
  srcW?: number;
  srcH?: number;
  sourceUrl?: string;
  expectVersion?: number;
  expectToken?: string;
  editsLeft?: number;
}

/** Plain words from a Convex error (a `ConvexError` carries `{ message }` as its data). */
export function errorWords(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message;
  }
  if (typeof data === "string" && data) return data;
  return fallback;
}

/** Rethrow a server refusal as an Error whose message the viewer can show as is. */
export async function inWords<T>(work: Promise<T>, fallback: string): Promise<T> {
  try {
    return await work;
  } catch (e) {
    throw new Error(errorWords(e, fallback));
  }
}

const CROP_OF = (raw: unknown): PhotoCrop | null => asPhotoEdit({ turns: 0, crop: raw ?? null })?.crop ?? null;

/**
 * The server's answer as the viewer's `EditStart`. The opening edit is the
 * server's (it already turned the scan's rotation into quarter turns); with
 * none, the auto crop at `fallbackTurns` (the scan's own rotation, row S's
 * contract rule Q5). Start over keeps the opening turn and goes back
 * to the auto crop, else the whole frame. A missing size is measured from the
 * picture itself.
 */
export async function toEditStart(raw: RawEditSource, guard: unknown, fallbackTurns: QuarterTurns = 0): Promise<EditStart> {
  if (raw.mode === "viewOnly" || !raw.sourceUrl) {
    return { mode: "viewOnly", reason: raw.reason ?? "This photo can't be turned or cropped right now." };
  }
  const autoCrop = CROP_OF(raw.autoCrop);
  const opening: PhotoEdit = asPhotoEdit(raw.edit) ?? { turns: fallbackTurns, crop: autoCrop };
  const size =
    typeof raw.srcW === "number" && typeof raw.srcH === "number" && raw.srcW > 0 && raw.srcH > 0
      ? { w: raw.srcW, h: raw.srcH }
      : opening.crop
        ? { w: opening.crop.srcW, h: opening.crop.srcH }
        : await measureImage(raw.sourceUrl);
  return {
    mode: raw.mode,
    sourceUrl: raw.sourceUrl,
    srcW: size.w,
    srcH: size.h,
    opening,
    reset: { turns: opening.turns, crop: autoCrop },
    ...(autoCrop ? {} : { noAutoCrop: true }),
    ...(typeof raw.editsLeft === "number" ? { editsLeft: raw.editsLeft } : {}),
    guard,
  };
}

/** The bits of a `listPlaceholderImages` row the viewer reads. */
export interface ScanImageFacts {
  editVersion?: number;
  rotationDegrees?: number;
  pendingEdit?: unknown;
}

/** One side of a scan: its index in the job, and its row when the caller has it. */
export interface ScanSideInput {
  entryIndex: number;
  image?: ScanImageFacts;
}

/** How long a scan's address may take before the viewer says "Image unavailable" instead of waiting. */
export const MINT_TIMEOUT_MS = 15_000;

/**
 * A scan's current picture behind a signed GET, minted again when its edit
 * version changes. `failed` when the mint is refused (the scan is gone) or
 * takes too long: the viewer then says so rather than wait for ever. A late
 * answer still wins.
 */
function useScanUrl(jobId: string, entryIndex: number | undefined, version: number | undefined): { url?: string; failed: boolean } {
  const mint = useAction(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl);
  const [minted, setMinted] = useState<{ key: string; url?: string; failed?: boolean } | null>(null);
  const key = `${jobId}:${entryIndex}:${version ?? 0}`;
  useEffect(() => {
    if (entryIndex === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      if (live) setMinted((m) => (m?.key === key && m.url ? m : { key, failed: true }));
    }, MINT_TIMEOUT_MS);
    mint({ jobId, entryIndex }).then(
      (r) => {
        clearTimeout(timer);
        if (live) setMinted({ key, url: r.url });
      },
      () => {
        clearTimeout(timer);
        if (live) setMinted({ key, failed: true });
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `mint` is a new function every render (the Convex action-in-effect loop): keyed on what names the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return minted?.key === key ? { url: minted.url, failed: !!minted.failed && !minted.url } : { failed: false };
}

/**
 * NEO-481 — a scan's photos for the viewer (unpaired, or a pair not saved
 * yet). Pass the image rows the screen already subscribes to, so the viewer
 * follows the pending edit and the new version without a second read.
 * `viewOnly` opens it view-only with that reason (a saved pair whose photos
 * are on their way, `ON_THE_WAY_REASON`).
 */
export function useScanPhotoSource({
  jobId,
  label,
  front,
  back,
  viewOnly,
}: {
  jobId: string;
  label: string;
  front?: ScanSideInput;
  back?: ScanSideInput;
  viewOnly?: string;
}): PhotoSource {
  const loadSource = useAction(api.photoEdits.photoEditSource);
  const saveScanEdit = useAction(api.photoEdits.saveScanEdit);
  const dismiss = useAction(api.photoEdits.dismissPhotoEditFailure);
  const frontImage = useScanUrl(jobId, front?.entryIndex, front?.image?.editVersion);
  const backImage = useScanUrl(jobId, back?.entryIndex, back?.image?.editVersion);
  const frontUrl = frontImage.url;
  const backUrl = backImage.url;
  const frontFailed = frontImage.failed;
  const backFailed = backImage.failed;

  return useMemo(() => {
    const side = (input: ScanSideInput | undefined, url: string | undefined, failed: boolean): PhotoSideSource | undefined => {
      if (!input) return undefined;
      const ref = { kind: "scan" as const, jobId, entryIndex: input.entryIndex };
      const pending = asPendingPhotoEdit(input.image?.pendingEdit);
      return {
        imageUrl: url,
        ...(failed ? { imageFailed: true } : {}),
        previewKey: scanPreviewKey(jobId, input.entryIndex),
        ...(pending ? { pending } : {}),
        ...(viewOnly ? { viewOnly } : {}),
        async load() {
          const raw = (await inWords(loadSource({ ref }), "Couldn't open this photo for editing.")) as RawEditSource;
          return toEditStart(raw, raw.expectVersion ?? 0, openingTurns(input.image?.rotationDegrees));
        },
        async save(edit, start) {
          await inWords(
            saveScanEdit({ jobId, entryIndex: input.entryIndex, edit, expectVersion: (start.guard as number | undefined) ?? 0 }),
            "That edit didn't save. Try again.",
          );
        },
        async dismissFailure() {
          await inWords(dismiss({ ref }), "Couldn't clear that note.");
        },
      };
    };
    return { label, front: side(front, frontUrl, frontFailed), back: side(back, backUrl, backFailed) };
  }, [jobId, label, front, back, frontUrl, backUrl, frontFailed, backFailed, viewOnly, loadSource, saveScanEdit, dismiss]);
}

/** The preview memory's key for a scan, so its tile finds the edit the viewer saved. */
export function scanPreviewKey(jobId: string, entryIndex: number): string {
  return `scan:${jobId}:${entryIndex}`;
}

/** The preview memory's key for a copy's photo. */
export function copyPreviewKey(copyId: string, side: ViewerSide): string {
  return `copy:${copyId}:${side}`;
}
