---
name: screenshots-and-nested-env
description: takeScreenshot refuses absolute paths (relative names land under maestro-report/debug/<flow>/<name>/takeScreenshot/); runFlow env is inherited by a nested runFlow, so pass SET into util-discard-resumed-review-batch
metadata:
  type: reference
---

**takeScreenshot (CLI 2.8.0).** An absolute path fails the step:
`Invalid path "…png" for takeScreenshot: it resolves outside this run's
takeScreenshot output folder`. A bare relative name works and lands at
`apps/web/maestro-report/debug/<flow-dir>/<flow name>/takeScreenshot/<name>.png`.
To hand Jason screenshots from a local run: add the steps temporarily with
relative names, run, copy the PNGs to `worktrees/<ticket>/screenshots/`, then
restore the flow. A failure screenshot (`screenshots/step-N-*.png`) at the
right step is also usable. Local captures are 1024x625, CI's 1024x629.

**Nested env is inherited.** `GraalJsEngine.enterEnvScope` pushes a COPY of the
current env and `putAll`s the runFlow's `env:` onto the live map, restoring on
leave (decompiled 2026-10-10). So a util that calls another util with no `env:`
still sees the caller's values. `util-discard-resumed-review-batch` re-runs
`util-fetch-real-set-checklist-to-wizard` with no env, which defaults
`SET` to Topps Big League: a flow on any OTHER set must call the discard util
with `env: { SET: "<its set>" }` or its refetch drills the wrong set.

Related: [[offline-flow-parse-harness]], [[wizard-fixture-lookup-throughput]].
