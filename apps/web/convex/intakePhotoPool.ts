/**
 * NEO-427 — the queue a scanned pair's photos wait on. `saveIntakeMatch` and
 * `beginIntakePhotoRetry` enqueue `intakePhotos.attachIntakePhotos` here.
 *
 * Kept in its own module for the reason placeholderPool.ts is: this is the only
 * file that touches `components.intakePhotoPool`.
 *
 * WHY IT EXISTS: a "Save all" on a run of 500 cards is 500 attaches at once. An
 * ordinary attach reads stored sizes from the placeholder bucket and calls no
 * service, but a side without them falls back to `/derive-copy-photos`, on the
 * service `fastPreprocessPool` already fills to its instance ceiling. A run
 * processed before the sizes were stored is every side, 1,000 calls. Run straight
 * from the saves, they would take the instances from the run's processing and be
 * shed with 429s.
 *
 * WHY THE WIDTH: sized for that fallback. An attach's sides run together but ask
 * the service one at a time (`intakePhotos.oneAtATime`), so it holds at most one
 * FAST instance and this width is the most this pool can take. A quarter of the
 * ceiling leaves the rest to processing (prod 5 of 20). The floor of 2 is for dev and previews (2 of 3), whose small ceiling would
 * otherwise leave one lane; their volume is low, and `fastPreprocessPool`'s retries
 * cover a rare 429. At an estimated 3 seconds an attach through the fallback (not
 * measured), prod clears 500 cards in about 5 minutes, inside
 * `INTAKE_PHOTO_ATTACH_TIMEOUT_MS`; a success after that timeout still lands. An
 * attach that reads its sizes takes less.
 *
 * NO POOL RETRIES: `attachIntakePhotos` never throws, and a fallback derive inside
 * it has its own two tries, so this pool's would never fire. `retryActionsByDefault`
 * stays off to say so, and a retry could not multiply those two.
 */

import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";
import { PREPROCESS_MAX_PARALLELISM } from "./preprocessCapacity";

/** The pool's width for a FAST ceiling. */
export function intakePhotoParallelism(fastCeiling: number): number {
  return Math.max(2, Math.floor(fastCeiling / 4));
}

export const INTAKE_PHOTO_MAX_PARALLELISM = intakePhotoParallelism(PREPROCESS_MAX_PARALLELISM);

export const intakePhotoPool = new Workpool(components.intakePhotoPool, {
  maxParallelism: INTAKE_PHOTO_MAX_PARALLELISM,
  retryActionsByDefault: false,
});
