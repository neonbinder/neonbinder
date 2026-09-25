---
name: set-shape-doors-need-both-source-shapes
description: After NEO-305's flagship absorb, a brand-year whose BSC list carries the bare brand never mints a SportLots-only set; every "Brand X" SL name lands in the flagship's Parallels reconcile instead. Any operator door that moves an SL link must accept both the leftover SL-only set AND the row the Parallels reconcile makes, and an E2E source for such a door can only come from that reconcile (sole-writer conflict).
metadata:
  type: project
---

Under a brand-year where BSC lists the bare brand (2026 Bowman lists "Bowman"),
`routeSlSets` with `flagshipAbsorbs` writes NO SportLots-only set: every SL
entry extending the prefix is counted as a flagship parallel and offered in the
flagship's Parallels reconcile. So an SL-filed "set" seen on prod (e.g. an
insert's parallel filed as a set) is a pre-NEO-305 leftover, and the same data
on a fresh preview arrives as an insert-level row under the Parallel type
(made by "Make its own set" in the reconcile), or not at all.

**Why:** planning NEO-306 ("Make insert of…") the obvious fixture — Sync Sets
minting the SL set on 2026 Bowman — cannot exist on a fresh preview; the only
in-flow source is the Parallel reconcile, which one flow already owns
(sole writer, fresh-only).

**How to apply:** a door that moves an SL link off a "wrongly filed" row needs
two source shapes (SL-only set+Base; insert-level row under a parallel-role
type). Its E2E either extends the flow that owns the reconcile or needs a new
real brand-year with NO bare-brand flagship on BSC, measured first. Shared
move helpers (cards follow their slot, links never dropped, empty rows deleted
through `deleteEmptySelectorOptionRow`) belong in one module both doors import.
