---
name: pairing-dialog-columns-need-matched-collapsed
description: CardPairingModal's BSC-only / SportLots-only columns sit BELOW the Matched list; Matched starts collapsed only if the FIRST streamed batch had an unmatched card, so a spec must not branch on a column being visible before Confirm is ready; prove Keep all by arithmetic
metadata:
  type: reference
---

The Match Cards dialog body renders Matched first, then the `BSC only (N)` /
`SportLots only (N)` columns with `Keep all BSC-only cards` / `Keep all
SportLots-only cards`. `matchedCollapsed` is `useState(initialData.unmatched*
> 0)`, evaluated ONCE at mount, and the dialog mounts on the first streamed
candidates (NEO-195). So whether the columns start near the body's top
depends on stream order.

**How to apply:** wait for the fetch-done gate first (Confirm reads
`Confirm`, not `Loading…`; since NEO-341 it also waits for the batch's team
lookups), then assert the column headings hard. An `isVisible()` branch on a
column heading taken before that gate can skip Keep all silently; the
retired Maestro seed's guards did exactly that.

Prove Keep all by arithmetic, not by sight: read both column headings and the
footer `N cards will be saved` before, then after the keeps assert footer ==
before + bsc + sl (footer = matched + kept).

No live spec needs this today: NEO-339 found every Topps Chrome insert pairs
100%, so the keep-all flow became `topps-chrome-insert-known-roster-no-wizard`
(no columns). Apply it the day a set with one-sided cards is approved.
