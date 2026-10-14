---
name: record-a-fixture-sets-lookups
description: How to add one wizard fixture set's Wikidata lookups to the NEO-289 recording (captureFromCli scoped by a creation-time boundary, paged, merged with the NEO-346 script), where the exact staged-name list comes from, how to prove 100% hit offline, and how to classify a card's club as auto-link vs operator step without a probe
metadata:
  type: reference
---

**Capture runs on a catalogue-loaded preview** (NEO-346 superseded the old
"it refuses past 5,000 rows" note). `captureFromCli` lists only names a RUN
looked up: entity rows created since a boundary (default: the oldest `year`
row's `_creationTime`; the catalogue keeps its source creation times, so it
is older), plus `entityReviewQueue` and `entityReviewSkips` rows. Each source
is an index range capped at 2,000 rows and named in `truncatedSources` when
cut; on a deployment whose year rows predate its catalogue, pass `since`.
`offset`/`limit` page a long list. Arming is still a deployment env flag set
for the run and removed after (runbook: `docs/operations/neo289-enrichment-
fixtures.md` §4; the module header of `convex/enrichmentFixtures.ts` has the
exact commands).

**The result's `fixture.entries` is a sorted LIST of `{key, entry}`**, not the
file's keyed object: a key embeds the name and Convex rejects a non-ASCII
field name in a return value (one accented club failed a whole page). Never
hand-merge it. **Merge with one command** from `apps/web`:
`npx tsx scripts/merge-enrichment-capture.ts <capture.json>...` (every page's
file, in order). It adds only keys the file lacks, lists any key whose answer
differs instead of overwriting it (`--replace` is the deliberate re-capture),
`--dry-run` reports only, and it writes the committed format itself (Python
`json.dumps(indent=2)` with `\uXXXX` escapes). The rules live in
`convex/adapters/enrichmentFixtureMerge.ts`; the hand-written Python merge is
retired.

**Fallback when a capture cannot be armed**: run the same live bodies locally
under `npx tsx` (an `.mts` script; a `.ts` in the scratchpad is CJS and
top-level await fails): `lookupPlayerEnrichmentLive`,
`lookupTeamEnrichmentLive(name, sport, knownQid, trace)`,
`lookupLeagueEnrichmentLive`, then `toFixtureEntry` + `fixtureKey`, ~5
workers, and DROP any entry whose `newLookupTrace()` tripped
`transportFailed` (the capture's own guard). Feed the result to the same
merge script rather than editing the file.

**The exact staged names:** after a committed probe the set's
`entityReviewSkips` rows hold every SKIPPED row's raw `name`, the split
per-player strings the wizard staged, not `cardName` ("A / B CO" cards stage
two names). A staged name the operator LINKED leaves no row of its own, so
add those by hand. Staged career teams/leagues carry a `knownQid`
(`source.wikidataId`): a recorded entry hits only when its `wikidataId`
equals it, and a recorded `null` is a MISS for a known-QID caller.

**Prove coverage offline** before any deploy: `coverageReportFromCli` (not
armed, read-only), or under tsx set `NEONBINDER_ENRICHMENT_FIXTURES=1` and a
dummy `TESTING_RESET_SECRET` in `process.env` and call
`readFixture(kind, sportQid, name, knownQid)` for every lookup the batch
makes. A preview cannot show a new recording until its bundle is redeployed
(the JSON is imported at build).

**Auto-link vs operator, without a probe** (NEO-307 rule in
`pickTeamForYear`): dump the sport's `teams` read-only, key rows by
`normalizeEntityName` of the composed name AND each alias, then run the real
`pickTeamForYear(rows, setYear, { allowPastEra: true })` under tsx. One dated
row ending before the set year = silent past-era link (no wizard step); two+
rows with none covering the year = no auto-link (a team step ONLY if the
name reaches the review gate; on a BSC-only fetch it can instead commit
teamless as "needs a team", see [[catalogue-seeded-wizard-staging]]); one of
several covering it = silent link to that era (the NEO-336 retro-card trap).
BSC public shop facets give `teamName` per card. See
[[catalogue-seeded-wizard-staging]], [[neo284-team-alias-fixture]].
