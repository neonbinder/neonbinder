---
name: patterns-neo240-league-management
description: League Management (/admin/leagues) — all 7 new public fns are requireAdmin and registered in the hand-maintained auth registry; the real gaps are the UNTOUCHED leagues.create (no length caps, plain Error) and the unvalidated sportQid SPARQL interpolation shared with findPlayerQid/findTeamQid
metadata:
  type: project
---

Audited 2026-09-04 on branch `neo-240-league-management`.

## What holds (do not re-derive)

* All seven new public functions in `convex/leagues.ts` —
  `listForManagement`, `getByIdParam`, `nearMatches`, `createByAdmin`,
  `saveLeagueFields`, `teamsIn`, `enrichFromWikidata` — call `requireAdmin`
  as the FIRST statement, and all seven are listed in the hand-maintained
  `LEAGUE_ADMIN_GATED` table in `convex/publicFunctionAuth.test.ts`. There is
  no completeness sweep over `api` in either registry test, so a new public
  function is only covered if someone adds the row by hand.
* `leagues` has NO audit column (no `createdByUserId`), so the
  "audit fields never leave the server" rule is vacuous here — but the
  creation log line at `leagues.ts:776` omits the actor, unlike
  `teams.findOrCreate`, which captures `const userId = await requireAdmin(ctx)`.
* **The creation-only enrichment hook is admin-bounded.** Every caller of
  `findOrCreateLeague` / `resolveDefaultLeagueId` is either `internal*` or
  `requireAdmin`: `teams.findOrCreate` (raised in NEO-208),
  `leagues.create`, `leagues.createByAdmin`, `commitCardChecklistPrelude`
  (internalMutation), `teams.findOrCreateInternal`,
  `teams.convertLegacyLeagueInternal`, `seedTeamColors.seedChunkInternal`,
  `cardChecklist` internals. `resolveDefaultLeagueId` is additionally bounded
  to ONE league per sport (found-not-created on every later call → no enqueue).

## The two things worth re-checking on any follow-up

1. **`leagues.create` (leagues.ts:347) was deliberately left alone** and now
   bypasses every cap the ticket introduced — no `MAX_LEAGUE_NAME_LENGTH`,
   no `MAX_LEAGUE_ABBREVIATION_LENGTH`, and a plain `Error` (prod redacts to
   "Server Error"). NEO-240 wired a NEW abbreviation input to it from
   `TeamManagement.tsx`, capped only by a DOM `maxLength={16}`.
2. **`sportQid` is interpolated into SPARQL unvalidated** —
   `adapters/wikidata.ts:570` (`findLeagueQid`), and the same in the
   pre-existing `findPlayerQid`:448 / `findTeamQid`:481. Not reachable today:
   `sportConfig` is only ever written from the hardcoded
   `sportConfigDefaultsFor` table or copied from an existing row — no client
   arg reaches it. The same file already validates `hallOfFameQid` with
   `isWikidataQid` before use (:704), so the asymmetry is the tell.

The `name` half IS safe: `sparqlStringLiteral` escapes `\ " \n \r \t`
U+2028/9 and slices to 200 chars.

See [[patterns_wikidata_pool_abuse_surface]], [[patterns_convex_auth_boundary]].
