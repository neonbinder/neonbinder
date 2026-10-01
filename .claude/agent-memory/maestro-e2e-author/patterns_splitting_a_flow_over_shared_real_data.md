---
name: splitting-a-flow-over-shared-real-data
description: Before splitting one long real-set flow into concurrent flows, measure each brand/set-wide write's row set AND each dialog that saves a client-side snapshot — a reconcile seeded with every existing row re-creates a row another flow just moved
metadata:
  type: feedback
---

When a sole-writer flow on a real brand-year gets too long (NEO-312: 570 s of
the 600 s kill) and is split into flows the queue runs CONCURRENTLY, the
server-side write sets are rarely the problem; client-side SNAPSHOT SAVES are.

**Why:** in the 2026 Bowman split, every server write was disjoint or a
set-union (`children` unions, changed-fields-only patches, subtree rows held),
yet one pair still clobbered: `Sync <Type>s` opens a ReconciliationModal that
seeds EVERY existing row of that variant type into Ready, and its save matches
each item's `existingId` against that type's own children only. A Make insert
of… that moved (created-new + deleted-source) one of those rows into another
variant type while the dialog was open makes the save re-create it — two NB
rows on one marketplace link. Held-elsewhere protection is per variant type,
so it does not see across types.

**How to apply:**
- List every brand/set-wide write in the flow and, per write, (a) the rows it
  touches (cite file:line) and (b) whether its client computed a plan or list
  before saving. (b) is where the overlaps hide: reconcile modals, Group
  Parallels plans, any dialog's reactive target list.
- A pair with a stale-snapshot clobber goes in ONE flow, in the order the
  merged flow proved. A pair that only reshapes a reactive list under a tap is
  a UI race: retry the pick once, result-keyed (gate on the fold/selection,
  erase the filter before re-typing).
- A brand-wide write BOTH halves need (Sync Sets + the SportLots review) moves
  into `setup.yaml`, which runs alone; also give the seed the paused-mode
  manufacturer row and Variant Types, and strip `CREATE_MANUFACTURER` from the
  concurrent flows (two guarded creates can both create).
Related: [[per-worker-data-isolation]], [[guard-then-tap-toctou]].
