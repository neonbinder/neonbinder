---
name: blocked-parallel-via-a-collector-copy
description: How to reach a BLOCKED base parallel in the Parallels of Base section on seeded data (no natural block exists under the SportLots pause) — a Have on one of the built parallel's cards, the list and ledger strings, and the cleanup
metadata:
  type: pattern
---

The seed's 2024 Topps Chrome parallels are all buildable (paused or not), so a
blocked parallel has to be made. The honest route is the collector guard
(NEO-358): mark ONE card of a parallel that has cards Have through the real
`/collection` (`drillToCollectorChecklist` with `checklist: { type: "Parallel",
name }`, Binder → Main, wait for `Added <short> to Main`). The plan query then
marks it blocked; a rebuild never deletes a collector's card.

Strings (lib/collection/collectors.ts, one collector, sampled read so "a collector"):
- section attention item: `<P> — blocked: a collector owns copies of its cards, and a rebuild would pull those cards out from under them`
- summary sentence ends `... 1 is blocked.`; the button still says `Build <total> parallels from Base`
- Replace confirm counts only buildable parallels with cards: `Replace the cards on <withCards-1> of <total> ...`
- ledger line, shown before the run sends anything: `<P> — Blocked — <same reason>`; the stopped heading counts built only (`stopped after 1 of <total>`)

Scope both lines with `region "Parallels of Base"` + `getByRole("listitem").filter({hasText})`
(`hasText` is a case-insensitive substring; ":" vs " —" keeps the two apart).

The list samples a parallel's EARLIEST 200 cards; the first row of the collector
checklist was inside that sample on a fresh build. A second run, stopped after
one, writes the NEXT parallel — widen the registry claim. Remove the copy in a
`finally` (drawer → `Your copies of <short>` → `Remove <short>, Raw, Excellent`,
wait for `Removed ...`), or that parallel stays blocked for every later run.

Planted break that proves it: drop the Have click + notice; the spec reds at the
attention item. Related: [[collector-insert-checklist-names]], [[patterns-finally-cleanup-without-an-isvisible-branch]]
