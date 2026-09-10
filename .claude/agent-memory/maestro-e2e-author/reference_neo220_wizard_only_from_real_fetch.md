---
name: reference-neo220-wizard-only-from-real-fetch
description: NEO-220/221 — quick-add's Players field became a PlayerPicker, so a custom subtree can no longer produce an unknown name; the six wizard flows were deleted and the ONLY live EntityReviewWizard left is STEP 6 of inserts-1996-score
metadata:
  type: reference
---
**Date: 2026-09-05 (NEO-220/221, PR #229).**

## The fixture that died

Six flows reached `EntityReviewWizard` the same way: type an invented name into
the quick-add card form's free-text **Players** box → sync → the resulting
`cardChecklist.pendingPlayerNames` opens the wizard. All six were **deleted**:

`checklist-fetch-cancel-dialog` (`fcd-`), `checklist-fetch-unknown-entities-link-existing`
(`lce-`), `checklist-fetch-wizard-add-career-team` (`cte-`),
`checklist-fetch-wizard-back-and-resume` (`wbr-`),
`checklist-fetch-wizard-skip-not-a-person` (`skp-`),
`checklist-keyboard-only-dialog` (`kod-`).

**Why it cannot be rebuilt:** quick-add's Players field is a `PlayerPicker` now
and `addCustomCard` takes real `playerIds`, so a hand-added card is **born
linked** and never carries a pending name. `resolveUnknownsAndStartBatch` finds
nothing unknown, the sync commits immediately, and no wizard appears. Do not
"fix" a wizard flow by re-typing into `id: "Players"` — that control is gone.

## Where wizard coverage lives now

- **E2E:** STEP 6 of
  `set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml` — the only
  QUEUE flow that opens the wizard. It folds in the decide → `Cancel (Esc)` →
  `Discard 1 decision.*` → confirm's own `Cancel` (anchored `below:` the
  description "…The same names come back the next time you sync this set.") →
  `Decided (1)` check, then `Add All Remaining as New` and a `pressKey: Enter`
  commit. `setup.yaml` also drains a wizard in the seed job, but only
  bulk-confirms. `signed-by-autofills-from-players` has a wizard branch that is
  a LOCAL-ONLY fallback (skipped in CI).
- **Unit:** `EntityReviewWizard.test.tsx` (cancel/back/Enter),
  `entityReviewQueue.test.ts`, `entityReviewSkips.test.ts`,
  `SkippedNamesPanel.test.tsx`.

## Two selector facts worth keeping

- **`Confirm & Save (Enter)` is disambiguated by a marker CLASS, not a DOM id
  (changed in NEO-260).** maestro-web's `pressKey` re-finds
  `document.activeElement` by an XPath that falls back to the CLASS string; the
  footer's `Cancel (Esc)` is a NeonButton with the identical classes, so Selenium
  returned the first match and Enter aimed at Confirm landed on Cancel (failure
  screenshot showed "Discard 1 decision?" while the app's own focus was
  correct). NEO-220 fixed that with `id="entity-review-confirm-save"`; NEO-260
  removed the id — the standing rule is never to target a DOM id — and replaced
  it with a `useFieldTestClass()` marker (`btn-confirm-save` / `btn-cancel-review`)
  plus distinct aria-labels. No flow changed, because no flow ever selected on
  the id. The button also handles Enter in its own `onKeyDown`, because a
  synthetic
  KeyboardEvent has no default action and cannot activate a `<button>`.
- **On a REAL fetch the presented row may be a TEAM.** The decide button's
  accessible name is `Add as New {Player|Team}`, so match
  `id: "Add as New (Player|Team)"`. The retired custom-subtree flows could pin
  "Player" only because their invented names were always players. (An exact
  near-match promotes the button to `Link to {name}` — effectively impossible
  for a queued row, since only names with no `findByNameAndSport` hit are
  queued.)

## Post-NEO-239 revival

`todos/neo-220-221-e2e-fixture-plan.md` holds the conditions: back-and-resume
first (its reload path is E2E-only), then skip / link-existing / career-team, on
an owner-approved SportLots set whose players are not already known. Needs
Jason's approval of that set AND of the "marketplace id on a per-worker set"
pattern. See [[patterns-per-worker-data-isolation]].
