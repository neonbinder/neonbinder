---
name: keep-failure-artifacts
description: Each playwright run wipes playwright/results, so an intermittent red's screenshot and error-context.md vanish on the next run unless --output points elsewhere
metadata:
  type: feedback
---

`npx playwright test` clears `playwright/results/` at the start of every run, so a red you want to diagnose is gone after the next command (even a different spec or project).

**Why:** the "never diagnose timing first" rule needs the screenshot and `error-context.md`; losing them forces a reproduction before any theory.

**How to apply:** when chasing an intermittent red, run with `--output=<scratchpad>/outN` and read the artifacts from there before launching any other run.
