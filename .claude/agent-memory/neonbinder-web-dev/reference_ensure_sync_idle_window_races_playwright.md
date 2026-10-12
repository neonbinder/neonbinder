---
name: ensure-sync-idle-window-races-playwright
description: An empty ensure-path column renders its idle "Sync <X>" button before ensureSelectorOptions writes "syncing", so a Playwright wait on that button (or on "Syncing <X>" hidden) passes while the sync has not started
metadata:
  type: reference
---

On the `useEnsureSync` path a freshly opened empty column has `syncStatus === null` for the few queries `ensureSelectorOptions` runs before its `syncing` write. During that time `newPathContent` renders the idle row, so "Sync Sets" is visible and "Syncing Sets" is hidden. A web-first `toBeVisible`/`toBeHidden` on either passes immediately, and the cold sync is still in flight. Maestro's ~1.85 s per tap hid this.

Consequence seen in NEO-341 (brand-via-all-brands spec): the year-wide set sync reads the year's brands only AFTER its BSC fetch (`listYearSetRows`). A brand created during that fetch gets its sets filed straight under it by prefix. They never sit in Unknown, so the "N sets moved out of Unknown" notice is correctly never written. The planner's guess (a later sync overwrote the notice) was impossible: the populated gate in `ensureSelectorOptions` skips any unforced sync on a non-empty column.

**How to apply:** when a spec's later step depends on a cold sync having FINISHED, wait for its data (a row in the list), never for the idle button. Before blaming a status-row overwrite, check the populated gate, the force callers, and whether the event (here, the rehome) happened at all. Related: [[maestro-web-driver-overhead]].
