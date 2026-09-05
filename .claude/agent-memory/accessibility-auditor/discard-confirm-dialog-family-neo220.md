---
name: discard-confirm-dialog-family-neo220
description: NEO-220/221's "one confirm for every discard" pass added ConfirmDialog + Tab-trap/role=dialog to four Set Builder session modals — what was done right everywhere, and the three gaps found and fixed (ParallelGroupingModal missing role/trap entirely, ReconciliationModal/ParallelGroupingModal missing trigger-capture-restore-on-close, CardPairingModal's own capture stale across the wizard's "Back to matching" reopen)
metadata:
  type: patterns
---

## The pattern this ticket established (do this for every future "discard this session?" dialog)

`CardPairingModal`, `ReconciliationModal`, `ParallelGroupingModal` and
`sync-review-modal.tsx` each grew (or already had) the same shape:

- A pure count function (`countPairingEdits`, `countReconciliationEdits`,
  `totalChanges`, `acceptedFieldCount + selectedDeleteIds.length`) drives a
  `ConfirmDialog` ("Discard N pairings?" etc.) rendered as a **sibling of the
  overlay inside the same portal** — never nested inside it, because the
  overlay's own backdrop-click-to-close would otherwise hand the confirm's
  backdrop click straight to the thing it's protecting.
- One `requestClose()` seam that every dismissal path (root Escape, footer
  Cancel, backdrop click) routes through, so "would this lose anything?" is
  asked exactly once.
- `isEditableTarget` (new shared helper, `lib/dom/is-editable-target.ts`) at
  the top of every root Escape handler, so Escape inside a filter/rename field
  clears the field instead of discarding the whole session — each such field
  handler `stopPropagation`s so the guarantee doesn't depend on the root's own
  condition.
- Escape-during-a-drag (`if (activeDragId) return;`) so dnd-kit's own
  drag-cancel Escape doesn't ALSO close the dialog.

## Gap 1 (found, fixed): ParallelGroupingModal had no `role="dialog"`, no `aria-modal`, no Tab trap

The builder's own plan explicitly flagged this as unresolved ("still lacks
role=dialog/aria-modal/Tab trap — evaluate"). It replaced a `window`
`keydown` listener with a root `onKeyDown`, which was necessary groundwork
(the window listener would have fired *inside* the new discard confirm too),
but never added the role/name/Tab-trap trio every sibling dialog in this
directory carries. Fixed by copying the exact `role="dialog" aria-modal
aria-labelledby` + Tab-trap `querySelectorAll` block from
`ReconciliationModal`/`CardPairingModal`, and giving the heading an `id`.

**When auditing this family of dialogs**: always check for these three
things explicitly on the outermost `fixed inset-0` div — a builder can wire
`isEditableTarget` and the discard-confirm plumbing perfectly and still skip
role/aria-modal/Tab-trap on one file if nothing forced them to grep for it.

## Gap 2 (found, fixed): "focus opens on the container" is not the same as "focus opens on the container AND restores to the trigger on close"

`ReconciliationModal`'s NEW open-effect (`dialogRef.current?.focus()`) and
`ParallelGroupingModal`'s NEW open-effect (`overlayRef.current?.focus()`)
both handled focus-IN correctly but neither captured `document.activeElement`
at mount nor restored it on unmount — unlike `CardPairingModal`'s
PRE-EXISTING effect, which does both (`triggerRef.current =
document.activeElement`, restore in the cleanup). Closing either of the two
new-trap dialogs (Cancel, Confirm, or the discard confirm) dropped focus to
`<body>` instead of back to whatever button opened it (WCAG 2.4.3). Fixed by
adding the identical capture/restore pair to both.

**Lesson**: when a dialog is retrofitted with "focus starts inside" for
`aria-modal`, always check it ALSO does the other half (capture + restore on
close) rather than assuming a `.focus()` on open is the whole job — the two
are easy to conflate because they're both one line, but the second one is
the one that has no visible symptom during casual testing (you only notice
it by tabbing right after the dialog closes).

## Gap 3 (found, fixed): a modal's own trigger-capture can go stale across a WITHIN-COMPONENT unmount/remount, not just an async gap

[[nested-dialog-focus-trap]] documents this for an `await`-separated
cross-modal handoff (`SyncReviewModal` opening after `CardPairingModal`
unmounts and a network round-trip elapses). NEO-221's "Back to matching"
produces the SAME symptom with NO `await` at all: `EntityReviewWizard`'s
`onBack` handler does `setPendingPreview(null); setPairingPhase("review")` —
two synchronous `setState` calls in one handler, batched into one React
commit. The wizard (and its "Back to matching" button, which had focus)
unmounts in the SAME commit that flips `CardPairingModal`'s `isOpen` back to
`true`. DOM removal of a focused node blurs to `<body>` synchronously during
the commit's DOM-mutation phase, which happens BEFORE any passive `useEffect`
fires — so by the time `CardPairingModal`'s own mount effect reads
`document.activeElement`, it is already `document.body`, not the button that
"opened" it. No `await` is required for this class of bug; only "the trigger
element is a member of the same tree that's about to make it disappear."

**Fix, same shape as `SyncReviewModal`'s existing `restoreFocusRef`**: added
an identical optional `restoreFocusRef?: RefObject<HTMLElement | null>` prop
to `CardPairingModal`, preferred over its own `document.activeElement`
capture, falling back to the original behavior when absent (so every
existing caller/test is untouched). `CardChecklist.tsx` already had a
durable, always-mounted trigger for exactly this purpose — `syncButtonRef`
(the "Sync card checklist" button) — reused it as `CardPairingModal`'s
`restoreFocusRef` too, so BOTH pairing-related dialogs in that file's
pipeline now share the one durable anchor.

**When auditing here**: any time a parent hands a dialog a way to reopen
itself ("Back to X") by unmounting the CURRENT dialog and flipping another
one's `isOpen` in the same synchronous handler, check whether the reopened
dialog's own focus-capture effect trusts `document.activeElement` — if the
control that triggered the reopen belongs to the dialog now unmounting, it
does not, regardless of whether an `await` is anywhere nearby.

## Gap 4 (found, fixed): a pre-existing native-`disabled` focus-park gap, narrowed but not closed by this ticket

`EntityReviewWizard`'s footer Cancel/Confirm&Save buttons already used native
`disabled={cancelling || saving}` / `disabled={saving}` on `origin/main`
(pre-dating this ticket) with NO focus-park effect — a genuine instance of
[[focus-park-pattern]]'s gap. Before this ticket EVERY cancel went this route
(no confirm concept existed), so the gap was universal; D7 narrowed it to
only the `decided === 0` "nothing to lose, close immediately" fast path (the
`decided > 0` path now goes through `ConfirmDialog`, which already parks its
own focus correctly via `if (busy) dialogRef.current?.focus()`). The ticket
also ADDED two more buttons sharing the exact same native-disabled pattern
(`onBack` "Back to matching", `commitError`'s "Retry commit"). Fixed with one
new effect mirroring `ConfirmDialog`'s own: `if ((cancelling && !confirming)
|| saving) dialogRootRef.current?.focus()` on the wizard's own outer
`role="dialog"` div (`tabIndex={-1}` added to make it a valid focus target).

**The `!confirming` guard is the subtle part**: without it, the new effect
and `ConfirmDialog`'s OWN busy-effect both fire on the SAME `cancelling`
transition when `decided > 0` (cancel confirmed from inside the already-open
`ConfirmDialog`) — and because `ConfirmDialog` is a child within the same
render tree, React flushes ITS effect first, so an unguarded park effect on
the ancestor would fire second and steal focus back OUT of the confirm
dialog that's still on screen. **When adding a park effect at a level ABOVE
an already-open child dialog that has its own park effect on the identical
condition, gate the outer one on "and that child dialog is not currently
open" or the two will race and the outer one wins the race it should lose.**
