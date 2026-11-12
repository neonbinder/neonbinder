---
name: xhr-guard-and-fake-xhr
description: The network guard also refuses XMLHttpRequest; use lib/testing/fake-xhr.ts to drive uploads, and a convex-test action with R2 env needs fetch stubbed plus fake timers
metadata:
  type: reference
---

`vitest.setup.network-guard.ts` installs a refusing, recording XMLHttpRequest on every project (happy-dom's
real XHR bypasses the fetch guard). A test that uploads installs `installFakeXhr()` from `lib/testing/fake-xhr.ts`
(optional `onSend` hook to auto-answer); `vi.unstubAllGlobals()` restores the guard.

Stall/timer tests of `uploadWithRetry`: inject a scripted `transport` instead of XHR and use fake timers;
`attemptTimeoutMs(12)` is 20001 (ceil), compute it rather than hard-coding 20000.

convex-test actions that configure R2 env: `reserveUpload` schedules a delete, and leaked schedules from
earlier tests in the same file reach the network once R2 env is set. Stub `fetch` in `beforeEach`,
use fake timers and `cancelScheduled(t)` before the test ends.
