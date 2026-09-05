---
name: patterns-status-message-live-regions
description: How TeamPicker.tsx (and likely PlayerPicker.tsx) pairs a role="alert" refusal banner with aria-describedby preview text next to form fields — when it's correct, and the clear-before-retry rule for it to keep announcing on repeat identical failures
metadata:
  type: pattern
---

Verified in `components/SetSelector/TeamPicker.tsx`'s NEO-236/NEO-208 create-team
form: a mutation refusal renders as `<p role="alert">` conditionally mounted
only while `createError` is truthy, and both create-form inputs point at a
sibling preview `<p id={previewId}>` via a shared `aria-describedby`.

**`role="alert"` is correct here** for a refusal that appears after a button
press — SC 4.1.3 Status Messages wants exactly this for a message needing
immediate attention, and it doesn't move focus (avoids a 3.2.1 On Focus
problem).

**Clear-before-retry is required for a repeated *identical* failure to
re-announce**, and there are two different shapes that satisfy it in this
codebase, only one of which is "free":
- **Async catch path** (already correct as written): `setCreateError(null)`
  runs synchronously before the `await`, and the eventual
  `setCreateError(userFacingMessage(err, ...))` only happens after the mutation
  rejects — a real intervening tick/render separates the two, so even an
  identical error string re-mounts the alert and re-announces.
- **A synchronous early-return guard is NOT free the same way.** If a handler
  does `setCreateError("Enter a team name."); return;` directly, and the
  previous rendered value was already that exact string, React's batching
  collapses `null → "Enter a team name."` calls made in the same tick, and
  `Object.is` against the *already-rendered* value can bail the re-render out
  entirely — a second identical activation announces nothing. Give it the same
  shape as the async path: `setCreateError(null)` synchronously, then
  `setTimeout(() => setCreateError("..."), 0)` to commit the message on a
  separate tick.

**A live "preview" line (e.g. "Shows as: San Diego Padres" recomputed on every
keystroke) should NOT get `aria-live`.** `aria-describedby` alone is correct:
it's read once when the field is focused, which is enough context, and
`aria-live="polite"` would re-announce on every keystroke — worse for
screen-reader users, not better. Don't recommend `aria-live` for this shape
reflexively; only for content that needs to interrupt independent of any focus
event.

Related: the submit button this error sits next to should itself carry
`aria-describedby={previewId}` too (not just the two text inputs) — a screen
reader user who tabs straight to a disabled-looking submit currently gets no
programmatic reason for its state without it. See
`patterns_aria_disabled_focus_park.md`.

## The inverse gap, seen in EntityReviewWizard.tsx's `createBlocked` (NEO-236)

Same "standing precondition, not role=alert" shape (correctly reasoned in that
file's own comment: a message tied to a specific field/button via
`aria-describedby`, not a discrete post-submit event — a role="alert"/"status"
here would compete with the header's own `role="status"` progress counter on
every keystroke). But the wiring initially ran only ONE direction: the
buttons (`aria-describedby={createBlockedId}`) but not the actual input whose
blank value causes the block (the Team Name field, and each per-career-team
"Name for new team X" field). That is the mirror image of the TeamPicker gap
above — there it was "button missing it", here it was "field missing it".
**Both controls in the pair need it**: the field, so a screen-reader user
typing into it and clearing it hears the reason without tabbing forward; the
button, so a user who tabs straight to it (skipping the field, e.g. via
Shift+Tab from the next control) still gets it. Add `aria-describedby` to
whichever field's specific emptiness is the actual block condition — not to
every field in the row indiscriminately (e.g. Location was correctly left
out here, since the block is specifically about Name being blank).
