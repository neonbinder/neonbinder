---
name: convex-test-bulk-rows-bypass-children
description: Seeding thousands of selectorOptions rows in convex-test — insert directly inside one t.run, never through a seed helper that patches the children cache
metadata:
  type: reference
---

Testing a `MAX_YEAR_SET_ROWS`-style bound needs 3000+ `selectorOptions` rows.
Done through the file's usual `seedSet` helper it is O(n²): each call is its
own `t.run` that re-reads the parent and rewrites a `children` array that grows
to 3000 entries.

Insert them directly in ONE `t.run` loop with `children: []` and no parent
patch — the `children` cache plays no part in an indexed
`by_level_and_parent` read, which is what these bounds are about. A 3001-row
overflow test then costs ~150ms, cheap enough to keep in the normal unit run.
Precedent: `setFromMarketplace.test.ts` (buildSetNameIndex truncation).

Related: [[convex-test-read-budget-by-construction]], [[convex-test-needs-the-modules-arg]]
