---
name: player-management-counter-reflow
description: On /admin/players, picking a sport blanks the "N matches" counter until the filtered query answers, sliding "Add player" ~110px left and back — a moving-target tap; wait for "0 matches" to be visible again before tapping Add player (five flows share the sequence)
metadata:
  type: reference
---

`PlayerManagement`'s toolbar is `[filter][sport select][counter][Add player]`
and `counter` is `""` while `results === undefined`. Changing the sport
re-keys the search query, so for one round-trip the `<p role="status">`
collapses and "Add player" moves from x≈636 to x≈526, then back.

Signature (CI run 35122900214 / runner 5, `admin-franchises-link-teams`):
log `Tapping on element … text=Add player, bounds=[526,327][626,359]`, the
failure screenshot shows the button at `[636,327]`, the add form never opened
and `New player name` is "not found" two seconds later. A moving-target tap
([[moving-target-tap-and-hierarchy-forensics]]), not a dropped one.

Fix in flows: after `tapOn: "Baseball"` (or any sport), wait
`extendedWaitUntil: visible: "0 matches"` (7000) BEFORE `tapOn: "Add player"`.
The counter can only read "0 matches" again after the reload answered (the
blank is rendered in the click's own React flush), so the wait is the layout
being still. Applied to `admin-franchises-link-teams`, `admin-teams-two-eras`,
`team-management-edit-a-team`, `player-management-add-and-career-history`
and `checklist-wizard-link-team-saves-alias`;
`spine-label/player-team-colors-default-to-longest-tenure` has the same
sequence and was NOT changed (not in scope, never red).

**Second trigger, cross-runner (CI run 35134145689 / runner 1,
`admin-players-same-name-birth-year`):** the Sport `<select>` is content-sized
to its LONGEST option and the option list is a live global query, so another
runner creating or deleting a custom sport (`custom-entry-survives-resync`'s
"Yes, delete" landed between the bounds read and the click) moves "Add player"
by ~110px. No wait can see that coming — wrap the tap in `retry: maxRetries: 1`
against its own result gate (`Add a player`).

Product fix worth asking for: fixed-width Sport select and a reserved-width
counter (or keep the last text while loading) so the toolbar never reflows.
