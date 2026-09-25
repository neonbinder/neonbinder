---
name: team-resolver-serves-card-and-stint-years
description: resolveTeamForSetYear answers for BOTH a card's set year and a career stint's start year — card-only era rules go behind the opt-in allowPastEra option (NEO-307); aliases may never be another team's name in any era, because a disjoint-era alias steals retro cards
metadata:
  type: reference
---

`resolveTeamForSetYear` (convex/lib/teamRow.ts) is the single name→team gate,
but its `setYear` argument means two different things depending on the caller:

- card callers pass the SET's year and opt in with `{ allowPastEra: true }`:
  `teams.findByNameAndSport` (the review gate), the commit's team loop (create
  guard + resolve phase), and cardChecklist's backfill + BSC team resolution;
- stint callers pass a STINT's start year and stay strict (no option):
  `teams.findByFullNameInternal` (Wikidata career teams), the career-team
  staging loop in entityReviewQueue, and the commit's `resolveTeamIdByName`
  (its only caller is `resolveCareerTeamId` — despite living in the commit, it
  is a STINT path, not a card path).

**Why it matters:** an era rule justified by card semantics ("a retro card can
show a folded team") is wrong for a stint — a player cannot play for a team
after it folded. The option defaults off so a new caller must decide which
kind of year it holds. Before changing the rule, list the callers and which
year each passes. The commit's create guard is not independently pinned: the
create path's `findCollidingTeams` adopts an undated/overlapping answer anyway.

**Alias rule (NEO-307):** a team's alias may never equal another team's
primary full name in the same sport, WHATEVER the eras. The old S1 guard only
refused overlapping eras, which let a dated successor (LA Dodgers 1958–) carry
"Brooklyn Dodgers" and silently win every 2026 retro card, because the era
narrowing picks the one covering row. The reverse order (creating or renaming
a team onto another team's alias) is `assertNameNotAnotherTeamsAlias` /
`findAliasHoldersOfName`, gated on the key changing so a legacy pair cannot
lock a team out of its own saves. The bulk loader checks both orders: forward in
step 4 (`aliasOwnedBy`), reverse in step 4b (`nameHeldAsAliasBy`, status
`ambiguous`, nothing written).

**How to apply:** when touching era narrowing or alias writers, test both the
card and stint callers, and a successor row wearing its predecessor's name.
Related: [[shared-alias-only-match-is-a-question-not-an-adopt]].
