---
name: reference-new-attention-kind-fixture-ripple
description: A deriveCardAttention kind that fires on a common empty field (missingPlayer on no playerIds, NEO-339) reds ~80 tests in ~10 files and several E2E specs; where the fixtures and counts live
metadata:
  type: reference
---

Adding a kind to `convex/features/cardAttention.ts` that fires on an EMPTY
field most fixtures leave out (NEO-339 `missingPlayer`: no `playerIds`) turns
every "settled" / "needs only a team" fixture into a flagged one.

Where it bit (fix by giving the fixture builder a default `playerIds`, and
`playerIds: undefined` / `[]` in the tests that really mean "no player"):
- `CardAttentionWalker.test.tsx` `needsTeamRow`, `CardChecklist.test.tsx`
  `attentionCard`/`settledCard` (the playerless re-sync tests need
  `playerIds: undefined` back), `CardChecklist.needsYou.test.tsx` `teamless`,
  `CardChecklist.search.test.tsx` `card`, `CardChecklistItem.test.tsx`
  `makeCard`, `lib/cards/card-search.test.ts`, `convex/cardChecklist.noTeam.test.ts`
  (addCustomCard cards are born with no player), the rule's own test.
- The set-build tool: `lib/attention.fixture.ts` `quiet` + the fake mutations,
  `attention.test.ts`, `attention-answers.test.ts`, `runner/runner.test.ts`
  `auCard`; `attention-parity.test.tsx` has a hard-coded combination count.
- E2E: any spec adding cards through `addCardViaForm` (a card NAME, no player
  link) and asserting a badge label with `$`, a pill count, a walker subtitle
  or "Step x of y"; plus the oneshot `attention.totals.byKind` pin.

Badge labels join reasons with "; " — anchor E2E regexes as
`needs attention: (.+; )?<reason>$`. The walker's `answered` is keyed per
QUESTION (card + kind) since NEO-339, so a card answered for one kind comes
back in the same sitting for its next one and "Step x of y" counts questions.

See [[gates-in-a-shared-worktree]] for running the full suite alongside siblings.
