---
name: pin-tests-need-a-bypass-plant
description: The *.pin.test.ts files scan source text, so a planted throw inside a helper leaves them green; prove a pin with a planted bypass (a direct delete/insert elsewhere, or a removed call inside the helper)
metadata:
  type: reference
---

`cardPlayerLinks.pin`, `cardTeamLinks.pin` and `cardCounts.pin` read the
convex/*.ts sources with regexes (every card delete goes through
`removeCardRow`, the helper calls `deleteCard*Links` / `ledger.removeCard`).
A `throw` at the top of `removeCardRow` reddens ~35 behaviour tests across 12
files but no pin test.

**Why:** found while proving the NEO-358 delete guard: the planted throw was
the wrong plant for the pins.

**How to apply:** for a behaviour proof, plant a throw. For a pin proof, plant
what the pin forbids: e.g. an exported helper doing `ctx.db.delete(card._id)`
outside `removeCardRow`, or drop a required call from the helper. Back the
file up to the scratchpad first and confirm a byte-exact restore with `diff`
and `shasum` (never `git stash` in a shared worktree).
