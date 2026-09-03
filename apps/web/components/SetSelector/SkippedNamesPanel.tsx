import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "../../lib/errors/user-facing-message";

/**
 * NEO-212 — the visible, undoable record of "Skip — not a person/team".
 *
 * ## Why this exists
 *
 * The review wizard's third decision writes an `entityReviewSkips` row, and
 * resolution then filters that name out of every later fetch of the SAME set,
 * forever. That is the point — junk like "Checklist" or "Team Card" should
 * stop being asked about — but it makes a skip the one decision in this
 * feature that is invisible after the fact and silently suppresses real data
 * if it was wrong. The security review would not accept a suppression list
 * with no way to see it or take it back, so this panel is that way: read the
 * set's skips, and delete one to put the name back in the queue.
 *
 * Deleting the row IS the undo. Nothing re-opens the wizard here — the name
 * simply stops being filtered, so it re-enters the review queue the next time
 * the set is synced. The copy says exactly that, because "Unskip" on its own
 * reads like it might do something immediately.
 *
 * ## Design
 *
 * - **No chrome in the common case.** A set with no skips (nearly all of them,
 *   nearly all the time) renders literally nothing — an empty "Skipped names
 *   (0)" disclosure sitting under the sync controls forever would be pure
 *   noise on the one screen that is already dense.
 * - **A native `<details>`, not a modal and not a custom disclosure.** It is
 *   keyboard-operable and correctly announced with zero JS, and — per the
 *   NEO-102 rule this feature already follows — nothing here may open itself
 *   off a background event. The operator presses the summary; the count is
 *   advertised in its label so they can decide whether it is worth opening.
 * - **The undo announces, and it does not lie about timing.** `role="status"`
 *   (polite) for the success line, `role="alert"` for a failure, mirroring the
 *   status/alert pair CardChecklist's sync banner uses.
 * - **The status line outlives the list.** Unskipping the LAST row empties the
 *   query, which would unmount the whole panel and take the unannounced
 *   confirmation with it. So when a message is pending and the list has gone
 *   empty, the bare status line stays behind on its own.
 */

/**
 * Mirrors `entityReviewSkips.listForSet`'s `returns` validator field for
 * field. Note what is NOT here: `skippedByUserId` is deliberately withheld by
 * that validator — the operator needs to know what is suppressed, not who
 * suppressed it — and `batchId` is the log handle offered in its place.
 */
type Skip = {
  _id: Id<"entityReviewSkips">;
  kind: "player" | "team";
  name: string;
  skippedAt: number;
  batchId?: string;
};

/** Same shape as the "Last synced" line above this panel, minus the clock. */
function formatSkippedAt(skippedAt: number): string {
  return new Date(skippedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function SkippedNamesPanel({
  selectorOptionId,
}: {
  selectorOptionId: Id<"selectorOptions">;
}) {
  const skips = useQuery(api.entityReviewSkips.listForSet, {
    selectorOptionId,
  }) as Skip[] | undefined;
  const clearSkip = useMutation(api.entityReviewSkips.clearSkip);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which row is mid-request. Guards a double-press only; the button stays
  // focusable while it runs (see the aria-disabled note on the button).
  const [pendingId, setPendingId] = useState<string | null>(null);
  const summaryRef = useRef<HTMLElement>(null);

  const rows = skips ?? [];

  const unskip = async (skip: Skip) => {
    if (pendingId) return;
    setPendingId(skip._id as unknown as string);
    setError(null);
    setStatus(null);
    try {
      await clearSkip({ skipId: skip._id });
      setStatus(`Unskipped ${skip.name} — it will be reviewed on the next sync.`);
      // The row this button belongs to is about to disappear from the reactive
      // query, so focus would fall to <body>. Park it on the disclosure the
      // operator opened, which is the nearest thing that survives.
      summaryRef.current?.focus();
    } catch (e) {
      setError(
        userFacingMessage(
          e,
          `Couldn't unskip ${skip.name}. Try again.`,
        ),
      );
    } finally {
      setPendingId(null);
    }
  };

  // Still loading, or genuinely nothing skipped for this set — and nothing to
  // announce either. Render no chrome at all.
  if (rows.length === 0 && !status && !error) return null;

  const message = (
    <>
      {status && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-blue-800 dark:text-blue-200">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-pink-800 dark:text-pink-200">
          {error}
        </p>
      )}
    </>
  );

  // The last skip was just cleared: keep only the live-region line, so the
  // confirmation is not unmounted before it is read.
  if (rows.length === 0) {
    return <div className="mb-3">{message}</div>;
  }

  return (
    <details className="mb-3 text-sm">
      <summary
        ref={summaryRef}
        // The count is on the accessible name as well as the visible text so a
        // screen-reader user hears what this hides before opening it, and the
        // suffix says what "skipped" MEANT — the wizard's wording, not a
        // generic "hidden".
        aria-label={`Skipped names (${rows.length}) — not players or teams`}
        className="cursor-pointer select-none py-1.5 text-gray-600 dark:text-gray-400"
      >
        Skipped names ({rows.length})
      </summary>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        These names were marked not a person or team and will not be offered
        again for this set. Unskip a name to review it on the next sync.
      </p>

      <ul aria-label="Skipped names" className="mt-2 list-none space-y-1 p-0">
        {rows.map((skip) => (
          <li
            key={skip._id as unknown as string}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-gray-700 dark:text-gray-300">
              {`${skip.name} · ${skip.kind} · skipped ${formatSkippedAt(skip.skippedAt)}`}
            </span>
            <button
              type="button"
              // aria-disabled rather than `disabled`: this is the control the
              // operator just pressed, and natively disabling it mid-request
              // would blur focus to <body> — the focus-park failure NEO-189
              // called out. The handler's own `pendingId` guard is what stops
              // the second press.
              aria-disabled={pendingId ? true : undefined}
              aria-label={`Unskip ${skip.name}`}
              onClick={() => void unskip(skip)}
              className={`rounded-sm px-2 py-1 font-semibold underline decoration-dotted hover:decoration-solid ${
                pendingId ? "opacity-60" : ""
              }`}
            >
              Unskip
            </button>
          </li>
        ))}
      </ul>

      {message}
    </details>
  );
}
