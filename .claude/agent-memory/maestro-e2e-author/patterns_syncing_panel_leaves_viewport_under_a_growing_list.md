---
name: syncing-panel-leaves-viewport-under-a-growing-list
description: The drill util's `"Syncing Sets" is not visible` return gate is a FALSE "done" on a cold Sets-level sync — the panel sits UNDER the column's list, the BSC phase grows that list to its 400px box within ~2s and pushes the panel past the 625px device height, and the hierarchy prunes it while the SportLots phase (~9–13s) is still running. Gate the end of a sync on the idle `Sync <X>` button AFTER a content precondition, never on the panel's absence.
metadata:
  type: reference
---

# A "Syncing …" panel under a list that fills is not a wait

NEO-237, PR #272 run 35665861484 r6 (`brand-via-all-brands-narrows-sportlots`,
2026-09-21). Every number below was measured, not guessed.

## The geometry (All Brands view, Hockey 1997/1996/1994/1993)
- `EntityColumn` renders `{selector}` (header + search + `max-h-[400px]` list)
  and THEN `newPathContent()` — the "Syncing Sets" panel OR the idle action row
  (`Sync Sets`, pills, "+ Custom"/reason line). Same slot, one or the other.
- Before the BSC phase stores anything the list is empty and the panel's
  `<h2>` sits at doc y≈483. `storeSelectorOptions` lands per bucket ~1–2s after
  the tap; at >8 rows the search box appears and the list becomes 400px, so the
  panel moves to doc y≈883–911.
- After the pinned-entry tap the window is at **scrollY≈238, not the 313 the
  centring reached**: Chrome's scroll anchoring pulls the page back when the
  previous columns collapse to cards (probe dump: root `[0,-238]`). So the panel
  h2 lands at viewport y≈645 — past the 625px device height — and
  `filterOutOfBounds` drops it (see [[maestro-web-driver-primitives]] §3a).
- The pill / `Sync Sets` row is at doc 859 → viewport 621–653: 12% visible, so a
  DOWN `scrollUntilVisible` needs one swipe; the pill itself (624–650) is pruned
  at that scroll.

## What the util's gate therefore does
`runFlow when visible "Syncing Sets" → extendedWaitUntil notVisible` either
- **skips** (local, cold 1993/1994/1997: the `when` never sees the panel, 7.4s
  of `when` cost, no wait at all), or
- **passes falsely** (CI r6: seen at tap+2.3s while the list was short, "not
  visible" 1.0s later once the list had filled).
Either way the flow continues while the SportLots phase (one all-brands POST +
up to 18 brand POSTs; 8.5s on 1996, 11.7s on 1997, ~13s in CI) is still running.
Its writes land right before the status clears, so anything that depends on the
SportLots phase (the skipped-side notice; before 2026-09-22 the done-row count
too) is simply not there yet. (Measured on the `N new on SportLots` pill + `setCandidates` table,
built and removed the same day, 2026-09-21, when Jason ruled a marketplace set
is saved, not offered; the phase now mints the sets directly and the geometry
is unchanged.)

## The gate that works
```yaml
- extendedWaitUntil: { visible: ".*Search sets.*", timeout: 15000 }   # BSC content = the sync STARTED
- scrollUntilVisible: { element: { text: "Sync Sets" }, timeout: 150000 }  # idle row = the sync ENDED
- assertNotVisible: "SportLots skipped: no SportLots ids on this path."     # live: SL WAS asked
```
- The button is rendered only when the status row has left "syncing"
  (`showSyncingPanel` cannot be false any other way in the view: `hasInteracted`
  never latches there because `items` is always `[]` for a year parent).
- The content precondition rules out the ~300ms pre-sync idle window after
  mount — the search box only exists once the sync has stored rows.
- Any done notice is the SAME status-row render as the idle button (both come
  from one `getSelectorSyncStatus` subscription), so it lands with the button,
  not after it — which is what makes reading (or not reading) it at the button
  race-free. (The removed pill had its own subscription and landed one
  round-trip later: 200ms CDP, 0.6s Maestro — the 7000 bar held even then.)
- 150000 is the util's own RETURN CONTRACT ceiling for this sync, relocated —
  record it at the site (R5), do not invent a number.

(The third line used to be the done-row count `N sets added from SportLots.`;
that notice was removed 2026-09-22 — see
[[sync-summary-is-not-a-ui-surface]]. The negative that replaced it is sound
only because the button scroll runs FIRST: it stops at the minimum scroll
that fully reveals the button, so the notice's slot — `SyncDoneNotice`
directly above `idleButtons` — is on screen. An unpaired negative on that
sentence is vacuous; `setup.yaml` had one read "absent" at y≈620, under the
625px fold, on PR #265 run 1.)

## Forensics that settle it in one read
`Sync Sets`/pill present in the failure screenshot ≠ they were present during
the tries: both screenshots are taken AFTER the timeout. Compare the step
timestamps with the sync's measured length from the tap instead, and check the
root's y in the hierarchy dump for the real scrollY.

Related: [[negative-asserts-pass-on-a-dead-page]],
[[inner-scroller-clip-is-invisible-to-maestro]],
[[below-the-fold-asserts-and-bottom-locked-scrolls]],
[[never-diagnose-timing-first]].
