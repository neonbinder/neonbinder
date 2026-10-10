---
name: convex-test-search-is-not-the-backend
description: convex-test's withSearchIndex returns insertion order (no BM25), prefix-matches EVERY term, and never checks filterFields — so a search-ranking unit test can pass for the wrong reason; typecheck is what catches an undeclared filter field
metadata:
  type: reference
---

`convex-test` (the edge-runtime unit harness, read in `node_modules/convex-test/dist/index.js`,
`case "Search"` and `evaluateSearchFilter`) is a naive stand-in for the real search engine:

- **Order is `_creationTime` ascending.** No relevance. The real backend orders
  by BM25 and breaks ties toward NEWER documents, the opposite of the harness.
- **Every query term prefix-matches** (`word.startsWith(term)` for any term).
  The real engine prefix-matches only the FINAL term.
- **Filters are evaluated on any field path.** An `.eq("leagueId", …)` on a
  search index whose `filterFields` does not declare `leagueId` passes in the
  harness and is refused by the deployed backend.

**Why:** found while reviewing NEO-331 (2026-10-10), which added a
league-filtered search leg (later replaced by a `by_league_id` read, because
two same-text searches in one query left the subscription stale) and pinned it with "30 same-token teams, the
right one inserted last". In the harness `.take(25)` drops the LAST-inserted
rows; on the backend it would drop the OLDEST. The test is still a valid
proof that the filtered leg is needed, but only by accident of direction.

**How to apply:** when a plan's tests pin search ranking or a window
(`.take(n)` on a search), tell the test author which order the harness uses
and write the fixture so the expected row is outside the window in BOTH
orders (or rank it with an explicit server-side sort, never search order).
For a new filter field, the gate is `npm run typecheck` — the generated
types restrict `.eq()` to declared `filterFields` — not convex-test.
Related: [[strict-returns-drift-is-invisible-to-typecheck]].
