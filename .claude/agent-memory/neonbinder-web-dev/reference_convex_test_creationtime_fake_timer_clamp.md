---
name: convex-test-creationtime-fake-timer-clamp
description: convex-test stamps _creationTime from Date.now() but clamps it strictly-increasing, so testing a time-based sweep with fake timers needs a base AFTER real wall-clock now, else old rows aren't old
metadata:
  type: reference
---

To unit-test anything that ages/expires rows by `_creationTime` (a cron sweep,
a stale-row cleanup) under convex-test, you drive the clock with
`vi.useFakeTimers()` + `vi.setSystemTime(base)`. The trap: convex-test stamps a
new doc's `_creationTime` as `Date.now()` but **clamps it to be strictly
increasing** — `_creationTime = now <= _lastCreationTime ? _lastCreationTime +
0.001 : now` (node_modules/convex-test/dist/index.js ~line 105).

So if ANY insert happened at real wall-clock time before you set a fake `base`
in the PAST, `_lastCreationTime` is already ~real-now (e.g. 1.79e12 in 2026),
and your "old" rows inserted at `base` get clamped **forward** to ~real-now
instead of `base`. They then look FRESH to the sweep and nothing ages — the test
fails with `aged: 0`.

**Fix:** pick `base` strictly AFTER real wall-clock now, and do every seed under
fake time:

```ts
const base = Date.now() + 10 * 365 * 24 * 3600 * 1000; // ~10y ahead, computed pre-fake
vi.useFakeTimers();
vi.setSystemTime(base);
const t = convexTest(schema, modules);
// ...seed "old" rows here (creationTime ≈ base)...
vi.setSystemTime(base + STALE_MS + 60_000);
// ...seed a "fresh" row; run the sweep (its Date.now() is the mocked one)...
```

The sweep's own `Date.now()` is mocked too, so `cutoff = now - STALE_MS` lands
between the old and fresh rows. A fixed past base like `1_700_000_000_000` does
NOT work — it's before 2026's real now and gets clamped.

Also confirmed here: every Convex index is ordered `(fields..., _creationTime,
_id)` ascending (convex-test index sort at ~line 449), so a `by_status`-style
index returns `status="pending"` rows oldest-first — a sweep can `.take(chunk)`
and `break` at the first row younger than the cutoff. See the NEO-99
`sweepStalePendingRows` in convex/entityReviewQueue.ts +
convex/entityReviewResilience.test.ts.
