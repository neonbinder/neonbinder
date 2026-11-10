---
name: websocket-faked-query-masks-transitions
description: A spec that fakes a Convex query value over the sync websocket proves the stored state only; the fake also hides intermediate states (syncing), so session-only branches (alert role, focus return) stay unproven
metadata:
  type: feedback
---

When a spec fakes a reactive Convex query value on the sync WebSocket
(NEO-450 `support/column-sync-fault.ts`), check which branches it can reach:

- It rewrites EVERY server value of the armed query, so intermediate states
  (e.g. status "syncing") never reach the page while armed. A UI branch that
  depends on that transition (focus parked then returned when "syncing" ends)
  is not exercised, and a `toBeFocused()` after the retry would pass
  vacuously because the button never unmounted.
- It forwards action responses untouched, so a branch keyed on THIS session's
  own action result (`reason: "error"` -> role alert) is unreachable; the spec
  proves only the stored-state variant (role status).

**Why:** the spec reads green and "covers the feature", but the a11y branches
the diff added are proven only in happy-dom.
**How to apply:** map each branch to what the fake can produce; ask for the
fake to also rewrite the matching action response (stays within the no-hook
decision) and for focus-return to be asserted in a spec that runs a REAL sync.
Related: [[keyboard-alternative-to-pointer-unit-only]].
