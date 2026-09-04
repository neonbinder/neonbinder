---
name: patterns-attention-flag-suppression
description: Review rule for NeonBinder "needs attention" flags — a stored flag cleared by any write of its field is silently clearable by an unrelated save; check the client's mutation args, not just the mutation
metadata:
  type: feedback
---

When auditing a stored "needs attention" flag on `cardChecklist`
(`listingTitleTruncated`, `teamNoneConfirmedAt`, and whatever comes next), the
mutation-level rule "cleared by any write of field X" is NOT the whole story.
Check what the client actually sends. `CardDetailPanel` USED to send the full
field set on every save (`listingTitle`, `cardVariation`, teams, features), so
"cleared on any write of the title" meant "cleared whenever the drawer is saved
for any reason" — the attention item disappeared without being addressed and,
because the flag is only ever set at insert, it never came back.

**Corrected 2026-09-04 (NEO-216):** that drawer is now per-field autosave —
no Save button, no draft, one field per `updateCard` call. The full-payload
hazard is gone for THIS dialog; see [[patterns-card-drawer-autosave]]. The
rule below still governs every other client and every new control added to
the drawer.

**Why:** these flags gate an operator review pass. Silent clearing is the same
false-green class as an unauthenticated e2e queue mutation — the gate reports
clean without the work having been done.

**How to apply:** for each such flag, ask (1) which mutation clears it, (2) does
the clear require the value to have actually CHANGED (compare to the stored row,
not just "the arg was present"), (3) does every client send that arg
unconditionally. NEO-102's `teamNoneConfirmedAt` is the correct precedent — only
a NON-EMPTY team write retires it (`selectorOptions.ts`, the
`writtenTeamIds.length > 0` guard). NEO-101's `listingTitleTruncated` clear
was missing that guard at first review and was fixed on the branch: it now
clears only when the trimmed incoming title differs from the stored one.

Related: [[patterns-convex-auth-boundary]], [[patterns-checklist-commit-trust-boundary]].

## Other NEO-101 facts worth carrying forward

- `selectorOptions.updateCard` is the ONLY write path for `listingTitle` outside
  the two insert branches (`commitCardChecklistChunk`, `addCustomCard`); the
  80-char cap lives there and nowhere else. Any new title writer must go through it.
- `updateCard` caps and validates `teamOnCardIds` (`MAX_CARD_TEAMS`, dedupe,
  existence, sport match) but `playerIds` has NO cap, dedupe or existence check.
  Flag it whenever new code fans out over `playerIds`.
- `findSetNameValue`'s ancestor walk has no depth cap — a `parentId` cycle spins
  until Convex's time limit. Pre-existing, reachable from several admin queries.
