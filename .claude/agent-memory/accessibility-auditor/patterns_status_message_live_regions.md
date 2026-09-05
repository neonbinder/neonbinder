---
name: patterns-status-message-live-regions
description: How this codebase pairs role="alert" refusal banners with aria-describedby preview text next to form fields (NEO-212/NEO-236 pattern) — when it's correct and when aria-live would hurt
metadata:
  type: pattern
---

Pattern seen in `components/admin/TeamManagement.tsx` `TeamDetail` (NEO-212 /
NEO-236) and worth expecting elsewhere: a save refusal (name collision, etc.)
renders as `<p id={errorId} role="alert">` conditionally mounted only while
`saveError` is truthy, and BOTH inputs it's about point at it (and at a sibling
preview `<p id={previewId}>`) via a shared `aria-describedby`.

**`role="alert"` is correct here** for a refusal that appears after a button
press — SC 4.1.3 Status Messages wants exactly this for a message needing
immediate attention, and it doesn't move focus (avoids a 3.2.1 On Focus
problem). It re-announces correctly on a *repeated identical* failure too, as
long as the handler clears the error state (`setSaveError(null)`) synchronously
before the retry and only re-sets it after the async call fails — that forces
an unmount/remount (a real DOM content change) rather than leaving an unchanged
node an AT won't re-announce. Check for that clear-before-retry shape whenever
reviewing a `role="alert"` refusal; without it, a second identical failure is
silent.

**A live "preview" line (e.g. "Shows as: San Diego Padres" recomputed on every
keystroke) should NOT get `aria-live`.** `aria-describedby` alone is the right
call: it's read once when the field is focused, which is enough context, and
adding `aria-live="polite"` would re-announce on every single keystroke —
worse for screen-reader users than the status quo, not better. Don't recommend
`aria-live` for this shape reflexively; only for content that needs to interrupt
independent of any focus event.
