---
name: entity-column-shapes-and-cold-sync
description: Two EntityColumn facts that break drills — the search input appears only ABOVE 8 entries, and an empty column shows its idle Sync button BEFORE the sync starts
metadata:
  type: project
---

# Selector column shapes, and why "Sync <X> is visible" is not "the column has data"

Verified live against dev on 2026-09-03 (NEO-211) with deliberate-failure probes.

## 1. The search input needs MORE THAN 8 entries

`EntitySelector.tsx`: `const showSearch = sortedItems.length > 8;`

Several comments in `flows/set-selector/` say "more than one entry" — that is
wrong and has been wrong for a while. A three-set column (e.g. Hockey → 2024 →
Topps) renders **no** search input, so a drill that waits on `".*Search sets.*"`
hangs there for its full timeout.

**How to apply:** any drill step for a column whose entry count you have not
measured needs BOTH shapes — filter-then-`below: {id: "Search <x>"}`, and a
direct `below: {text: "<Column header>"}` tap. Gate the second branch on the
NEXT column's header (never on the search input: selecting a row collapses the
column and removes the input, so both branches would fire).

## 2. An empty column renders its idle buttons BEFORE the sync starts

`EntityColumn.newPathContent()` shows the `Syncing <X>` panel only while
`selectorSyncStatus.status === "syncing"`. A cold, empty column renders
`Sync <X>` + `+ Custom` **immediately**, and only switches to the panel once
`ensureSelectorOptions` has round-tripped (~300ms later). So a settle gate of
`visible: "Sync Sets"` passes in the first fraction of a 60s fetch — measured:
a probe dumped a completely empty Sets column at exactly that moment.

**How to apply** — the cold-column settle pattern (see
`util-drill-to-cold-real-set.yaml`):

```yaml
- runFlow:
    when: { visible: "Syncing Sets" }        # catches the panel if one started
    commands:
      - extendedWaitUntil: { notVisible: "Syncing Sets", timeout: 150000 }
- extendedWaitUntil: { visible: ".*Search sets.*|<THE VALUE>", timeout: 60000 }
```

The `when:` guard costs one full poll on a warm column; that is the documented
R10 exception, and it is much cheaper than the alternative (asserting against an
empty column). The content gate's alternation covers both shapes from §1 — but
the VALUE must not full-string-match an ancestor's collapsed chip, or the gate
is satisfied before the column loads.

## Enumerating a column's real contents

Maestro cannot print. To find out what a marketplace actually returned, add
`- assertVisible: "ZZZ-DUMP-<thing>"` (or `extendedWaitUntil` with a long
timeout when you also need to wait out a sync) and read the failing step's
`screen-hierarchy/*.json`. That dump is the only way to see a column's rows
without a running app you can inspect. Note it lists only nodes that are not
clipped by an inner `overflow-y-auto` container, so filter the column first when
the list is long.

Related: [[cold-real-set-drill-and-hockey-fixture]],
[[local-validation-needs-a-pr-preview]].
