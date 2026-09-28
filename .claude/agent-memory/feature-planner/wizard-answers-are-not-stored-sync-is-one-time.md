---
name: wizard-answers-are-not-stored-sync-is-one-time
description: Never plan a table that remembers wizard answers, and never engineer re-sync durability; the only durable result of set building is card → player → team links on NB rows
metadata:
  type: feedback
---
Product owner ruling (NEO-313): "We should not be keeping answers to anything.
NB has sets of cards and cards. Cards have players, players have teams. When
building the set we should simply be linking the card to the players. Any
dialogs or interim information needed to do that is simply for the purpose of
building the set/card data and should never be stored." And: syncing a set is
a one-time event; re-sync only repairs broken data and may require rebuilding
the set, so features need not be "smart about resync".

**Why:** a planner proposed an `entityReviewSkips`-style per-set record so a
cross-sport link would survive a re-sync; that is a second source of truth for
a path that only runs on broken data. (`entityReviewSkips` predates the ruling;
do not extend the pattern.)

**How to apply:** scope a plan to the FIRST build of a set. If a re-sync would
re-ask or lose an operator answer, say so in one line and move on. Durable
facts are player/team data (e.g. `playerSports` for a multi-sport athlete) or
derived indexes rebuilt from cards (`cardPlayerLinks`), never answers. Note:
`cardChecklist` has no by-player index (Convex cannot index array members);
`cardPlayerLinks` is the derived join.
