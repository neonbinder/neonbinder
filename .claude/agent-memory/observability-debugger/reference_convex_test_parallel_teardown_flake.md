---
name: convex-test-parallel-teardown-flake
description: Pre-existing nondeterministic teardown noise in apps/web's convex-lib parallel unit run — not a regression
metadata:
  type: reference
---

The `apps/web` unit suite (`npm run test:unit`, vitest) emits **nondeterministic
teardown noise** in the parallel `convex-lib` project that is NOT a test failure
and NOT caused by whatever change you're looking at:

- `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
- `Error when running scheduled function <fn> ... after the environment was torn down`
- `Error when running scheduled function placeholderPipeline:enqueueImageChunk ... Component "preprocessPool" is not registered`

**Root cause:** convex-test runs `runAfter(0)` scheduled functions on real
timers. Tests that drive a pipeline which schedules a chain (e.g.
`placeholderPipeline.test.ts` → runExtract → registerExtractedImages →
enqueueImageChunk, which needs the unmounted `preprocessPool` component) leave
those callbacks pending; under parallel load a file's environment tears down
before they fire, so they run against a dead env and their console output races
the worker's rpc close.

**How to confirm it's pre-existing, not yours:** the count is flaky (observed
13–18 across pristine runs). It is invisible if you `tail` the output — the
"Unhandled Errors" section prints just *above* the final summary, so `tail -25`
shows a clean-looking pass. Grep the FULL output:
`npm run test:unit 2>&1 | grep -cE "onUserConsoleLog|Error when running scheduled function"`.
Stash your changes (`git stash -u`) and it still reproduces.

**The suite still exits 0** — all tests pass, the `&& node scripts/verify-test-completeness.mjs`
gate runs, `test:e2e`-style completeness is 106/106 (pre-change). Don't chase it
as a regression; don't "fix" it by draining scheduled functions in an unrelated
test.

**If a NEW convex-test file schedules `internal.posthog.captureEvent` or a
pairing run** (as the NEO-170 watchdog does), the clean way to keep it from
adding to this noise is `vi.useFakeTimers()` in `beforeEach` / `vi.useRealTimers()`
in `afterEach` and assert the sweep's SYNCHRONOUS effects (DB patches + the
dual-written `console.warn` line) — leave the `runAfter(0)` schedules undrained
so they never fire on a real timer post-teardown. Draining them
(`finishInProgressScheduledFunctions`) pulled `runPairing`'s dynamic
`lib/pairing/pool.ts` import into the race and cascaded a failure into an
unrelated component test (`app/placeholders/page.test.tsx`). See
[[neo170-wedged-batch-alert]].
