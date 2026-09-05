---
name: patterns-flex-row-reflow-missing-wrap
description: A fixed-width field (e.g. Location, w-28/w-40) placed in an unwrapped flex row ahead of a flex-1 text input risks SC 1.4.10 Reflow overflow at 320px — text inputs have a non-zero intrinsic min-width that flex-1 alone does not override
metadata:
  type: pattern
---

Seen in `components/SetSelector/CareerTeamEntry.tsx` (NEO-236): a new
`<div className="flex items-start gap-2">` row puts a fixed `w-28` Location
`<Input>` ahead of a `<div className="relative flex-1">` wrapping the Name
`<Input>`. No `flex-wrap` and no `min-w-0` on the flex-1 wrapper.

**Why this is a real SC 1.4.10 Reflow risk, not just style nitpicking:** a flex
item's default `min-width` is `auto`, which for a text `<input>` resolves to
the input's own intrinsic minimum (commonly ~150–170px across browsers absent
an explicit `size` attribute) rather than 0 — `flex-1` alone does not override
that floor, only `flex-shrink` behavior above it. At a 320px viewport (the
literal SC 1.4.10 test width), a fixed sibling (112px here) + gap + that
intrinsic minimum can exceed the row's available width and force horizontal
scroll on whatever ancestor has `overflow-y-auto` set explicitly (CSS forces
the other axis to compute as `auto` too once one axis is set non-`visible`,
per the box overflow interaction rule) — which is exactly the wizard body's
`overflow-y-auto` in `EntityReviewWizard.tsx`.

**The tell to check for on sight:** the SAME ticket's own sibling component
(`EntityReviewWizard.tsx`'s top-level Team Location/Team-name pair) used
`flex flex-wrap items-end gap-2` for the visually identical two-field pattern
— i.e. the fix was already known and applied one component over, just missed
on the second, structurally-identical instance. When a fixed-width field
precedes a flex-1 text field, always check whether the row has `flex-wrap` OR
`min-w-0` on the flex-1 wrapper; if neither, it is very likely a fresh Reflow
regression.

**The minimal fix** (chosen over `flex-wrap` to avoid changing the visual
layout of already-narrow inline rows): add `min-w-0` to the flex-1 wrapper
div, e.g. `<div className="relative flex-1 min-w-0">`. This lets the item
shrink to the input's actual `w-full` size instead of its content-based
minimum, with no effect at normal widths.
