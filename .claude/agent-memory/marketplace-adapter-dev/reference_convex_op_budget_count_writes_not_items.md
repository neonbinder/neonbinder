---
name: convex-op-budget-count-writes-not-items
description: Bounding a Convex loop — count operations at the call sites rather than estimating a worst case, budget WRITES not items so a truncated call is finished by replaying the same list, and make a shared dry-run handler pay the write cost too
metadata:
  type: reference
---

Convex counts **one system op per CALL** (`db.get`, an index/search read,
`insert`, `patch`, `delete`, `scheduler.runAfter`). A `.collect()` returning
754 rows is ONE op — document count is a separate budget with its own error.
So the thing to bound is the LOOP, and the house calibration is
`CARDS_PER_COMMIT_CHUNK`'s: **~900 comfortable, ~1,800 straining, ~4,000
failing**.

Three things that were not obvious when applying it (NEO-296,
`setReconciliation.storeReconciledOptions` and `bulkLoad.loadTeams`):

- **Count at the call sites; do not estimate.** Wrap the helper —
  `const lookup = async (s) => { const rows = await findTeamsByFullName(...);
  ops += 2 + rows.length; return rows; }` — so the budget is spent against
  what the row actually read. A worst-case estimate off the alias count charges
  a clean 4-alias row 137 ops for 16 `db.get`s it will never make and cuts the
  chunk 8×. Predicted totals then land EXACTLY (989 and 854 were right first
  run), which makes them assertable in a test.
- **Budget WRITES, not items, when the caller cannot hold a cursor.** An item
  that matches a row and changes nothing costs zero ops (the write-if-changed
  guard), and on a replay every already-stored item is exactly that. Counting
  writes makes truncation *resumable by replay*: the caller re-sends the
  identical list, the stored prefix re-matches by id for free, and the call
  walks into the tail. Counting items would re-spend the whole budget on the
  prefix and never advance — which matters when the caller is a React form
  that cannot be taught to page. To do this the loop needs the patch decision
  BEFORE the deferred write pass: lift the write-if-changed comparison into a
  pure `pendingPatchFor(w)` closure used by both.
- **A dry run sharing the handler must charge the WRITE cost too.** Charge
  `ops +=` outside the `if (mutationCtx)`, not inside. Otherwise the preview
  spends only reads, truncates several rows later than the mutation, and
  reports rows the write run then stops short of — the dry run's one job is to
  predict the write run.

Check the bound BETWEEN rows, never inside one, and always attempt the first
row: the ceiling is then `budget + worst single row`, which is worth writing
into the doc comment as arithmetic, and no legitimate row becomes unloadable.

Related: [[convex-test-read-budget-by-construction]],
[[convex-test-bulk-rows-bypass-children]].
