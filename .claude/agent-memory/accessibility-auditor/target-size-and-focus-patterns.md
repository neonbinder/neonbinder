---
name: target-size-and-focus-patterns
description: Recurring WCAG 2.5.8 target-size gaps in small text-buttons (px-1 with no py-*), and the codebase's own aria-disabled convention for avoiding focus-strand bugs
metadata:
  type: project
---

## Target size: `px-1` with no vertical padding is a recurring miss

Small inline text-buttons throughout `components/SetSelector/*` use only
horizontal padding (`px-1`) and no vertical padding, which — combined with
`text-xs`/no explicit font-size — renders well under WCAG 2.5.8's 24×24 CSS
px minimum. Found and fixed in NEO-219 in `MultiSourcePanel.tsx`'s chip
controls:
- The unified `×` "Remove" button (bare glyph + `px-1`, ~18×19px) — fixed with
  `inline-flex items-center justify-center min-w-6 min-h-6` (guarantees 24×24
  regardless of glyph width, more robust than guessing padding for a
  single-character label).
- The confirm-chip's `Confirm`/`Cancel` buttons (`text-xs ... px-1`, ~16px
  tall since `text-xs`'s Tailwind line-height is 1rem/16px) — fixed by adding
  `py-1` (16 + 4+4 = 24px exactly).

This `px-1`-only pattern is widespread (also on `SetAttributesPanel.tsx`'s
"Hide/Edit attributes" toggle, untouched by NEO-219 so left alone per scope) —
worth checking on any future PR that touches a small text-button in this
family of components.

## The codebase's own established `aria-disabled` convention

Three places in this codebase state, almost verbatim, the same reasoning:
*"a natively disabled button blurs to `<body>` the moment it is disabled,
dropping focus outside the modal/surface and ending its modality mid-round-trip
— use `aria-disabled` + a click/keydown guard instead of the native `disabled`
attribute, whenever the control might be focused at the moment it needs to go
inert."* — `MultiSourcePanel.tsx`'s `handleDetach` guard,
`components/modules/confirm-dialog.tsx`'s busy-park effect, and
`SetAttributesPanel.tsx`'s delete-button comment. `NeonButton` (
`components/modules/NeonButton.tsx`) already supports this: it dims/greys out
on EITHER `props.disabled` OR `props["aria-disabled"]`, so swapping one for
the other is visually a no-op.

**`BaseSetPicker.tsx`'s footer Confirm/Cancel buttons do NOT follow this
convention** — they use native `disabled={...}` via `NeonButton`. This is a
real, if narrow, focus-strand risk (if the caller ever flips `loading` back to
`true` while the dialog stays open with Confirm focused, focus would drop to
`<body>` and could escape the dialog's own Tab-trap on the next keypress).
Flagged but **not fixed** in NEO-219's audit pass: `BaseSetPicker.test.tsx:162`
asserts the native `.disabled` DOM property directly
(`screen.getByText("Confirm Base Set").closest("button")?.disabled`), so
switching mechanisms would need a coordinated test update, and the actual
caller (`BaseMappingForm.tsx`) only sets `loading` once during the initial
mount as far as verified — so the risk is currently more theoretical than
live. Revisit if `loading` ever becomes re-triggerable while the dialog stays
open.
