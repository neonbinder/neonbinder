---
name: dialog-initial-focus-no-fallback
description: A dialog's "focus the first candidate row" initial-focus effect needs a fallback to the dialog container when every candidate list can legitimately be empty at once — otherwise focus never enters the modal
metadata:
  type: patterns
---

`BaseSetPicker.tsx`'s initial-focus effect (NEO-287 audit) picks its target as
`searchRef.current ?? slRefs.current[0] ?? bscRefs.current[0] ?? null` and does
nothing if the result is `null` — it doesn't set `initialFocusDone`, so the
effect stays eligible to re-run, but with nothing to focus it never moves
focus into the dialog at all. This was harmless while at least one side
always had candidates. NEO-287 made both sides independently able to render
zero candidates (a paused marketplace's pane shows only static text, no
`role="option"` rows), so an operator who has paused BOTH SportLots and BSC
opens a `role="dialog"` whose focus never leaves whatever triggered it —
a WCAG 2.4.3/4.1.2 dialog-focus violation, not caught because it needs two
independently-triggered "this side is empty" states at once to reproduce.

**The fix already exists one function away in the same file**: `onDialogKeyDown`'s
Tab-trap has the identical "nothing focusable" case and falls back to
`dialog.focus()` (the container itself has `tabIndex={-1}`). The initial-focus
effect needs the same fallback — `target ?? dialogRef.current` — instead of
bailing out on `null`.

**General lesson**: whenever a dialog's initial-focus effect enumerates a
chain of "first interactive thing in each section" refs, check what happens
when every section in the chain can be legitimately empty at the same time,
not just one at a time. A new feature that makes a second section
independently empty (here: pausing BOTH marketplaces, where before only one
side's marketplace could return zero rows at a time) can produce a
zero-candidates state nobody tested for. See [[focus-park-pattern]] for the
sibling convention (parking focus on unmount) — this is the mirror case,
initial mount with nothing to receive focus.
