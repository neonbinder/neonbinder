/**
 * Ceilings a checklist commit is held to, shared by the server that enforces
 * them and the UI that must not hand over more than they allow.
 *
 * Here rather than in `convex/selectorOptions.ts` for the reason
 * `lib/players/name-limits.ts` exists: a component cannot import a Convex
 * module (it would pull the whole backend into the browser bundle), and a
 * second hand-written copy of the number is a cap that silently drifts out of
 * agreement with the one that actually throws.
 */

/**
 * NEO-203 — hard ceiling on how many rows one commit may be told to delete.
 *
 * A client-side cap is advisory, and a direct API call must not be able to
 * hand a single transaction an unbounded delete list. Deletion is an explicit
 * operator decision (see `commitCardChecklistFinalize`), and an operator
 * confirming a thousand deletions in one pass is already far beyond anything
 * the review UI produces.
 *
 * NEO-294 — and now the UI honours it too. `SyncReviewModal`'s "Select all"
 * used to seed the delete list from the WHOLE orphan array with no cap, so a
 * large re-sync could hand finalize more ids than it accepts — and the refusal
 * landed after every card chunk had already written, which is the worst place
 * to discover it. The modal caps its own selection at this number and says so.
 */
export const MAX_OPERATOR_DELETE_IDS = 1000;

/**
 * NEO-296 — how many card numbers one `addCrossListingsByCardNumbers`
 * transaction resolves and links.
 *
 * Here rather than in `convex/selectorOptions.ts` for the same reason
 * `MAX_OPERATOR_DELETE_IDS` is: `CrossListingImportModal` slices its paste
 * against this number and the mutation refuses above it, so the two must be
 * one constant. A component cannot import a Convex function module without
 * pulling the backend into the browser bundle.
 *
 * The arithmetic lives on the mutation, which is where the operations are
 * spent: ~2 per number (an indexed read on the source set, plus an insert),
 * so 400 is ~800 against the ~900 the house treats as comfortable.
 */
export const CROSS_LISTING_LINKS_PER_CALL = 400;
