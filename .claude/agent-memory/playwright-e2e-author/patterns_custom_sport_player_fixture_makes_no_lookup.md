---
name: patterns-custom-sport-player-fixture-makes-no-lookup
description: NEO-462 — minted-name player fixtures go in the worker's custom sport (no Wikidata request); same-name forks by birth year; how to read the logs; Back on /admin/players is an exit
metadata:
  type: pattern
---

A spec that needs several players with MINTED single-token names (no recorded
no-match pool) builds them in the worker's custom sport (`drillToCustom(page,
{ sport: customSport(env) })` once, then `/admin/players`, `emptyListAndPickSport`).
The custom sport row has no `sportConfig.wikidata`, so `findPlayerQid` refuses
before any request.

- Reading the Convex logs of such a run: each player's enrich logs
  `wikidata_player_no_match` (name + sport label) THREE times. That is the
  refusal, not a live lookup; the proof of "no request" is zero
  `enrichment_fixture_live_refused` plus the sport having no QID.
- Rows sharing one minted surname token are forked apart with the birth-year
  field: first create is plain, later ones need `Create player <name> anyway`
  with a year no row carries. Typing the surname in the add form then promotes
  the FIRST-created exact row to the primary `Open <name>, b. <year>` and leaves
  the others in the `Possible player matches` list, one listitem each (scope
  rows through that list so the primary never shadows them).
- Stints: `Add team` -> search -> `No matches.` -> Enter -> `New team: <name>`
  dialog -> `Create team <name>`; later stints at the same team pick the
  `Add <team>` option. Pass "is this team new" explicitly, never branch on it.
- The spec re-runs without a re-seed (attempt token differs per run), unlike the
  recorded-name specs.
- `/admin/players` selects with `setSearchParams(..., { replace: true })`:
  Back is an exit from the screen by design, so a spec that opens a row from the
  panel does not walk Back to the add form.
