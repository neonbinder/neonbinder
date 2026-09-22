---
name: confirmdialog-owns-the-word-cancel
description: The shared ConfirmDialog always renders a button whose accessible name is exactly "Cancel", so a control that opens it must never put a second Cancel on screen — make the trigger a disclosure toggle instead
metadata:
  type: reference
---

`components/modules/confirm-dialog.tsx` always renders a button named exactly
`Cancel`. So any control that (a) reveals an inline picker/list and (b) then
raises a `ConfirmDialog` from a row of that list must NOT give the picker its
own "Cancel" dismiss: while the dialog is open both are in the document, and
a flow (or a `getByRole("button", { name: "Cancel" })`) matches two elements.

The fix that costs nothing: make the trigger itself the disclosure — same
button opens and closes the list, `aria-expanded` carries the state, Escape
closes it. That also removes a control rather than renaming one, which is the
right answer per [[disambiguate-duplicate-aria-labels-by-rewording]] (reword,
never suffix) when the duplicate is a shared component's fixed string you
cannot reword at all.

Worked example: `MoveSetToBrandControl` in the Set Builder attributes panel
(NEO-294) — trigger → brand list → ConfirmDialog, with no second Cancel.
Its refusals also land in the dialog's `error` rather than the panel toast,
following `DeleteSelectorRowControl`: the dialog is already open and already
announced, and a toast behind the modal barrier is read by nobody.
