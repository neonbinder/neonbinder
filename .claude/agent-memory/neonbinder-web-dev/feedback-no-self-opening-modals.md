---
name: feedback-no-self-opening-modals
description: Never let a modal open itself off a background/reactive event — advertise the work in a live region and let the operator press a button
metadata:
  type: feedback
---

A modal must never open itself in response to a background event (a
subscription tick, a queue finishing, a commit resolving). Surface the fact
reactively — a count, a banner, an inline call-to-action button — and let the
operator open the dialog by pressing something.

**Why:** NEO-102 shipped an attention walker that armed on a completed commit
and opened when a background enrichment pass flagged its first row. Two costs,
both real:

1. **It breaks E2E.** The dialog's `fixed inset-0 z-50` overlay swallowed the
   next tap of any Maestro flow that committed and then touched the grid
   (`checklist-fetch-unknown-entities-link-existing`,
   `checklist-fetch-wizard-add-career-team`). The failure screenshot showed a
   plain grid, because the grace timer had already closed the modal by the time
   the shot was taken — so the symptom pointed nowhere near the cause.
2. **It is an interruption, and a11y has to paper over it.** The auto-open
   needed a `document.activeElement` guard purely to avoid yanking focus out of
   a text field mid-keystroke, and a 15s grace timer to bound how far into
   unrelated work it could fire. Both were load-bearing scaffolding for a
   behaviour nobody asked for.

**How to apply:** when tempted by "the work is ready, so show them", render the
affordance instead of the dialog. Put the count in an existing
`role="status"` / `aria-atomic` region so it re-announces as it changes, and
reuse the ONE handler the manual entry point already has, so there is exactly
one way the dialog can come up. Applies to any dialog, drawer, or overlay in
`apps/web` whose trigger would be data rather than a press.

Two follow-on details worth reusing:

- **Reactive counts belong in `role="status"`, not `role="alert"`.** A count
  that changes as a background pass runs will re-announce on every tick; polite
  is right, assertive is an interruption of its own. Gate the CTA to the
  status tone when the region flips role on failure.
- **Don't copy a neon-green hover/focus recolour into a tinted container.**
  `#00D558` measures 1.65:1 on `bg-blue-100`, so `hover:text-[#00D558]` +
  `focus:outline-none` (the pattern used on the white-background header
  button) drops the text under 4.5:1 and removes the focus indicator. Change
  the underline style on hover and leave the UA focus ring alone.
