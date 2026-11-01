---
name: cached-lookup-answer-must-reverify-membership
description: A stored "name X resolved to player P" answer confirmed by db.get alone binds P after a rename, alias removal or sport removal; re-check that P still answers to X, in memory, before trusting it
metadata:
  type: project
---

When a fetch caches an exactly-one answer (name key → row id) for a later
mutation to skip a multi-leg lookup (`sameNamePlayers`: primary name,
`playerSports`, `playerAliases`), a `db.get` that returns non-null proves only
that the row exists. It does not prove the row would still be in the lookup's
result. Between fetch and commit an operator can rename the row, clear a wrong
alias ("these were wrong"), or drop a sport. The live lookup would then return
0 rows and leave the card unlinked for review; the cache binds it anyway.

**How to apply:** accept a cached id only when the row still passes every leg's
own membership test: belongs to the sport (`playerBelongsToSport`, free for the
home sport) AND `row.nameNormalized === key` or one of `row.aliases`
normalises to `key`. Both are in-memory on the row already read, so the guard
costs nothing in the common case. Then the only accepted divergence is a NEW
same-name row appearing, which the product owner can rule on explicitly.

Also: Convex caps an array value (including a function argument) at 8,192
entries, so a per-doc chunking constant times a doc cap above that is dead
headroom; the cap has to be applied before the `runMutation` call.

Related: [[convex-occ-read-set-is-the-third-budget]], [[transient-side-table-checklist]].
