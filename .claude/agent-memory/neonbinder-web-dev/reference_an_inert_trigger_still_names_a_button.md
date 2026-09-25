---
name: an-inert-trigger-still-names-a-button
description: A dialog's trigger stays in the DOM (inert) while the dialog is up, so a confirm button reusing the trigger's text gives two buttons one name — getByRole throws and a Maestro text tap is ambiguous
metadata:
  type: reference
---

The house pattern puts `inert` on a dialog's opener while the dialog is open
([[inert-the-opener-behind-confirmdialog]]). Inert does not remove it: it is
still a `button` in the document with its visible text as its name, and
happy-dom's `getByRole` does not exclude inert subtrees.

So a confirm labelled like its trigger ("Promote to set" opening a dialog whose
confirm says "Promote to set") is two buttons with one accessible name: every
`getByRole("button", { name })` in the tests throws "multiple elements", and a
Maestro `tapOn: "Promote to set"` has two candidates.

**How to apply:** name the confirm by what it does NOW ("Promote it", "Make it
a parallel"), never by the trigger's label. Pin it with a test that opens the
dialog and asserts every button name is unique
(`getAllByRole("button")` → names → `new Set(names).size === names.length`).
Found on NEO-305 when six tests failed at once on the first run.

Related: [[disambiguate-duplicate-aria-labels-by-rewording]],
[[reference_confirmdialog_owns_the_word_cancel]].
