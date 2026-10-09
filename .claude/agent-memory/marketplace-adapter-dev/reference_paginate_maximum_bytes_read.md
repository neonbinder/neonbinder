---
name: paginate-maximum-bytes-read
description: paginate() takes maximumBytesRead (convex 1.45), convex-test enforces it and transactionLimits.bytesRead; a single .take(N) cannot be byte-bounded, so page big card reads across queries
metadata:
  type: reference
---

A check of `ctx.meta.getTransactionMetrics().bytesRead.remaining` BEFORE a read
(the holder-walk pattern, `WALK_BYTES_RESERVE` in selectorSyncStore.ts) cannot
bound one `.take(5001)`: the read itself can cross 16 MiB. For a big list of
cards:

- page it across separate query calls with
  `.paginate({ numItems, cursor, maximumBytesRead })`. A byte-split page still
  returns the row that crossed the bound (`isDone: false`), so every page makes
  progress. Sum `getTransactionMetrics().bytesRead.used` per page if a total
  byte cap is wanted;
- a mutation that reads rows one by one by id checks remaining room before each
  read after the first, stops early, and returns how many it `processed` so
  the action resumes from there.

Only one `paginate` per function: take/first/get beside it are fine.

When the contract gives a query no cursor (a reactive read the client
subscribes to whole), use ONE `paginate({ numItems: CAP + 1, cursor: null,
maximumBytesRead })` and answer "too many" when `!isDone || page.length > CAP`:
`isDone` is false both past the row cap and at the byte bound, so one check
covers both, and the `+ 1` keeps an exactly-CAP list from reading as over.

To test: `convexTest({ schema, modules, transactionLimits: { bytesRead: X } })`
plus rows padded with `"x".repeat(kb * 1024)` in a field the code under test
never copies. An unbounded read then THROWS exactly as on Convex. Seed heavy
rows in several `t.run` batches (the write limit applies too).

Size such fixtures with LITERALS. A row count derived from the cap under test
(`Math.ceil(CAP / size) + 2`) scales with the constant, so a mutation that
raises the cap stays green. Seen once in practice, caught by a break-check
([[a-green-suite-can-mean-the-test-stopped-testing]]).
