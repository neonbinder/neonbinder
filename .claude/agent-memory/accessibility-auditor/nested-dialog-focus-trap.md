---
name: nested-dialog-focus-trap
description: A dialog-inside-a-dialog (delete confirm over a review screen) needs its OWN Tab trap and its own focus-restore-on-close — the outer dialog's trap silently covers neither; plus the optional restoreFocusRef pattern for a modal whose own document.activeElement capture can't be trusted across an async cross-modal handoff (NEO-203)
metadata:
  type: patterns
---

## The bug: a nested confirm dialog that is a DOM descendant of the outer dialog leaks Tab focus into content behind it

`sync-review-modal.tsx`'s delete-confirm (`role="alertdialog"`) renders as a
sibling `<div>` *inside* the same outer `role="dialog"` wrapper the main
review screen uses (both are children of one `dialogRef`-tracked container,
because it's a single `createPortal` root). The outer dialog's Tab-trap
`onKeyDown` computes its focusable set with `dialogRef.current.querySelectorAll(...)`
— which, since the confirm is a descendant, includes the MAIN dialog's own
checkboxes/buttons even while the confirm overlay is the only thing visible.
The confirm had an `onKeyDown` for Escape (with `e.stopPropagation()`) but
none for Tab, so an unhandled Tab bubbled up to the outer handler, which
computed "first"/"last" across the WRONG combined set — a `Shift+Tab` from
the confirm's own first control could walk focus back into the review
dialog's content behind the overlay, which is supposed to be inert.

**The fix**: give the nested dialog its OWN ref and its own Tab-trap
`onKeyDown`, scoped to `querySelectorAll` *within that ref only*, and
`e.stopPropagation()` on Tab too (not just Escape) so the outer handler's
Tab logic never runs while the nested one is open. Same roving first/last
`preventDefault()` + `.focus()` logic as the outer trap, just re-scoped.

**When auditing here**: any component that renders a second `role="dialog"`/
`role="alertdialog"` INSIDE the same portal/ref as its parent dialog (rather
than as a fully separate portal) needs this checked explicitly — grep for a
second `onKeyDown` handling only `"Escape"` near a conditionally-rendered
overlay `<div>` and verify it also traps `"Tab"` and stops its propagation.

## The other half: closing the nested dialog must restore focus to what OPENED it

The confirm's Cancel button focuses itself on open (matches
[[focus-park-pattern]] — landing on the safe/non-destructive default). But
closing it (Cancel click, or Escape) just unmounted the confirm's own DOM
with no restoration step — the browser drops focus to `<body>` the instant
the focused Cancel button disappears, because the REVIEW dialog stays open
(this isn't the "whole modal unmounts, top-level cleanup effect restores
focus" case — that only fires when the review dialog itself closes).

**Fix**: a ref to the button that opened the confirm (here, "Apply &
Continue"), called synchronously (`applyBtnRef.current?.focus()`) in both the
Cancel `onClick` and the Escape branch. No `requestAnimationFrame` needed
here unlike the top-level open-focus effect — the target button was never
unmounted, only the confirm's own overlay was, so it's already in the DOM and
focusable the instant `setConfirmingDeletes(false)` runs.

## Related finding: cross-modal handoff can make `document.activeElement`-at-mount capture the wrong thing — fixed (NEO-203 follow-up, 2026-09-01)

`SyncReviewModal`'s top-level open effect does
`triggerRef.current = document.activeElement` to restore focus to whatever
opened IT, on close. In `CardChecklist.tsx`'s actual pipeline, this modal is
opened from `handlePairingConfirm`, which unmounts `CardPairingModal` (its
own portal, own dialog) SYNCHRONOUSLY, then `await`s a real Convex query
(`diffChecklistAgainstExisting`) before mounting `SyncReviewModal`. Because
there's a genuine async gap (a network round trip) between the two dialogs,
by the time `SyncReviewModal`'s mount effect reads `document.activeElement`,
`CardPairingModal`'s own trigger button has already been removed from the DOM
and the browser has already reverted focus to `<body>` — so the captured
"trigger" is `document.body`, and `.focus()` on that is a no-op. Net effect:
closing `SyncReviewModal` restores focus to nowhere useful, same failure
shape as [[focus-park-pattern]] describes, just via a different mechanism
(stale capture instead of a disable-triggered blur).

**Left unfixed in the initial NEO-203 audit** (scoped to `sync-review-modal.tsx`
only), then **fixed in a follow-up pass** once `CardChecklist.tsx` came into
scope. The shape of the fix:

- `SyncReviewModal` gained an optional prop, `restoreFocusRef?: RefObject<HTMLElement | null>`
  — when present, it's preferred over the component's own
  `document.activeElement`-at-mount capture for BOTH setting the initial
  `triggerRef` and (implicitly, since `triggerRef` is what the unmount
  cleanup reads) what focus is restored to on close. When the prop is absent,
  behavior is byte-identical to before (falls through to
  `document.activeElement`), which is what let all 24 pre-existing tests pass
  unmodified.
- `CardChecklist.tsx` added one ref (`syncButtonRef`) shared by BOTH of its
  "Sync card checklist" `NeonButton`s (only one is ever mounted at a time,
  keyed on `sortedCards.length`), and passed it down as `restoreFocusRef`.
  That button is the one that actually starts the whole
  fetch→pair→review→commit pipeline, stays mounted for the pipeline's entire
  duration (unlike `CardPairingModal`'s own trigger, which is exactly the
  thing that goes stale across the async gap), and is what an operator
  actually expects focus to return to once Skip/Apply finishes.

**General lesson for future audits**: whenever two portal-rendered dialogs
hand off across an `await`, don't trust `document.activeElement` captured at
the second dialog's mount time to be the meaningful trigger — verify there
isn't an async gap between the first dialog's unmount and the second's mount
before assuming that capture-on-mount / restore-on-unmount pattern (correct
and sufficient elsewhere in this codebase, e.g. the delete-confirm case
above) actually works end to end. When a modal component's own capture can't
be trusted because of who calls it, an optional `restoreFocusRef` prop that
the parent can supply — falling back to the original self-contained behavior
when absent — is a low-risk way to fix it without changing the modal's
default behavior or its existing tests.

**No `await` required — a same-tick unmount/remount goes stale the same way
(NEO-221, [[discard-confirm-dialog-family-neo220]]).** `EntityReviewWizard`'s
"Back to matching" unmounts the wizard (whose own button had focus) and flips
`CardPairingModal.isOpen` back to `true` in the SAME synchronous handler —
two batched `setState` calls, one React commit, zero `await`. That's enough:
DOM removal of a focused node blurs to `<body>` during the commit's mutation
phase, which completes before any passive effect runs, so
`CardPairingModal`'s own mount effect still reads a stale `document.body` by
the time it fires. Don't gate this check on "is there a network round-trip
between the two dialogs" — gate it on "is the trigger element a member of the
tree that's unmounting in the same transition that reopens the other dialog."
