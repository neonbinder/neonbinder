---
name: focus-park-pattern
description: NeonBinder's established pattern for parking keyboard focus when the control that had it is about to disappear or be disabled — where it's used right, and where it was missing
metadata:
  type: patterns
---

This codebase already has a correct, well-documented convention for a common
React-SPA failure mode: an action disables or unmounts the very control that
triggered it, and the browser drops focus to `<body>` with zero indication to
a keyboard/screen-reader user of what happened or where they are now.

**The pattern**, seen in two places:

1. `apps/web/components/modules/confirm-dialog.tsx` — while `busy` is true,
   both dialog buttons disable simultaneously (nothing left to Tab between), so
   an effect parks focus on the dialog container itself: `if (busy)
   dialogRef.current?.focus()`. The container has `tabIndex={-1}` and `role`/
   `aria-modal` already giving it a real accessible name to announce.
2. `apps/web/app/print/placeholders/intake.tsx` — after confirming Close/Abort,
   the button that was pressed can vanish once the session leaves its active
   states. Focus is parked on `#session-heading` (`tabIndex={-1}`, with its own
   `focus-visible:ring-2 focus-visible:ring-neon-purple` since a programmatic
   focus target needs a visible indicator of its own — WCAG 2.4.7), via
   `requestAnimationFrame(() => document.getElementById("session-heading")?.focus())`
   deferred one frame so it lands after the dialog's own unmount-restores-focus
   cleanup.

**The gap found (NEO-152 audit, 2026-08-26):** `review-grid.tsx`'s Split /
Swap sides / Pair these two actions all shared one global `busy` flag that
disables every control in the grid while any one action is in flight —
including the control just activated — and none of the three applied this
pattern. Two distinct failure moments, both real:

- **Immediate**: the instant `busy` is set, the just-clicked button disables
  and the browser blurs it to `<body>` — this happens on *every* action, not
  just ones that remove an element, because disabling a focused form control
  forces a blur in every major browser.
- **Delayed**: Split removes the pair's `<li>` outright; Swap changes the
  pair's key (`frontIndex-backIndex` reverses) so React unmounts the old node
  and mounts a new one; a completed Pair empties the last two cards out of the
  loose pile, which can unmount the whole "Not paired" section including the
  button itself.

**Fix applied**: an effect identical in shape to confirm-dialog's —
`useEffect(() => { if (busy !== null) sectionRef.current?.focus(); }, [busy])`
— focusing a `tabIndex={-1}` ref on the grid's own outer `<section>` (which
always has an accessible name via `aria-label`/`aria-labelledby` either way).
Firing on `busy` becoming non-null catches the immediate blur *before* it can
happen; because focus then already sits on a stable node, the delayed
unmount/remount cases are covered by the same fix with no separate check
needed.

**When auditing new interactive UI here**: any component with a shared `busy`/
`pending` flag that disables multiple controls at once is a candidate for this
exact bug. Check what happens to keyboard focus in the disabled instant, not
just after the async action resolves — the disable-triggered blur happens
first and is usually the actual moment focus is lost, even when the visible
symptom (an element vanishing) looks like the later cause.

Also add a success **status message** alongside the fix, not just error
handling — see [[live-region-role-pattern]]. review-grid.tsx had a `role=alert`
region for failures but nothing telling a screen-reader user an action
*succeeded*; visible DOM restructuring (a card moving between lists) is not
narrated by AT on its own (WCAG 4.1.3).

## The native-`disabled`-on-the-just-clicked-button bug keeps recurring, one button at a time (NEO-102, 2026-09-02)

NEO-189 found and fixed this on `CardPairingModal`'s Confirm button; the fix
(swap native `disabled` for `aria-disabled`, since the FIRST needs the
button to disable while STILL being reachable — a caller mid-background-fetch
case) was applied there and to `MissingTeamFixer`'s own Save button when that
component was built. But `MissingTeamFixer`'s SECOND button, "No team on this
card" (which also sets the same `busy` flag its own click triggers), still
used plain `disabled={busy}` — same file, same session's own prior fix
sitting right next to it, missed anyway. This is worth calling out as its own
checklist item because it keeps recurring **per-button, not per-component**:
fixing one busy-gated button in a dialog does not imply its siblings got the
same treatment. **When auditing any dialog with a `busy`/`pending` flag that
multiple buttons key off of, check EVERY button individually** — grep for
`disabled={` (not `aria-disabled={`) near any button whose own `onClick` is
what sets that flag.

## A DERIVED "may I steal focus" gate belongs on an auto-triggered interruption — CardChecklist's post-commit walker (NEO-102, 2026-09-02)

`CardAttentionWalker` can open itself automatically (no operator click) for
up to 15s after a commit, once the background BSC pass flags a card — a
genuinely different case from every other entry in this file, because
nothing DISABLED or UNMOUNTED the operator's current control; the interrupt
is generated entirely by a REACTIVE SUBSCRIPTION UPDATE unrelated to
whatever they're doing. Nothing in the original code checked whether the
operator was mid-task before yanking focus into the new dialog. Fix: read
`document.activeElement` at the moment the auto-open condition would
otherwise fire and suppress the open (but NOT the underlying state — the
manual entry point stays available) when it's a text input/textarea. This
reads `document.activeElement` inside a component body rather than an
effect, which is fine here specifically because it can only ever SUPPRESS a
state transition, never cause one — an impure read that's advisory-only and
one-directional is a materially different risk than one that drives a
`setState` cascade. **Any future "arm now, auto-open later on a live
condition" feature in this codebase should get the same guard** — check for
one whenever a dialog can mount itself with no antecedent user click.
