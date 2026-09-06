---
name: neo254-undated-career-teams-surfaces
description: NEO-254's undated-Wikidata-teams list has two UI surfaces but only ONE is E2E-reachable — the review wizard; the Players page copy needs players.undatedCareerTeams, which only a checklist COMMIT ever writes. Includes the aria-labels and the measured Wikidata hit rate.
metadata:
  type: reference
---

# "Also on Wikidata, no years yet" — which surface a flow can actually reach

Two components render the same list:

* `SetSelector/UndatedCareerTeams.tsx` — in the entity-review wizard, fed by
  `entityReviewQueue` **`enrichment.undatedCareerTeams`** (a live Wikidata
  lookup on the queued name). **Reachable, and writes nothing.**
* `admin/PlayerManagement.tsx` — on `/admin/players`, fed by
  **`players.undatedCareerTeams`**. **Not reachable.** That column is written
  by exactly one function, `commitCardChecklistPrelude` in `selectorOptions.ts`,
  at COMMIT time. `applyEnrichmentInternal` — the path a player created from
  the admin form or a PlayerPicker takes, and the one "Re-enrich" forces —
  accepts `teamYears` / `isHallOfFame` / `wikidataId` and **not** the undated
  names. So "Add a player" + "Re-enrich" can never populate that section, and a
  commit is forbidden on the wizard fixture.

## The wizard's selectors (verified 2026-09-06)

Visible heading `Also on Wikidata, no years yet`. Per lead, all aria-labelled
with the team name so each row is uniquely addressable — match on the prefix:

`Add years for .*` · `From year for .*` · `To year for .* \(optional\)` ·
`Save years for .*` · `Cancel years for .*` (and `role=group` "Years for …").

Blank start year → `Start year must be a whole year between 1869 and <year+1>.`
(`MIN_CAREER_YEAR` / `maxCareerYear()` in `lib/players/career-years.ts` — match
the upper bound as a pattern, it rolls over on 1 January).

A saved lead is promoted into the wizard's ordinary staged list
(`aria-label="Staged career teams"`) as `<team> (<from>–<to|present>)` — the
SAME shape the dated Wikidata career lines above it use, so pick a start year
that cannot collide with a real stint on the fixture set.

## How often a wizard row has one (measured on WDQS, 2026-09-06)

`classifyMembership` calls any P54 with no usable P580 "undated". Of 500
baseball players holding a P54 dated 2021+ (the closest proxy for a 2024 set's
checklist), **133 — 27% — carry at least one undated P54**. Over the whole
baseball population the rate is 85% (424/500), which is why the ticket's own
examples are 1990-era commons. A flow therefore has to walk the wizard forward
(Skip is the only decision that writes nothing) until a lead appears; 14 rows
leaves ~1.3% chance of finding none.

Related: [[neo254-same-name-panel-unreachable-from-ui]],
[[neo248-wizard-fixture-via-attached-sl-set]].
