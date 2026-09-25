---
name: inert-the-opener-behind-confirmdialog
description: ConfirmDialog is not portalled and traps only Tab, so a list left mounted behind it stays reachable by a screen reader's browse cursor — fix with `inert`, and restore focus in an effect because inert blurs
metadata:
  type: reference
---

`components/modules/confirm-dialog.tsx` renders in place (no portal), sets
`aria-modal="true"`, and traps **Tab only**. Anything the opener leaves mounted
behind it — an open picker list, a row of buttons — is therefore still reachable
by a screen reader's browse cursor and by AT that does not follow the tab order,
which is exactly what `aria-modal` promises does not exist.

**Fix:** put `inert` on the container while the dialog is up.
`aria-hidden` is the wrong tool: it leaves focusable children inside a hidden
subtree, which is its own violation (axe `aria-hidden-focus`). React 19 accepts
`inert` as a boolean prop (`inert={target !== null}`), and `inert={false}`
renders nothing.

**The catch — inert blurs.** The moment an element becomes inert the browser
resets focus inside it to `<body>`. That happens in the same commit that mounts
the dialog, so `ConfirmDialog`'s own "restore focus to whatever opened me"
captures `document.body`, and cancelling drops a keyboard user at the top of the
document. So:

- remember which child was chosen (a ref holding its id, plus a `data-*`
  attribute to find it again — not an `aria-label` lookup, and never an E2E
  target),
- restore focus in an **effect keyed on the dialog closing**, not inside
  `onCancel`: the effect runs after the commit that removed `inert`, and
  focusing a still-inert element is a no-op.

**happy-dom does not implement inert's focus behaviour**, so a component test
can assert the attribute goes on and comes off, but cannot prove the restore —
in happy-dom focus never leaves the child and `ConfirmDialog`'s own restore
succeeds, so the test passes either way. Treat that assertion as a contract
statement, not evidence. See [[reference_confirmdialog_owns_the_word_cancel]]
for the other constraint this dialog puts on an inline picker that raises it.

Worked example: `components/SetSelector/MoveSetToBrandControl.tsx` (NEO-294).

**Portalled modals (NEO-307):** a `createPortal`-to-body modal holds the page
with `lib/dom/inertBackground(dialogEl)`, which inerts every other body child,
ref-counts across nested modals (either close order is safe) and never clears
an `inert` it did not set. Capture the opener BEFORE calling it, call the
release BEFORE refocusing the opener. `EntityReviewWizard` and `NewTeamDialog`
both use it. happy-dom's role queries do NOT exclude inert subtrees, so assert
"live" as `el.closest("[inert]") === null`.
