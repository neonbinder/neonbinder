/**
 * NEO-339 — what an operator-authored listing title must be before it is
 * saved: not blank, and within `LISTING_TITLE_MAX`.
 *
 * One rule, three enforcement points that must agree: `selectorOptions.
 * updateCard` (the server, which refuses), and the two surfaces that write a
 * title through it — the attention walker's `TitleFixer` and the card drawer
 * — plus the set-building tool's title answer, which say so before the write.
 * The sentences are the server's, so the operator reads the same words
 * whichever side caught it.
 *
 * Pure and env-free, relative imports only, so the Convex runtime, the browser
 * bundle and a Node script can all load it.
 */

import { LISTING_TITLE_MAX } from "../../convex/features/listingLimits";

/** DRAFT copy (NB voice). */
export const BLANK_LISTING_TITLE_MESSAGE = "A card title can't be blank.";

/** The over-length sentence, with the length and the cap and never the title. */
export function listingTitleTooLongMessage(length: number): string {
  return `Listing title is ${length} characters; the limit is ${LISTING_TITLE_MAX}.`;
}

/**
 * Why this title cannot be saved, or null when it can. Trims first: trailing
 * whitespace the operator cannot see is neither stored nor counted, and a
 * title of nothing but spaces is blank.
 */
export function listingTitleRefusal(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === "") return BLANK_LISTING_TITLE_MESSAGE;
  if (trimmed.length > LISTING_TITLE_MAX) return listingTitleTooLongMessage(trimmed.length);
  return null;
}
