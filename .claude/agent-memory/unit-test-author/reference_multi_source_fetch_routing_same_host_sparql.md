---
name: reference-multi-source-fetch-routing-same-host-sparql
description: How to route a single vi.stubGlobal("fetch", ...) stub across ESPN + two distinct Wikidata SPARQL calls on the same host, for testing convex/adapters/wikidata.ts's enrichTeam (NEO-91).
metadata:
  type: reference
---

## Distinguishing two SPARQL calls on the same host by decoded query content

`enrichTeam` (convex/adapters/wikidata.ts) issues up to three fetches per
call: one to `site.api.espn.com` (adapters/espn.ts's `fetchEspnTeamInfo`),
and two to `query.wikidata.org` — `findTeamQid`'s entity-search query, then
(if a QID was found) the detail query for league/city/inception/dissolved.
Both Wikidata calls share the same host and path shape (`?query=<encoded
SPARQL>&format=json`), so URL-substring routing alone can't tell them
apart. Fix: `decodeURIComponent(url)` and check for a predicate unique to
the detail query — `wdt:P118` or `wdt:P571` — which the search query never
contains (it only has `wikibase:mwapi`/`EntitySearch`). A single
`makeFetchStub({ espnTeams, wikidataQid, wikidataDetail })` helper routes
all three calls this way; established in `convex/wikidataEnrichTeam.test.ts`
(all 5 cases passed first try with this approach, no need to fall back to
per-call-order stubbing).

Test file lives at convex/ ROOT, not convex/adapters/, per
[[reference-convextest-modules-glob-must-be-convex-root]] (see
`reference_convextest_modules_glob_must_be_repo_root_of_convex_dir.md`) —
`enrichTeam` is an `internalAction` needing the real convex-test harness. By contrast,
`fetchEspnTeamInfo` itself (adapters/espn.ts) is a plain function with no
Convex dependency at all — its test file (`convex/adapters/espn.test.ts`)
lives right next to the source with a bare `vi.stubGlobal("fetch", ...)`,
no `convexTest`/module-glob involved, and that constraint simply doesn't
apply to it.

## Verifying "no DB write happened at all"

For `enrichTeam`'s early-return branch (neither ESPN nor Wikidata match),
don't just assert individual fields are undefined — capture the full row
via `ctx.db.get(id)` before calling the action and `toEqual` it against the
row after. This catches an accidental `lastUpdated` bump or any other
silent patch that per-field assertions would miss.

## Verifying "a key was never touched" vs. "set to empty"

When a spec requires a key be genuinely absent (e.g. `colors` must not
exist at all when ESPN found nothing, not `{}`), pair
`expect(team.colors).toBeUndefined()` with
`expect(Object.prototype.hasOwnProperty.call(team, "colors")).toBe(false)`
— the first alone can't distinguish "field never set" from "field set to
`undefined`" after a round-trip through Convex's patch semantics.

Related: [[reference-convextest-modules-glob-must-be-convex-root]]
