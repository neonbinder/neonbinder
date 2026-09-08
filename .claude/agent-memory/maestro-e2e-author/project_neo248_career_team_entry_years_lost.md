---
name: neo248-career-team-entry-years-lost
description: "FIXED 2026-09-06 (71f23a4 + c657a57). 'Add career team' still hops to the typed team's own New Team step — that is by design — but the years now survive it. How to walk the hop in a flow, and the auto-add deferral that came with the fix."
metadata:
  type: project
---

**RESOLVED — see the bottom of this note.** Pressing **Add career team** with a hand-typed team name on a player row moves
the wizard to that team's own `New Team` step before the staged chip ever
renders, and the from/to years typed alongside it are lost.

**Why:** `EntityReviewWizard`'s `CareerTeamEntry onAdd` stages the entry into
local `stagedCareerTeams` *and* calls `stageCareerTeams({careerTeamNames:[name]})`
server-side. The inserted team row is `source.kind === "careerTeamOf"` for this
player, so `waitingOnStagedTeams(player, rows)` is true and `resolveNav` moves
off the player. The row-change effect then runs `setStagedCareerTeams([])`, and
the mutation was never sent the years — only the name — so nothing holds them.

**Measured**, twice, on two different sets (Topps Big League and the
career-team-commits set), against the merged #235 preview:
type name + 2001 + 2005 → Add → `New Team: <typed name>` visible → `Add as New
Team` → back on the player row → `"<typed name> (2001–2005)"` **not visible**.
All three assertions pass, i.e. the loss is deterministic.

**How to apply:** `checklist-wizard-career-team-entry.yaml` and
`checklist-wizard-career-team-commits.yaml` are RED for this reason and each
carries a `⛔ BLOCKED ON A PRODUCT FINDING` header. Do not "fix" them by
asserting the lossy behaviour — that writes the defect down as correct. They go
green once the product keeps the operator on the row (or persists the years).
Note the code path the fix probably wants: typing a name that already resolves
to an existing team inserts nothing and so does NOT navigate.

## Resolved (71f23a4, c657a57)

The **navigation is unchanged and expected** — a hand-typed club still mints its
own `New Team` step and the walk still goes there. What changed is that the
years survive it: `stageCareerTeamRows` stores them on the staged step as
`source.manualStint`, and the chip list is keyed by player review-row id
(`stagedCareerTeamsByRow[current._id]`) instead of being a bare array the
presented-row effect wiped.

**So a flow must WALK the hop, never assert around it:**

    Add career team
    → extendedWaitUntil visible "New Team: <typed name>"   (30s, stage round-trip)
    → tapOn "Add as New Team"
    → extendedWaitUntil visible id "Career team name"      (back on the player)
    → assertVisible ".*<typed name> \(2001.2005\).*"      ← the regression

The chip is NOT assertable at the moment of the add: the step is already up by
the time Maestro reads the screen.

Two further consequences worth knowing:

- **Assert absence WITH the years.** Once the club is decided its bare name also
  appears in the `Decided (N)` history, so `notVisible ".*<name>.*"` asserts the
  history collapsed, not that the chip went. `"<name> (2001–2005)"` renders only
  in the chip list.
- **c657a57: the auto-add sweep DEFERS while the presented row has edits** —
  text in the career-team field, a staged chip, an open link search, an unticked
  chip, a touched New Team form. A flow that types into that field and then
  waits for `Add remaining players as new` waits forever. Decide the row
  explicitly first.
