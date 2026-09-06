---
name: patterns-typeahead-highlight-outside-listbox
description: TeamPicker/PlayerPicker-style typeahead popovers track one highlightIdx across role=option rows AND a trailing action row (Create/submit) that lives outside role=listbox — aria-selected is invalid there, aria-current is the cheap correct substitute
metadata:
  type: pattern
---

`components/SetSelector/TeamPicker.tsx` (and by its own docstring,
`PlayerPicker.tsx` mirrors the layout) drives a single `highlightIdx` state
with ArrowUp/ArrowDown from the search `<Input>`, applied to `matches.length + 1`
rows: N `role="option"` buttons (which get `aria-selected={idx===highlightIdx}`,
correctly, since they're inside the sibling `role="listbox"` div) plus one
trailing action button (create/submit) that as of NEO-236 lives OUTSIDE the
listbox in a `role="group"` — because a `role="listbox"` may only contain
`option` children, and the group also holds text inputs a listbox can't host.

**The gap:** the trailing button gets the same visual highlight treatment
(`bg-[#00D558]/20 text-[#00D558]` when `highlightIdx === matches.length`) but no
ARIA state announces it. `aria-selected` is not valid there — its host language
semantics require a `listbox`/`grid`/`tablist`/`tree` ancestor role, which this
button deliberately does not have.

**The cheap correct fix:** `aria-current="true"` when highlighted, `undefined`
otherwise. `aria-current` (ARIA 1.2) is valid on essentially any element and is
semantically "the current item within a container or set of related elements" —
which is exactly this shape (one logical set: N options + 1 action, sharing one
arrow-key cursor). It does not require wiring a full combobox
(`aria-activedescendant` + ids on every option) to fix just this one row.

**What this does NOT fix, and is a bigger, separate gap:** the search input
itself has no `role="combobox"`, `aria-expanded`/`aria-controls` pointing at the
listbox, or `aria-activedescendant` pointing at whichever row is highlighted.
Without that wiring, screen readers get **no** indication of the highlight even
for the `role="option"` rows that already carry `aria-selected` — that attribute
only matters to AT if something already told it which listbox item is
"active" via activedescendant, or if AT focus has actually moved into the
listbox (it hasn't; focus stays on the search input throughout). This is a
pre-existing gap that predates NEO-236, not introduced by it — flag it
separately as a larger "wire up the combobox pattern properly" item rather than
folding it into a review of one new row.
