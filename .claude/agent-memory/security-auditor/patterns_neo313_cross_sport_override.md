---
name: patterns-neo313-cross-sport-override
description: NEO-313 cross-sport player/team override - where the sport guard was relaxed (card only, set keeps it via noun), the commit's client-supplied sportId trap, and the derived cardPlayerLinks index pin
metadata:
  type: project
---

NEO-313 relaxed the "player/team must be in the card's sport" guard on
`resolvePlayerIdsForWrite` / `resolveTeamOnCardIdsForWrite`. The card guard is
gone; the SET guard stays via the `noun !== "card"` branch. Ids stay safe
because args are `v.id("players")` / `v.id("teams")` (table-typed) and every id
is existence-checked before the write.

Recurring trap: `commitCardChecklistPrelude.args.sportId` is a CLIENT argument
checked only for `level === "sport"`, never against the selector row's ancestry.
The chunk walks `findSportForSelectorOption` for this reason, so any NEW writer
keyed on the commit's sport (e.g. addSetSport -> playerSports) should use the
walked sport, not `args.sportId`.

`cardPlayerLinks` is a derived index; `cardPlayerLinks.pin.test.ts` counts
`orphanVariationsOf` vs `deleteCardPlayerLinks` calls in selectorOptions.ts and
the cardChecklist insert sites. A new card delete or playerIds writer outside
that file will not be caught by the counts - grep for it.

**How to apply:** on any later cross-sport or multi-sport change, re-check the
noun branch, the client sportId, and the pin counts. Related:
[[patterns-public-function-auth-registry]], [[patterns-wikidata-pool-abuse-surface]].
