---
name: alias-index-pin-exempts-reset-drain-by-name-and-position
description: players/teams aliasIndexPin (and players.sportsIndexPin) flag READS too — ONE query allowed in selectorOptions.ts after `export const reset<Table>Batch`; any other module needing to scan the table calls a paging helper exported from the owner module
metadata:
  type: reference
---

`convex/players.aliasIndexPin.test.ts` (and its NEO-284 twin for
`teamAliases`) greps every non-test `convex/**/*.ts` for `insert|patch(
"<aliasTable>"` and `query("<aliasTable>"`. The sanctioned exception is
checked by NAME and by POSITION, not by file: the module may contain exactly
one `query("<aliasTable>"`, it must sit after the string
`export const reset<Table>AliasesBatch`, and no insert/patch at all.

**Why:** the reset drain has no entity to hand `sync<Table>Aliases`, so it
must read and delete the table directly; the pin keeps that the only
side door so the operator-edited `aliases` array and the flat index cannot
disagree.

**How to apply:** never read the alias index from `selectorOptions.ts` for
any other purpose (the commit prelude reads `linked.aliases` off the team
doc and lets `syncTeamAliases` diff the index). A second lookup belongs in
`convex/lib/teamRow.ts` / `players.ts`, which are the modules the pin
exempts wholesale.

`players.sportsIndexPin.test.ts` applies the same rule to `playerSports`
(`resetPlayerSportsBatch`). A module outside the owners that must SCAN one
of these tables (NEO-322's `rekeyEntityNames.ts`) gets a one-line
read-only `.paginate` helper exported from the owner (`pagePlayerAliasRows`,
`pagePlayerSportRows` in players.ts, `pageTeamAliasRows` in teams.ts) and
still writes only through `sync*`. Never dodge the grep with a variable
table name.
