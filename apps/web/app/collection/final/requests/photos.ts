import type { Id } from "@/convex/_generated/dataModel";

/** What the server takes (`collectionRequests.checkPhoto`): a photo type, at most 10 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Why a picked file can't go up, or null when it can. */
export function photoProblem(file: File): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return "That file isn't a photo. Add a JPG, PNG, WebP or HEIC.";
  if (file.size > MAX_PHOTO_BYTES) return "That photo is over 10 MB. Add a smaller one.";
  return null;
}

/**
 * Upload one photo to Convex file storage: ask for a one-time URL, POST the
 * bytes to it, and hand back the storage id the request mutation takes.
 */
export async function uploadPhoto(
  generateUploadUrl: () => Promise<string>,
  file: File,
): Promise<Id<"_storage">> {
  const url = await generateUploadUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!res.ok) throw new Error("That photo didn't upload. Try adding it again.");
  const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
  return storageId;
}
