---
name: patterns-neo495-scoped-capped-list
description: Adding a scope arg to a capped admin list (take(CAP+1) + truncated) — what to check; filter-after-take with `truncated` computed post-filter silently under-reports
metadata:
  type: project
---

NEO-495 gave `teams.listForManagement` (requireAdmin, capped newest-first window
with a `truncated` flag) an optional `leagueId: Id | "none"` read via an index.
Auth and validator were clean; the reusable checks:

- New arg on an existing public fn: the hand registry only pins one arg shape.
  Confirm a registry entry exercises the NEW arg (here `{ leagueId: "none" }`)
  and the gate is still the handler's first line.
- `"none"` sentinel -> `q.eq(field, undefined)` reads exactly the rows missing the
  field; the union validator keeps arbitrary strings out.
- Client sends a URL/select value cast to `Id<...>`: check the URL param is
  allowlisted against loaded ids before it becomes an arg, or a hand-edited
  link throws the subscription into the error boundary.
- Trap: a secondary arg applied as `.filter()` AFTER `.take(CAP + 1)` and then
  `truncated = rows.length > CAP` on the filtered rows reports "complete" while
  rows were dropped — the exact silent-cap the flag exists to prevent. Compute
  `truncated` before the filter, use a compound index, or reject the combo.

**How to apply:** any scoped variant of a capped list; related
[[patterns-neo296-transaction-bounds]], [[patterns-neo321-build-source-resolver]].
