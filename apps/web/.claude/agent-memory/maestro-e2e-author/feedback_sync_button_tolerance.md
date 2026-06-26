---
name: Sync button tolerance — completion signals in set-selector flows
description: How to wait for sync completion at each level; after DB reset, use data-presence guards (not button visibility) because auto-sync races the tap
type: feedback
---

## After a DB reset: use data-presence guards (UPDATED 2026-05-04)

`EntityColumn` auto-fires `setMode("sync")` immediately when a column renders with an empty
items list. On a freshly-reset DB, every level auto-syncs. The "Sync X" button fires and
disappears before a tap can land — `when: visible: "Sync X"` passes the check but the tap
fails "Element not found."

**The correct approach after a DB reset: guard on data indicators, not button visibility.**
See `feedback_sync_form_timing.md` for the full data-indicator table and code patterns.

## When intentionally testing sync (NOT a util/setup flow)

For flows that test sync as a core assertion (e.g., `set-selector-smoke.yaml`,
`custom-entry-survives-resync.yaml`), you CAN directly `tapOn: "Sync X"` — but only AFTER
using `scrollUntilVisible` to confirm the button is there. These flows need to own the
sync interaction explicitly.

Even these flows must use `scrollUntilVisible: "Sync X"` as the completion signal (the
button reappears below the populated list once ALL platforms have merged). Exception: Sets
(`extendedWaitUntil: notVisible: "Syncing Sets"` — "Sync Sets" does not reliably reappear).

**Never use data-item appearance as the completion signal in sync-testing flows** — items
appear when the first platform (usually SL) responds, before BSC data merges in. The button
returning is the correct all-platforms-done signal.

## Do NOT hardcode "Topps" in generic flows

Topps may not be present in SL data for all sport/year combos. Only use Topps as a search
target in flows that specifically require the 2024 Topps Chrome anchor set.

The "+ Custom" button in a populated list may be below the fold — always use
`scrollUntilVisible` before `tapOn: "+ Custom"`.
