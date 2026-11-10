/**
 * NEO-450 — the sentence a set-builder column shows when its own sync has
 * failed outright and it has no rows to show instead.
 *
 * `column` is the column's label: its "Sync <X>" button text without the
 * leading "Sync " ("Variant Types", "Autographs"). The sentence names it so
 * the operator knows which column failed when several are open side by side;
 * the `Sync <X>` button beside it is the retry.
 *
 * The server's own status message stays generic for logs; this is the copy
 * the column renders. Keep this module free of React and Convex imports:
 * Playwright specs import it to assert the same sentence.
 */
export function columnSyncFailedMessage(column: string): string {
  return `Couldn't sync ${column.toLowerCase()} — please try again.`;
}
