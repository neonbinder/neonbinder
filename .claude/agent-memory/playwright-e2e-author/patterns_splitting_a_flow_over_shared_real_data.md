---
name: splitting-a-flow-over-shared-real-data
description: Before splitting one long real-set spec into concurrent specs, measure each brand/set-wide write's row set AND each dialog that saves a client-side snapshot — a reconcile seeded with every existing row re-creates a row another spec just moved
metadata:
  type: feedback
---

When a sole-writer spec on a real brand-year gets too long and is split into
specs the shards run CONCURRENTLY, the server-side write sets are rarely the
problem; client-side SNAPSHOT SAVES are.

**Why:** in the 2026 Bowman split, every server write was disjoint or a
set-union, yet one pair still clobbered: `Sync <Type>s` opens a
ReconciliationModal that seeds EVERY existing row of that variant type into
Ready, and its save matches each item's `existingId` against that type's own
children only. A Make insert of... that moved (created-new + deleted-source) one
of those rows into another variant type while the dialog was open made the save
re-create it: two NB rows on one marketplace link. It was a PRODUCT bug, not only
a race (a plain later `Sync <Type>s` after the move re-created the row too);
NEO-312 fixed it with a whole-set/brand held check at save. When a split exposes
a cross-spec clobber, ask whether one spec alone can trigger it; if so, file it
and write the regression step, and keep the sequencing anyway.

**How to apply:**
- List every brand/set-wide write in the spec and, per write, (a) the rows it
  touches (cite file:line) and (b) whether its client computed a plan or list
  before saving. (b) is where the overlaps hide: reconcile modals, Group
  Parallels plans, any dialog's reactive target list.
- A pair with a stale-snapshot clobber goes in ONE spec, in the order the merged
  spec proved. A pair that only reshapes a reactive list under a click is a UI
  race: retry the pick once, result-keyed (assert the fold/selection, clear the
  filter before re-typing).
- A brand-wide write BOTH halves need (Sync Sets + the SportLots review) moves
  into the seed (`setup.spec.ts`), which runs alone; also give the seed the
  paused-mode manufacturer row and Variant Types, and strip guarded creates from
  the concurrent specs (two guarded creates can both create).
Related: [[patterns_per_worker_data_isolation]].
