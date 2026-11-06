---
name: patterns-neo426-teamless-sport-default
description: NEO-426 server-derived "No team" default (sport-row hasNoTeams flag) — how to judge a server auto-stamp of a suppression flag (compare to what the client wire can already send), and the absent-vs-failed lookup trap
metadata:
  type: project
---
NEO-426 lets the commit stamp `teamNoneConfirmedAt` (the missing-team
suppression flag, see [[patterns-neo102-card-team-none]]) WITHOUT an operator
answer, when every resolved player's home sport row carries `hasNoTeams`.

**Escalation test for any server-derived default of an operator answer:**
compare it with what the client wire can already send. `commitCardChecklist`
already accepts `teamNone: true` per card from an admin client, so an auto
default fed into the same `teamNone && no team ids && no pending names` gate
grants nothing new; the strip-a-team question is answered by
`settleCardTeamAnswer` returning early on `hasTeam` (both call sites compute it
from the post-write team ids). Re-check both if either gate moves.

**Shape that held:** the client only hides cards from the Teams step; it never
sends `teamNone` for them, so the server predicate (`defaultsToNoTeamOnCommit`)
is the authority, and a client/server disagreement degrades to "card lands in
the missing-team lane", the safe direction. playerIds come from the server's
`playerIdByName`, skips from the prelude, never from the wire.

**Trap:** a predicate that refuses on `teamLookup === "failed"` but passes on
`undefined` treats "no lookup recorded" as "no team". On a card carrying a BSC
ref that also stamps `teamCheckDoneAt` and suppresses the background lookup
(invariant 8: missing data goes to a person). Ask for `hasBscRef && lookup
!== "answered"` to refuse.

**Flag-on-shared-table rule:** a new optional field on `selectorOptions` rides
`selectorOptionFields` into every doc `returns` validator automatically; check
no public mutation patches a client object spread onto that table (none did
here: no `v.any()`, no `db.replace` on selectorOptions) so the level-check in
the dedicated setter is the only door.
