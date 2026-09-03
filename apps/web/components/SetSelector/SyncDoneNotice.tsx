import type { UnlinkedNotice as Notice } from "./selector-sync-feedback";

/**
 * NEO-211 (plans B + D) — everything a FINISHED sync still has to tell you.
 *
 * Two different things land here, because the backend folds them into one
 * `status: "done"` row and either can arrive without the other:
 *
 *   `message`  — one marketplace could not be reached while the other stored
 *                fine (plan B). A FIXED server-composed string; rendered
 *                verbatim, never rebuilt here.
 *   `notices`  — links this sync detached because a reached marketplace no
 *                longer lists those rows (plan D).
 *
 * They share one box and ONE dismiss control deliberately. A message-only done
 * row is the common partial-failure case, and giving it no way to clear itself
 * would leave a permanent banner over the column; giving each half its own
 * Dismiss would put two of them side by side in a 260-340px column for the case
 * where both arrive together.
 *
 * ## "The marketplace stopped listing these"
 *
 * Jason, 2026-09-03: "just remove BSC from the platform data and alert the user
 * that it was done. No need to track it in the DB." So there is no flag, no
 * staging row and no second screen: the store detaches the link, reports what it
 * detached, and this is the report. Nothing here is recoverable from the
 * database afterwards, which is exactly why it must not be possible to miss.
 *
 * ## Not an error, and not a delete
 *
 * The row, its name and its entire subtree are untouched — only that one
 * marketplace's link went away, and a later sync that returns the set under a
 * new id re-links it by name. So this is AMBER — the same "an unanswered
 * question, nothing broke" register as the suggestions pill and
 * `CardAttentionBadge` — never pink (destructive) or blue (neutral info): an
 * admin who reads "No longer listed on BSC" as "I lost my sets" has been told
 * the wrong thing, and one who scrolls past it as chrome has been told nothing.
 *
 * `role="status"` (implying `aria-live="polite"`) rather than `role="alert"`,
 * for the same reason: it is worth announcing when it appears, but it does not
 * interrupt. At levels 1-5 `EntityColumn` additionally fires the codebase's
 * existing toast pattern (`SetAttributesPanel`'s fixed-position `role="status"`
 * banner) on the syncing→done transition, because that column may well have
 * scrolled out of view by the time the sync lands.
 *
 * ## Dismissable, and the column stays usable behind it
 *
 * Rendered inline above the column's own controls rather than as an overlay:
 * the operator is mid-data-entry, and a modal for "an id changed upstream" would
 * be a stop sign in front of a signpost. Dismissal is per-surface — the column
 * calls the server's dismiss mutation so it does not come back on every
 * re-subscribe; the forms just drop their local copy.
 *
 * ## Maestro
 *
 * Deliberately contains no bare word "Custom": `custom-entry-survives-resync`
 * asserts `text: "Custom"` positioned `rightOf` a row, and a second match in the
 * same column is a resolution hazard.
 */
export default function SyncDoneNotice({
  message,
  notices,
  onDismiss,
  dismissing,
}: {
  /** Server-composed partial-failure text. Rendered verbatim. */
  message?: string;
  notices: Notice[];
  onDismiss: () => void;
  /** Server round-trip in flight (column path); locks the button. */
  dismissing?: boolean;
}) {
  if (!message && notices.length === 0) return null;

  return (
    <div
      role="status"
      // border-amber-700 / dark:border-amber-400/70 (not /60 and /40): composited
      // over this box's own bg-amber-400/10, the /60 and /40 weights measured
      // 2.45:1 (light) and 2.57:1 (dark) — both fail WCAG 1.4.11's 3:1 non-text
      // minimum. This is the same pairing EntityColumn's suggestions pill
      // already uses (4.75:1 light / 4.96:1 dark).
      className="p-3 mb-1 bg-amber-400/10 border border-amber-700 dark:border-amber-400/70 rounded-md text-amber-800 dark:text-amber-300 text-sm flex items-start justify-between gap-2"
    >
      <div className="min-w-0 space-y-1">
        {message && <p className="break-words">{message}</p>}
        {notices.map((n) => (
          <p key={n.side} className="break-words">
            {n.text}
          </p>
        ))}
        {/* The reassurance is the point of the unlink notice, not decoration on
            it: "no longer listed" reads as "deleted" unless we say otherwise.
            Scoped to the unlink half — it makes no sense over a message that is
            only reporting an unreachable marketplace. */}
        {notices.length > 0 && (
          <p className="text-xs opacity-80">
            These are still yours — only the marketplace link was removed.
          </p>
        )}
      </div>
      <button
        type="button"
        // aria-disabled, not disabled: the column's own dismiss round-trip is
        // moot in every current caller (the notice already unmounts on the
        // same render the optimistic local dismiss lands), but a future
        // caller that keeps this visible while `dismissing` is true must not
        // hit the native-disabled-strands-focus bug this codebase keeps
        // finding one button at a time.
        onClick={dismissing ? undefined : onDismiss}
        aria-disabled={dismissing || undefined}
        aria-label="Dismiss notice"
        // px-2 py-1.5 (not px-1, no py): a bare underline link with no
        // vertical padding measures well under WCAG 2.5.8's 24px minimum
        // target size.
        className="shrink-0 text-xs underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-[#00B7FF] rounded px-2 py-1.5 aria-disabled:opacity-50"
      >
        Dismiss
      </button>
    </div>
  );
}
