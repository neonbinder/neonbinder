---
name: league-combobox-name-collision-neo307
description: NEO-307 retired NewTeamForm's League radiogroup for the shared Autocomplete, named exactly "League" (not "New team league") as a deliberate, tested E2E contract — but two NewTeamForm instances (wizard's inline team step + a TeamPicker-opened NewTeamDialog) CAN be live in the DOM at once with neither marked inert, so two identically-labeled "League" comboboxes coexist for AT/E2E
metadata:
  type: patterns
---

## What changed (NEO-307, 2026-09-25)

`NewTeamForm.tsx`'s League field went from a `role="radiogroup"` of pills
(accessible name "New team league" — see [[collapsed-radiogroup-posinset]],
now OBSOLETE for this file, the radiogroup is fully gone, no `role="radio"`
left anywhere) to the shared `Autocomplete` combobox, named exactly `"League"`
via a hardcoded `label="League"` prop. `NewTeamForm.test.tsx` pins this
literally and says so: "The combobox's accessible name ('League') ... is the
E2E contract." Sibling fields on the SAME form keep the old "New team …"
prefix (`New team location (optional)`, `New team name`, `New team aliases
(optional)` — the aliases prefix is explicitly reasoned in-file as needed "so
the two alias boxes a wizard can show ... never share a name"). League alone
was left bare.

## Why that is a real (not theoretical) collision risk

`CardChecklist.tsx` renders a per-card-row `TeamPicker` (which can open
`NewTeamDialog`, a `createPortal`-to-`document.body` modal, `z-60`, its own
`NewTeamForm`) AND `EntityReviewWizard` (also `createPortal`, `role="dialog"
aria-modal="true"`, also able to show an inline `NewTeamForm` on its own Team
step) as siblings. **Neither modal marks the other's DOM subtree `inert` or
`aria-hidden`** (grepped both files — no such wiring). A Tab-trap stops
keyboard focus from crossing between them, but NOT a screen reader's
browse/virtual cursor (same gap as [[inert-list-trigger-not-covered]]). So it
is possible for two live "League" combobox inputs to exist in the
accessibility tree at once, with no way for AT — or a Maestro selector keyed
on `id: "League"` (confirmed in
`checklist-wizard-career-team-entry.yaml`) — to tell them apart. House rule:
identically-labeled siblings collapse to one target for the E2E driver.

`NewTeamForm.tsx`'s own `helpId`/`previewId` comment already anticipates "Two
NewTeamForms mounted at once (a picker's dialog over the wizard's own step)"
and uses `useId()` to keep THOSE unique per instance — the League label is the
one thing on the form that got no equivalent treatment, because renaming it
would break the pinned E2E contract above.

## How to fix without breaking the E2E contract

Prefer making the background `inert` while either modal is open (so only one
live "League" control ever exists at a time) over renaming the label — that
fixes the practical collision with zero Maestro-flow impact. A full rename
back to "New team league" is the more complete SC 2.5.3/4.1.2 fix but changes
what `id: "League"` selectors match in `checklist-wizard-career-team-entry.yaml`
(lines ~257, ~292, ~356) — sequence that with maestro-e2e-author, never do it
solo in an accessibility-only patch.
