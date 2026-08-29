---
name: disabled-button-pattern
description: how to make a "temporarily blocked" NeonButton/Radix Button reachable and explainable to keyboard + screen reader users
metadata:
  type: project
---

`components/modules/NeonButton.tsx` wraps Radix Themes' `Button`, which renders
a native `<button disabled={disabled}>` — the real DOM `disabled` attribute,
not just a visual/aria state (verified against
`node_modules/@radix-ui/themes/src/components/_internal/base-button.tsx`).
A native `disabled` button:

- is pulled out of the tab order entirely (keyboard users can't reach it at all)
- can't receive focus, so any `title` tooltip meant to explain *why* it's
  disabled is unreachable without a mouse, and `title` isn't reliably
  announced by screen readers even when reachable

This bit `CardPairingModal`'s Confirm button (NEO-195/NEO-189): it disabled on
`confirming || isStreaming` with a `title` explaining the streaming case. The
`confirming` case is fine (self-explaining, momentary, the label itself changes
to "Saving…"). The `isStreaming` case could last ~80s and left keyboard/screen
reader users with **no reachable explanation** for why Confirm wasn't doing
anything.

**Fix pattern** (applied there — see git history around NEO-189 for the
worked example):
- Keep native `disabled` only for the case that's truly terminal/momentary.
- For "blocked pending an external event but should stay reachable," use
  `aria-disabled={condition || undefined}` instead — the button stays
  focusable and in the tab order.
- Guard the actual handler (`if (condition) return;`) so activating it while
  aria-disabled is a safe no-op — don't rely on the DOM attribute to prevent
  the action.
- Point `aria-describedby` at the id of whatever element already explains the
  reason (e.g. a `role="status" aria-live="polite"` banner), rather than only
  a `title`. This makes the reason available at the moment of focus, not just
  whenever the live region happened to announce.
- `NeonButton`'s inline disabled-dimming style keys off `props.disabled ||
  props["aria-disabled"]` (updated for this) — so `aria-disabled`-only buttons
  still get the dimmed/not-allowed visual treatment. Any future NeonButton
  consumer using this pattern doesn't need to add its own dimming.

This generalizes to any button whose disabled reason should be explainable to
a keyboard-only or screen-reader user (bulk-review admin tools especially —
long-running background operations are common here).
