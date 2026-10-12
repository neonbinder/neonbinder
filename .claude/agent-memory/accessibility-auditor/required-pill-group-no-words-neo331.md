---
name: required-pill-group-no-words-neo331
description: How to signal a required single-select pill group with zero new visible copy (house rule - only optional fields get a marker) - radiogroup plus aria-required, and focus-the-unanswered-field on a held primary
metadata:
  type: project
---

NEO-331 made league Level required; LevelGroup (components/admin/AddLeagueForm.tsx) stayed `role="group"` + `aria-pressed` buttons that cannot be un-pressed.

- aria-pressed toggles that can never be cleared are a radio group in disguise (SC 4.1.2). `aria-required` is NOT allowed on `role="group"`, so the only no-new-words way to tell a screen-reader user "required" is `role="radiogroup"` + `aria-required="true"`, reusing the roving-tabindex handler from [[patterns-pill-radiogroup]]. Keep `aria-label="Level"` and the button text byte-identical (Maestro taps by text).
- A held primary (aria-disabled + early return) with no describedby is a silent no-op on press. Wordless fix: on press, move focus to the unanswered field's group (standard validation-focus), rather than adding sr-only copy.
- Native `disabled` on the form primaries (AddLeagueForm Create, NewTeamForm Add league) drops them from the tab order, so keyboard users never meet the explanation point; prefer aria-disabled per [[patterns-aria-disabled-focus-park]].

**Why:** Jason rejected added copy ("we don't need more words"); semantics and focus carry the information instead.
