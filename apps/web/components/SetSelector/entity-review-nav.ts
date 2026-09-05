/**
 * NEO-221 — which review row is on screen, and what the batch adds up to.
 *
 * ## Why this exists at all
 *
 * The wizard used to DERIVE the presented row: `rows.find(r => r.status !==
 * "pending" && !r.decision)`. Nothing pinned it, so the row on screen was a
 * function of the whole batch rather than of anything the operator had done —
 * and `getBatch` is reactive, so the batch changes underneath them. Three ways
 * that bit:
 *
 *  1. **A sibling row settling re-ordered the answer.** A lookup landing on a
 *     row EARLIER in the array made that row the new `find` hit, so the row the
 *     operator was reading swapped out mid-sentence, taking their staged career
 *     teams with it.
 *  2. **A decision could land on the wrong row.** The click handler closed over
 *     `current._id` from the render that drew the button, so a decide issued
 *     just as the presentation moved recorded against a row nobody was looking
 *     at.
 *  3. **There was no way back.** A derived "first undecided" cannot present a
 *     row that already has a decision, so a misclick was permanent for the life
 *     of the batch.
 *
 * The fix is to make the presented row a piece of STATE (`NavState`) that only
 * ever moves for a stated reason, and to put the rule for when it moves here,
 * where it is a pure function of `(rows, nav)` and can be tested without a
 * dialog, a Convex mock or a clock.
 *
 * `explicit` is the whole trick: it records that the OPERATOR chose this row
 * (Back, "Change" in the decided list, "Back to review" after a failed commit)
 * rather than the wizard walking to it. An explicit row stays put even once it
 * carries a decision — that is what makes reviewing your own decision possible
 * — while an implicit one advances the moment it is settled.
 *
 * Deliberately PURE: no React, no Convex, no ids. The row type is structural so
 * a test can hand it three-field literals.
 */

/** The three terminal decisions a review row can carry. */
export type NavDecision =
  | { action: "create" }
  | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
  | { action: "skip" };

/**
 * The slice of an `entityReviewQueue` row this module reads. Structural rather
 * than the generated Doc type so the wizard can pass its rows straight through
 * and a test does not have to fabricate `_creationTime`, `sportValue` and the
 * rest to exercise a counting rule.
 */
export type NavRow = {
  _id: string;
  status: "pending" | "ready" | "error";
  decision?: NavDecision | null;
};

/**
 * `rowId` — the row the wizard is presenting, or null for "nothing to present"
 * (every row settled, or the batch is empty).
 *
 * `explicit` — true when the operator navigated here on purpose. See the header.
 */
export type NavState = { rowId: string | null; explicit: boolean };

/**
 * The first row that is ready to be reviewed: settled (its lookup finished, or
 * failed) and not yet decided.
 *
 * Array order, not sorted: `getBatch` returns insertion order, and NEO-99's
 * pool completes out of order, so "earliest inserted that is ready" is what
 * keeps the sequence stable while lookups stream in. A still-pending row is
 * stepped over rather than blocking on a straggler.
 */
export function nextUndecided<T extends NavRow>(rows: readonly T[]): T | null {
  return rows.find((r) => r.status !== "pending" && !r.decision) ?? null;
}

/** Rows carrying any decision — the wizard's progress numerator. */
export function countDecided(rows: readonly NavRow[]): number {
  return rows.reduce((n, r) => (r.decision ? n + 1 : n), 0);
}

/**
 * Undecided rows whose lookup has not finished.
 *
 * This is the count "Add All Remaining as New" cannot act on (NEO-221 stopped
 * the bulk create from deciding rows the operator has never seen), so it is the
 * number the button has to say out loud.
 */
export function countPendingUndecided(rows: readonly NavRow[]): number {
  return rows.reduce(
    (n, r) => (r.status === "pending" && !r.decision ? n + 1 : n),
    0,
  );
}

/** What the batch will actually do, for the final step's summary. */
export function summarizeDecisions(rows: readonly NavRow[]): {
  created: number;
  linked: number;
  skipped: number;
} {
  let created = 0;
  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.decision) continue;
    if (row.decision.action === "create") created += 1;
    else if (row.decision.action === "link") linked += 1;
    else skipped += 1;
  }
  return { created, linked, skipped };
}

/**
 * The ONE rule that moves the presented row.
 *
 * Returns the SAME object when nothing should move, so the caller's effect can
 * bail on identity (`if (next === nav) return`) and never loop.
 *
 * It advances in exactly three situations:
 *  - nothing is presented yet (`rowId === null`);
 *  - the presented row is gone from the batch (cancelled, swept, or reconciled
 *    away by a resume);
 *  - the wizard walked here (`explicit === false`) and the row has since been
 *    decided — by this operator, or by a bulk action.
 *
 * An explicitly-presented row is never moved off by a decision landing on it.
 * That is the read-only "Decided: …" panel: the operator asked to see this row,
 * so they keep seeing it until they ask for something else.
 */
export function resolveNav<T extends NavRow>(
  rows: readonly T[],
  nav: NavState,
): NavState {
  const presented =
    nav.rowId === null ? null : (rows.find((r) => r._id === nav.rowId) ?? null);

  const stale =
    nav.rowId === null ||
    presented === null ||
    (!nav.explicit && !!presented.decision);
  if (!stale) return nav;

  const nextId = nextUndecided(rows)?._id ?? null;
  // Already sitting on the right answer implicitly — returning a fresh object
  // here would re-render forever for no change.
  if (nextId === nav.rowId && !nav.explicit) return nav;
  return { rowId: nextId, explicit: false };
}

/**
 * How a settled decision reads in the decided list and the read-only panel.
 *
 * Past tense, and "Linked to {name}" rather than "Link to {name}": the live
 * controls own the imperative `Link to {name}` accessible name (it is an E2E
 * matcher and a screen reader's only way to tell two of them apart), so a
 * static history line must not collide with it.
 */
export function describeDecision(
  decision: NavDecision | null | undefined,
  linkedName?: string | null,
): string {
  if (!decision) return "Not yet decided";
  if (decision.action === "create") return "Added as new";
  if (decision.action === "skip") return "Skipped";
  return linkedName ? `Linked to ${linkedName}` : "Linked to an existing record";
}
