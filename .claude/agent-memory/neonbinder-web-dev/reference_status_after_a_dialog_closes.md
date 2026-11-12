---
name: status-after-a-dialog-closes
description: A status line said as a portalled dialog closes is lost while the page is still inert; queue it in a ref and say it from a parent effect keyed on the dialog's open state (child unmount cleanups run first)
metadata:
  type: reference
---

A dialog that uses `inertBackground` releases the page in its effect
cleanup. A parent that calls `onStatus(...)` (or writes a `role="status"`
region) in the same handler that closes the dialog writes into an inert
subtree, and the screen reader drops the line. A bare `requestAnimationFrame`
is not enough either: after an `await` the close is not a discrete event, so
React may render after the frame.

Pattern (NEO-496 PublishedChecklistPanel, A2): store `{ message, focus }` in
a ref, close the dialog, and flush from `useEffect(() => { if (open) return;
... requestAnimationFrame(() => { focus(); onStatus(msg) }) }, [open])`. In
one commit React runs the unmounting child's cleanups before the parent's
effects, so the release has happened. Test it with an `onStatus` mock that
records `document.querySelectorAll("[inert]").length` and whether a dialog is
still in the DOM at the moment it is called.

Related: adding `<span className="sr-only">Name match </span>` inside a chip
changes its text for Playwright `getByText(/^NN%$/)` (Playwright matches the
element's whole text, descendants included), though RTL `getByText("94%")`
still passes (own text nodes only). Sweep specs for anchored regexes.
See [[inert-the-opener-behind-confirmdialog]].
