---
name: neo254-same-name-players-via-birth-year
description: Two players can share one name in one sport, and the ONLY UI route is /admin/players "Create anyway" carrying a birth year no existing row has; pickers deliberately never fork. The wizard's "Same name, different people" panel is still not E2E-reachable, for a different reason.
metadata:
  type: reference
---

# Making two same-name players from the UI (NEO-254, commit e77ed10)

`players.createByAdmin` → `adoptOrForkOnCreate` is the only path that will ever
insert a second row under an existing `(nameNormalized, sportId)`:

| candidates | birth year given | outcome |
|---|---|---|
| 0 | any | insert |
| 1 | none | **adopt** (`created:false`, "That player already exists — opened it.") |
| 1 | differs from it, or the row has none | **fork** (`created:true`, "Added `<name>`.") |
| 1 | matches it | adopt |
| ≥2 | matches exactly one | adopt that one |
| ≥2 | matches none, all dated | fork |
| ≥2 | matches none, any undated | refuse |
| ≥2 | none | refuse |

`players.findOrCreate` (every PlayerPicker) is deliberately different: one match
adopts, full stop, because a picker's job is to LINK. With ≥2 it throws
`N players are already filed under <name>. Pick the right one instead of adding
another.` into the picker's `role="alert"`, adding no chip.

Verified by convex-test probe 2026-09-06: A(1960) → B(none, adopts) →
B(1975, forks) leaves two rows, and `findOrCreate` then throws that message.

## Two E2E gotchas this creates

* **`nearMatches` returns EVERY row on the exact key**, so after a fork it
  returns two rows both `confidence: "exact"`. The admin form's
  `panelMatches` filters only the one `exact._id`, so the survivor renders in
  `NearMatchPanel` as a second `Open <name>` — two controls with one accessible
  name. Never `tapOn: "Open <name>"` on a name that has been forked. (The
  wizard avoided this with `candidateLinkLabel`, which folds the birth year
  into the label; the admin form did not get the same treatment — a finding.)
* **The wizard's `SameNamePlayerPanel` is still not reachable in E2E**, and the
  reason is no longer the players table. It needs a *checklist card carrying
  that name*, and a synthetic `Samename<token>` never appears on a marketplace
  checklist while quick-add cards are born LINKED (no `pendingPlayerNames`). So
  the precondition is now makeable and the trigger still is not.

Flow: `apps/web/.maestro/flows/admin/admin-players-same-name-birth-year.yaml`.

Related: [[neo254-undated-career-teams-surfaces]],
[[neo248-wizard-fixture-via-attached-sl-set]].
