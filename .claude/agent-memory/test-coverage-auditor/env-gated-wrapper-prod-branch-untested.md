---
name: env-gated-wrapper-prod-branch-untested
description: An E2E-only wrapper behind a build-env guard is proven by its spec on the E2E side only; ask for a unit test pinning the production branch, and for a planted-break proof of any failure-only fixture path
metadata:
  type: project
---

Diagnostics that only run on E2E builds (a wrapped client, a window.* hook,
an extra logger) ship with a spec proving they work under E2E, but nothing
proves the production branch stays untouched: the component's existing unit
test mocks the wrapped class and passes because the env var happens to be
unset. A flipped guard ships the wrapper to users with every test green.

Same shape: a shared Playwright fixture that only acts when a test FAILS
(attach on failure) is never exercised by a green suite, and vitest excludes
playwright/, so there is no unit route.

**How to apply:** for an `isE2E()`-style branch, ask for a test that stubs the
env both ways and asserts the constructor args / window globals on each side.
For a failure-only fixture path, ask for a planted-break proof (a temporary
failing expect, check the attachments appear and are redacted, restore
byte-exact) recorded in the PR body, or a pure module under lib/ with a unit
test. Also check that unit-test titles match what they drive: "drops it on
unsubscribe" tests often unsubscribe an already-settled call.
