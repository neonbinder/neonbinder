---
name: autosave-per-field-drawer-patterns
description: Patterns from auditing CardDetailPanel's conversion from a Save-button draft editor to a per-field autosave-on-blur editor (NEO-216/217) — Escape-bypasses-blur data loss, a shared-busy-flag native-disabled recurrence on a THIRD component, an <option>'s visible text being its only reliable accessible name, and a "silent success" gap on a component that already had errors wired
metadata:
  type: patterns
---

## Escape (and any close path that skips a native blur) silently drops an uncommitted autosave-on-blur edit — keyboard-only failure

When a dialog's fields commit on blur (the `useReactiveField` NEO-39 contract:
commit fires from the field's own `onBlur`, nothing else), every close
affordance that goes through a REAL DOM click — backdrop, ×, a footer "Done"
button — already blurs the focused field first, for free: a mousedown on a
different element is a native blur before the click handler ever runs. A
`keydown` listener for Escape attached to `document` does **not** get this for
free — pressing Escape never blurs the active element on its own, so
`onClose()` unmounts the dialog with the operator's last edit still sitting
uncommitted in the DOM. This is invisible in a mouse-driven manual test (every
other way of leaving the field looks fine) and only bites a keyboard user,
which is exactly the population this app's "keyboard-first" rule (CLAUDE.md)
protects. **Fix**: in the Escape branch, before calling the close handler,
explicitly blur the active element when it's an editable one —
`(document.activeElement as HTMLElement | null)?.blur()` — so Escape commits
exactly like every other close path. Cheap, no new state, no risk (a fired
commit that's already "in flight, left to land" on unmount is this
component's own documented, accepted behavior for every other close route).
**Check for this specifically whenever a dialog/drawer (a) commits on blur
per-field and (b) has an Escape handler that calls its close callback
directly** — it is very easy to write the Escape handler before ever noticing
mouse-driven closes had this covered implicitly.

## Native `disabled` on a shared-busy-flag button group — THIRD confirmed occurrence

See [[focus-park-pattern]] for the first two (`MissingTeamFixer`'s second
button, `VariantForm`/`SyncDoneNotice`/`SelectorSyncReviewModal`). Found again
in `CardDetailPanel.tsx`'s RC/AU/RELIC/SP/SSP/NUM attribute-toggle chip row
(NEO-216 diff): `toggleAttribute` sets ONE `attributesBusy` flag shared by
every chip in the row, and the just-clicked chip had `disabled={attributesBusy}`
— so the instant the write starts, the button that was just clicked (and every
sibling) goes native-disabled, and the browser blurs it to `<body>` mid-toggle
with no warning. Confirmed via `git diff` that this `disabled={...}` was NEW
in this ticket's diff, not carried from before. **Fix, same as the established
pattern**: swap to `aria-disabled={attributesBusy || undefined}` (keeps the
button focusable/reachable), rely on the handler's own existing
`if (attributesBusy) return` guard to block a second toggle (no native
click-blocking needed since the guard already no-ops it), and swap the
Tailwind `disabled:opacity-60 disabled:cursor-progress` variants to
`aria-disabled:opacity-60 aria-disabled:cursor-progress` — Tailwind's
`aria-*` variants exist for exactly this and need no config in this project's
Tailwind v4 setup. **This bug class is now confirmed on four separate
components across three different tickets — grep `disabled={` (never
`aria-disabled={`) on any button whose OWN click sets the flag it's gated on,
every single time, in every future audit of this codebase.**

## An `<option>`'s visible text is its ONLY reliably-announced accessible name

`aria-label` on `<option>` has inconsistent browser/AT support — unlike a
`<button>` or other interactive element, you cannot reliably give an
`<option>` an accessible name that differs from its text content. So a
`<select>`'s "clear/none" option (`SelectValueControl` in
`FeatureValueControl.tsx`, NEO-217's "clear a set/card attribute" feature)
MUST spell out what it does in its actual visible/rendered text — a bare `—`
(em dash) reads to a screen reader as "hyphen" or nothing at all, with no
signal distinguishing it from a rendering artifact. This is a different case
from a `<button>`'s label-in-name concerns
([[label-in-name-async-swap-pattern]], [[nested-opacity-contrast-and-radiogroup]]):
there, the accessible name CAN legitimately differ from visible text via
`aria-label` (a button's own text can even be omitted in favor of one); an
`<option>` cannot. Fixed here: `<option value="">—</option>` →
`<option value="">No value</option>` — descriptive without regressing into
the "— Select —" INSTRUCTION framing the code had already deliberately
rejected (blank is a real, permanent, selectable value here, not a
placeholder prompting a choice). **When auditing a `<select>`'s placeholder/
clear option in this codebase, check the actual option TEXT, not whether an
`aria-label` exists** — an `aria-label` there would not reliably help anyway.

## A component with error handling wired but ZERO success feedback becomes a real defect once "blank" becomes a reachable, meaningful outcome

`CardFeaturesEditor.tsx`'s per-card feature rows (`CardFeatureRow` →
`FeatureValueControl`) had `role="alert"` wired for failures from day one, but
never announced anything on SUCCESS — no toast, no live region, nothing —
for any row type (text, select, checkbox, toggleOptions), even though its
sibling `SetAttributesPanel.tsx` has always had a `role="status"` "Saved
{label}" toast for the identical action. This asymmetry was tolerable before
NEO-217, because a blank field could only ever mean "never filled in" — no
operator ACTION produced silence, so there was nothing to fail to announce.
NEO-217 made "blank" a real, deliberate, reachable OUTCOME (clearing a
feature), so post-217 an operator can now silently erase a value with
literally zero AT feedback — the field just becomes empty, indistinguishable
from having always been so. **General lesson: when a ticket adds a new
successful-action outcome (not just a new success message) to a component,
re-check whether that component had ANY success announcement at all before —
"it already had error handling" is not evidence it had success handling too,
and the gap that was harmless when the outcome space was smaller can become a
real 4.1.3 defect once the ticket widens it.** Fix used here: an optional
`onFieldSaved?: (message: string) => void` prop threaded from the row's
existing `onSave`/`onSaveBoolean` wrappers up to the PARENT drawer's own
single shared toast (`CardDetailPanel`'s `announce`, already the "ONE live
region for the whole drawer" per that file's own header comment) — additive,
so every existing caller/test that doesn't pass it is unaffected. Also caught
the same gap on `CardFeatureRow` used a SECOND time directly in
`CardDetailPanel` (the always-visible Autographed dropdown, promoted out of
the collapsed editor) — a shared row component's silence needs checking at
EVERY call site, not just its primary host.

## `toggleOptions`-type features spell "cleared" as `options[0]`, never `""`

Relevant when adding "Saved vs Cleared" messaging to any `ExpectedFeature`
row: `text`/`select` rows send `""` on a clear (NEO-217's wire spelling,
removed key server-side), but `toggleOptions` rows (Autographed, Short Print
— see `ToggleOptionsValueControl`) never send `""`; their off-state is
`options[0]` (e.g. `"None"`), matching that control's own
`offValue = options[0] ?? ""` derivation. `checkbox` rows (`"true"`/`"false"`)
have no "cleared" state at all — unchecked is exactly as much a deliberate
save as checked. Get the input type's actual off-value spelling right before
wiring "Saved"/"Cleared" copy onto a generic `onSave(value)` callback shared
across row types, or "Cleared" will silently never fire for a toggleOptions
field.
