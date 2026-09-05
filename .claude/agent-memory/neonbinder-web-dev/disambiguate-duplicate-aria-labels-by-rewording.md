---
name: disambiguate-duplicate-aria-labels-by-rewording
description: When two instances of the same picker/component can be on screen at once, give the second instance labels that share NO substring with the first — never a suffixed variant, because Maestro's `id:` selector is a regex find
metadata:
  type: feedback
---

When a component that carries fixed `aria-label`s (a picker, a toolbar, a
fixer) can be mounted twice on one screen, the second instance needs
overridable labels, and those labels must share **no substring** with the
defaults in either direction. Reword the whole string; never suffix or prefix
it.

**Why:** Maestro's web driver sets `resource-id` from the element's
`aria-label`, and `tapOn: id: "..."` is a **regex find**, not an equality
check. So the intuitive fix — `"Add player"` → `"Add player to new card"` —
makes things strictly worse: a flow targeting the original `id: "Add player"`
now matches *both* elements, turning a duplicate-label problem into a
wrong-element tap. The same trap applies to `assertVisible`/`assertNotVisible`
by id. (NEO-220, quick-add PlayerPicker vs. the card drawer's, both mounted by
`CardChecklist` with neither hiding the other.)

**How to apply:** add an all-or-nothing `labels` object prop (not individual
optional overrides — a half-renamed instance is a collision you then have to
hunt for), covering only the *container* controls that are always present and
carry no entity name: root, trigger, search input, listbox. Leave chip and
option labels alone — they already carry the row's name, which is the
disambiguator, and renaming them breaks the existing flows. Then state the
default↔override pairs in a comment and pin the "neither contains the other"
property in a unit test, since the failure is silent in both directions. Worked
example: `QUICK_ADD_PLAYER_LABELS` in `components/SetSelector/CardChecklist.tsx`
and `PlayerPickerLabels` in `PlayerPicker.tsx`.

Related: [[e2e-viewport-is-the-ux-constraint]].
