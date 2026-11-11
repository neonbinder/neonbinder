---
name: settle-on-fake-clock-drifts-on-first-import
description: settleOnFakeClock (lib/testing/bsc-team-lane.ts) steps the fake clock while the first action in a file imports the BSC adapter, moving Date.now() tens of seconds before the item's first read
metadata:
  type: reference
---

`settleOnFakeClock` advances the fake clock 50 ms per loop while it awaits an
action. The FIRST `t.action` into `adapters/buysportscards` in a test file
dynamically imports that big module, and the loop keeps stepping during the
import: the item's first `ctx.runQuery` saw `Date.now()` = NOW + 26 s
(measured). A later action in the file sees ~0 drift (module cached).

So a test that depends on the clock at the item's first read (a 15 s
cooldown window opened at NOW) passes in a full-file run and fails alone
under `-t`, or the other way round when test order changes.

**How to apply:** warm the module first with a throwaway item (seed a card,
delete it, run `runBscTeamCheckItem` → `notNeeded`), then
`vi.setSystemTime(NOW)` and open the window. Verify by logging `Date.now()`
at the first read once; it should be exactly NOW. Related:
[[hold-runafter0-in-convex-test]], [[adapter-retry-pause-is-injected]].
