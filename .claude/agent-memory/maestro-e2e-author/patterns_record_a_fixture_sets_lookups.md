---
name: record-a-fixture-sets-lookups
description: How to add one wizard fixture set's Wikidata lookups to the NEO-289 recording when `captureFromCli` cannot run (catalogue-loaded preview), where the exact staged-name list comes from, and how to prove 100% hit offline; plus how to classify a card's club as auto-link vs operator step without a probe
metadata:
  type: reference
---

**`captureFromCli` refuses on any catalogue-loaded preview**: `listCaptureNames`
reads every player/team row of the sport and throws past 5,000 (Baseball's
catalogue is far larger). Arming it is also a preview env change. Instead run
the SAME live bodies locally under `npx tsx` (an `.mts` script — a `.ts` in the
scratchpad is CJS and top-level await fails): `lookupPlayerEnrichmentLive`,
`lookupTeamEnrichmentLive(name, sport, knownQid, trace)`,
`lookupLeagueEnrichmentLive`, then `toFixtureEntry` + `fixtureKey`, 5 workers,
and DROP any entry whose `newLookupTrace()` tripped `transportFailed` (the
capture's own guard). The sport context is the sport row's `sportConfig`
(read-only `--inline-query`). 200 names took ~48 s from a laptop.

**The exact staged names:** after a committed probe the set's
`entityReviewSkips` rows (index `by_selector_option_and_kind_and_name`) hold
every SKIPPED row's raw `name` — the split per-player strings the wizard
staged, not `cardName` ("A / B CO" cards stage two names). Linked rows are
not there; add them by hand. Staged career teams/leagues carry a `knownQid`
(`source.wikidataId`): a recorded entry hits only when its `wikidataId`
equals it, and a recorded `null` is a MISS for a known-QID caller.

**Prove coverage offline** before any deploy: set
`NEONBINDER_ENRICHMENT_FIXTURES=1` and a dummy `TESTING_RESET_SECRET` in the
script's `process.env`, call `readFixture(kind, sportQid, name, knownQid)` for
every lookup the batch makes, count misses. The preview cannot show the new
recording until the bundle is redeployed (the JSON is imported at build).

**File hygiene:** `json.dumps(indent=2, ensure_ascii=True) + "\n"` reproduces
the committed file byte-exact; merge only absent keys, re-sort keys, and
check no existing entry changed. `enrichmentFixtureFile.test.ts` pins the
key/shape/sort and keeps the live-proof player out.

**Auto-link vs operator, without a probe** (NEO-307 rule in
`pickTeamForYear`): dump the sport's `teams` read-only, key rows by
`normalizeEntityName` of the composed name AND each alias, then run the real
`pickTeamForYear(rows, setYear, { allowPastEra: true })` under tsx. One dated
row ending before the set year = silent past-era link (no wizard step); two+
rows with none covering the year = a team step; one of several covering it =
silent link to that era (the NEO-336 retro-card trap). BSC public shop facets
give `teamName` per card. See [[catalogue-seeded-wizard-staging]],
[[neo284-team-alias-fixture]].
