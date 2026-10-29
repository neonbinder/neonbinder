/**
 * NEO-377 — make a copy photo's two files from the original, in the browser:
 * the listing-sized image (long edge 1600px, eBay's recommended size) and the
 * thumbnail binder pages show. Both JPEG, which every marketplace takes. The
 * original never leaves the device.
 *
 * Mirrors `COPY_PHOTO_LONG_EDGE`, `COPY_PHOTO_THUMB_EDGE` and the byte caps in
 * `convex/copyPhotos.ts`; the server refuses anything over them.
 */

export const COPY_PHOTO_LONG_EDGE = 1600;
export const COPY_PHOTO_THUMB_EDGE = 360;
export const MAX_COPY_PHOTO_BYTES = 3 * 1024 * 1024;
export const MAX_COPY_THUMB_BYTES = 256 * 1024;
/** The originals a collector may pick: what phones, cameras and scanners write. */
export const COPY_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";

export interface ResizedPhoto {
  contentType: "image/jpeg";
  image: Blob;
  thumb: Blob;
}

/** The size to draw at: the long edge capped at `edge`, never scaled up. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= edge) return { width, height };
  const scale = edge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encode(bitmap: ImageBitmap, edge: number, quality: number): Promise<Blob> {
  const size = fitWithin(bitmap.width, bitmap.height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("This browser can't resize photos.");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("This browser can't resize photos.");
  return blob;
}

/**
 * The two files for one side. Rejects with a message to show when the file
 * is not a picture this browser can read (HEIC opens on Safari only).
 */
export async function resizeCopyPhoto(file: File): Promise<ResizedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file isn't a photo this browser can open. Try a JPG or PNG.");
  }
  try {
    const image = await encode(bitmap, COPY_PHOTO_LONG_EDGE, 0.88);
    const thumb = await encode(bitmap, COPY_PHOTO_THUMB_EDGE, 0.8);
    if (image.size > MAX_COPY_PHOTO_BYTES || thumb.size > MAX_COPY_THUMB_BYTES) {
      throw new Error("That photo is too detailed to save. Try another.");
    }
    return { contentType: "image/jpeg", image, thumb };
  } finally {
    bitmap.close();
  }
}
