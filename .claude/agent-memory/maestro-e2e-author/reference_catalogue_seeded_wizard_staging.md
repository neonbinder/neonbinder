---
name: catalogue-seeded-wizard-staging
description: NEO-330 — with the reference catalogue loaded, which checklist names still reach the entity-review wizard, how to check a name against a preview's catalogue read-only, and what the catalogue does and does not cover (measured 2026-10-10)
metadata:
  type: reference
---

**The catalogue is a PROD snapshot, not just public reference data.** It holds
the players/teams prod's own set builds created (2025-26 Bowman prospects, NPB
names, "Checklist" as a baseball player), with their prod `_creationTime`. So
"prospects are absent from Lahman" is not a fixture strategy: anything an
operator has built in prod is known, and every bundle refresh can drain a
fixture that was green. Re-measure wizard fixtures after each refresh.

**What still stages (CI run, all fixtures fresh):** non-person rows ("Become a
Big Leaguer", "Team Photo") — permanent unless prod commits one; spelling
variants of a catalogue row ("Ismael Valdes" vs "Valdez", "Frank Rodriguez" vs
"Frankie"); same-name rows the card year cannot narrow (two "Frank Thomas");
names under the WRONG sport (football stars in a baseball insert); 1995
minor-league hockey (every Roanoke name, Wikidata no-match for all). Current
MLB team sets stage NOTHING: the fetch goes straight to `Saved N cards`.

**Coverage map:** Hockey players = NHL only (Tretiak/Kharlamov/Wickenheiser
absent). Basketball starts ~1976 (Erving, Bird present; Mikan, Robertson,
Chamberlain, Cousy absent). Baseball teams = every MLB era + Negro leagues +
current MiLB affiliates + indie clubs; defunct MiLB (Tidewater Tides, Hawaii
Islanders) and national teams ("Japan", "Team Canada", "USSR") absent. Only
Baseball/Basketball/Football/Hockey carry `sportConfig.wikidata`/`espn`;
every other sport gets no enrichment, so a live-Wikidata fixture must be one
of those four. The enrichment recording is Baseball-only (every key `|Q5369|`).

**1995 minor-league hockey (re-measured 2026-10-10, wizard fixtures):** Tulsa
Oilers / Memphis RiverKings / San Antonio Iguanas / Fort Worth Fire CHL each
stage 15–16 players and 0 teams (BSC tags no team on these team sets — even
absent clubs never stage). Some players DO hit Wikidata (career clubs staged,
tall "Also on Wikidata" bodies). Live-proof person: Vladislav Tretiak (Hockey,
absent; NHL-only catalogue).

**Retro-card trap:** `resolveTeamForSetYear` prefers an IN-era row, so a 2024
retro card naming "Kansas City Monarchs" links to the 2021– independent club,
not the 1920–48 one. A same-name modern club silently wins.

**Checking a name read-only:** `npx convex run --deployment <preview>
--codegen disable --typecheck disable --inline-query '…'` is sandboxed
read-only. Key = `nameNormalized` (diacritics folded, lowercase, punctuation
to spaces, tokens SORTED: "Frank Thomas" → "frank thomas", "Josh Gibson" →
"gibson josh"); index `by_name_normalized_and_sport_id` on `players`/`teams`,
plus `playerAliases.by_alias_normalized_and_sport_id` and
`playerSports.by_name_normalized_and_sport_id`. Count per sport by iterating
`by_sport_id` (32k-doc read limit; Football/Soccer exceed it).

**Reading a wizard red:** a walk util that spins its 200-iteration repeat
(~1.7s each, ~340s) and then fails on `Skip .* not a person` means the batch
ran out of player rows, not a slow page — check `N of N reviewed` in the
screenshot. `runEntityReviewLookup` `enrichment_fixture` lines in the
convex-logs artifact list every staged player name per fetch, timestamped,
so a passing flow's staging can be counted without a screenshot. See
[[measure-a-fixture-from-ci-artifacts]], [[same-name-player-panel]].
