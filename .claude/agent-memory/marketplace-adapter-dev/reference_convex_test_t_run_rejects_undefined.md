---
name: convex-test-t-run-rejects-undefined
description: convex-test's t.run cannot return a value containing undefined (an array with an undefined entry throws); return null or omit the field instead
metadata:
  type: reference
---

In convex-test, the value returned from `t.run(async (ctx) => ...)` goes
through Convex value serialisation. An array containing `undefined` throws,
while an object with an absent field round-trips (the field just isn't
there). Seen writing NEO-358 count tests that mapped rows to
`row.cardCount` where some rows had no count yet.

**How to apply:** in test helpers, map missing values to `null`
(`row.cardCount ?? null`) or return objects and assert with
`toMatchObject`, never a raw array that may hold `undefined`.
