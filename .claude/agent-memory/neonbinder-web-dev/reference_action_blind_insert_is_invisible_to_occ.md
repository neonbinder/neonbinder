---
name: action-blind-insert-is-invisible-to-occ
description: An action's write mutation that inserts without reading the range it competes for cannot conflict with a concurrent writer; re-check status and read the range INSIDE the write. How to reproduce the interleave in convex-test.
metadata:
  type: reference
---

An internalAction that reads (runQuery), computes, then writes (runMutation) has a
read→write gap of its own. If the write mutation BLIND-INSERTS (reads nothing),
Convex OCC has nothing to conflict on, so a mutation that commits inside the gap
(e.g. an inline finalize on a close path) and the action both write the same rows.
A start-of-action status check does not help; it is a different transaction.

Fix shape (NEO-325, placeholder pairing):
- Pass the run's flags into the write mutation and re-read the job there; no-op
  and return `stale: true` when it left the writable statuses; the action stops.
- Make the insert idempotent inside the mutation by reading the owning range
  (`by_job`) and skipping rows already claimed. That read also puts the range in
  the read set, so a concurrent insert now forces an OCC retry.
- Anything stamped from the action's own belief (a status flag on the image row)
  must be checked against the table in the same transaction once inserts can skip.

Reproducing it deterministically in convex-test: do not try to pause the action.
Drive its steps by hand — `t.query` the same internal queries, call the exported
pure diff, run the competing mutation, then `t.mutation` the write with the diff.
Swap HEAD's module in briefly to confirm it goes red; restore and `cmp`.

Related: [[reference_occ_window_moves_to_a_query_behind_an_action]].
