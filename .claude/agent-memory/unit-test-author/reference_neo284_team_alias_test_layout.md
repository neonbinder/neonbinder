---
name: neo284-team-alias-test-layout
description: NEO-284 team-alias test file split (teamAliases / teams.aliasIndexPin / teamAliasLookups / bulkLoad), the loader arming recipe (vi.stubEnv + _scheduled_functions via ctx.db.system), and the saveAsAlias commit-vs-recordDecision split worth pinning
metadata:
  type: reference
---

Team aliases (NEO-284) mirror the player-alias suite one-for-one:
`convex/teamAliases.test.ts` (normalise/sync/save/findOrCreate/aliasesInUse),
`convex/teams.aliasIndexPin.test.ts` (grep pin: `syncTeamAliases` is the only
insert/delete on `teamAliases`, exempting `selectorOptions.resetTeamAliasesBatch`
by name+position), `convex/teamAliasLookups.test.ts` (union/era/collision/
commit/nearMatches/search/saveAsAlias), `convex/bulkLoad.test.ts` (the loader).

**Loader recipe.** `vi.stubEnv("ALLOW_BULK_LOAD","true")` arms `upsertTeams` /
`upsertLeagues` (+ `afterEach(vi.unstubAllEnvs)`); `previewTeams` needs no
arming. Assert "no enrichment scheduled" through
`ctx.db.system.query("_scheduled_functions").collect()` inside `t.run` (cast
ctx — the typed ctx has no `system`). Seed teams with BOTH the `aliases` array
and matching `teamAliases` rows, or the alias leg silently misses.

**Bounds asymmetry to pin, not "fix".** `normalizeTeamAliasList` REFUSES past
64/120 (messages carry counts only); `aliasesInUse` (a read) silently
`.slice(0, 64)`s. Both are intentional per their comments.

**saveAsAlias split.** `entityReviewQueue.recordDecision` only stores the
flag (refuses `true` on a non-team row, tolerates `false`); the alias is
written at COMMIT in `selectorOptions` only — assert on `teams.aliases` and the
`teamAliases` index after commit, not after recordDecision. A held (undecided)
row and a skip decision write nothing.

**nearMatches search-leg overwrite** (teams and players): the search leg must
`if (candidates.has(hit._id)) continue;` or it drops the exact leg's
`matchedAlias`. Regression fixture: alias exact-matches AND the search index
also returns the row; assert `confidence: "exact"` + `matchedAlias` survive.

**Alias collision through the public mutation.** `saveTeamFields` renaming
onto another row's alias throws `NAME_TAKEN:<id>` (via `findCollidingTeams`);
`findOrCreate` with a full name that is another row's alias returns that row.
