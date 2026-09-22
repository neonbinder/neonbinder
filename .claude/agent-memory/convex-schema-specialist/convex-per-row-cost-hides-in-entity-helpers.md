---
name: convex-per-row-cost-hides-in-entity-helpers
description: In apps/web/convex, a loop's real per-row op cost is almost never visible at the call site — the shared name-resolution helpers fan out to 3-30 ops each. Always read into the helper.
metadata:
  type: project
---

When auditing a Convex loop for the system-operation budget, the call site lies.
This repo funnels entity resolution through a small set of shared helpers, and
each one costs far more than the single line that calls it suggests.

The fan-out, measured:

- `lib/teamRow.ts` `findTeamsByFullName` → `findTeamsByExactName` (1 index read)
  + `findTeamsByAlias` (1 index read) + **up to `TEAM_ERA_SCAN_LIMIT` (16)
  `db.get`s**, one per alias-index hit. So **2–18 ops**, from one call.
  `resolveTeamForSetYear` and `findCollidingTeams` both wrap it.
- `players.ts` `sameNamePlayers` → 1 `players` index read + 1 `playerAliases`
  index read + 1 `db.get` per alias hit (≤8). **2–10 ops.**
- `players.ts` `buildExistingPlayerCandidates` → `sameNamePlayers` plus up to 3
  team `db.get`s per candidate for the career summary. **up to ~35 ops.**
- A player `create` in `commitCardChecklistPrelude` additionally resolves every
  Wikidata career team through `resolveTeamForSetYear`, so one enriched player
  create is **~28 ops** — the same figure NEO-296 measured for the bulk decide.

**Why it matters:** the two worst instances found so far (`decideAllRemaining`,
and the commit prelude) each looked like "one write per row" at the call site
and were ~28. A reviewer who costs the loop body without opening the helper will
size a chunk 10–30x too large and the bound will not hold.

**How to apply:** when costing any loop in `convex/`, open every helper it calls
and count the reads inside, including the conditional legs (the alias leg, the
ambiguity leg, the career-team leg). Write the derived per-row number into a doc
comment at the site, the way `CARDS_PER_COMMIT_CHUNK` and
`ENTITY_REVIEW_BULK_PAGE` do, so the next change can re-derive the bound instead
of guessing. Beware a cost comment that counts only the happy path —
`commitCardChecklistPrelude`'s own note claims O(distinct names) index reads and
omits the career-team fan-out entirely.

Related: [[convex-two-transaction-limits]].
