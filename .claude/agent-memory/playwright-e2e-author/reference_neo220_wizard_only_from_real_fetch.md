---
name: reference-neo220-wizard-only-from-real-fetch
description: NEO-220/221 — quick-add's Players field became a PlayerPicker, so a hand-made subtree can no longer produce an unknown name; the wizard is reachable only through a real committed fetch
metadata:
  type: reference
---
**Date: 2026-09-05 (NEO-220/221, PR #229).**

## The fixture that died

Six specs reached `EntityReviewWizard` the same way: type an invented name into the
quick-add card form's free-text **Players** box, sync, and the resulting
`cardChecklist.pendingPlayerNames` opens the wizard. All six were **deleted**.

**Why it cannot be rebuilt:** quick-add's Players field is a `PlayerPicker` now and
`addCustomCard` takes real `playerIds`, so a hand-added card is **born linked** and
never carries a pending name. `resolveUnknownsAndStartBatch` finds nothing unknown,
the sync commits immediately, and no wizard appears. Do not "fix" a wizard spec by
re-typing into a Players box: that control is gone.

## Where wizard coverage lives

- **E2E:** the committing wizard specs under `tests/set-selector/` (see
  `SET-REGISTRY.md` and the GUIDE reference table), driven through `support/wizard.ts`.
  The seed also drains a wizard but only bulk-confirms.
- **Unit:** `EntityReviewWizard.test.tsx` (cancel/back/Enter), `entityReviewQueue.test.ts`,
  `entityReviewSkips.test.ts`, `SkippedNamesPanel.test.tsx`.

## Two facts worth keeping

- **The Confirm and Cancel footer buttons need distinct accessible names.** The old
  driver re-found the focused element by class and landed Enter on Cancel; the fix
  (NEO-260) was distinct aria-labels plus a marker class, never a DOM id. The button
  also handles Enter in its own `onKeyDown`, because a synthetic KeyboardEvent has no
  default action. In Playwright address each by role and name, and drive Enter with
  `press("Enter")` on the focused control.
- **On a REAL fetch the presented row may be a TEAM.** The decide button's accessible
  name is `Add as New {Player|Team}`, so match `/^Add as New (Player|Team)/`. (An exact
  near-match promotes the button to `Link to {name}`, effectively impossible for a
  queued row, since only names with no `findByNameAndSport` hit are queued.)

## Revival

`todos/neo-220-221-e2e-fixture-plan.md` (private wrapper) holds the conditions:
back-and-resume first, then skip / link-existing / career-team, on an owner-approved
SportLots set whose players are not already known. Needs Jason's approval of that set
AND of the "marketplace id on a per-worker set" pattern. See
[[patterns_per_worker_data_isolation]].
