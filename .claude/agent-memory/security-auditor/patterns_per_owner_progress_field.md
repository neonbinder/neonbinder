---
name: patterns_per_owner_progress_field
description: Auditing a progress/ledger field written by a long-running action on a per-owner row
metadata:
  type: reference
---

A progress or ledger field on a per-owner row should have: an internal-only writer, patch-only (never insert), guarded by a run id, and a public query that strips the run id.

Also check every sibling write the same run makes (slot fills, settings saves). If one goes through a get-or-create helper, a disconnect mid-run (which deletes the row) lets the run's finish bring the row back with the old account's ids, and a reconnect mid-run lets stale ids fill the new row. Those writes must be patch-only and bound to the same run id. (NEO-415, eBay Set me up.)
