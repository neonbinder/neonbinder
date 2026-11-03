---
name: walk-a-ledger-by-position
description: E2E following a step ledger — reading the label of `open.first()` races the last step landing (the locator re-resolves to nothing and textContent waits the full action timeout); walk `listitem.nth(i)` + toHaveAccessibleName instead
metadata:
  type: reference
---

`followRunToEnd` (playwright/support/collection.ts) checks that an open
(`, working|waiting`) item is visible, then reads `open.first().textContent()`.
A locator re-resolves on every call: if that step lands in between and it was
the last open one, `textContent` finds no element and waits the whole action
timeout before throwing. If the step lands but stays first, the text carries
", done" and a suffix-strip that only knows working/waiting builds a name that
never matches.

For a ledger whose items keep their place (NEO-415 Set me up,
`SetupSections.tsx`), walk by position: `steps.nth(i)`, wait
`step.or(answer)`, break on the answer, then
`expect(step).toHaveAccessibleName(/, (done|...settled words)$/)`. One wait per
step, no text read, no race. Say in a comment that `nth` is the run order,
since GUIDE rule 2 keeps `nth` for "any one of these" otherwise.

Related: [[reference_ensure_sync_idle_window_races_playwright]].
