---
name: pick-a-wizard-name-from-bsc-facets-and-the-gate-resolver
description: How to choose a real name that is on two named checklists and unknown to the Baseball catalogue, with no browser and no commit: BSC shop facets for the cards, players:resolveNameForReview for the catalogue verdict; what to record afterwards
metadata:
  type: reference
---

**Cards without a login.** `POST <BSC API base>/search/shop/results?q=` (body in
[[probe-bsc-public-search-for-card-ids]]) with `filters` `{sport:["baseball"],
year:["2009"],setName:["topps"],variant:["insert"],variantName:["<slug>"]}`
answers unauthenticated. `aggregations.variantName` lists every insert of a set
with its card count; `aggregations.players` lists the names on one insert;
paging `results` (size 100) gives `cardNo | players | teamName` per card. The
`/search/bulk-upload/filters` endpoint is the authenticated one (401).

**Catalogue verdict.** Run the gate's own resolver read-only, per name and in
parallel (`xargs -P6`): `npx convex run --codegen disable --typecheck disable
players:resolveNameForReview '{"name":…,"sportId":<Baseball sport row id, read
with --inline-query>,"cardYear":2010,"cardTeamNames":[<card team>]}'`. No
`playerId` and `matchCount` 0 = the name stages as a plain New player;
`matchCount` 2 = a pick or Hall-of-Fame case. A hand-rolled name-key query gives
false misses (initials are joined: "B.J. Upton" resolves though a naive key
does not) so use it only as a first filter, and sort tokens when keying.

**Selection recipe.** Intersect the player lists of every small insert of the
two years, drop names already spent by the spec's other inserts, run the
resolver over every card name on the two candidate inserts, keep a pair where
the target is the ONLY unknown name (every other unknown name is another live
Wikidata lookup to record). Real MLB names can be absent from the catalogue
(Rickie Weeks, Jon Niese), as can BSC misspellings (Kendry for Kendrys).

**Record afterwards.** Baseball (default sport, no `sportQid`) hit plus a
Football no-match, with `lookupPlayerEnrichmentLive` under `npx tsx` and a
tripped-`transportFailed` check; see [[record-a-fixture-sets-lookups]]. A
suggested player's row (rules E1/E2) is inserted READY with no lookup, so the
second fetch needs no recording.

**Unprovable from dev alone:** whether the CI preview's catalogue (a prod
snapshot) holds the name. Say so in the registry.
