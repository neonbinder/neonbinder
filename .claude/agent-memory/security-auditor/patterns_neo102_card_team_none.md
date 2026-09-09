---
name: patterns-neo102-card-team-none
description: NEO-102 "no team" reconciliation as SHIPPED (v2, derived attention list) — where the teamNoneConfirmedAt suppression flag is honored/cleared, why the flag must never ride a client arg spread, and the residual updateCard team-array gap
metadata:
  type: project
---

NEO-102 shipped as **v2**: a *derived* "needs attention" list, not an
`entityReviewQueue` row kind. Re-audited 2026-09-02 against commits
`e825c75`/`334fde6`/`6252bae`. v1's queue design (and its audit conditions
2, 6–9) is dead — do not reason from it.

## What v2 actually is

- `convex/features/cardAttention.ts` — **pure**, no ctx/db/async, so the SPA
  and Convex share one rule. Re-exported to the SPA via
  `components/SetSelector/card-attention.ts` (the single seam; UI wording
  lives only on the SPA side).
- `cardChecklist.teamNoneConfirmedAt` + `teamNoneConfirmedByUserId`
  (schema.ts ~L374-414). Distinct from `teamCheckDoneAt` ("the BSC lookup
  ran, whatever it found") — conflating them makes every pre-feature
  teamless card permanently invisible.
- Badge rule = teams empty AND no `teamNoneConfirmedAt` AND not still
  awaiting the BSC pass (`platformData.bsc.ref` && !`teamCheckDoneAt`).

## The five write paths, all verified honoring the flag

`cardChecklist.getForBscTeamCheck` (~L243), `applyBscTeamResolution`
(~L276, **re-read inside the writing mutation**, stamps `teamCheckDoneAt`
on the way out), `enqueueBscTeamBackfill` (~L404), and
`commitCardChecklistChunk`'s existing-row enqueue (selectorOptions.ts
~L6656-6665, reading the post-patch value, not `existing.*`).

## The clear-only-on-a-real-write rule

The flag is cleared in exactly two places and both require a **non-empty**
`teamOnCardIds` to have actually been written:
`selectorOptions.updateCard` (~L1974-1979, derived from the write, *after*
the arg filter) and the commit chunk (~L6618-6635), where it rides
`contentPatch.teamOnCardIds` — i.e. the same `applyFields` + `baseVersion`
gate, so a stale decision or a linkage-only re-sync cannot touch it.
`teamOnCardIds: []` deliberately does NOT clear it.

## The rule that keeps re-mattering

`updateCard` patches a **filtered spread of its own args**. Any
server-derived field (an audit stamp, a suppression timestamp) must be
written *after* that loop and must never appear in the arg validator.
Same for `commitChunkCardValidator` — that wire is client-supplied.
Both hold as shipped; check them again on any new field of this shape.

## Audit stamps are Clerk subject STRINGS, not `Id<"users">`

`teamNoneConfirmedByUserId: v.string()` matches `players.createdByUserId`
and `entityReviewQueue.createdByUserId`. A `users` table exists in
schema.ts but **nothing in `convex/` ever reads or writes it**, so there is
no document to reference. Don't "fix" this to `v.id("users")`.
Convex validates `returns` strictly, so `getCardChecklist` must list the
field or every stamped row throws `Object contains extra field` — that
query is `requireAdmin` and the value is an admin's own subject, so the
exposure is acceptable. The SPA type declares it and never renders it.

## Residual gap — CLOSED by NEO-101 (verified 2026-09-03)

`selectorOptions.updateCard` NOW enforces all three on `teamOnCardIds`
(selectorOptions.ts ~L2076-2124): order-preserving dedupe, `MAX_CARD_TEAMS`
(= 8, `convex/features/cardAttention.ts` L206, imported by BOTH the SPA
`MissingTeamFixer` and Convex), and a per-team existence + sport-match check
via `findSportForSelectorOption` (`convex/cardChecklist.ts` L53) — the sport
check is skipped, deliberately, when the ancestor chain is orphaned.
`addCustomCard` had NO equivalent until NEO-208; when reusing this, note the
helper must key off a `selectorOptionId`, not a stored card row (the
add-custom row does not exist yet).

## Still-open note carried from v1

`teams.findOrCreate` is `requireSignedIn`, not `requireAdmin` — the one
signed-in-non-admin write primitive left in teams.ts (NEO-154 added the
gate). NEO-102 reaches it through the existing `TeamPicker`, so it is not
a widening, but it stays worth watching. See
[[patterns_convex_auth_boundary]].
