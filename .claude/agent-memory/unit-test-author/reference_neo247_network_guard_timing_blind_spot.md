---
name: reference_neo247_network_guard_timing_blind_spot
description: vitest.setup.network-guard.ts's afterEach/afterAll checked for a violation too early to catch one from an undrained runAfter(0) scheduled function — fixed with a 30ms settle in afterAll only.
metadata:
  type: reference
---

`vitest.setup.network-guard.ts` (the NEO-188 fetch guard) pushes a violation
into a module-scoped array synchronously the instant a real `fetch` is
attempted, then throws. `afterEach`/`afterAll` re-check that array and throw
if non-empty, to catch cases where application code swallows the guard's
thrown error in its own try/catch (e.g. `fetchBscCardTeamNameRaw`).

**The bug (NEO-247):** when the real fetch call comes from an undrained
`ctx.scheduler.runAfter(0, ...)` scheduled function, convex-test runs it on a
LATER tick of the real event loop, not synchronously within the triggering
test. An immediate, no-delay `afterEach`/`afterAll` check can run and find the
violations array empty — not because nothing leaked, but because it checked
before the leaked call had actually fired. This is why NEO-247 found ~63
"blocked a real outbound request" console lines that never failed a single
test and never showed as `EnvironmentTeardownError` either: the violation was
recorded into the array too late for any hook to ever see it, and the
`Test Files ... passed` count stayed green throughout.

**The fix:** `afterAll` (which runs once per FILE, not once per test) now
awaits `await new Promise(r => setTimeout(r, 30))` before checking. 30ms was
sufficient to catch every known leak reliably in repeated per-file runs, and
in a `--no-file-parallelism` sequential full run (5/5 clean catches of a known
residual leak in `convex/previewListingTitle.test.ts`, left to another agent
to fix). In the DEFAULT fully-parallel `npm run test:unit`, worker contention
means it's closer to ~2/3 reliable rather than 5/5 — still a massive
improvement from ~0/N before the fix, but not airtight under heavy parallel
load. `afterEach` intentionally got NO added delay (kept at 4600+ tests ×
0ms) — the delay only needed to live in the once-per-FILE check.

**Diagnostic technique worth reusing:** to find which test/file ACTUALLY
leaked (as opposed to whichever test happened to be running when a stray
scheduled function fired), temporarily bump the settle delay in BOTH
`afterEach` and `afterAll` to 100ms and run with
`npx vitest run --project convex-lib --no-file-parallelism` (sequential,
single fork — eliminates cross-worker timing noise). This turns silent
console-log leaks into real, correctly-attributed test failures. Revert the
per-test delay before finishing; keep only the small afterAll settle.

See [[reference_neo247_bsc_multicard_reschedule_needs_cancel]] for the most
common source of what this diagnostic technique found.
