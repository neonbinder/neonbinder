/**
 * NEO-496 — the line a marketplace pane shows when the fetch never asked that
 * side (the result's `skippedSides`: no marketplace id on the set's path).
 * "Returned no base set" / "Nothing pending" would claim an answer nobody
 * got. Map Base Set and Reconcile both read it from here, so a wording change
 * is one edit. A PAUSED side has its own sentence (`PAUSE_NOTICE_COPY.pane`),
 * which wins over this one.
 *
 * `side` is the pane's own short name; `setName` the set as the operator
 * reads it, or nothing when the caller has none.
 */
export function unaskedSideCopy(side: "BSC" | "SportLots", setName?: string | null): string {
  const set = setName?.trim() || "this set";
  return `${side} wasn't asked: ${set} has no ${side} link.`;
}

/** The pane's short name for a slot side. */
export function unaskedSideName(side: "bsc" | "sportlots"): "BSC" | "SportLots" {
  return side === "bsc" ? "BSC" : "SportLots";
}
