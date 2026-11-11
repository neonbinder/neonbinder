---
name: harness-fix-masked-by-product-fallback
description: A test-seed change that pre-does work a product fallback also does (e.g. seed saves an id the drain would read lazily) cannot be proven by the E2E going green; unit tests are the proof, E2E only proves the failure stop
metadata:
  type: feedback
---

When a diff only changes a test-harness seed action so it pre-does work a
product path would otherwise do lazily (save an id, warm a token), the covering
E2E stays green whether the seed's new work happens or not: the product
fallback hides it. So:

- The unit tests on the seed are the only proof the work happens; check they
  assert the write AND its order relative to the status write that starts the
  product path (a call-order tap on `_handler`).
- The E2E proves only the failure leg: the seed page stops on `stored: false`
  and prints the reason. Check the seed page filters `!stored && !skipped`.
- Do not demand a new spec; demand that every early-return branch of the new
  helper (session open failure, read failure, empty answer) has a unit test,
  since each maps to a distinct reason string.

**Why:** a harness-only PR claimed "the seller specs prove it"; they could not
distinguish the fix from the old lazy path.
**How to apply:** any PR touching `convex/testing.ts` seed actions.
Related: [[seeded-terminal-state-spec]], [[cross-service-error-string-contract]].
