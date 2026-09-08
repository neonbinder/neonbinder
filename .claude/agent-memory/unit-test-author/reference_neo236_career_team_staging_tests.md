---
name: reference-neo236-career-team-staging-tests
description: NEO-236 staged career-team review rows — test layout, plus two commit-prelude fixture traps (token-sorted player nameNormalized; cardChecklist stores teamOnCardIds and NOT teamNames)
metadata:
  type: reference
---

# NEO-236 — career teams as their own review steps

## Where the tests live

| File | Covers |
|---|---|
| `convex/entityReviewQueue.careerTeamStaging.test.ts` | `stageCareerTeamRowsImpl` (dedup, exclusions, idempotence, `source.wikidataId`, per-call enqueue, MAX 64 cap, ownership), `walkOrder`/`getBatch` ordering, `prefilledTeamCreate`'s league half |
| `convex/commitCardChecklist.careerTeamRows.test.ts` | the prelude's staged `careerTeamOf` pass — operator leagues, `leagueId: null`, undecided/skipped rows, old-shaped `createTeams` still committing |
| `convex/teams.findOrCreate.league.test.ts` | `leagueId` / `leagueId: null` / `leagueName` / cross-sport refusal / sport-default fallback |
| `convex/wikidataEntityReviewQueue.test.ts` (appended block) | `lookupTeamEnrichment(name, sport, knownQid)` skipping EntitySearch; `runEntityReviewLookup` passing `row.source.wikidataId` |

Staging is reachable three ways and all three are worth driving directly:
`t.mutation(internal.entityReviewQueue.applyLookupResult, {...})` (the lookup
landing), `api.entityReviewQueue.recordAllRemainingAsCreate` (the bulk path),
and `api.entityReviewQueue.stageCareerTeamRows` (the wizard's own call).

Set `nameNormalized` on every fixture review row. It IS the dedup key staging
reads through `by_batch_and_kind_and_name`; omitting it makes every
"already in the batch" assertion vacuously pass.

## Two commit-prelude fixture traps (both cost me a red run)

**1. `players.nameNormalized` is TOKEN-SORTED.** The prelude's `norm` is
`normalizeEntityName`, which lowercases *and sorts tokens* — for players too,
not just teams. "Travis Bazzana" is stored as `"bazzana travis"`, "Tony Gwynn"
as `"gwynn tony"`. Every pre-existing test happened to use an
already-alphabetical name ("mike trout", "daulton varsho"), which hides this.
Look the row up by `name`, never by a hand-written normalized string.

**2. `cardChecklist` stores `teamOnCardIds`, not `teamIds`, and does NOT store
`teamNames`.** `teamNames` is a prelude-resolved *wire* value the chunk phase
feeds to listing generation and then drops. To assert the composed full name
("San Diego Padres", not "Padres") reaches the card, assert on
`card.listingTitle`.

## Production bug found (fixed with the proof)

`reviewedTeamFields` in `convex/selectorOptions.ts` checked
`enrichment?.league` BEFORE `create.leagueName`, so an operator who replaced
the suggested league with a name of their own silently got the suggestion
back. Contradicted its own docstring and the ticket. Branches swapped;
`commitCardChecklist.careerTeamRows.test.ts` → "the operator's leagueName wins
over the enrichment's league suggestion" is the pin.

Related: [[reference-neo92-entity-review-wizard-test-suite]],
[[reference-convextest-modules-glob-must-be-repo-root-of-convex-dir]].
