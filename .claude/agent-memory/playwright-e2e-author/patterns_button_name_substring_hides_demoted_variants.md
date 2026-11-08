---
name: button-name-substring-hides-demoted-variants
description: A string button name is a substring match, so "Add as New Player" also matches the demoted "... anyway" control; creating specs need a regex plus a two-press-aware helper
metadata:
  type: patterns
---

`getByRole("button", { name: "Add as New Player" })` is a case-insensitive SUBSTRING match, so it already matches "Add as New Player anyway" when that is the only one on screen. Two traps follow:

- A spec that pins the plain name works by accident when the step demotes creating (a suggested "Link to <name> (<sport>)" leads), and goes strict-mode red the day both exist. Pin intent with `/^Add as New Player( anyway)?$/`, never the bare string.
- "anyway" is not always a create. On a row the batch inserted READY with no lookup (the suggested-player step, NEO-424), that press only opens the plain New Player step and records nothing. A create helper must press, then wait for either the counter's x to move or the exact "Add as New Player" primary, and press that. Check "x moved" first so the NEXT row's primary is never mistaken for the plain step.

**Why:** E(2) makes the player's create conditional on the catalogue, so a catalogue refresh can silently change which shape a fixture name shows.

**How to apply:** use `answerPlayerAsNew(page)` in `support/wizard.ts` wherever creating a player is the intent (teams and leagues have `answerStepAsNew`). Keep the exact name only where the spec asserts the step's identity.
