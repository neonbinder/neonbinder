---
name: recording-hits-stage-career-teams-by-qid
description: When adding names to enrichment-lookups.json, a player HIT's dated careerTeams become staged team steps looked up WITH knownQid; a recorded null or a different wikidataId is a miss, refused under NEO-413
metadata:
  type: reference
---

Recording a player for the E2E enrichment fixture is not one key. If the live answer is a hit, every
DATED `careerTeams[]` stint at a club the catalogue lacks is staged as a team step
(`stageCareerTeamRowsImpl`), and its lookup carries the stint's `wikidataId` as `knownQid`.
`undatedCareerTeams` stage nothing.

`readFixture` with a `knownQid` treats a recorded `null` as a miss, and a recorded `wikidataId`
that differs as a miss too. Under the recording a miss is refused at error level. So:

- capture each new dated club with `lookupTeamEnrichmentLive(name, sport, knownQid)`, then its
  `leagueWikidataId` league the same way (`lookupLeagueEnrichmentLive(..., knownQid)`);
- check existing team keys for a QID mismatch. Wikidata sometimes hands the same club two ids
  (Montreal Expos recorded as Q825838 while a stint points at Q1148233). §4a forbids changing an existing
  entry, so report it instead.

A single SPARQL player search can time out (30 s) twice in a row, then answer on a third try. Re-run
dropped names. Never record them as null.

Prove coverage with a scratch `.mts` under `npx tsx` that sets the two env vars and calls
`readFixture` for every lookup, career teams and leagues included. Related: [[convex-test-files-are-not-typechecked]].
