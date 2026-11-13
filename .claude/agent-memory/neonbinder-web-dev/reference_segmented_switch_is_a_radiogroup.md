---
name: segmented-switch-is-a-radiogroup
description: A two-option exclusive switch (Spacious | Condensed) is a roving-tabindex radiogroup, not two aria-pressed buttons; padded track keeps the focus ring off the cyan fill; reserve the check's slot
metadata:
  type: feedback
---

An exclusive choice drawn as a segmented pill is a `role="radiogroup"` (named by
`aria-labelledby` on its visible label) of `role="radio"` buttons with
`aria-checked`, the checked one `tabIndex 0`, the rest `-1`; Arrow keys, Home and
End move AND pick. House implementation: `app/collection/final/ChipGroup.tsx`;
the NEO-522 Pick List "Row size" switch follows it inline. `aria-pressed` stays for
chips that switch on and off independently (the Quick filters).

**Why:** the NEO-522 accessibility audit flagged two aria-pressed buttons for a
one-of-two choice. It also caught two visual faults: the check icon on only the
selected option made the switch about 20px wider on each toggle, and in dark the
focus colour IS `--neon-blue` (ring vs selected fill 1.00:1).

**How to apply:** render the check on every option with `invisible` when off, so the
width never moves. Put the pills inside a padded track (`bg-field p-0.5 border`):
`focus-outline`'s 2px offset then always has the track's colour between ring and
fill (measured ring/track 8.6:1 dark, 6.6:1 light; ring/fill 1.0 dark, 3.2 light,
never adjacent). Let the label and the track wrap apart (`flex-wrap`) for 320px.
E2E handles: `getByRole("radiogroup", {name}).getByRole("radio", {name})`.
