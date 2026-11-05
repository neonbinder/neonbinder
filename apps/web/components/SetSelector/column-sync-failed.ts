import { createContext } from "react";

/**
 * NEO-445 — true while the column's own sync has failed outright.
 *
 * `EntityColumn` owns the sync status and draws the error, but the line that
 * says a column is empty lives in `EntitySelector`, which the column receives
 * as a ready-made `selector` element from seven different wrappers. A context
 * reaches it without threading a prop through each wrapper or subscribing to
 * the status a second time.
 *
 * It defaults to false, so a selector rendered outside a column, or under a
 * column on the legacy sync path, behaves as it always has.
 */
export const ColumnSyncFailedContext = createContext(false);
