---
name: checklist-row-field-rides-five-hops
description: A new publisher-checklist row field (noTeam, noNumber) must be threaded through every hop of both pair paths, or the Match Cards operator-link path silently drops it
metadata:
  type: reference
---

A publisher-checklist row field that changes what a pair MEANS (NEO-489 `noTeam`, PR 451 `noNumber`) has two paths to a card, and the operator-link path drops any field it was not told about, with every gate green.

Hops, in order:
1. `lib/checklists/match-published-checklist.ts` `compareChecklistRow`: the one comparison every pair uses (number, case-folded, prefix, NNO, NEO-490 name fallback, operator link). Put conflict rules here, not in the matcher's loop.
2. `lib/checklists/apply-published-row.ts` `applyChecklistRow`: decides `answered`; the fetch's step 3c and `publishedChecklistPairs.applyPublishedChecklistPairs` both call it.
3. `convex/selectorOptions.ts` `publishedChecklistRowValidator` (shared by the fetch and the pairs action) and `checkPublishedChecklist`.
4. `components/SetSelector/checklist-match-apply.ts` `ChecklistLinkRow`, `ChecklistPairRequest.row` and `buildChecklistPairRequests` (it copies fields one by one).
5. `components/SetSelector/CardChecklist.tsx` `resolveChecklistPairs`, which maps the request into action args field by field, and `applyChecklistAnswers`, which folds the answer back. It ignored an empty `teams`, so a No Team answer was dropped.

**Why:** in the NEO-489 × NEO-490 merge, `noTeam` was dropped at hops 4 and 5 and the fold ignored `teams: []`. A No Team row linked by hand would have claimed nothing, and the card would have been looked up and guessed (wrapper invariant 8).
**How to apply:** when you add a row field, grep each hop above. Pin the operator path in `publishedChecklistPairs.test.ts` and `checklist-match-apply.test.tsx`, not only in the fetch test. Keep the harness `playwright/support/published-checklist.ts` (`checklistFacts` and `nameFallbackFacts` share `readRows`/`answersTeam`) reading rows the same way.
