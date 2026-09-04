---
name: label-in-name-async-swap-pattern
description: Two recurring bugs found together on NEO-212's entity-review UI — a hand-typed aria-label that substitutes a whole word instead of inserting one (SC 2.5.3 real failure vs the codebase's usual "insertion is fine" pattern), and a primary action whose DOM shape (not just its props) changes when an async near-match query resolves, risking focus loss
metadata:
  type: patterns
---

## Label-in-name: word SUBSTITUTION fails 2.5.3, word INSERTION (this codebase's established pattern) does not

This codebase already has a deliberate, tested pattern of keeping a control's
`aria-label` stable across visible-text changes for Maestro/E2E targeting —
e.g. `Skip {name} — not a {what}` (aria-label) vs "Skip — not a {what}"
(visible text): the name is *inserted* into the middle of an otherwise-intact
label, so every visible word still appears in the accessible name in the same
order. That passes SC 2.5.3 under the standard "contains, with insertions
tolerated" reading and should NOT be re-flagged when seen again.

**What actually fails**: `EntityReviewWizard.tsx`'s "Add as New anyway" button
(exact-match state) keeps `aria-label="Add as New {Player|Team}"` for the same
Maestro-target reason (`.maestro/flows/set-selector/checklist-fetch-wizard-add-career-team.yaml`
taps `"Add as New Player"`), but the visible text is "Add as New **anyway**" —
the last word is *substituted*, not inserted alongside. "anyway" never appears
in the accessible name at all. This is a genuine, confirmed SC 2.5.3 violation
(`EntityReviewWizard.test.tsx` even asserts the mismatch directly, so it's
intentional, not an oversight — flag it anyway; a deliberate tradeoff still
needs reporting, with a fix that keeps the E2E contract, e.g. a stable
`data-maestro-id`/testid instead of overloading aria-label).

Same bug, no E2E excuse: `CareerTeamEntry.tsx`'s "Did you mean {name}?" button
has `aria-label={`Use ${name}`}` — "Did you mean...?" doesn't appear in "Use
{name}" at all. Simplest fix: drop the aria-label entirely and let the
button's own text be the accessible name (no conflicting requirement forces
it to differ here).

**Rule of thumb when auditing a hand-set aria-label against different visible
text**: check whether every visible WORD still appears, in order, in the
aria-label (insertions of extra words like a name are fine) — vs whether any
visible word was swapped out for a different one (never fine).

## Async near-match results can swap a primary button's DOM SHAPE, not just its label

`EntityReviewWizard.tsx` and `PlayerManagement.tsx`'s `AddPlayerForm` both
render structurally different JSX (a `<Fragment>` of two elements vs a single
`<NeonButton>`) depending on whether `nearMatches`/`matches` has resolved with
an exact hit yet. Because the two branches aren't the same element type at
the same position, React unmounts/remounts on the transition rather than
patching props — so if a keyboard user has already tabbed to (or clicked into)
the "Add as New"/"Create player" button in the window before the debounced
near-match query resolves, the query landing yanks focus to `<body>` with no
warning. This is the same failure class as [[raf-focus-park-race]] and
[[focus-park-pattern]] but triggered by a REACTIVE SUBSCRIPTION arriving, not
a user action — closest existing precedent is CardAttentionWalker's
auto-trigger case in [[focus-park-pattern]]. Fix options: keep both branches
rendering the same button element (toggle its label/handler/variant via props
rather than swapping element trees), or add a focus-park effect that detects
`document.activeElement === document.body` after the swap and refocuses the
new primary action.

## An always-forced aria-label silently drops sibling visual-only info

`NearMatchPanel.tsx`'s pick button sets `aria-label={pickLabel(match.name)}`
unconditionally. Per the accname algorithm, an explicit `aria-label` makes the
browser ignore ALL descendant text — including the "same name" confidence
badge rendered as a sibling `<span>` inside the same button when
`confidence === "exact"`. Sighted users see the badge; screen-reader users
never learn a candidate is an EXACT match vs merely close. Live in
`PlayerManagement.tsx`'s `AddPlayerForm`, which (unlike the wizard's own use
of this panel, which filters the exact hit out of the list entirely) passes
the full unfiltered match list through, so the exact-tagged row and its badge
can actually render there. Fix: fold the distinction into the label itself,
e.g. `pickLabel` receiving `(name, confidence)` so the exact case can render
`"Open {name} (same name)"`.
