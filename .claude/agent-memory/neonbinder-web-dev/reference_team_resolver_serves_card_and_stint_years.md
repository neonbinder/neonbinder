---
name: team-resolver-serves-card-and-stint-years
description: resolveTeamForSetYear answers for BOTH a card's set year and a career stint's start year — card-only era rules go behind the opt-in allowPastEra option (NEO-307); and a disjoint-era alias on a successor row steals retro cards
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

**Alias hazard (verified with a probe, 2026-09-25):** the S1 alias guard only
refuses another team's primary name when the eras OVERLAP. A dated successor
(LA Dodgers 1958–) may carry "Brooklyn Dodgers" as an alias; then a 2026
"Brooklyn Dodgers" card has two candidates, only LA's era covers 2026, and the
several-candidate path silently links LA. An alias written on an UNDATED row
before the other row exists skips S1 entirely and does the same.

**How to apply:** when touching era narrowing or alias writers, test both the
card and stint callers, and a successor row wearing its predecessor's name.
Related: [[shared-alias-only-match-is-a-question-not-an-adopt]].
