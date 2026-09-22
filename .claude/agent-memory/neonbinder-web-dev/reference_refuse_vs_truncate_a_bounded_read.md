---
name: refuse-vs-truncate-a-bounded-read
description: Choosing between a thrown refusal and a documented truncation when capping an unbounded Convex read — decided by what the answer IS, not by how big it is
metadata:
  type: reference
---

When you put a cap on a read that had none, what the over-cap case does is
decided by **what the answer means to the caller**, not by the size of the
list:

- **The answer is a COUNT or a decision the operator acts on → throw.** A
  silently short answer is a WRONG answer. `teams.resolveNames` feeds the
  wizard's "will create N new teams" line, so it refuses an over-length name
  list and an over-budget fan-out rather than answering on a partial read.
- **The answer is a NAME MAP or other per-row decoration → truncate, and say
  so in the log.** Every consumer of `teams.getManyByIds` /
  `players.getManyByIds` already renders a missing id truthfully, because an
  orphaned link has always been dropped there ("Linked to an existing record",
  "a dangling id carries no hint", a chip per row found). Less specific and
  still true beats a thrown query, which BLANKS the panel for every row on it.
- **The answer is advisory (a note beside a field) → stop scanning and return
  what you have.** `teams.aliasesInUse` covers the aliases it could afford; the
  absence of a note never meant "definitely unshared" anyway.

The asymmetry is the point: in a query, a throw is not a refused click, it is
an empty screen. Reserve it for the answers where being wrong is worse than
being absent. See `convex/lib/batchIdReads.ts` and
`TEAM_NAME_LOOKUP_READ_BUDGET` in `convex/teams.ts` for the worked cases, and
[[reference_convex_system_op_budget_and_bounded_walks]] for the op arithmetic
that decides the number itself.

One trap when charging a read budget: a SHARED lookup helper hides its own cost
(an index read that returns 16 rows is 1 op; an alias leg's rows are 1 op each),
so a budget charged from the rows returned is an estimate. Document which
direction it errs in rather than re-implementing the helper inline to count
exactly — a second copy of an identity lookup is worse than a loose bound.
