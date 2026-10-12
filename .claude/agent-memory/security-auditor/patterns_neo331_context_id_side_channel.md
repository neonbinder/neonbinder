---
name: patterns-neo331-context-id-side-channel
description: A signed-in query that takes an id from an admin-gated table as ranking "context" leaks that row through order and tier; and a client moved to a new query leaves the old public query live and often unclamped
metadata:
  type: project
---

NEO-331 (2026-10-10), `teams.pickerCandidates`:

(a) The query was signed-in but read `selectorOptions` (every public read of
that table is `requireAdmin`) by a caller-supplied `contextOptionId`, ranking
teams by the row's `features.league` and year. The row was never returned,
but tier and order disclosed which league it resolves to and narrowed the
year. Fix: honour the context only when the caller is admin; otherwise rank
context-free.

**Why:** a ranking or filter keyed on a gated row is a read of that row.

**How to apply:** when a non-admin query accepts an id from an admin-gated
table for "context", check what order, tiers, counts or existence differences
disclose; gate the context on role, not just signed-in.

(b) After a client moves to a new query, grep `api.<module>.<old>`: the old
public query stays deployed, often without the new one's clamps (here
`teams.list`, uncapped `take(args.limit ?? 100)`). Delete it in the same PR or
clamp it.
