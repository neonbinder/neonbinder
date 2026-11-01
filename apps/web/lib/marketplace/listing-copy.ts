/**
 * NEO-370 — the listing words said on more than one screen: the Profile's
 * BuySportsCards panel (where listing starts) and the inventory's Sync
 * button and Sync status tab. One place, so a sentence reads the same
 * everywhere. NB voice: short, plain, a little rad; never an internal word
 * ("outbox", "lease", "drain", "SKU").
 */

/** The platform's name as a collector reads it. */
export const BSC_NAME = "BuySportsCards";

/** Where a collector saves (or renews) their marketplace sign-in, and starts listing. */
export const CREDENTIALS_PATH = "/profile/credentials";

/**
 * What starting to list does to listings the collector already has on BSC,
 * said before they press Start: NB's box count wins, including 0.
 */
export const CONSENT_LINE =
  `Starting sets every card you already list on ${BSC_NAME}, in any set you have in your boxes, to your box counts. A card that isn't in a box, or sits in an in-person box, goes to 0.`;

/** The seller account lists from another NB account: said wherever listing's state is. */
export const SELLER_CONFLICT_LINE = `That ${BSC_NAME} seller account already lists from another NeonBinder account, so nothing goes up or comes in from this one.`;

/** BSC is paused for everyone (NB's switch): changes wait, nothing is lost. */
export const PAUSED_LINE = `${BSC_NAME} is on a break. Your changes wait here and go up when it's back.`;
/** Start pressed while NB has paused the platform: nothing started. */
export const PAUSED_START_LINE = `Hold up: ${BSC_NAME} is on a break, so listing didn't start. Press Start again once it's back.`;

/** The saved sign-in died: nothing goes up until they sign in again. */
export const REAUTH_LINE = `Your ${BSC_NAME} sign-in ran out, so nothing goes up until you sign in again.`;

/** "Nov 1, 2026". */
export function listingDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
