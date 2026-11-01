---
name: outbox-rows-per-platform-seq-guarded-clear
description: House shape for a change outbox drained by a slow external push (NEO-370 listingOutbox) — one row per (owner, platform, item), a seq bumped on every upsert, cleared only at the seq pushed
metadata:
  type: project
---

When a table records "this item changed, push it to N external platforms"
and a drainer pushes over the network before clearing:

- **One row per (owner, platform, item)**, not one row per item with a
  flag per platform. Two platform drainers then never write one document
  (no cross-platform OCC rollbacks), `platform` is an index key (no index
  per platform), and a row exists only while work is pending.
- **Upsert always patches**, bumping `seq`. "Skip the write if the row
  exists" loses a change that lands between the drainer's read and its
  delete: the drainer snapshots `seq`, pushes, then deletes only rows whose
  `seq` is unchanged.
- Drainer selects in a QUERY, clears with point reads by id in a mutation
  ([[convex-occ-read-set-is-the-third-budget]]).
- A denormalised grouping key on the row (variant) is a hint; the drainer
  re-reads the item's current parent.

**Why:** NEO-370 (2026-11-01) design; the lost-update race is invisible in
unit tests unless one is written for it.

**How to apply:** any outbox / dirty-list / pending-push table. Its per-user
rows also join both resets ([[transient-side-table-checklist]]).
