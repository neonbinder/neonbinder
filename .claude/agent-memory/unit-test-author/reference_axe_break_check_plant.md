---
name: axe-break-check-plant
description: How to prove a component test's expectAccessibleInBothModes call is live — plant aria-live="bogus" (not aria-hidden), and a guarded plant/restore script for shared worktrees
metadata:
  type: reference
---

- To prove an `expectAccessibleInBothModes` call catches a broken state, plant `aria-live={"bogus" as never}` on the element that renders only in that state (conditional on the state when the same element shows in several). axe flags `aria-valid-attr-value`, and nothing else in the test notices.
- Do NOT plant `aria-hidden="true"`: RTL's `getByRole`/`findByRole` skip aria-hidden elements, so the test goes red on a locator before axe ever runs — a false proof. Check the red's message says "axe found violations in <label>".
- Same trap for convex plants: a plant that references an out-of-scope variable throws a ReferenceError and turns every test red. Read the error, not just the red count.
- With other agents in the worktree: copy the file to scratchpad, plant, record its hash, run `vitest -t`, and restore only if the hash still matches the plant (else someone edited it mid-run); then `cmp` and `git diff --quiet`.
- `lib/testing/axe.ts` needs no `rerender` for components that don't read the theme at render (CardPhotoViewer); pass `document.body` when the dialog has no container handle.

Related: [[reference_realaddcardstab_test_harness]], [[reference_neo452_held_intake_test_patterns]]
