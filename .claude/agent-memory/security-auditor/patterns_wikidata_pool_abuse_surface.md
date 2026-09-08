---
name: patterns-wikidata-pool-abuse-surface
description: The 5-wide wikidataPool is a shared, uncapped, deployment-wide resource — any signed-in-only write path that enqueues onto it (teams/players findOrCreate) is a DoS/cost vector, and there is no rate-limiter component in the deployment
metadata:
  type: project
---

Audited 2026-09-03 during the NEO-208 plan review.

## The lane

`convex/wikidataPool.ts` — ONE `Workpool` on `components.wikidataPool`,
`maxParallelism: 5` (`WIKIDATA_MAX_PARALLELISM`), no retries, **no queue-depth
cap**. Wired in `convex/convex.config.ts` alongside the two preprocess pools.
Every SPARQL caller in the deployment shares it, including the entity-review
wizard's drain. Saturating it re-creates the exact NEO-99 symptom (wizard stuck
on "Looking up…") for admins.

`internal.wikidataPool.enqueueEnrichment` is `internalMutation` — correct — but
that only means a *server* path must call it. The reachability question is the
auth gate on whatever public function schedules it.

**There is no `@convex-dev/rate-limiter` (or any rate limiter) in
`convex.config.ts` or `package.json`.** So "add a rate limit" is a new
component, not a config line — prefer tightening the auth gate.

## Cost per enqueued NEW entity

`adapters/wikidata.enrichTeam` on a bare row = ~3 outbound requests (SPARQL +
ESPN `fetchEspnTeamInfo` + the teamColorSources sitemap read). The
`teamEnrichmentMarkers` / `playerEnrichmentMarkers` guard sits ABOVE the
network calls, so an *already-enriched* row costs nothing — but a
just-inserted row has no markers, so it always pays full price. That is why
"enqueue only ids you just inserted" and "unbounded row creation" combine
badly.

## The signed-in-only creation primitives

`teams.findOrCreate` and `players.findOrCreate` are `requireSignedIn`
(NEO-154), and sign-up is **open** (`app/sign-up/[[...sign-up]]/page.tsx`,
`SignUpButton` on the landing + every feature page). So any self-registered
user can hit them directly on the public Convex API. Neither validates that
`sportId` is actually a sport-kind `selectorOptions` row, and neither caps
`name` length. Every UI consumer of `TeamPicker`/`PlayerPicker` lives under
`components/SetSelector/*` (admin operator tooling), so `requireAdmin` is
viable — it costs updates to `publicFunctionAuth.test.ts` (~L109-122) and
`leagues.test.ts` (~L155) which currently assert the signed-in-non-admin path
works.

## Where team/player names get logged unsafely

`convex/adapters/wikidata.ts` interpolates the raw name with `+`/template
concat in three places — L299 (`lookupPlayerEnrichment` no-match), L346
(skipped membership), L535 (`lookupTeamEnrichment` no-match; also prints
`${sport}` on an object → `[object Object]`). The enrich* skip logs at L465 /
L605 use `JSON.stringify` and are the pattern to copy.

See [[patterns_convex_auth_boundary]], [[patterns_neo102_card_team_none]].

## Update — NEO-208 (2026-09-03): teams half of this is CLOSED

`teams.findOrCreate` (apps/web/convex/teams.ts) was raised from
`requireSignedIn` to `requireAdmin` because its insert branch now schedules
`internal.wikidataPool.enqueueEnrichment`. It also gained: 120-char post-trim
name cap (refuse, not trim), blank-name refusal, a `sportRow.level === "sport"`
check on `sportId`, and a structured `team_created` JSON audit log. Its only
public consumer is `components/SetSelector/TeamPicker.tsx` (drawer, walker
fixer, and since NEO-208 the quick-add form) — all admin tooling.

`players.findOrCreate` deliberately stays `requireSignedIn` with a why-comment
(no enqueue → no new cost vector). So the remaining open-signup vector on this
surface is player-row insert spam, not outbound Wikidata cost.

The pool still caps concurrency (5) only — no queue-depth cap, no rate-limiter
component. Admins can still drive it; that is the accepted residual.
