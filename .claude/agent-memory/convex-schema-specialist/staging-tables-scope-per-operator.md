---
name: staging-tables-scope-per-operator
description: Per-selectorOption staging tables must be scoped by operator (createdByUserId), because multiple admins sync the same shared set concurrently
metadata:
  type: project
---

Any staging/scratch table keyed on `selectorOptionId` must ALSO be keyed on the
operator who wrote the rows — clear, read, and discard alike.

**Why:** card sets are shared across all operators, and a checklist fetch takes
~80–90s, so two admins syncing the same set at once is the normal case, not an
edge case. `checklistCandidates` (NEO-195) shipped with a selectorOption-wide
stale-clear and an unscoped read, so one operator's Sync deleted another's
in-flight rows and emptied their open review modal mid-review — silently, with
no error. The E2E harness runs eight parallel runners against the same real
sets, which makes this reachable in CI too.

**How to apply:** when adding a table like this, put `createdByUserId` (Clerk
subject) on the row AND in the index, second after the entity id
(`["selectorOptionId", "createdByUserId"]`); the entity id is always fixed
first, so the compound index still covers any genuinely-global query as a
prefix — do not keep a separate single-field index alongside it, a batch is
~900 inserts and every index costs write. Scope reads with
`getCurrentUserId(ctx)` and return an empty result (not a throw) when there is
no identity, because these queries back live `useQuery` subscriptions that
mount before auth resolves. Mutations that already call `requireAdmin(ctx)`
should use its return value as the scope rather than a second identity lookup.

The one exception is a cron sweeper: it has no caller to scope to and abandoned
rows belong to operators who are not coming back, so it stays global and
bounded (`.take(2000)`).
