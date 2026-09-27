---
name: count-gated-row-tears-out-its-own-dialog
description: A control rendered only while a live count is > 0 (and the row around it) unmounts mid-dialog when its own action empties the count — keep it up with an onActiveChange window; `empty:hidden` for self-gating children, pinned by childNodes in happy-dom
metadata:
  type: reference
---

A button gated on a LIVE count (`{n > 0 && <Fix/>}`, or a row gated on
`attentionCount > 0`) whose own action drives that count to 0 unmounts
itself while its ConfirmDialog is still up: the subscription update lands
before the action resolves, so "Filling…" vanishes and an in-dialog error
has nowhere to render. Found building NEO-306's "Fill N missing teams" in
CardChecklist's attention row.

**Shape that holds:** the child renders `null` only when `count === 0 &&
!active` (active = checking || busy || dialog open), holds the count it
was pressed at for its label, and reports `onActiveChange(active)`; the
owner adds `|| fillActive` to the ROW's condition. Report `false` from an
unmount cleanup through a ref, or a set change mid-check leaves the owner
stuck "active". After the window closes the trigger may unmount with focus
on it — the owner parks focus (guarded on `activeElement === body`).

**Self-gating children in a group:** when each child renders null unless
its own query says yes (the panel's "Set actions" row), the parent cannot
know it is empty. `empty:hidden` works in browsers (JSX leaves no
whitespace text nodes, so the div is `:empty`, and `display:none` drops the
role=group from the a11y tree), but happy-dom loads no CSS: pin it with
`group.childNodes.length === 0` plus the class, via
`getByRole("group", { hidden: true })`.

Related: [[reference_inert_the_opener_behind_confirmdialog]] (the trigger
behind the dialog is inert, so restore focus in an effect).
