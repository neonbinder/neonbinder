---
name: swept-log-markers-are-pinned
description: convex/resolvabilityLogSafety.test.ts pins the exact wording of the NEO-252 skip/coverage log lines in selectorOptions.ts and setReconciliation.ts; rewording one fails the gate with "expected 0 to be greater than 0"
metadata:
  type: reference
---

`apps/web/convex/resolvabilityLogSafety.test.ts` filters captured console
lines by literal markers such as `dropping bsc from coveredSides` and
`[syncSetsAcrossManufacturers] no BSC ids on this path`, then asserts the
matched lines carry no NB row value AND that at least one line matched.

**Why:** the "at least one" half exists so a swept log site cannot be
"fixed" by silently disappearing — but it also means a harmless rewording
of the marker text reads as a vanished log line and fails the gate with
`expected 0 to be greater than 0` at `expectSafeLogs`.

**How to apply:** when touching a `console.warn`/`console.log` in the
resolvability / coverage-narrowing paths, keep the existing marker prefix
intact and append new detail after it (e.g. a conditional "is paused" clause
placed after the marker, or a suffix). Grep the test for the marker before
changing any of these lines.
