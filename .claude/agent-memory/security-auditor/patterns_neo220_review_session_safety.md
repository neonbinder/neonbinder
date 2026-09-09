---
name: patterns-neo220-review-session-safety
description: NEO-220/221 plan audit — the three traps in entityReviewQueue session safety (client-driven resume DELETE, unindexed take(500) sweep judging a partial batch, pendingPlayerNames' custom-only lifecycle) and why the marketplace-ref attention gate is an invariant violation
metadata:
  type: project
---

Audited `todos/neo-220-221-plan.md` (2026-09-04) against `origin/main` @ `33c6cd7`.
Reusable traps for anything touching `convex/entityReviewQueue.ts` or
`pendingPlayerNames`/`pendingTeamNames`.

**Why:** these three are structural, not typos — each one reads as safe in the
plan prose and only fails once you follow the value back to who controls it.

**How to apply:** re-check all three on any future change to the review wizard,
the commit prelude/finalize, or the attention rule.

1. **The review batch's "incoming names" are CLIENT DATA.**
   `selectorOptions.resolveChecklistEntities` takes `cards: v.array(previewCardValidator)`
   from the browser; `resolveUnknownsAndStartBatch` derives the unknown-name set
   from it and hands it to `internal.entityReviewQueue.startBatch`. Only
   `createdByUserId` is server-derived (`getCurrentUserId`, thrown on null).
   So any reconciliation that DELETES batch rows "absent from the incoming set"
   is a client-driven delete of the operator's own decisions. Resume must be
   additive; at most delete rows that carry no `decision`. The commit prelude
   looks decisions up BY NAME (`reviewByKey.get('player:'+norm)`), so leftover
   decided rows are inert — there is no correctness reason to delete them.

2. **`pendingPlayerNames`/`pendingTeamNames` have a CUSTOM-ONLY lifecycle.**
   `selectorOptions.ts:8273` (commit prelude fold) and `:9408` (finalize clear
   loop) both `if (!isCustom) continue`. Only the OFFER path (`:831`, the loop
   over `getCardChecklist` misleadingly named `customRows`) is row-agnostic.
   Writing these fields onto a marketplace-sourced card therefore creates a
   value that is never resolved and never cleared — and `updateCard` has no arg
   that can clear them, so any attention item derived from them is permanently
   unclearable. Also note `deriveCardAttention` treats non-empty
   `pendingTeamNames` as HAVING a team (`cardAttention.ts:164`), so writing them
   silently retires the `missingTeam` badge.

3. **A cron sweep that groups a TRUNCATED window then deletes by index.**
   `ctx.db.query(table).take(500)` has no index and is ordered by `_creationTime`,
   which does not order by `lastTouchedAt`. Two failures: a batch straddling the
   window is judged abandoned on a partial row set and then deleted in full by a
   `by_selector_option_and_batch` helper (an ACTIVE session's rows); and a
   long-lived batch occupying the oldest 500 slots starves the sweep forever.
   Contrast the correct shape already in the file: `sweepStalePendingRows`
   (`:782`) reads through the `by_status` index, relies on oldest-first ordering
   for an early `break`, and self-schedules on a strictly shrinking set.

**Registry:** every new public Convex fn must be added by hand to
`convex/publicFunctionAuth.test.ts` (which gate) AND `publicFunctionAuthGuards.test.ts`
(refused-write persisted nothing / no audit field shipped). See
[[patterns_convex_auth_boundary]] and [[patterns_neo240_league_management]].

**Not a finding, twice over:** re-scheduling `wikidataPool.enqueueEntityReviewLookups`
for a review row does NOT violate the "enrichment fires only at creation" rule —
`runEntityReviewLookup` writes to `entityReviewQueue`, not `players`/`teams`.
But `enqueueEntityReviewLookups` has NO dedupe (`wikidataPool.ts:118`), so every
re-enqueue is a fresh work item on the deployment-wide 5-wide lane — see
[[patterns_wikidata_pool_abuse_surface]].
