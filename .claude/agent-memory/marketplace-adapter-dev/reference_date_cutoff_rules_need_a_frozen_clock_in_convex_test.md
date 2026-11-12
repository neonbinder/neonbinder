---
name: date-cutoff-rules-need-a-frozen-clock-in-convex-test
description: a rule keyed on a row's _creationTime vs a fixed date flips when the suite runs past that date; freeze Date per describe, and compare _creationTime with ceil/floor
metadata:
  type: reference
---

convex-test stamps `_creationTime` from the real `Date.now()`. A rule that
compares a row's creation with a fixed calendar date (NEO-520's eBay floor:
rows made before a legacy cutoff get a fixed date, later rows their own
creation) passes today and silently changes meaning once the suite runs after
the cutoff.

**How to apply:** freeze only `Date` for the describe block —
`beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at) })`
plus `afterEach(vi.useRealTimers)` — and pick `at` on the side of the cutoff
the test means. Scheduled functions still run (convex-test schedules with the
real `setTimeout`). `_creationTime` can carry a fractional millisecond while a
marketplace ISO date is whole ms, so an "exactly at the row's start" fixture
needs `Math.ceil(created)` and "just before" `Math.floor(created) - 1`.
Prove the test bites by swapping the rule back and watching it go red
([[pin-tests-need-a-bypass-plant]]).
