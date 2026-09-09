---
name: patterns-neo219-sanctioned-delete
description: NEO-219 adds the ONE sanctioned selectorOptions delete plus three client-supplied optimistic-concurrency levers; the durable traps are that "empty" excludes in-flight checklist work and that a multi-mutation commit ACTION escapes the mutation's OCC
metadata:
  type: project
---

NEO-219 (`convex/selectorOptions.ts`, `SetSelector/*`) ships the only delete of
a `selectorOptions` row that exists, plus `acknowledgedCards` (detach),
`baseVersion` (`setVariantTypePlatformData`), `allowDuplicateElsewhere`
(`addCustomSelectorOption`) and three admin queries. Code-audited 2026-09-04.
Auth is clean throughout — every new function `await requireAdmin(ctx)` as its
first statement. No credentials, no PII, single-tenant operator tooling.

## The two traps worth carrying forward

**1. "Nothing below it" is not the same as "no work in flight."**
`collectSelectorOptionHoldings` deliberately treats `checklistCandidates`,
`entityReviewQueue`, `entityReviewSkips` and `selectorSyncStatus` as transient
and deletes them WITH the row. But `checklistCandidates` is an operator's
staged, un-committed checklist (~900 rows for a real set, scoped per-operator
by `by_selector_option_and_user`), and a row under review is *precisely* an
empty row — it has no `cardChecklist` yet. So the delete affordance is enabled
exactly when another admin's review is live, and it wipes it with no holding
reported. Any future "delete if empty" guard anywhere in this codebase must ask
whether the staging tables count as emptiness.

**2. Convex OCC protects a mutation, not a multi-mutation action.**
The check and the delete are in one mutation, so a concurrent single-mutation
write conflicts on the read set and retries — that half is sound. The checklist
commit is an ACTION orchestrating `commitCardChecklistPrelude` then N
`commitCardChecklistChunk` calls, so a delete landing between them is invisible
to OCC. `resolveCardSlots` (`selectorOptions.ts:167-168`) returns `() => ({})`
for a missing row instead of throwing, so the chunk inserts `cardChecklist`
rows pointing at a deleted `selectorOptionId`. Whenever a new delete or guard
lands, check whether the thing it races is a mutation or an action.

## Mode heuristics decide whether a concurrency guard is armed

`baseVersion` is only sent in `mode === "remap"` (`BaseMappingForm.tsx:123-130,
197-203`), and `mode` comes from `baseHasMapping`, which counts the SPORTLOTS
side only (`components/modules/SetSelector.tsx:198-199` — deliberate, because
Sync Variant Types auto-populates the BSC slug and testing it would suppress
the auto-prompt). NEO-219 also made a BSC-ONLY confirm possible
(`BaseSetPicker.tsx:332, 779`). Result: a BSC-mapped row reads as unmapped
forever, re-opens in `initial` mode with no version guard, and
`setPrimarySlotId` reuses the primary slot key — the exact silent card-repoint
`baseVersion` exists to prevent. **Rule: never gate an optional
optimistic-concurrency arg on a UI mode. Send it whenever the version token
exists** — a stale value can only ever produce a refusal, never a wrong write.

## The three client levers, and why only one of them matters

- `acknowledgedCards` / `baseVersion` — fail-closed in the only direction that
  counts: optional, absent = no check (old bundle keeps working), present and
  mismatched = `ConvexError`, nothing written. Neither can cause a write that
  would not otherwise happen; they only add refusals. `lastUpdated` is a sound
  token — `schema.ts:282` makes it required and every writer of the row bumps
  it.
- `allowDuplicateElsewhere` — a bypass of a NEW advisory guard, not a
  capability. Creating a same-named row under another parent was always
  allowed. It cannot touch the same-parent dedupe, which runs unconditionally
  before it. When auditing a flag like this, the question is "does false→true
  reach anything the actor could not do before this PR?"

## Reference points

- Every `Id<"selectorOptions">` in `schema.ts` and who covers it: `parentId` /
  `children` (by_parent + parent patch), `cardChecklist`, `cardCrossListings`,
  `players`/`leagues`/`teams`.`by_sport_id` (sport level only),
  `entityReviewQueue`/`entityReviewSkips`/`checklistCandidates` (deleted with
  the row). `entityReviewQueue.sportId` is uncovered but transitively safe (a
  queue row implies a variant-level descendant, caught by the child check).
  `selectorSyncStatus.unlinked[].id` is the one genuinely dangling reference —
  inert only because `SyncDoneNotice` renders `value` and never resolves the
  id.
- `.take(HOLDING_SCAN_CAP)` saturation can only UNDERSTATE a count, never turn
  non-empty into empty, because the refusal is derived from `rows.length > 0`.
- `MAX_CARDS_PER_COMMIT` (5000) is a PER-CALL cap, not a per-row one. Any claim
  that a `by_selector_option` `.collect()` is "bounded by MAX_CARDS_PER_COMMIT"
  is wrong; it is bounded by Convex's transaction read limit, same as the
  dozen pre-existing `.collect()`s on that index.
- NEO-47 held on the new picker path: `BaseMappingForm` uses
  `blockedMessageFromErrors` / fixed strings, never `result.message`.

See [[patterns-neo211-additive-selector-sync]] for the store levers this
mirrors and [[patterns-neo137-platform-slots]] for the slot-reuse model that
makes a blind Base re-map destructive.
