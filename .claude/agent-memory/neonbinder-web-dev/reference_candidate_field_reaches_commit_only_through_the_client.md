---
name: candidate-field-reaches-commit-only-through-the-client
description: A field added to a checklistCandidates row never reaches commitCardChecklist by itself — the client copies preview-card fields by hand in three places, so a server-only change is dead until they carry it
metadata:
  type: reference
---

The candidate → commit path is a round trip through the SPA, and every hop
names its fields explicitly:

1. `checklistCandidates` row → `getReadyCandidates` returns validator (server).
2. `components/SetSelector/pairing-cards.ts` — `ReadyCandidate` type and
   `candidateToPairingCard` pick fields one by one.
3. `components/SetSelector/CardPairingModal.tsx` — the hand-linked pair merge
   builds a new card from the BSC and SL halves (e.g. `teamLookup` comes from
   the BSC side); `PairingCard` type lives there too.
4. `components/SetSelector/CardChecklist.tsx` — the commit wire card type.
5. `previewCardFields` in `convex/selectorOptions.ts` (public action arg;
   bound new strings in `assertCardBatchWithinLimits`).

So a task scoped to `convex/**` that "carries X on the candidate row to the
commit" cannot finish there: plan the client carry in the same PR, or give
the server a fallback that works without it and report the client half.
NEO-335's `rawTeamName` hint hit this: scoped to convex, it had to come back
for the client carry. Hand-linked pairs go through `mergePair`, which names
every field (take marketplace-owned values from the side that owns them);
auto-paired cards are spread, so only `candidateToPairingCard` can drop one. Related: [[convex-call-spread-hides-bad-args]].
