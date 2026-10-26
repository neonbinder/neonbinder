/**
 * NEO-367 — a catalog card's Notes: free text that is NB's own data about the
 * card ("short print, about 1:120 packs", "error card, corrected in a later
 * print run", "no team printed on the card").
 *
 * NB data, so the product invariant applies in full: no marketplace value
 * ever fills it in, a sync never writes or overwrites it, and nothing reads it
 * to decide behaviour. Only an admin writes it, through `addCustomCard` and
 * `updateCard`, and both go through `normalizeCardNotes` so the two paths
 * cannot disagree on what they accept.
 *
 * Not to be confused with `collectionCopies.notes`, the collector's own note
 * about one physical copy.
 */
import { ConvexError } from "convex/values";

/**
 * Generous for a paragraph of hobby trivia, small enough that a pasted
 * document cannot ride on every checklist read. The drawer and quick add show
 * a counter (`NotesLengthMeter`), which is UI only; this is the cap.
 */
export const CARD_NOTES_MAX = 1000;

/**
 * Trimmed; blank is `undefined`, which is how a patch deletes the field and
 * how an insert leaves it absent. Over the cap is REFUSED, never cut: a note
 * silently truncated mid-sentence says something the admin did not write.
 *
 * The error names the cap and the length, never the text, because it travels
 * through Convex's error path into the browser console.
 */
export function normalizeCardNotes(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > CARD_NOTES_MAX) {
    throw new ConvexError(
      `Notes are ${trimmed.length} characters; the limit is ${CARD_NOTES_MAX}.`,
    );
  }
  return trimmed;
}
