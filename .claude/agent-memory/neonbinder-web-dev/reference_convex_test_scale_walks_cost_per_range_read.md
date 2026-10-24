---
name: convex-test-scale-walks-cost-per-range-read
description: convex-test range reads scan the table, so a paged walk that does one indexed read per row is quadratic at scale; shape a "past the 5,000 boundary" test as few keys x many rows
metadata:
  type: reference
---

convex-test answers each `withIndex` range read by scanning, so cost grows
with table size times the number of range reads. Walking `collection.ownedCards`
(64 lines a page, plus one `by_owner_and_card` read per listed card) over
5,050 distinct cards took ~26 s in one test; the same walk over 26 cards x
200 lines each (5,200 lines) took ~1.3 s and proved more (a card's lines span
pages and must list once).

**How to apply:** when a test must cross a large line/row boundary, put the
volume in rows per key, not in distinct keys, unless distinct keys are the
thing under test. Insert the fixture in ONE `t.run` (5k inserts there is
~0.2 s). Confirm the scale test goes red by breaking the logic it guards
(back the file up to the scratchpad, edit, run, restore) before trusting it.
See also [[reference-vi-mock-a-constant-needs-a-getter]] for lowering a cap
instead, which only works when the constant lives in a module that registers
no Convex functions.
