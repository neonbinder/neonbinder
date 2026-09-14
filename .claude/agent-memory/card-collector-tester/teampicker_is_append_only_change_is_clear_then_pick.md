---
name: teampicker-is-append-only-change-is-clear-then-pick
description: TeamPicker has no "replace" gesture; a collector changes a single team by removing the chip then adding another, so any feature keyed on the previous value must survive a clear-then-pick path.
metadata:
  type: project
---

`TeamPicker` (apps/web/components/SetSelector/TeamPicker.tsx) is append-only:
`addChip` sends `[...value, id]`, `removeChip` sends the filtered list. There is
no swap. With one chip, the natural "change the team" gesture is remove, then
add, which any consumer sees as a clear followed by a fresh pick.

**Why:** NEO-277's set-level Team cascade follows cards whose value equals the
node's PREVIOUS value; a clear stores nothing, so the re-pick's previous is
empty and the cards that carried the old team are counted as overrides and
stay. First flagged in the NEO-277 copy/behaviour consult (2026-09-13).

**How to apply:** when reviewing anything that keys on "what the picker held
before", walk the remove-then-add path explicitly and check the empty-previous
case. Ask for either a replace gesture on single-team rows or a remembered
last value on the row.
