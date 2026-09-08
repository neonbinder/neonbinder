---
name: vitest-throwing-console-spy
description: Two shared-fork-worker vitest flakes in apps/web from console output racing the worker lifecycle — a throwing console spy ("Worker exited unexpectedly" + lower count), and a spurious file-level teardown "failure" ("Closing rpc while onUserConsoleLog was pending") with the FULL count intact; neither is a failed assertion — check .vitest-results.json numFailedTests
metadata:
  type: reference
---

In `apps/web`, vitest runs several test files inside one fork worker. A
`vi.spyOn(console, "log").mockImplementation(() => { throw ... })` therefore
intercepts logs from **every** file sharing that worker, not just the code under
test. When an unrelated file logs during the mock's window, the throw escapes
outside any awaited call and vitest reports:

```
Error: [vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly
```

with `Test Files 49 passed (50)` and a *lower test count* — no assertion ever
fails. Measured at roughly 1 run in 7 on the NEO-170 convex suite; 0/10 once the
spy was made conditional.

**How to use it:** fault injection through a console spy must match on the
message and fire once (`if (!msg.includes("my_marker")) return;` plus a latch),
then assert the latch flipped so the test cannot pass vacuously. More generally,
any global mutated across an `await` in these tests is cross-file racy.

**How to spot it:** compare the *count* between runs, never the word "passed"
— this failure mode leaves "passed" in the output. Related: the user's
`vitest count, not "passed"` rule. It also looks exactly like the CDP/E2E flake
pattern and is not one; it is a test bug with a deterministic cause.

**Sibling signature (no throwing spy needed) — a spurious file-level teardown
"failure" with the FULL count intact.** The same shared-fork-worker + heavy
console output during a run can surface as, on `npm run test:unit`:

```
EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending
 Test Files  1 failed | 109 passed (110)
      Tests  1 failed | 1609 passed (1610)
```

attributed to whichever file happened to be logging as the worker closed (I saw
it on `placeholderAdmin.test.ts`, which passes 31/31 in isolation). Unlike the
throwing-spy case the count is NOT lower — it is the full total minus one, and
the "failure" is a worker-lifecycle race, not an assertion. Confirmed on the
NEO-175 Phase 2 convex suite (lots of `[preprocessWarmupFast] failed
(non-fatal)` logs during scheduled-function drains); roughly 1 run in 2–3,
green on re-run.

**Disambiguator — do NOT report a failure on this alone.** The `.vitest-results.json`
is authoritative: `numFailedTests: 0` with all assertionResults `passed` means
no test actually failed. Re-run, or run the flagged file in isolation; a real
failure reproduces, this does not.
