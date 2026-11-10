---
name: tab-trap-offlist-swallows-script-focus-targets
description: A hand-rolled Tab trap that treats "focus not in the tabbable list" as "parked on the heading" sends Shift+Tab from ANY tabIndex=-1 focus target (a jumped-to group, a box) to the dialog's last control — check every new script focus target against the trap
metadata:
  type: project
---

ParallelGroupingModal's Tab trap (NEO-308) computes `offList = !focusable.includes(activeElement)`
so Shift+Tab from the parked heading or the overlay wraps to the last control. NEO-472 then
added a script-only focus target (a `role=group` box with `tabIndex={-1}`, focused by a
"Jump to them" button). Because tabindex=-1 is excluded from the list, Shift+Tab from that box
jumped to the footer instead of the previous row — a 2.4.3 focus-order defect invisible in
review unless you read the trap.

**Why:** the offList shortcut was written when the heading and overlay were the only
off-list focus targets; every later `tabIndex={-1}` target silently inherits the wrap.

**How to apply:** whenever a diff adds `tabIndex={-1}` + `.focus()` inside a dialog with a
hand-rolled trap (ReconciliationModal, CardPairingModal and this one share the copy), check the
trap's off-list rule. Fix: name the parked targets explicitly
(`activeElement === root || activeElement === headingRef.current`) instead of "anything not in
the list". Related: [[patterns_modal_dialog]], [[focus-park-pattern]].
